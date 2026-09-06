import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { seedDemoData } from "../scripts/seed-demo-data.ts";
import { deductionPaise } from "../src/payments/runs.ts";
import { migrateStore } from "../src/store/schema.ts";

const directories: string[] = [];
afterEach(async () => { while (directories.length > 0) await rm(directories.pop()!, { recursive: true, force: true }); });

async function migratedPath(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `k2-seed-${name}-`)); directories.push(directory);
  const path = join(directory, "ledger.sqlite"); const database = new Database(path); migrateStore(database); database.close();
  return path;
}

function snapshot(path: string): string {
  const database = new Database(path, { readonly: true });
  try {
    const tables = [["vendors", "id"], ["vendor_terms", "vendor_id"], ["source_documents", "id"], ["accruals", "id"], ["accrual_matches", "id"], ["review_items", "id"], ["review_values", "review_item_id"], ["review_decision_audit", "id"], ["payment_runs", "id"], ["payment_run_lines", "id"]] as const;
    return JSON.stringify(Object.fromEntries(tables.map(([table, order]) => [table, database.query(`SELECT * FROM ${table} ORDER BY ${order}`).all()])));
  } finally { database.close(); }
}

describe("synthetic/simulated demo-data seeder", () => {
  test("seeds derived accrual amounts, realistic lifecycle counts, reviews, and no payment-method rows", async () => {
    const path = await migratedPath("reconcile");
    expect(seedDemoData(path, 73)).toEqual({ vendors: 9, accruals: 36, openReviewItems: 4, paymentRunLines: 10 });
    const database = new Database(path, { readonly: true });
    try {
      const rows = database.query(`SELECT a.amount_paise, a.quantity_thousandths, a.status, t.rate_paise_per_tonne
        FROM accruals a JOIN vendor_terms t ON t.vendor_id = a.vendor_id ORDER BY a.id`).all() as Array<{ amount_paise: number; quantity_thousandths: number; status: string; rate_paise_per_tonne: number }>;
      expect(rows).toHaveLength(36);
      for (const row of rows) {
        expect(row.amount_paise).toBe(Number((BigInt(row.quantity_thousandths) * BigInt(row.rate_paise_per_tonne)) / 1000n));
        expect(row.rate_paise_per_tonne).toBeGreaterThanOrEqual(90_000);
        expect(row.rate_paise_per_tonne).toBeLessThanOrEqual(130_000);
      }
      expect(rows.filter(({ status }) => status === "incurred")).toHaveLength(22);
      expect(rows.filter(({ status }) => status === "invoiced")).toHaveLength(10);
      expect(rows.filter(({ status }) => status === "settled")).toHaveLength(4);
      expect(database.query("SELECT count(*) AS count FROM review_items WHERE state IN ('pending', 'claimed')").get()).toEqual({ count: 4 });
      expect(database.query("SELECT count(*) AS count FROM review_items WHERE state = 'decided'").get()).toEqual({ count: 3 });
      expect(database.query("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'vendor_payment_methods'").get()).toEqual({ count: 0 });
    } finally { database.close(); }
  });

  test("uses the shared deduction helper for every synthetic/simulated payment-run line", async () => {
    const path = await migratedPath("payments"); seedDemoData(path, 74);
    const database = new Database(path, { readonly: true });
    try {
      const lines = database.query(`SELECT p.gross_paise, p.tds_paise, p.retention_paise, p.net_paise,
        t.tds_rate_basis_points, t.retention_basis_points, t.tds_threshold_paise
        FROM payment_run_lines p JOIN accruals a ON a.id = p.accrual_id JOIN vendor_terms t ON t.vendor_id = a.vendor_id`).all() as Array<{ gross_paise: number; tds_paise: number; retention_paise: number; net_paise: number; tds_rate_basis_points: number; retention_basis_points: number; tds_threshold_paise: number }>;
      expect(lines).toHaveLength(10);
      for (const line of lines) {
        expect(line.tds_paise).toBe(line.gross_paise >= line.tds_threshold_paise ? deductionPaise(line.gross_paise, line.tds_rate_basis_points) : 0);
        expect(line.retention_paise).toBe(deductionPaise(line.gross_paise, line.retention_basis_points));
        expect(line.net_paise).toBe(line.gross_paise - line.tds_paise - line.retention_paise);
      }
    } finally { database.close(); }
  });

  test("is identical for the same seed and differs for another seed", async () => {
    const first = await migratedPath("same-one"); const second = await migratedPath("same-two"); const different = await migratedPath("different");
    seedDemoData(first, 75); seedDemoData(second, 75); seedDemoData(different, 76);
    expect(snapshot(first)).toBe(snapshot(second));
    expect(snapshot(first)).not.toBe(snapshot(different));
  });

  test("refuses an unmigrated store without creating its schema", async () => {
    const directory = await mkdtemp(join(tmpdir(), "k2-seed-unmigrated-")); directories.push(directory);
    const path = join(directory, "empty.sqlite"); const empty = new Database(path); empty.close();
    expect(() => seedDemoData(path, 77)).toThrow("refusing to seed: database is not a cleanly migrated store");
    const database = new Database(path, { readonly: true });
    try { expect(database.query("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'").get()).toEqual({ count: 0 }); } finally { database.close(); }
  });
});
