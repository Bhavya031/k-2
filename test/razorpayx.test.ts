import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { buildRazorpayXPayoutRequests, buildRazorpayXPayoutRequestsFromRun } from "../src/payments/razorpayx.ts";
import { migrateStore } from "../src/store/schema.ts";

const databases: Database[] = [];
const configuration = Object.freeze({ companyAccountNumber: "SIMULATED COMPANY ACCOUNT" });
const verifiedAt = "2026-09-06T12:00:00.000Z";

function store(): Database { const database = new Database(":memory:"); databases.push(database); migrateStore(database); return database; }
function result(vendorId = "syntheticvendor", accountNumber = "SIM ACCOUNT 0001", ifsc = "SYNB0123ABC", amountPaise = 12345, narration = "Payment run SIMRUN for syntheticvendor") {
  return { runId: "SIMRUN", reference: "SIMULATED-RUN-REFERENCE", instructions: [{ vendorId, beneficiaryName: "Synthetic Beneficiary", accountNumber, ifsc, amountPaise, narration }], held: [] } as const;
}
function method(database: Database, vendorId = "syntheticvendor", accountNumber = "SIM ACCOUNT 0001", ifsc = "SYNB0123ABC", status = "active", fundAccountId: string | null = "simulated_fund_account") {
  database.run("INSERT INTO vendors (id, name, status) VALUES (?, ?, 'active') ON CONFLICT(id) DO NOTHING", [vendorId, `Synthetic vendor ${vendorId}`]);
  database.run("INSERT INTO vendor_payment_methods (id, vendor_id, beneficiary_name, account_number, ifsc, status, verified_by, verified_at, razorpayx_fund_account_id) VALUES (?, ?, 'Synthetic Beneficiary', ?, ?, ?, 'Synthetic Operator', ?, ?)", [`method-${vendorId}-${accountNumber}-${ifsc}`, vendorId, accountNumber, ifsc, status, verifiedAt, fundAccountId]);
}

afterEach(() => { while (databases.length > 0) databases.pop()?.close(); });

describe("simulated RazorpayX payout request builder", () => {
  test("refuses a vendor with no active verified payment method", () => {
    const built = buildRazorpayXPayoutRequests(result(), configuration, store());
    expect(built).toEqual({ accepted: [], refused: [{ vendorId: "syntheticvendor", reason: "no active verified payment method" }] });
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.refused)).toBe(true);
    expect(Object.isFrozen(built.refused[0]!)).toBe(true);
  });

  test("refuses an instruction when even one account-number digit differs from the verified method", () => {
    const database = store(); method(database);
    const built = buildRazorpayXPayoutRequests(result("syntheticvendor", "SIM ACCOUNT 0002"), configuration, database);
    expect(built.refused).toEqual([{ vendorId: "syntheticvendor", reason: "instruction account number does not match active verified payment method" }]);
  });

  test("refuses an instruction when its IFSC differs from the verified method", () => {
    const database = store(); method(database);
    const built = buildRazorpayXPayoutRequests(result("syntheticvendor", "SIM ACCOUNT 0001", "SYNB0123ABD"), configuration, database);
    expect(built.refused).toEqual([{ vendorId: "syntheticvendor", reason: "instruction IFSC does not match active verified payment method" }]);
  });

  test("refuses a revoked verified method", () => {
    const database = store(); method(database, "revokedvendor", "SIM ACCOUNT 0001", "SYNB0123ABC", "revoked");
    const built = buildRazorpayXPayoutRequests(result("revokedvendor"), configuration, database);
    expect(built.refused).toEqual([{ vendorId: "revokedvendor", reason: "no active verified payment method" }]);
  });

  test("prepares exactly the frozen simulated API request with paise unchanged", () => {
    const database = store(); method(database);
    const built = buildRazorpayXPayoutRequests(result(), configuration, database);
    expect(built.refused).toEqual([]);
    expect(built.accepted[0]).toMatchObject({ account_number: "SIMULATED COMPANY ACCOUNT", fund_account_id: "simulated_fund_account", amount: 12345, currency: "INR", mode: "IMPS", purpose: "vendor bill", queue_if_low_balance: true, reference_id: "SIMULATED-RUN-REFERENCE", narration: "Payment run SIMRUN for syntheticvendor" });
    expect(built.accepted[0]!.headers["X-Payout-Idempotency"]).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(built.accepted)).toBe(true);
    expect(Object.isFrozen(built.accepted[0]!)).toBe(true);
    expect(Object.isFrozen(built.accepted[0]!.headers)).toBe(true);
  });

  test("uses content-derived idempotency: stable for identical content and different at one paise", () => {
    const database = store(); method(database);
    const originalNow = Date.now; let tick = 0;
    Date.now = () => ++tick;
    try {
      const first = buildRazorpayXPayoutRequests(result(), configuration, database).accepted[0]!.headers["X-Payout-Idempotency"];
      const same = buildRazorpayXPayoutRequests(result(), configuration, database).accepted[0]!.headers["X-Payout-Idempotency"];
      const plusOnePaise = buildRazorpayXPayoutRequests(result("syntheticvendor", "SIM ACCOUNT 0001", "SYNB0123ABC", 12346), configuration, database).accepted[0]!.headers["X-Payout-Idempotency"];
      expect(same).toBe(first);
      expect(plusOnePaise).not.toBe(first);
    } finally { Date.now = originalNow; }
  });

  test("refuses a narration containing a hyphen", () => {
    const database = store(); method(database);
    const built = buildRazorpayXPayoutRequests(result("syntheticvendor", "SIM ACCOUNT 0001", "SYNB0123ABC", 12345, "SIMULATED-NARRATION"), configuration, database);
    expect(built.refused).toEqual([{ vendorId: "syntheticvendor", reason: "narration contains unsafe characters" }]);
  });

  test("builds from payment-run snapshots and never falls back to vendor terms", () => {
    const database = store(); method(database);
    database.run("INSERT INTO source_documents (id, vendor_id, document_status) VALUES ('source', 'syntheticvendor', 'classified')");
    database.run("INSERT INTO accruals (id, source_document_id, vendor_id, paper_reference, amount_paise, quantity_thousandths, unit, incurred_on, status, extraction_confidence_basis_points) VALUES ('accrual', 'source', 'syntheticvendor', 'SIM', 12345, 1, 'tonne', '2026-09-06', 'invoiced', 9000)");
    database.run("INSERT INTO payment_runs (id, run_on, reference, status) VALUES ('SIMRUN', '2026-09-06', 'SIMULATED-RUN-REFERENCE', 'draft')");
    database.run("INSERT INTO payment_run_lines (id, payment_run_id, accrual_id, gross_paise, tds_paise, retention_paise, net_paise, beneficiary_account_number, beneficiary_ifsc, status) VALUES ('line', 'SIMRUN', 'accrual', 12345, 0, 0, 12345, 'SIM ACCOUNT 0001', 'SYNB0123ABC', 'draft')");
    expect(buildRazorpayXPayoutRequestsFromRun(database, "SIMRUN", configuration).accepted).toHaveLength(1);
    database.run("UPDATE payment_run_lines SET beneficiary_account_number = NULL, beneficiary_ifsc = NULL WHERE id = 'line'");
    expect(buildRazorpayXPayoutRequestsFromRun(database, "SIMRUN", configuration)).toEqual({ accepted: [], refused: [{ vendorId: "syntheticvendor", reason: "payment run has no verified-method comparison snapshot" }] });
  });

  test("database rejects an invalid IFSC and a second active method for the same vendor", () => {
    const database = store();
    database.run("INSERT INTO vendors (id, name, status) VALUES ('ifscvendor', 'Synthetic IFSC vendor', 'active')");
    expect(() => database.run("INSERT INTO vendor_payment_methods (id, vendor_id, beneficiary_name, account_number, ifsc, status, verified_by, verified_at) VALUES ('bad', 'ifscvendor', 'Synthetic Beneficiary', 'SIM ACCOUNT', 'BAD', 'active', 'Synthetic Operator', ?)", [verifiedAt])).toThrow("CHECK constraint failed");
    expect(() => database.run("INSERT INTO vendor_payment_methods (id, vendor_id, beneficiary_name, account_number, ifsc, status, verified_by, verified_at) VALUES ('bad-time', 'ifscvendor', 'Synthetic Beneficiary', 'SIM ACCOUNT', 'SYNB0123ABC', 'active', 'Synthetic Operator', '2026-02-29T12:00:00.000Z')")).toThrow("CHECK constraint failed");
    method(database, "ifscvendor", "SIM ACCOUNT 0001", "SYNB0123ABC");
    expect(() => method(database, "ifscvendor", "SIM ACCOUNT 0002", "SYNB0123ABD")).toThrow("UNIQUE constraint failed");
  });

  test("keeps vendor payment method writes confined to the interactive verifier script", () => {
    const root = join(import.meta.dir, "..");
    const sourceFiles = readdirSync(join(root, "src"), { recursive: true }).filter((file): file is string => typeof file === "string" && file.endsWith(".ts"));
    for (const file of sourceFiles) expect(readFileSync(join(root, "src", file), "utf8")).not.toMatch(/(?:INSERT|UPDATE)\s+INTO?\s+vendor_payment_methods/i);
    const verifier = readFileSync(join(root, "scripts", "verify-vendor.ts"), "utf8");
    expect(verifier).toContain("process.stdin.isTTY");
    expect(verifier).toMatch(/INSERT INTO vendor_payment_methods/);
    expect(verifier).toMatch(/UPDATE vendor_payment_methods SET status = 'revoked'/);
  });
});
