import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { saveVendorTerms } from "../src/ledger/accruals.ts";
import { deductionPaise, paiseToInr, PaymentRuns } from "../src/payments/runs.ts";
import { ReviewQueue } from "../src/review/queue.ts";
import { migrateStore } from "../src/store/schema.ts";

const databases: Database[] = [];
const REVIEWED = "2026-09-06T12:00:00.000Z";

function openStore(): Database { const database = new Database(":memory:"); databases.push(database); migrateStore(database); return database; }
afterEach(() => { while (databases.length > 0) databases.pop()?.close(); });

function eligible(database: Database, suffix: string, grossPaise: number, status = "exact", bank = true): void {
  const vendorId = `synthetic-vendor-${suffix}`;
  database.run("INSERT INTO vendors (id, name, status) VALUES (?, ?, 'active')", [vendorId, `Synthetic Vendor ${suffix}`]);
  database.run("INSERT INTO source_documents (id, vendor_id, document_status) VALUES (?, ?, 'classified')", [`delivery-${suffix}`, vendorId]);
  database.run("INSERT INTO source_documents (id, vendor_id, document_status) VALUES (?, ?, 'classified')", [`invoice-${suffix}`, vendorId]);
  saveVendorTerms(database, {
    vendorId, ratePaisePerTonne: 1, effectiveOn: "2026-09-01", tdsSection: "194C", tdsRateBasisPoints: 200,
    retentionBasisPoints: 500, paymentDays: 21, beneficiaryName: bank ? `Synthetic Beneficiary ${suffix}` : undefined,
    beneficiaryAccountNumber: bank ? `ACCT-${suffix}` : undefined, beneficiaryIfsc: bank ? `IFSC-${suffix}` : undefined,
  });
  database.run(`INSERT INTO accruals (id, source_document_id, vendor_id, paper_reference, amount_paise, quantity_thousandths, unit, incurred_on, status, extraction_confidence_basis_points)
    VALUES (?, ?, ?, 'SIM', ?, 1, 'tonne', '2026-09-01', 'invoiced', 9000)`, [`accrual-${suffix}`, `delivery-${suffix}`, vendorId, grossPaise]);
  database.run("INSERT INTO accrual_matches (id, accrual_id, invoice_source_document_id, status, matched_on) VALUES (?, ?, ?, ?, '2026-09-06')", [`match-${suffix}`, `accrual-${suffix}`, `invoice-${suffix}`, status]);
}

function runs(database: Database): PaymentRuns { return new PaymentRuns(database, new ReviewQueue(database)); }

describe("Stage 7 payment runs", () => {
  test("selects only unattached exact and within-tolerance matches, computes per-line floor deductions, and totals already-rounded nets", () => {
    const database = openStore();
    eligible(database, "a", 3_000_019, "exact"); // tax 60,000; retention 150,000; net 2,790,019
    eligible(database, "b", 3_000_011, "within_tolerance"); // tax 60,000; retention 150,000; net 2,790,011
    eligible(database, "variance", 9_000_001, "variance");
    eligible(database, "rejected", 9_000_001, "rejected");
    eligible(database, "old", 9_000_001, "exact");
    database.run("INSERT INTO payment_runs (id, run_on, status) VALUES ('old-run', '2026-09-05', 'draft')");
    database.run("INSERT INTO payment_run_lines (id, payment_run_id, accrual_id, gross_paise, tds_paise, retention_paise, net_paise, status) VALUES ('old-line', 'old-run', 'accrual-old', 1, 0, 0, 1, 'draft')");

    const result = runs(database).create({ id: "run-1", runOn: "2026-09-06", reviewedAt: REVIEWED });

    expect(database.query("SELECT accrual_id, gross_paise, tds_paise, retention_paise, net_paise, status FROM payment_run_lines WHERE payment_run_id = 'run-1' ORDER BY accrual_id").all()).toEqual([
      { accrual_id: "accrual-a", gross_paise: 3_000_019, tds_paise: 60_000, retention_paise: 150_000, net_paise: 2_790_019, status: "draft" },
      { accrual_id: "accrual-b", gross_paise: 3_000_011, tds_paise: 60_000, retention_paise: 150_000, net_paise: 2_790_011, status: "draft" },
    ]);
    expect(result.instructions.map(({ amountPaise }) => amountPaise)).toEqual([2_790_019, 2_790_011]);
    expect(database.query("SELECT count(*) AS count FROM payment_run_lines WHERE payment_run_id = 'run-1'").get()).toEqual({ count: 2 });
  });

  test("applies tax at the vendor-terms table threshold inclusively and uses floor rather than round on non-even values", () => {
    const database = openStore();
    eligible(database, "below", 2_999_999, "exact");
    eligible(database, "at", 3_000_000, "exact");
    expect(database.query("SELECT tds_section, tds_rate_basis_points, retention_basis_points, tds_threshold_paise FROM vendor_terms WHERE vendor_id = 'synthetic-vendor-at'").get()).toEqual({ tds_section: "194C", tds_rate_basis_points: 200, retention_basis_points: 500, tds_threshold_paise: 3_000_000 });
    const result = runs(database).create({ id: "threshold-run", runOn: "2026-09-06", reviewedAt: REVIEWED });
    expect(deductionPaise(101, 50)).toBe(0); // 0.505 paise must floor, not round.
    expect(database.query("SELECT gross_paise, tds_paise FROM payment_run_lines WHERE payment_run_id = 'threshold-run' ORDER BY gross_paise").all()).toEqual([
      { gross_paise: 2_999_999, tds_paise: 0 }, { gross_paise: 3_000_000, tds_paise: 60_000 },
    ]);
    expect(result.instructions).toHaveLength(2);
  });

  test("holds a vendor with missing extracted account/IFSC or a nonpositive net, creates review items, and never invents beneficiary data", () => {
    const database = openStore();
    eligible(database, "missing", 100_001, "exact");
    database.run("UPDATE vendor_terms SET beneficiary_account_number = NULL WHERE vendor_id = 'synthetic-vendor-missing'");
    eligible(database, "ifsc", 100_001, "exact");
    database.run("UPDATE vendor_terms SET beneficiary_ifsc = NULL WHERE vendor_id = 'synthetic-vendor-ifsc'");
    eligible(database, "zero", 1, "exact");
    database.run("UPDATE vendor_terms SET retention_basis_points = 10000 WHERE vendor_id = 'synthetic-vendor-zero'");
    const result = runs(database).create({ id: "hold-run", runOn: "2026-09-06", reviewedAt: REVIEWED });
    expect(result.instructions).toEqual([]);
    expect(result.held).toEqual([
      { vendorId: "synthetic-vendor-ifsc", reason: "missing beneficiary IFSC from extracted vendor invoice data", reviewItemId: "payment-held:hold-run:synthetic-vendor-ifsc" },
      { vendorId: "synthetic-vendor-missing", reason: "missing beneficiary account number from extracted vendor invoice data", reviewItemId: "payment-held:hold-run:synthetic-vendor-missing" },
      { vendorId: "synthetic-vendor-zero", reason: "nonpositive net payable", reviewItemId: "payment-held:hold-run:synthetic-vendor-zero" },
    ]);
    expect(database.query("SELECT status FROM payment_run_lines WHERE payment_run_id = 'hold-run' ORDER BY accrual_id").all()).toEqual([{ status: "held" }, { status: "held" }, { status: "held" }]);
    expect(database.query("SELECT count(*) AS count FROM review_items WHERE id LIKE 'payment-held:%'").get()).toEqual({ count: 3 });
  });

  test("renders exactly the required CSV header with integer paise converted only at the file boundary, and refuses missing bank details", () => {
    const database = openStore();
    eligible(database, "csv", 100_101, "exact");
    const service = runs(database);
    const created = service.create({ id: "csv-run", runOn: "2026-09-06", reviewedAt: REVIEWED });
    const csv = service.renderCsv("csv-run");
    expect(csv.split("\n")[0]).toBe("beneficiary_name,account_number,ifsc,amount_inr,narration,reference");
    expect(csv).toContain("950.96"); // 100101 - floor(100101*500/10000) = 95096 paise.
    expect(csv).toContain(created.reference);
    expect(paiseToInr(1)).toBe("0.01");
    database.run("UPDATE vendor_terms SET beneficiary_ifsc = NULL WHERE vendor_id = 'synthetic-vendor-csv'");
    expect(() => service.renderCsv("csv-run")).toThrow("refusing bank file: an instruction is missing beneficiary bank detail");
  });

  test("uses a deterministic reference and only records simulated execution after writing; a write failure leaves payments draft and accruals unsettled", () => {
    const database = openStore();
    eligible(database, "execute", 100_101, "exact");
    const service = runs(database);
    const first = service.create({ id: "execute-run", runOn: "2026-09-06", reviewedAt: REVIEWED });
    expect(() => service.simulateExecution("execute-run", () => { throw new Error("disk full"); })).toThrow("disk full");
    expect(database.query("SELECT status FROM payment_runs WHERE id = 'execute-run'").get()).toEqual({ status: "failed" });
    expect(database.query("SELECT status FROM payment_run_lines WHERE payment_run_id = 'execute-run'").get()).toEqual({ status: "draft" });
    expect(database.query("SELECT status FROM accruals WHERE id = 'accrual-execute'").get()).toEqual({ status: "invoiced" });

    const database2 = openStore();
    eligible(database2, "execute", 100_101, "exact");
    const success = runs(database2);
    const second = success.create({ id: "execute-run", runOn: "2026-09-06", reviewedAt: REVIEWED });
    expect(second.reference).toBe(first.reference);
    let written = "";
    success.simulateExecution("execute-run", (contents) => { written = contents; });
    expect(written).toContain("beneficiary_name,account_number,ifsc,amount_inr,narration,reference");
    expect(database2.query("SELECT status, notes FROM payment_runs WHERE id = 'execute-run'").get()).toEqual({ status: "executed_simulated", notes: "simulated execution; no bank connection" });
    expect(database2.query("SELECT status FROM payment_run_lines WHERE payment_run_id = 'execute-run'").get()).toEqual({ status: "executed_simulated" });
    expect(database2.query("SELECT status FROM accruals WHERE id = 'accrual-execute'").get()).toEqual({ status: "settled" });
  });
});
