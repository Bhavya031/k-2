import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { migrateIngestStore } from "../src/ingest/ingest.ts";
import { buildReport, inr, searchExactFirst, type SearchEntry } from "../src/report/report.ts";
import { migrateStore } from "../src/store/schema.ts";

const databases: Database[] = [];
function store(): Database { const database = new Database(":memory:"); databases.push(database); migrateStore(database); return database; }
afterEach(() => { while (databases.length > 0) databases.pop()?.close(); });

function reportFixture(database: Database): void {
  database.run("INSERT INTO vendors (id, name, status) VALUES ('vendor-a', 'Synthetic Ganesh Quarry', 'active')");
  for (const id of ["delivery-old", "delivery-matched", "invoice-variance"]) database.run("INSERT INTO source_documents (id, vendor_id, document_status) VALUES (?, 'vendor-a', 'classified')", [id]);
  migrateIngestStore(database);
  database.run("INSERT INTO ingest_assets (sha256, asset_type, media_type, bytes) VALUES ('synthetic-stage3-document', 'original_pdf', 'application/pdf', ?)", [new Uint8Array([1])]);
  database.run("INSERT INTO ingest_assets (sha256, asset_type, media_type, bytes) VALUES ('synthetic-stage3-page-1', 'rendered_page', 'image/png', ?)", [new Uint8Array([2])]);
  database.run("INSERT INTO ingest_assets (sha256, asset_type, media_type, bytes) VALUES ('synthetic-stage3-page-2', 'rendered_page', 'image/png', ?)", [new Uint8Array([3])]);
  database.run("INSERT INTO ingest_documents (source_sha256, original_filename, page_count) VALUES ('synthetic-stage3-document', 'synthetic.pdf', 2)");
  database.run("INSERT INTO ingest_pages (document_sha256, page_number, image_sha256, classification_status, document_type, confidence_basis_points, summary, labels_json) VALUES ('synthetic-stage3-document', 1, 'synthetic-stage3-page-1', 'classified', 'royalty_pass', 9800, 'Synthetic page one.', '[]')");
  database.run("INSERT INTO ingest_pages (document_sha256, page_number, image_sha256, classification_status, document_type, confidence_basis_points, summary, labels_json) VALUES ('synthetic-stage3-document', 2, 'synthetic-stage3-page-2', 'classified', 'royalty_pass', 9400, 'Synthetic page two.', '[]')");
  database.run(`INSERT INTO accruals (id, source_document_id, vendor_id, paper_reference, amount_paise, quantity_thousandths, unit, incurred_on, status, extraction_confidence_basis_points)
    VALUES ('unbilled-old', 'delivery-old', 'vendor-a', 'PASS-77', 155250, 12420, 'tonne', '2026-09-01', 'incurred', 9800)`);
  database.run(`INSERT INTO accruals (id, source_document_id, vendor_id, paper_reference, amount_paise, quantity_thousandths, unit, incurred_on, status, extraction_confidence_basis_points)
    VALUES ('already-matched', 'delivery-matched', 'vendor-a', 'MATCHED-88', 10000, 1000, 'tonne', '2026-09-02', 'invoiced', 9800)`);
  database.run("INSERT INTO accrual_matches (id, accrual_id, invoice_source_document_id, score_basis_points, variance_paise, variance_cause, status, matched_on) VALUES ('matched-row', 'already-matched', 'invoice-variance', 10000, 0, NULL, 'exact', '2026-09-03')");
  database.run("INSERT INTO review_items (id, subject_id, decision_prompt, evidence, priority, created_at, state) VALUES ('review-1', 'delivery-old', 'Confirm synthetic evidence.', 'Synthetic paper evidence.', 80, '2026-09-02T00:00:00.000Z', 'pending')");
  database.run("INSERT INTO payment_runs (id, run_on, reference, status) VALUES ('run-1', '2026-09-04', 'simulated-ref', 'draft')");
  database.run("INSERT INTO payment_run_lines (id, payment_run_id, accrual_id, gross_paise, tds_paise, retention_paise, net_paise, status) VALUES ('line-1', 'run-1', 'already-matched', 10000, 200, 500, 9300, 'draft')");
  database.run("UPDATE accruals SET status = 'invoiced' WHERE id = 'already-matched'");
  database.run("UPDATE accrual_matches SET status = 'variance', variance_paise = -1000, variance_cause = 'quantity_variance' WHERE id = 'matched-row'");
  database.run("INSERT INTO review_items (id, subject_id, decision_prompt, evidence, priority, created_at, state) VALUES ('invoice-variance:invoice-variance', 'invoice-variance', 'Decide the synthetic variance.', 'Synthetic matched documents differ.', 99, '2026-09-03T00:00:00.000Z', 'pending')");
}

describe("Stage 8 offline report", () => {
  test("renders each section in required order with explicit empty states from an empty persisted store", () => {
    const report = buildReport(store());
    expect(report).toContain("No unbilled accruals.");
    expect(report).toContain("No pending review items or variance matches.");
    expect(report).toContain("No payment runs.");
    expect(report).toContain("No source documents.");
    expect(report.indexOf("1. Unbilled")).toBeLessThan(report.indexOf("2. Exceptions"));
    expect(report.indexOf("2. Exceptions")).toBeLessThan(report.indexOf("3. Payments"));
    expect(report.indexOf("3. Payments")).toBeLessThan(report.indexOf("4. Documents"));
  });

  test("renders one unbilled, variance, and payment line in their sections using exact paise displays", () => {
    const database = store(); reportFixture(database);
    const report = buildReport(database);
    const payload = /const data=(.*?);const inr=/.exec(report)?.[1];
    const data = JSON.parse(payload!) as { unbilled: Array<{ vendor: string; paperReference: string; incurredOn: string; quantityThousandths: number; unit: string; amountPaise: number }>; variances: Array<{ variancePaise: number; cause: string }>; paymentRuns: Array<{ lines: Array<{ grossPaise: number; tdsPaise: number; retentionPaise: number; netPaise: number }> }> };
    expect(data.unbilled).toEqual([{ vendor: "Synthetic Ganesh Quarry", paperReference: "PASS-77", incurredOn: "2026-09-01", quantityThousandths: 12420, unit: "tonne", amountPaise: 155250 }]);
    expect(data.variances).toEqual([expect.objectContaining({ variancePaise: -1000, cause: "quantity_variance" })]);
    expect(data.paymentRuns[0]?.lines).toEqual([expect.objectContaining({ grossPaise: 10000, tdsPaise: 200, retentionPaise: 500, netPaise: 9300 })]);
    expect(report).toContain("quantity read differently");
    expect(report).toContain("Execution is simulated; no bank connection.");
    expect(report.indexOf("1. Unbilled")).toBeLessThan(report.indexOf("2. Exceptions"));
    expect(report.indexOf("2. Exceptions")).toBeLessThan(report.indexOf("3. Payments"));
  });

  test("uses exact-first search when a pass reference also has a prefix match", () => {
    const exact: SearchEntry = { value: "PASS-77", label: "Paper reference: PASS-77", section: "Unbilled" };
    const suffix: SearchEntry = { value: "PASS-77-SUFFIX", label: "Paper reference: PASS-77-SUFFIX", section: "Unbilled" };
    const index: SearchEntry[] = [exact, suffix, { value: "Synthetic Ganesh Quarry", label: "Vendor: Synthetic Ganesh Quarry", section: "Unbilled" }];
    expect(searchExactFirst(index, "PASS-77")).toEqual([exact]);
    expect(searchExactFirst(index, "Synthetic Ganesh Quarry")).toEqual([index[2]!]);
    expect(searchExactFirst(index, "pass")).toEqual([exact, suffix]);
  });

  test("resolves documents from Stage 3 ingest persistence, including type, page count, and confidence", () => {
    const database = store(); reportFixture(database);
    const report = buildReport(database);
    const payload = /const data=(.*?);const inr=/.exec(report)?.[1];
    const documents = (JSON.parse(payload!) as { documents: unknown[] }).documents;
    expect(documents).toContainEqual({ id: "synthetic-stage3-document", vendor: "Unassigned vendor", type: "royalty_pass", pageCount: 2, confidenceBasisPoints: 9400 });
  });

  test("one report command reads a persisted store and writes a self-contained file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "k2-report-"));
    const storePath = join(directory, "store.sqlite"); const outputPath = join(directory, "report.html");
    const database = new Database(storePath); migrateStore(database); database.close();
    try {
      const result = Bun.spawnSync({ cmd: [process.execPath, "run", "report", storePath, outputPath], cwd: resolve(import.meta.dir, "..") });
      expect(result.exitCode).toBe(0);
      const output = await Bun.file(outputPath).text();
      expect(output).toContain("K-2 ledger report");
      expect(output.toLowerCase()).not.toContain("http");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("contains no external reference and is byte-identical for the same store", () => {
    const database = store(); reportFixture(database);
    const first = buildReport(database); const second = buildReport(database);
    expect(first).toBe(second);
    expect(first.toLowerCase()).not.toContain("http");
    expect(first).not.toContain("//");
    expect(first).not.toMatch(/<(?:script|link|img|iframe|source)\b[^>]*(?:src|href)\s*=/i);
  });

  test("formats signed integer paise without float arithmetic", () => {
    expect(inr(-1000)).toBe("-₹10.00");
    expect(inr(155250)).toBe("₹1,552.50");
  });
});
