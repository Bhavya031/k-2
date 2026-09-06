import { existsSync } from "node:fs";

import { Database } from "bun:sqlite";

import { deductionPaise } from "../src/payments/runs.ts";
import { ReviewQueue } from "../src/review/queue.ts";

const REQUIRED_SCHEMA_VERSION = 4;
const ACCRUAL_COUNT = 36;
const VENDORS = [
  "SYNTHETIC AURORA AGGREGATES", "SIMULATED COBALT QUARRY", "SYNTHETIC JUNIPER STONEWORKS",
  "SIMULATED ORBITAL MATERIALS", "SYNTHETIC VELVET BASALT", "SIMULATED LANTERN SANDS",
  "SYNTHETIC COMET CRUSHING", "SIMULATED PEBBLEWORKS NINE", "SYNTHETIC NORTHSTAR ROCK",
] as const;
const REQUIRED_TABLES = [
  "schema_migrations", "vendors", "vendor_terms", "source_documents", "accruals", "accrual_matches",
  "review_items", "review_values", "review_decision_audit", "payment_runs", "payment_run_lines",
] as const;

type DemoSummary = Readonly<{ vendors: number; accruals: number; openReviewItems: number; paymentRunLines: number }>;
type VendorTerms = Readonly<{ id: string; ratePaisePerTonne: number; tdsRateBasisPoints: number; retentionBasisPoints: number; tdsThresholdPaise: number }>;

/** Compact deterministic PRNG for synthetic/simulated records; never use it for production secrets. */
class SeededRandom {
  private state: number;
  constructor(seed: number) { this.state = seed === 0 ? 0x6d2b79f5 : seed >>> 0; }
  next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }
  between(minimum: number, maximum: number): number { return minimum + (this.next() % (maximum - minimum + 1)); }
}

function dateDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function timestampFor(daysAgo: number, sequence: number): string {
  return `${dateDaysAgo(daysAgo)}T${String(8 + (sequence % 8)).padStart(2, "0")}:00:00.000Z`;
}

function parseSeed(value: string | undefined): number {
  if (value === undefined) return 20260906;
  if (!/^[0-9]+$/.test(value)) throw new Error("seed must be a non-negative integer");
  const seed = Number(value);
  if (!Number.isSafeInteger(seed)) throw new Error("seed must be a safe integer");
  return seed;
}

function assertExistingMigratedStore(databasePath: string): void {
  if (!existsSync(databasePath)) throw new Error("refusing to seed: database path does not exist; migrate a store first");
  const database = new Database(databasePath, { readonly: true });
  try {
    const tables = new Set((database.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(({ name }) => name));
    const missing = REQUIRED_TABLES.filter((table) => !tables.has(table));
    if (missing.length > 0) throw new Error(`refusing to seed: database is not a cleanly migrated store (missing ${missing.join(", ")})`);
    const migration = database.query("SELECT version FROM schema_migrations WHERE version = ?").get(REQUIRED_SCHEMA_VERSION) as { version: number } | null;
    if (migration === null) throw new Error("refusing to seed: database is not a cleanly migrated store (current migration is absent)");
  } finally {
    database.close();
  }
}

/** Integer floor pricing: quantity is thousandths of a tonne and rate is paise per tonne. */
function accrualAmountPaise(quantityThousandths: number, ratePaisePerTonne: number): number {
  return Number((BigInt(quantityThousandths) * BigInt(ratePaisePerTonne)) / 1000n);
}

function insertTerms(database: Database, random: SeededRandom): readonly VendorTerms[] {
  return VENDORS.map((name, index) => {
    const id = `synthetic-vendor-${String(index + 1).padStart(2, "0")}`;
    const ratePaisePerTonne = random.between(90_000, 130_000);
    const tdsRateBasisPoints = index === 1 ? 100 : index === 6 ? 250 : 200;
    const retentionBasisPoints = index === 3 ? 300 : index === 7 ? 650 : 500;
    const terms: VendorTerms = { id, ratePaisePerTonne, tdsRateBasisPoints, retentionBasisPoints, tdsThresholdPaise: 3_000_000 };
    database.run("INSERT INTO vendors (id, name, status) VALUES (?, ?, 'active')", [id, name]);
    database.run(`INSERT INTO vendor_terms
      (vendor_id, rate_paise_per_tonne, effective_on, tds_section, tds_rate_basis_points, retention_basis_points, tds_threshold_paise, payment_days)
      VALUES (?, ?, ?, '194C-SIMULATED', ?, ?, ?, ?)`,
    [id, terms.ratePaisePerTonne, dateDaysAgo(60), terms.tdsRateBasisPoints, terms.retentionBasisPoints, terms.tdsThresholdPaise, random.between(14, 30)]);
    return terms;
  });
}

function addReviews(database: Database): void {
  const queue = new ReviewQueue(database);
  const reviews = [
    ["quantity-mismatch", "Review simulated quantity mismatch between the delivery slip and invoice.", "Synthetic/simulated weighbridge quantity differs by 1,000 thousandths.", 90],
    ["printed-amount", "Review simulated printed amount mismatch against agreed-rate pricing.", "Synthetic/simulated paper amount is evidence only and differs from calculated paise.", 80],
    ["missing-date", "Provide the missing date on this simulated delivery document.", "Synthetic/simulated document has no readable incurred date.", 70],
    ["unreadable-vehicle", "Confirm the unreadable vehicle marking on this simulated delivery document.", "Synthetic/simulated vehicle characters cannot be read reliably.", 60],
    ["rate-question", "Confirm the simulated agreed rate before a disputed accrual is released.", "Synthetic/simulated rate card is marked for human confirmation.", 50],
    ["duplicate-pass", "Decide whether the simulated pass reference is a duplicate.", "Synthetic/simulated reference resembles another generated document.", 40],
    ["invoice-link", "Confirm the simulated invoice-to-delivery link.", "Synthetic/simulated invoice date is near the matching-window boundary.", 30],
  ] as const;
  for (const [id, prompt, evidence, priority] of reviews) {
    queue.enqueue({ id: `synthetic-review-${id}`, subjectId: `synthetic-document-${id}`, decisionPrompt: prompt, evidence, priority, createdAt: timestampFor(2, priority) });
  }
  for (let index = 0; index < 3; index += 1) {
    const claimed = queue.claimNext("Synthetic demo reviewer", timestampFor(1, index));
    if (claimed === null) throw new Error("synthetic review queue unexpectedly empty");
    queue.decide(claimed.id, { outcome: index === 1 ? "correct" : "approve", decidedBy: "Synthetic demo reviewer", decidedAt: timestampFor(0, index), ...(index === 1 ? { correctedValue: { kind: "quantity_thousandths" as const, value: 13_460 } } : {}) });
  }
}

export function seedDemoData(databasePath: string, seed = 20260906): DemoSummary {
  assertExistingMigratedStore(databasePath);
  const database = new Database(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON;");
    const existing = database.query("SELECT count(*) AS count FROM vendors").get() as { count: number };
    if (existing.count !== 0) throw new Error("refusing to seed: existing migrated store is not empty");
    const random = new SeededRandom(seed);
    const terms = insertTerms(database, random);
    database.transaction(() => {
      database.run("INSERT INTO payment_runs (id, run_on, reference, notes, status) VALUES ('synthetic-payment-run-01', ?, 'SYNTHETIC-SIMULATED-RUN-01', 'Synthetic/simulated preparation only; no money moves and no bank connection.', 'simulated')", [dateDaysAgo(0)]);
      for (let index = 0; index < ACCRUAL_COUNT; index += 1) {
        const vendor = terms[index % terms.length]!;
        const documentId = `synthetic-delivery-${String(index + 1).padStart(2, "0")}`;
        const accrualId = `synthetic-accrual-${String(index + 1).padStart(2, "0")}`;
        const quantityThousandths = random.between(8_000, 28_000);
        const amountPaise = accrualAmountPaise(quantityThousandths, vendor.ratePaisePerTonne);
        const incurredOn = dateDaysAgo(random.between(1, 60));
        const status = index < 22 ? "incurred" : index < 32 ? "invoiced" : "settled";
        database.run("INSERT INTO source_documents (id, vendor_id, document_status) VALUES (?, ?, 'classified')", [documentId, vendor.id]);
        database.run(`INSERT INTO accruals
          (id, source_document_id, vendor_id, paper_reference, amount_paise, printed_amount_paise, quantity_thousandths, unit, incurred_on, status, extraction_confidence_basis_points)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'tonne', ?, ?, ?)`,
        [accrualId, documentId, vendor.id, `SIMULATED-PASS-${String(index + 1).padStart(3, "0")}`, amountPaise,
          index % 6 === 0 ? amountPaise + 101 : null, quantityThousandths, incurredOn, status, random.between(8_000, 9_900)]);
        if (status !== "incurred") {
          const invoiceId = `synthetic-invoice-${String(index + 1).padStart(2, "0")}`;
          database.run("INSERT INTO source_documents (id, vendor_id, document_status) VALUES (?, ?, 'classified')", [invoiceId, vendor.id]);
          database.run(`INSERT INTO accrual_matches
            (id, accrual_id, invoice_source_document_id, score_basis_points, variance_paise, variance_cause, status, matched_on)
            VALUES (?, ?, ?, 10000, 0, NULL, 'exact', ?)`,
          [`synthetic-match-${String(index + 1).padStart(2, "0")}`, accrualId, invoiceId, dateDaysAgo(1)]);
          if (status === "settled" || index < 28) {
            const tdsPaise = amountPaise >= vendor.tdsThresholdPaise ? deductionPaise(amountPaise, vendor.tdsRateBasisPoints) : 0;
            const retentionPaise = deductionPaise(amountPaise, vendor.retentionBasisPoints);
            database.run(`INSERT INTO payment_run_lines
              (id, payment_run_id, accrual_id, gross_paise, tds_paise, retention_paise, net_paise, status)
              VALUES (?, 'synthetic-payment-run-01', ?, ?, ?, ?, ?, ?)`,
            [`synthetic-payment-line-${String(index + 1).padStart(2, "0")}`, accrualId, amountPaise, tdsPaise, retentionPaise, amountPaise - tdsPaise - retentionPaise, status === "settled" ? "executed_simulated" : "held"]);
          }
        }
      }
    })();
    addReviews(database);
    const openReviewItems = (database.query("SELECT count(*) AS count FROM review_items WHERE state IN ('pending', 'claimed')").get() as { count: number }).count;
    const paymentRunLines = (database.query("SELECT count(*) AS count FROM payment_run_lines").get() as { count: number }).count;
    return { vendors: VENDORS.length, accruals: ACCRUAL_COUNT, openReviewItems, paymentRunLines };
  } finally {
    database.close();
  }
}

function main(arguments_: readonly string[]): void {
  const [databasePath, ...rest] = arguments_;
  if (databasePath === undefined || rest.length > 2 || (rest.length > 0 && rest[0] !== "--seed") || (rest.length === 2 && rest[1] === undefined)) {
    throw new Error("usage: bun run seed-demo -- <migrated-database-path> [--seed <non-negative-integer>]");
  }
  const summary = seedDemoData(databasePath, parseSeed(rest[1]));
  console.log(`Seeded ${summary.vendors} synthetic/simulated vendors, ${summary.accruals} synthetic/simulated accruals, ${summary.openReviewItems} open synthetic/simulated review items, and ${summary.paymentRunLines} synthetic/simulated payment-run lines. No money moves.`);
}

if (import.meta.main) main(process.argv.slice(2));
