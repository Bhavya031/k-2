import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { saveVendorTerms } from "../src/ledger/accruals.ts";
import { runBatchPipeline } from "../src/pipeline/batch.ts";
import { buildReport } from "../src/report/report.ts";
import type { PdfRenderer } from "../src/ingest/ingest.ts";
import type { StructuredProvider } from "../src/model/boundary.ts";
import { migrateStore } from "../src/store/schema.ts";

const databases: Database[] = [];
const directories: string[] = [];
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const REVIEWED = "2026-09-06T12:00:00.000Z";

afterEach(async () => {
  while (databases.length > 0) databases.pop()?.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class SyntheticRenderer implements PdfRenderer {
  async countPages(): Promise<number> { return 2; }
  async renderPage(_path: string, pageNumber: number): Promise<Uint8Array> { return new Uint8Array([...PNG, pageNumber]); }
}

function responses(...items: readonly unknown[]): StructuredProvider {
  let index = 0;
  return { async request() { return { data: items[index++] }; } };
}

function boundaries(): StructuredProvider {
  return { async request(request) {
    const pages = (request.images ?? []).map((image) => Number(/^page-(\d+)/.exec(image.label)![1]));
    return { data: { judgements: pages.map((pageNumber) => ({ pageNumber, startsDocument: true, confidenceBasisPoints: 9_000 })) } };
  } };
}

async function syntheticOptions(database: Database) {
  const directory = await mkdtemp(join(tmpdir(), "k2-pipeline-synthetic-"));
  directories.push(directory);
  const pdfPath = join(directory, "synthetic-batch.pdf");
  await writeFile(pdfPath, "synthetic batch, not a company document");
  migrateStore(database);
  database.run("INSERT OR IGNORE INTO vendors (id, name, status) VALUES ('synthetic-vendor', 'Synthetic Aggregate Ltd', 'active')");
  saveVendorTerms(database, {
    vendorId: "synthetic-vendor", ratePaisePerTonne: 12_500, effectiveOn: "2026-09-01", tdsSection: "194C",
    tdsRateBasisPoints: 200, retentionBasisPoints: 500, paymentDays: 21, beneficiaryName: "Synthetic Aggregate Ltd",
  });
  return {
    database, pdfPath, config: { modelMaxConcurrency: 1 }, renderer: new SyntheticRenderer(),
    classificationProvider: responses(
      { documentType: "delivery_challan", confidenceBasisPoints: 9_000, summary: "Synthetic delivery", labels: ["synthetic"] },
      { documentType: "invoice", confidenceBasisPoints: 9_000, summary: "Synthetic invoice", labels: ["synthetic"] },
    ),
    boundaryProvider: boundaries(),
    extractionProvider: responses(
      { challanNumber: "SYN-DEL-1", challanDate: "2026-09-01", vendor: "Synthetic Aggregate Ltd", quantity: "12,420 kg" },
      { invoiceNumber: "SYN-DEL-1", invoiceDate: "2026-09-07", vendor: "Synthetic Aggregate Ltd", amount: "₹ 1,552.50", supplierBankDetails: { accountNumber: "SYNTHETIC-ACCOUNT", ifscCode: "SYNB0000123", bankName: "Synthetic Bank" } },
    ),
    matchedOn: "2026-09-07", reviewedAt: REVIEWED, paymentRunId: "synthetic-run-1", paymentRunOn: "2026-09-07",
  } as const;
}

describe("Stage 9 post-stage batch composition", () => {
  test("takes an invented batch through the real production handoffs into one report-visible persisted store", async () => {
    const database = new Database(":memory:"); databases.push(database);
    const result = await runBatchPipeline(await syntheticOptions(database));

    expect(result.ingestion).toMatchObject({ duplicate: false, pageCount: 2, classifiedPages: 2 });
    expect(database.query("SELECT count(*) AS count FROM ingest_documents").get()).toEqual({ count: 1 });
    expect(database.query("SELECT count(*) AS count FROM ingest_pages").get()).toEqual({ count: 2 });
    expect(database.query("SELECT count(*) AS count FROM segmented_documents").get()).toEqual({ count: 2 });
    expect(database.query("SELECT id, ingest_source_sha256, ingest_first_page, ingest_last_page, document_status FROM source_documents ORDER BY ingest_first_page").all()).toEqual([
      { id: `source:${result.ingestion.documentHash}:1:1`, ingest_source_sha256: result.ingestion.documentHash, ingest_first_page: 1, ingest_last_page: 1, document_status: "classified" },
      { id: `source:${result.ingestion.documentHash}:2:2`, ingest_source_sha256: result.ingestion.documentHash, ingest_first_page: 2, ingest_last_page: 2, document_status: "classified" },
    ]);
    expect(database.query("SELECT count(*) AS count FROM document_pages").get()).toEqual({ count: 2 });
    expect(result.accruals).toEqual([{ kind: "accrued", accrualId: `accrual:source:${result.ingestion.documentHash}:1:1`, amountPaise: 155_250 }]);
    expect(database.query("SELECT amount_paise, status, source_document_id FROM accruals").get()).toEqual({ amount_paise: 155_250, status: "invoiced", source_document_id: `source:${result.ingestion.documentHash}:1:1` });
    expect(result.matches).toMatchObject([{ kind: "matched", status: "exact", variancePaise: 0 }]);
    expect(database.query("SELECT count(*) AS count FROM accrual_matches").get()).toEqual({ count: 1 });
    expect(result.paymentRun?.instructions).toMatchObject([{ vendorId: "synthetic-vendor", accountNumber: "SYNTHETIC-ACCOUNT", ifsc: "SYNB0000123", amountPaise: 147_488 }]);
    expect(database.query("SELECT gross_paise, tds_paise, retention_paise, net_paise, status FROM payment_run_lines").get()).toEqual({ gross_paise: 155_250, tds_paise: 0, retention_paise: 7_762, net_paise: 147_488, status: "draft" });
    expect(database.query(`SELECT s.id FROM source_documents s JOIN accruals a ON a.source_document_id = s.id
      JOIN accrual_matches m ON m.accrual_id = a.id JOIN payment_run_lines p ON p.accrual_id = a.id`).all()).toEqual([{ id: `source:${result.ingestion.documentHash}:1:1` }]);
    expect(database.query("SELECT beneficiary_account_number, beneficiary_ifsc, beneficiary_bank_name FROM vendor_terms WHERE vendor_id = 'synthetic-vendor'").get())
      .toEqual({ beneficiary_account_number: "SYNTHETIC-ACCOUNT", beneficiary_ifsc: "SYNB0000123", beneficiary_bank_name: "Synthetic Bank" });
    expect(buildReport(database)).toContain(`source:${result.ingestion.documentHash}:1:1`);
  });

  test("re-running an invented batch recognizes its content and does not duplicate source, ledger, match, or payment rows", async () => {
    const database = new Database(":memory:"); databases.push(database);
    await runBatchPipeline(await syntheticOptions(database));
    const rerun = await runBatchPipeline(await syntheticOptions(database));

    expect(rerun.ingestion.duplicate).toBe(true);
    expect(rerun.accruals.map((item) => item.kind)).toEqual(["already-accrued"]);
    expect(rerun.matches.map((item) => item.kind)).toEqual(["already_matched"]);
    expect(rerun.paymentRunAlreadyPrepared).toBe(true);
    for (const table of ["source_documents", "document_pages", "accruals", "accrual_matches", "payment_runs", "payment_run_lines"]) {
      expect(database.query(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: table === "source_documents" || table === "document_pages" ? 2 : 1 });
    }
  });
});
