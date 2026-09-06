import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import {
  AccrualLedger,
  DELIVERY_DATA_REVIEW_PRIORITY,
  priceAccrual,
  PRINTED_AMOUNT_TOLERANCE_PAISE,
  saveVendorTerms,
  VENDOR_RATE_REVIEW_PRIORITY,
  type DeliveryForAccrual,
} from "../src/ledger/accruals.ts";
import { ReviewQueue } from "../src/review/queue.ts";
import { migrateStore } from "../src/store/schema.ts";

const databases: Database[] = [];
const REVIEWED = "2026-09-06T12:00:00.000Z";

function openStore(): Database {
  const database = new Database(":memory:");
  databases.push(database);
  migrateStore(database);
  return database;
}

function insertVendorAndDocument(database: Database, suffix: string, vendor = "synthetic-vendor"): void {
  database.run("INSERT OR IGNORE INTO vendors (id, name, status) VALUES (?, ?, 'active')", [vendor, `Synthetic ${vendor}`]);
  database.run("INSERT INTO source_documents (id, vendor_id, document_status) VALUES (?, ?, 'classified')", [
    `synthetic-delivery-${suffix}`, vendor,
  ]);
}

function terms(database: Database, vendor = "synthetic-vendor", ratePaisePerTonne = 12_500): void {
  saveVendorTerms(database, {
    vendorId: vendor, ratePaisePerTonne, effectiveOn: "2026-09-01", tdsSection: "194C",
    tdsRateBasisPoints: 100, retentionBasisPoints: 500, paymentDays: 21,
  });
}

function delivery(suffix: string, overrides: Partial<DeliveryForAccrual> = {}): DeliveryForAccrual {
  return {
    id: `synthetic-accrual-${suffix}`,
    sourceDocumentId: `synthetic-delivery-${suffix}`,
    vendorId: "synthetic-vendor",
    paperReference: `SIM-PASS-${suffix}`,
    quantityThousandths: 12_420,
    unit: "tonne",
    incurredOn: "2026-09-06",
    extractionConfidenceBasisPoints: 9_500,
    reviewedAt: REVIEWED,
    ...overrides,
  };
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe("Stage 6 ledger accruals", () => {
  test("books a synthetic known-vendor delivery on its incurred date using only the agreed-rate formula", () => {
    const database = openStore();
    insertVendorAndDocument(database, "known");
    terms(database);
    const ledger = new AccrualLedger(database, new ReviewQueue(database));

    expect(ledger.accrue(delivery("known", { printedAmountPaise: 1 }))).toEqual({
      kind: "accrued", accrualId: "synthetic-accrual-known", amountPaise: 155_250,
    });
    expect(database.query("SELECT amount_paise, printed_amount_paise, quantity_thousandths, unit, incurred_on, status FROM accruals").get()).toEqual({
      amount_paise: 155_250, printed_amount_paise: 1, quantity_thousandths: 12_420,
      unit: "tonne", incurred_on: "2026-09-06", status: "incurred",
    });
  });

  test("uses one integer floor division for pricing, including remainders on both sides of half a paise", () => {
    expect(priceAccrual(1_001, 1)).toBe(1);
    expect(priceAccrual(12_420, 12_500)).toBe(155_250);
    // 155,808,900 / 1000 = 155,808.9: floor must not round this up.
    expect(priceAccrual(12_420, 12_545)).toBe(155_808);
    // 155,796,480 / 1000 = 155,796.48: this also pins integer truncation below half.
    expect(priceAccrual(12_420, 12_544)).toBe(155_796);
    expect(() => priceAccrual(1.5, 1)).toThrow("quantityThousandths must be a safe integer");
  });

  test("preserves a printed amount as evidence and flags only discrepancies beyond the documented trivial one-paise tolerance", () => {
    const database = openStore();
    insertVendorAndDocument(database, "disagreement");
    terms(database);
    const ledger = new AccrualLedger(database, new ReviewQueue(database));
    const computed = 155_250;

    ledger.accrue(delivery("disagreement", { printedAmountPaise: computed + PRINTED_AMOUNT_TOLERANCE_PAISE + 1 }));

    expect(database.query("SELECT printed_amount_paise, amount_paise FROM accruals").get()).toEqual({
      printed_amount_paise: computed + 2, amount_paise: computed,
    });
    expect(database.query("SELECT decision_prompt FROM review_items WHERE id = ?").get("printed-discrepancy:synthetic-delivery-disagreement"))
      .toEqual({ decision_prompt: "Review the printed delivery amount: it differs from the agreed-rate accrual by more than 1 paise." });
  });

  test("routes a synthetic vendor without agreed terms to exactly one high-priority vendor-rate review and creates no accrual", () => {
    const database = openStore();
    insertVendorAndDocument(database, "no-rate");
    const ledger = new AccrualLedger(database, new ReviewQueue(database));

    expect(ledger.accrue(delivery("no-rate"))).toEqual({
      kind: "skipped", reason: "missing rate", reviewItemId: "accrual-missing:synthetic-delivery-no-rate",
    });
    expect(ledger.accrue(delivery("no-rate"))).toEqual({
      kind: "skipped", reason: "missing rate", reviewItemId: "accrual-missing:synthetic-delivery-no-rate",
    });
    expect(database.query("SELECT count(*) AS count FROM accruals").get()).toEqual({ count: 0 });
    expect(database.query("SELECT count(*) AS count, priority, decision_prompt FROM review_items").get()).toEqual({
      count: 1, priority: VENDOR_RATE_REVIEW_PRIORITY,
      decision_prompt: "Set the agreed vendor rate per tonne before this delivery can be accrued.",
    });
  });

  test("uses the fixed missing-data precedence and ranks a rate review above a missing-reference review", () => {
    const database = openStore();
    insertVendorAndDocument(database, "missing-vendor");
    insertVendorAndDocument(database, "missing-reference");
    insertVendorAndDocument(database, "missing-date");
    insertVendorAndDocument(database, "missing-quantity");
    insertVendorAndDocument(database, "missing-rate");
    terms(database);
    const queue = new ReviewQueue(database);
    const ledger = new AccrualLedger(database, queue);

    expect(ledger.accrue(delivery("missing-vendor", { vendorId: undefined, paperReference: undefined, incurredOn: undefined, quantityThousandths: undefined }))).toMatchObject({ kind: "skipped", reason: "missing vendor" });
    expect(ledger.accrue(delivery("missing-reference", { paperReference: undefined, incurredOn: undefined, quantityThousandths: undefined }))).toMatchObject({ kind: "skipped", reason: "missing reference" });
    expect(ledger.accrue(delivery("missing-date", { incurredOn: undefined, quantityThousandths: undefined }))).toMatchObject({ kind: "skipped", reason: "missing date" });
    expect(ledger.accrue(delivery("missing-quantity", { quantityThousandths: undefined }))).toMatchObject({ kind: "skipped", reason: "missing quantity" });
    database.run("INSERT INTO vendors (id, name, status) VALUES ('synthetic-no-rate-vendor', 'Synthetic no-rate vendor', 'active')");
    database.run("UPDATE source_documents SET vendor_id = 'synthetic-no-rate-vendor' WHERE id = 'synthetic-delivery-missing-rate'");
    expect(ledger.accrue(delivery("missing-rate", { vendorId: "synthetic-no-rate-vendor" }))).toMatchObject({ kind: "skipped", reason: "missing rate" });
    expect(queue.claimNext("synthetic-accountant", "2026-09-06T12:01:00.000Z")?.priority).toBe(VENDOR_RATE_REVIEW_PRIORITY);
    expect(VENDOR_RATE_REVIEW_PRIORITY).toBeGreaterThan(DELIVERY_DATA_REVIEW_PRIORITY);
  });

  test("is idempotent once an accrual exists for a delivery source document", () => {
    const database = openStore();
    insertVendorAndDocument(database, "idempotent");
    terms(database);
    const ledger = new AccrualLedger(database, new ReviewQueue(database));
    ledger.accrue(delivery("idempotent"));

    expect(ledger.accrue(delivery("idempotent", { id: "would-be-duplicate", printedAmountPaise: 999_999 }))).toEqual({
      kind: "already-accrued", accrualId: "synthetic-accrual-idempotent",
    });
    expect(database.query("SELECT count(*) AS count FROM accruals").get()).toEqual({ count: 1 });
  });

  test("database enforces accrual integers, date, exact status set, one source delivery, and future match/payment tables", () => {
    const database = openStore();
    insertVendorAndDocument(database, "constraints");
    terms(database);
    database.run(`INSERT INTO accruals (id, source_document_id, vendor_id, paper_reference, amount_paise, quantity_thousandths, unit, incurred_on, status, extraction_confidence_basis_points)
      VALUES ('synthetic-accrual-constraints', 'synthetic-delivery-constraints', 'synthetic-vendor', 'SIM', 1, 1, 'tonne', '2026-09-06', 'incurred', 9000)`);
    expect(() => database.run("UPDATE accruals SET status = 'paid' WHERE id = 'synthetic-accrual-constraints'")).toThrow("CHECK constraint failed");
    expect(() => database.run("UPDATE accruals SET quantity_thousandths = -1 WHERE id = 'synthetic-accrual-constraints'")).toThrow("CHECK constraint failed");
    expect(() => database.run("UPDATE accruals SET amount_paise = 1.5 WHERE id = 'synthetic-accrual-constraints'")).toThrow("cannot store REAL value in INTEGER column accruals.amount_paise");
    expect(() => database.run("UPDATE accruals SET incurred_on = '2026-02-29' WHERE id = 'synthetic-accrual-constraints'")).toThrow("CHECK constraint failed");
    expect(() => database.run(`INSERT INTO accruals (id, source_document_id, vendor_id, paper_reference, amount_paise, quantity_thousandths, unit, incurred_on, status, extraction_confidence_basis_points)
      VALUES ('duplicate', 'synthetic-delivery-constraints', 'synthetic-vendor', 'SIM-2', 1, 1, 'tonne', '2026-09-06', 'incurred', 9000)`)).toThrow("UNIQUE constraint failed");
    expect(database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('accrual_matches', 'payment_runs', 'payment_run_lines') ORDER BY name").all())
      .toEqual([{ name: "accrual_matches" }, { name: "payment_run_lines" }, { name: "payment_runs" }]);
  });

  test("vendor terms allow one integer-only term set per vendor and constrain tax, retention, payment days, and beneficiary fields", () => {
    const database = openStore();
    insertVendorAndDocument(database, "terms");
    terms(database, "synthetic-vendor", 10_000);
    terms(database, "synthetic-vendor", 11_000);
    expect(database.query("SELECT rate_paise_per_tonne, effective_on, tds_section, tds_rate_basis_points, retention_basis_points, payment_days, beneficiary_name FROM vendor_terms").get())
      .toEqual({ rate_paise_per_tonne: 11_000, effective_on: "2026-09-01", tds_section: "194C", tds_rate_basis_points: 100, retention_basis_points: 500, payment_days: 21, beneficiary_name: null });
    expect(() => database.run("UPDATE vendor_terms SET rate_paise_per_tonne = 1.5")).toThrow("cannot store REAL value in INTEGER column vendor_terms.rate_paise_per_tonne");
    expect(() => database.run("UPDATE vendor_terms SET tds_rate_basis_points = 10001")).toThrow("CHECK constraint failed");
    expect(() => database.run("UPDATE vendor_terms SET payment_days = -1")).toThrow("CHECK constraint failed");
  });
});
