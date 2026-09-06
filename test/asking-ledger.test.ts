import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { askLedger, executeLedgerPlan, ledgerPlanSchema } from "../src/asking/ledger.ts";
import { startLedgerServer } from "../src/asking/server.ts";
import type { StructuredProvider, StructuredRequest } from "../src/model/boundary.ts";
import { migrateStore } from "../src/store/schema.ts";
import { migrateIngestStore } from "../src/ingest/ingest.ts";
import { ReviewQueue } from "../src/review/queue.ts";

const databases: Database[] = [];
function store(): Database { const database = new Database(":memory:"); databases.push(database); migrateStore(database); return database; }
afterEach(() => { while (databases.length > 0) databases.pop()?.close(); });
function fixture(database: Database): void {
  database.run("INSERT INTO vendors (id,name,status) VALUES ('v','Synthetic Quarry','active')");
  database.run("INSERT INTO vendor_terms (vendor_id,rate_paise_per_tonne,effective_on,payment_days) VALUES ('v',12500,'2026-01-01',14)");
  for (const id of ["doc-1", "doc-2"]) database.run("INSERT INTO source_documents (id,vendor_id,document_status) VALUES (?,'v','classified')", [id]);
  database.run("INSERT INTO source_documents (id,document_status) VALUES ('doc-3','needs_review')");
  database.run("INSERT INTO accruals (id,source_document_id,vendor_id,paper_reference,amount_paise,quantity_thousandths,unit,incurred_on,status,extraction_confidence_basis_points) VALUES ('a-1','doc-1','v','PASS-77',155250,12420,'tonne','2026-08-11','incurred',9800)");
  database.run("INSERT INTO accruals (id,source_document_id,vendor_id,paper_reference,amount_paise,quantity_thousandths,unit,incurred_on,status,extraction_confidence_basis_points) VALUES ('a-2','doc-2','v','PASS-88',10000,1000,'tonne','2026-08-12','invoiced',9800)");
  migrateIngestStore(database);
  database.run("INSERT INTO ingest_assets (sha256,asset_type,media_type,bytes) VALUES ('source-a','original_pdf','application/pdf',?)", [new Uint8Array([3])]);
  database.run("INSERT INTO ingest_assets (sha256,asset_type,media_type,bytes) VALUES ('image-a','rendered_page','image/png',?)", [new Uint8Array([137,80,78,71])]);
  database.run("INSERT INTO ingest_assets (sha256,asset_type,media_type,bytes) VALUES ('image-b','rendered_page','image/png',?)", [new Uint8Array([137,80,78,72])]);
  database.run("INSERT INTO ingest_documents (source_sha256,original_filename,page_count) VALUES ('source-a','synthetic.pdf',2)");
  database.run("INSERT INTO ingest_pages (document_sha256,page_number,image_sha256,classification_status,document_type,confidence_basis_points,summary,labels_json) VALUES ('source-a',1,'image-a','classified','invoice',9800,'Synthetic.','[]')");
  database.run("INSERT INTO ingest_pages (document_sha256,page_number,image_sha256,classification_status,document_type,confidence_basis_points,summary,labels_json) VALUES ('source-a',2,'image-b','classified','delivery_challan',9700,'Synthetic.','[]')");
  database.run("UPDATE source_documents SET ingest_source_sha256='source-a',ingest_first_page=1,ingest_last_page=1 WHERE id='doc-1'");
  database.run("UPDATE source_documents SET ingest_source_sha256='source-a',ingest_first_page=2,ingest_last_page=2 WHERE id='doc-2'");
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

  test("serves only on loopback and exposes overview", async () => {
    const directory = await mkdtemp(join(tmpdir(), "k2-asking-")); const path = join(directory, "store.sqlite");
    const writable = new Database(path); migrateStore(writable); fixture(writable); writable.close();
    const server = startLedgerServer({ databasePath: path, port: 0, provider: new CannedProvider([{ kind: "review_queue", template: "plain" }]) });
    try {
      expect(server.url).toStartWith("http://127.0.0.1:");
      const overview = await (await fetch(`${server.url}api/overview`)).json() as Array<{ label: string; count: number }>;
      expect(overview).toContainEqual({ label: "Vendors", count: 1 });
      expect(overview).toContainEqual({ label: "Accruals", count: 2 });
      expect(overview).toContainEqual({ label: "Open review items", count: 1 });
      const answer = await (await fetch(`${server.url}api/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "what needs review?" }) })).json() as { citations: unknown[] };
      expect(answer.citations).toEqual([{ table: "review_items", id: "r-1", label: "Review r-1 (subject doc-1)" }]);
      const check = new Database(path, { readonly: true });
      expect((check.query("SELECT count(*) AS count FROM review_items").get() as { count: number }).count).toBe(1); check.close();
    } finally { server.stop(); await rm(directory, { recursive: true, force: true }); }
  });

  test("claims then approves through ReviewQueue, records audit, and cannot overwrite a human result", async () => {
    const database = store(); fixture(database); const queue = new ReviewQueue(database);
    const claimed = queue.claimNext("Asha", "2026-09-01T00:00:00.000Z");
    expect(claimed?.id).toBe("r-1");
    queue.decide("r-1", { outcome: "approve", decidedBy: "Asha", decidedAt: "2026-09-01T00:01:00.000Z" });
    expect(database.query("SELECT state,decided_by AS actor FROM review_items WHERE id='r-1'").get()).toEqual({ state: "decided", actor: "Asha" });
    expect(database.query("SELECT outcome,decided_by AS actor FROM review_decision_audit WHERE review_item_id='r-1'").get()).toEqual({ outcome: "approve", actor: "Asha" });
    expect(() => queue.decide("r-1", { outcome: "reject", decidedBy: "Asha", decidedAt: "2026-09-01T00:02:00.000Z" })).toThrow("review item must be claimed by the decision maker");
  });

  test("correct route records a typed human correction and serves only linked rendered page bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "k2-review-")); const path = join(directory, "store.sqlite"); const writable = new Database(path); migrateStore(writable); fixture(writable); writable.close();
    const server = startLedgerServer({ databasePath:path,port:0,provider:new CannedProvider([]) });
    try {
      const image = await fetch(`${server.url}api/documents/doc-1/pages/1`); expect(image.status).toBe(200); expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([137,80,78,71]);
      expect((await fetch(`${server.url}api/documents/nope/pages/1`)).status).toBe(404);
      expect((await fetch(`${server.url}api/documents/doc-1/pages/2`)).status).toBe(404);
      const claimed = await fetch(`${server.url}api/review/claim`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({actor:"Asha"})}); expect((await claimed.json()).item.id).toBe("r-1");
      const response = await fetch(`${server.url}api/review/r-1/decision`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({actor:"Asha",outcome:"correct",kind:"quantity_thousandths",value:"12421"})}); expect(response.status).toBe(200);
      const check = new Database(path,{readonly:true}); expect(check.query("SELECT value_kind,value_integer,provenance FROM review_values WHERE review_item_id='r-1'").get()).toEqual({value_kind:"quantity_thousandths",value_integer:12421,provenance:"human"}); check.close();
    } finally { server.stop(); await rm(directory,{recursive:true,force:true}); }
  });

  test("lists document accruals and unresolved documents, then returns document pages and open reviews", async () => {
    const directory = await mkdtemp(join(tmpdir(), "k2-documents-")); const path = join(directory, "store.sqlite"); const writable = new Database(path); migrateStore(writable); fixture(writable); writable.close();
    const server = startLedgerServer({ databasePath:path,port:0,provider:new CannedProvider([]) });
    try {
      const documents = await (await fetch(`${server.url}api/documents`)).json() as Array<{ id: string; vendorName: string | null; documentType: string | null; pageCount: number; documentStatus: string; accrual: { paperReference: string; amountPaise: number; quantityThousandths: number; unit: string; incurredOn: string } | null; openReviewCount: number }>;
      expect(documents).toContainEqual({ id:"doc-1",vendorName:"Synthetic Quarry",documentType:"invoice",pageCount:1,documentStatus:"classified",accrual:{paperReference:"PASS-77",amountPaise:155250,quantityThousandths:12420,unit:"tonne",incurredOn:"2026-08-11"},openReviewCount:1 });
      expect(documents).toContainEqual({ id:"doc-3",vendorName:null,documentType:null,pageCount:0,documentStatus:"needs_review",accrual:null,openReviewCount:0 });
      const detail = await (await fetch(`${server.url}api/documents/doc-1`)).json() as { document: { id: string; accrual: { amountPaise: number } | null }; pages: Array<{ pageNumber: number; documentType: string; confidenceBasisPoints: number }>; reviews: Array<{ id: string; prompt: string; evidence: string }> };
      expect(detail).toEqual({ document:expect.objectContaining({id:"doc-1",accrual:expect.objectContaining({amountPaise:155250})}),pages:[{pageNumber:1,documentType:"invoice",confidenceBasisPoints:9800}],reviews:[{id:"r-1",prompt:"Check synthetic source.",evidence:"Synthetic evidence."}] });
      expect((await fetch(`${server.url}api/documents/nope`)).status).toBe(404);
    } finally { server.stop(); await rm(directory, { recursive:true, force:true }); }
  });

  test("returns a zero-row planned file request as an explicit no-match screen answer without a file offer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "k2-zero-file-")); const path = join(directory, "store.sqlite"); const writable = new Database(path); migrateStore(writable); writable.close();
    const server = startLedgerServer({ databasePath:path, port:0, provider:new CannedProvider([{ kind:"unbilled_file" }]) });
    try {
      const response = await fetch(`${server.url}api/ask`, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({question:"Give me the unbilled list as a file"}) });
      const answer = await response.json() as { kind:string; heading:string; fragments:string[]; citations:unknown[]; filename?:string };
      expect(answer).toEqual({ kind:"screen", heading:"No matching records", fragments:["No records matched the applied filter.", "Applied filter: Unbilled accruals."], citations:[] });
      expect(answer.filename).toBeUndefined();
    } finally { server.stop(); await rm(directory,{recursive:true,force:true}); }
  });

  test("does not render an image element for an unresolvable review source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "k2-review-empty-page-")); const path = join(directory, "store.sqlite"); const writable = new Database(path); migrateStore(writable); fixture(writable); writable.run("INSERT INTO review_items (id,subject_id,decision_prompt,evidence,priority,created_at,state) VALUES ('r-2','doc-3','No page','Synthetic evidence.',80,'2026-08-12T00:00:00Z','pending')"); writable.close();
    const server = startLedgerServer({ databasePath:path,port:0,provider:new CannedProvider([]) });
    try {
      const html = await (await fetch(server.url)).text();
      expect(() => new Function(html.split("<script>",2)[1]!.split("</script>",1)[0]!)).not.toThrow();
      expect(html).toContain('const source=documents.find(candidate=>candidate.id===doc);if(source&&source.pageCount>0){const i=image(doc,1,title,true);d.append(i);i.onclick=()=>openDocument(doc)}else d.append(node("p","No linked stored page.","muted"))');
      expect(html).not.toContain('if(doc){const i=image(doc,1,title,true)');
    } finally { server.stop(); await rm(directory,{recursive:true,force:true}); }
  });

  test("reports no vendor match with existing stored vendor names without transliteration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "k2-vendor-no-match-")); const path = join(directory, "store.sqlite"); const writable = new Database(path); migrateStore(writable); fixture(writable); writable.close();
    const server = startLedgerServer({ databasePath:path,port:0,provider:new CannedProvider([{ kind:"quarry_last_month", vendorName:"Sinthhetic Kvari", month:"2026-08", template:"brief" }]) });
    try {
      const answer = await (await fetch(`${server.url}api/ask`, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({question:"What did Sinthhetic Kvari supply?"}) })).json() as { kind:string; heading:string; fragments:string[]; citations:unknown[] };
      expect(answer).toEqual({ kind:"screen", heading:"No matching records", fragments:["No vendor matched “Sinthhetic Kvari”.", "Existing vendor names: Synthetic Quarry. Applied filter: Vendor: Sinthhetic Kvari; month: 2026-08."], citations:[] });
    } finally { server.stop(); await rm(directory,{recursive:true,force:true}); }
  });

  test("rejects an unsafe integer query result before it can be rendered", () => {
    const database = store(); fixture(database); database.run("UPDATE accruals SET amount_paise=9007199254740992 WHERE id='a-1'");
    expect(() => executeLedgerPlan(database,{kind:"pass_reference",reference:"PASS-77",template:"brief"})).toThrow("amount must be a safe integer");
  });

});
