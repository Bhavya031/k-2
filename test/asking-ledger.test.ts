import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { askLedger, executeLedgerPlan, ledgerPlanSchema } from "../src/asking/ledger.ts";
import { startLedgerServer } from "../src/asking/server.ts";
import type { StructuredProvider, StructuredRequest } from "../src/model/boundary.ts";
import { migrateStore } from "../src/store/schema.ts";

const databases: Database[] = [];
function store(): Database { const database = new Database(":memory:"); databases.push(database); migrateStore(database); return database; }
afterEach(() => { while (databases.length > 0) databases.pop()?.close(); });
function fixture(database: Database): void {
  database.run("INSERT INTO vendors (id,name,status) VALUES ('v','Synthetic Quarry','active')");
  database.run("INSERT INTO vendor_terms (vendor_id,rate_paise_per_tonne,effective_on,payment_days) VALUES ('v',12500,'2026-01-01',14)");
  for (const id of ["doc-1", "doc-2"]) database.run("INSERT INTO source_documents (id,vendor_id,document_status) VALUES (?,'v','classified')", [id]);
  database.run("INSERT INTO accruals (id,source_document_id,vendor_id,paper_reference,amount_paise,quantity_thousandths,unit,incurred_on,status,extraction_confidence_basis_points) VALUES ('a-1','doc-1','v','PASS-77',155250,12420,'tonne','2026-08-11','incurred',9800)");
  database.run("INSERT INTO accruals (id,source_document_id,vendor_id,paper_reference,amount_paise,quantity_thousandths,unit,incurred_on,status,extraction_confidence_basis_points) VALUES ('a-2','doc-2','v','PASS-88',10000,1000,'tonne','2026-08-12','invoiced',9800)");
  database.run("INSERT INTO review_items (id,subject_id,decision_prompt,evidence,priority,created_at,state) VALUES ('r-1','doc-1','Check synthetic source.','Synthetic evidence.',90,'2026-08-12T00:00:00Z','pending')");
  database.run("INSERT INTO payment_runs (id,run_on,status) VALUES ('run-1','2026-08-20','simulated')");
  database.run("INSERT INTO payment_run_lines (id,payment_run_id,accrual_id,gross_paise,tds_paise,retention_paise,net_paise,status) VALUES ('line-1','run-1','a-2',10000,200,500,9300,'executed_simulated')");
}
class CannedProvider implements StructuredProvider {
  calls = 0;
  constructor(private readonly replies: unknown[]) {}
  async request(_request: StructuredRequest): Promise<Readonly<{ data: unknown }>> { return { data: this.replies[this.calls++] }; }
}

describe("Stage 10 asking the ledger", () => {
  test("validates an exact closed query-plan schema and rejects SQL, prose, and unknown number fields", () => {
    expect(ledgerPlanSchema.validate({ kind: "pass_reference", reference: "PASS-77", template: "plain" }).ok).toBe(true);
    const rejected = ledgerPlanSchema.validate({ kind: "pass_reference", reference: "PASS-77", template: "plain", sql: "SELECT 1", answer: "₹9,999.99" });
    expect(rejected).toEqual({ ok: false, errors: [{ path: "$", message: "must be one closed ledger plan shape with no extra properties" }] });
  });

  test("retries only the malformed plan and cannot render a fabricated model number", async () => {
    const database = store(); fixture(database);
    const provider = new CannedProvider([
      { kind: "pass_reference", reference: "PASS-77", template: "plain", wording: "There is ₹9,999.99 owed" },
      { kind: "pass_reference", reference: "PASS-77", template: "plain" },
    ]);
    const answer = await askLedger(database, provider, "Find pass PASS-77");
    expect(provider.calls).toBe(2);
    expect(answer).toEqual(expect.objectContaining({ kind: "screen", heading: "Ledger answer — Pass reference PASS-77", citations: [
      { table: "accruals", id: "a-1", label: "Accrual a-1 (PASS-77)" }, { table: "source_documents", id: "doc-1", label: "Document doc-1" },
    ] }));
    const rendered = answer.kind === "screen" ? answer.fragments.join(" ") : answer.content;
    expect(rendered).toContain("₹1,552.50");
    expect(rendered).not.toContain("₹9,999.99");
  });

  test("executes the fixed quarry and overdue plans with integer-store figures and citations", () => {
    const database = store(); fixture(database);
    const quarry = executeLedgerPlan(database, { kind: "quarry_last_month", vendorName: "Synthetic Quarry", month: "2026-08", template: "brief" });
    expect(quarry).toEqual(expect.objectContaining({ kind: "screen", fragments: ["2 delivery records; total ₹1,652.50.", "PASS-77: 12.420 tonne · ₹1,552.50", "PASS-88: 1.000 tonne · ₹100.00"] }));
    const overdue = executeLedgerPlan(database, { kind: "unpaid_past_terms", asOf: "2026-09-01", template: "plain" });
    expect(overdue).toEqual(expect.objectContaining({ kind: "screen", heading: "Ledger answer — Unpaid past terms as of 2026-09-01", fragments: ["Synthetic Quarry · PASS-77 · due 2026-08-25 · ₹1,552.50"] }));
  });

  test("renders requested files solely from selected rows with row citations", () => {
    const database = store(); fixture(database);
    const output = executeLedgerPlan(database, { kind: "unbilled_file" });
    expect(output).toEqual(expect.objectContaining({ kind: "file", filename: "unbilled-accruals.csv", citations: expect.arrayContaining([{ table: "accruals", id: "a-1", label: "Accrual a-1 (PASS-77)" }]) }));
    if (output.kind === "file") {
      expect(output.content).toContain('"Synthetic Quarry","PASS-77","2026-08-11","155250"');
      expect(output.content).not.toContain("₹");
    }
  });

  test("serves only on loopback, exposes live overview, and performs no writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "k2-asking-")); const path = join(directory, "store.sqlite");
    const writable = new Database(path); migrateStore(writable); fixture(writable); writable.close();
    const server = startLedgerServer({ databasePath: path, port: 0, provider: new CannedProvider([{ kind: "review_queue", template: "plain" }]) });
    try {
      expect(server.url).toStartWith("http://127.0.0.1:");
      const overview = await (await fetch(`${server.url}api/overview`)).json() as Array<{ label: string; count: number }>;
      expect(overview).toContainEqual({ label: "Accruals", count: 2 });
      const answer = await (await fetch(`${server.url}api/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "what needs review?" }) })).json() as { citations: unknown[] };
      expect(answer.citations).toEqual([{ table: "review_items", id: "r-1", label: "Review r-1 (subject doc-1)" }]);
      const check = new Database(path, { readonly: true });
      expect((check.query("SELECT count(*) AS count FROM review_items").get() as { count: number }).count).toBe(1); check.close();
    } finally { server.stop(); await rm(directory, { recursive: true, force: true }); }
  });
});
