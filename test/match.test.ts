import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_MONEY_TOLERANCE_PAISE,
  MATCH_MARGIN_BASIS_POINTS,
  MINIMUM_MATCH_SCORE_BASIS_POINTS,
  ThreeWayMatcher,
  type SupplierInvoiceForMatch,
} from "../src/matching/match.ts";
import { ReviewQueue } from "../src/review/queue.ts";
import { migrateStore } from "../src/store/schema.ts";

const databases: Database[] = [];
const REVIEWED = "2026-09-06T12:00:00.000Z";

function store(): Database {
  const database = new Database(":memory:");
  databases.push(database);
  migrateStore(database);
  return database;
}

function fixture(database: Database, id: string, options: Partial<{ vendorId: string; vendorName: string; reference: string; amount: number; quantity: number; incurredOn: string }> = {}): void {
  const vendorId = options.vendorId ?? "synthetic-vendor";
  database.run("INSERT OR IGNORE INTO vendors (id, name, status) VALUES (?, ?, 'active')", [vendorId, options.vendorName ?? "Synthetic Quarry Limited"]);
  database.run("INSERT INTO source_documents (id, vendor_id, document_status) VALUES (?, ?, 'classified')", [`synthetic-delivery-${id}`, vendorId]);
  database.run(`INSERT INTO accruals (id, source_document_id, vendor_id, paper_reference, amount_paise, quantity_thousandths, unit, incurred_on, status, extraction_confidence_basis_points)
    VALUES (?, ?, ?, ?, ?, ?, 'tonne', ?, 'incurred', 9000)`, [`synthetic-accrual-${id}`, `synthetic-delivery-${id}`, vendorId,
    options.reference ?? `SIM-REF-${id}`, options.amount ?? 155_250, options.quantity ?? 12_420, options.incurredOn ?? "2026-09-01"]);
}

function invoice(database: Database, id: string, options: Partial<SupplierInvoiceForMatch> = {}): SupplierInvoiceForMatch {
  const sourceDocumentId = options.sourceDocumentId ?? `synthetic-invoice-${id}`;
  database.run("INSERT INTO source_documents (id, vendor_id, document_status) VALUES (?, ?, 'classified')", [sourceDocumentId, options.vendorId ?? "synthetic-vendor"]);
  return { id: `invoice-${id}`, sourceDocumentId, documentType: "supplier_invoice", vendorId: "synthetic-vendor", vendorName: "Synthetic Quarry Limited",
    invoiceReference: `SIM-REF-${id}`, invoiceDate: "2026-09-08", amountPaise: 155_250, quantityThousandths: 12_420, ...options };
}

function run(database: Database, invoices: readonly SupplierInvoiceForMatch[], overrides: Partial<{ moneyTolerancePaise: number; dateCloseDays: number; maxInvoiceDelayDays: number }> = {}) {
  return new ThreeWayMatcher(database, new ReviewQueue(database)).run({ invoices, matchedOn: "2026-09-08", reviewedAt: REVIEWED, ...overrides });
}

afterEach(() => { while (databases.length > 0) databases.pop()?.close(); });

describe("Stage 7 Piece A deterministic three-way matching", () => {
  test("matches a supplier invoice only through vendor/date hard gates and writes an exact match deterministically", () => {
    const database = store(); fixture(database, "exact");
    const result = run(database, [invoice(database, "exact")]);

    expect(result).toEqual([{ invoiceId: "invoice-exact", accrualId: "synthetic-accrual-exact", kind: "matched", scoreBasisPoints: 10_000,
      runnerUpScoreBasisPoints: 0, reasons: ["reference", "exact_money", "date_close", "vendor_id"], status: "exact", variancePaise: 0, varianceCause: undefined }]);
    expect(database.query("SELECT score_basis_points, variance_paise, variance_cause, status FROM accrual_matches").get()).toEqual({ score_basis_points: 10_000, variance_paise: 0, variance_cause: null, status: "exact" });
    expect(database.query("SELECT status FROM accruals").get()).toEqual({ status: "invoiced" });
  });

  test("rejects vendor-ID mismatch even when names match, rejects names below six characters, and admits a bounded normalized spelling variant for no points", () => {
    const database = store(); fixture(database, "variant");
    database.run("INSERT INTO vendors (id, name, status) VALUES ('other-vendor', 'Synthetic Quarry Limited', 'active')");
    const idMismatch = invoice(database, "id-mismatch", { vendorId: "other-vendor" });
    const shortName = invoice(database, "short", { vendorId: undefined, vendorName: "Qurry" });
    const variant = invoice(database, "variant", { vendorId: undefined, vendorName: "Synthetic Quary Limited" });

    expect(run(database, [idMismatch, shortName, variant])).toEqual([
      expect.objectContaining({ invoiceId: "invoice-id-mismatch", kind: "unmatched", reason: "no_candidate", scoreBasisPoints: 0 }),
      expect.objectContaining({ invoiceId: "invoice-short", kind: "unmatched", reason: "no_candidate", scoreBasisPoints: 0 }),
      expect.objectContaining({ invoiceId: "invoice-variant", kind: "matched", scoreBasisPoints: 10_000, reasons: ["reference", "exact_money", "date_close", "vendor_name_variant"] }),
    ]);
  });

  test("excludes dates before the accrual and after the configured delay window before scoring", () => {
    const database = store(); fixture(database, "dates");
    const before = invoice(database, "before", { invoiceDate: "2026-08-31" });
    const after = invoice(database, "after", { invoiceDate: "2026-09-12" });
    expect(run(database, [before, after], { maxInvoiceDelayDays: 10 })).toEqual([
      expect.objectContaining({ invoiceId: "invoice-after", kind: "unmatched", reason: "no_candidate" }),
      expect.objectContaining({ invoiceId: "invoice-before", kind: "unmatched", reason: "no_candidate" }),
    ]);
  });

  test("uses explicit threshold and margin boundaries, retaining best and runner-up scores when unmatched", () => {
    expect(MINIMUM_MATCH_SCORE_BASIS_POINTS).toBe(5_000);
    expect(MATCH_MARGIN_BASIS_POINTS).toBe(1_000);
    const database = store();
    fixture(database, "threshold", { amount: 200_000, incurredOn: "2026-09-01" });
    fixture(database, "margin", { amount: 200_500, incurredOn: "2026-09-01" });
    fixture(database, "runner", { amount: 200_000, incurredOn: "2026-09-03" });
    const below = invoice(database, "threshold", { invoiceReference: undefined, amountPaise: 300_000, invoiceDate: "2026-09-02" });
    const margin = invoice(database, "margin", { vendorId: undefined, invoiceReference: "SIM-REF-margin", amountPaise: 200_050, invoiceDate: "2026-09-03" });

    expect(run(database, [below, margin], { dateCloseDays: 0 })).toEqual([
      expect.objectContaining({ invoiceId: "invoice-margin", kind: "matched", scoreBasisPoints: 5_000, runnerUpScoreBasisPoints: 4_000 }),
      expect.objectContaining({ invoiceId: "invoice-threshold", kind: "unmatched", reason: "below_threshold", scoreBasisPoints: 1_000, runnerUpScoreBasisPoints: 1_000 }),
    ]);
  });

  test("breaks competing claims by higher score then accrual id and records the loser as invoice_claimed", () => {
    const database = store();
    fixture(database, "a"); fixture(database, "b", { reference: "SIM-REF-b", incurredOn: "2026-09-02" });
    const higher = invoice(database, "higher", { invoiceReference: "SIM-REF-a" });
    const lower = invoice(database, "lower", { invoiceReference: "SIM-REF-a", invoiceDate: "2026-09-09", amountPaise: 155_251 });

    expect(run(database, [lower, higher])).toEqual([
      expect.objectContaining({ invoiceId: "invoice-higher", kind: "matched", accrualId: "synthetic-accrual-a" }),
      expect.objectContaining({ invoiceId: "invoice-lower", kind: "unmatched", reason: "invoice_claimed", accrualId: null }),
    ]);
  });

  test("classifies exact, within-tolerance, and signed variance; quantity takes precedence over rate then unknown", () => {
    const database = store();
    fixture(database, "within"); fixture(database, "quantity", { amount: 100_000, quantity: 8_000 });
    fixture(database, "rate", { amount: 100_000, quantity: 8_000 }); fixture(database, "unknown", { amount: 100_000, quantity: 8_000 });
    const within = invoice(database, "within", { amountPaise: 155_250 + DEFAULT_MONEY_TOLERANCE_PAISE });
    const quantity = invoice(database, "quantity", { amountPaise: 99_000, quantityThousandths: 7_999 });
    const rate = invoice(database, "rate", { amountPaise: 101_000, quantityThousandths: 8_000 });
    const unknown = invoice(database, "unknown", { amountPaise: 99_000, quantityThousandths: undefined });

    expect(run(database, [within, quantity, rate, unknown]).map(({ invoiceId, status, variancePaise, varianceCause }) => ({ invoiceId, status, variancePaise, varianceCause }))).toEqual([
      { invoiceId: "invoice-quantity", status: "variance", variancePaise: -1_000, varianceCause: "quantity_variance" },
      { invoiceId: "invoice-rate", status: "variance", variancePaise: 1_000, varianceCause: "rate_variance" },
      { invoiceId: "invoice-unknown", status: "variance", variancePaise: -1_000, varianceCause: "cause_unknown" },
      { invoiceId: "invoice-within", status: "within_tolerance", variancePaise: DEFAULT_MONEY_TOLERANCE_PAISE, varianceCause: undefined },
    ]);
    expect(database.query("SELECT evidence FROM review_items WHERE id = 'invoice-variance:synthetic-invoice-quantity'").get()).toEqual(expect.objectContaining({ evidence: expect.stringContaining("signed variance -1000 paise") }));
  });

  test("is idempotent: repeats create no match or review duplicates and retain the existing match", () => {
    const database = store(); fixture(database, "repeat"); const bill = invoice(database, "repeat");
    expect(run(database, [bill])[0]?.kind).toBe("matched");
    expect(run(database, [bill])).toEqual([expect.objectContaining({ kind: "already_matched", invoiceId: "invoice-repeat", accrualId: "synthetic-accrual-repeat" })]);
    expect(database.query("SELECT count(*) AS count FROM accrual_matches").get()).toEqual({ count: 1 });
    expect(database.query("SELECT count(*) AS count FROM review_items").get()).toEqual({ count: 0 });
  });

  test("refuses non-supplier invoices rather than treating them as matching candidates", () => {
    const database = store(); fixture(database, "type");
    const bill = { ...invoice(database, "type"), documentType: "delivery_challan" } as unknown as SupplierInvoiceForMatch;
    expect(() => run(database, [bill])).toThrow("only supplier_invoice documents may be matched");
  });
});
