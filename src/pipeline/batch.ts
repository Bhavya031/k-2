import { Database } from "bun:sqlite";

import type { AppConfig } from "../config.ts";
import { extractPageFields, rollExtractedPages, type ExtractionDocumentType, type RolledDocument } from "../extract/extract.ts";
import { ingestPdf, type IngestResult, type PdfRenderer } from "../ingest/ingest.ts";
import { AccrualLedger, saveExtractedSupplierBankDetails } from "../ledger/accruals.ts";
import { ThreeWayMatcher, type MatchResult, type SupplierInvoiceForMatch } from "../matching/match.ts";
import type { StructuredProvider } from "../model/boundary.ts";
import { PaymentRuns, type PaymentRunResult } from "../payments/runs.ts";
import { ReviewQueue } from "../review/queue.ts";
import { segmentPdf, type SegmentedDocument } from "../segmentation/segment.ts";
import { migrateStore } from "../store/schema.ts";

type StoredPage = Readonly<{ pageNumber: number; image: Uint8Array; documentType: string; confidenceBasisPoints: number }>;
type Vendor = Readonly<{ id: string }>;
type FieldValue = string | number | Readonly<{ accountNumber?: string; ifscCode?: string; bankName?: string }>;

export type BatchPipelineOptions = Readonly<{
  database: Database;
  pdfPath: string;
  config: Pick<AppConfig, "modelMaxConcurrency">;
  classificationProvider: StructuredProvider;
  boundaryProvider: StructuredProvider;
  extractionProvider: StructuredProvider;
  renderer?: PdfRenderer;
  matchedOn: string;
  reviewedAt: string;
  paymentRunId: string;
  paymentRunOn: string;
}>;

export type PipelineDocumentResult = Readonly<{
  sourceDocumentId: string;
  sourceSha256: string;
  firstPage: number;
  lastPage: number;
  kind: "extracted" | "needs_review";
  reason?: "unsupported_page_type" | "extraction_failed" | "incomplete_invoice";
}>;

export type BatchPipelineResult = Readonly<{
  ingestion: IngestResult;
  sourceDocuments: readonly PipelineDocumentResult[];
  accruals: readonly ReturnType<AccrualLedger["accrue"]>[];
  matches: readonly MatchResult[];
  paymentRun?: PaymentRunResult;
  paymentRunAlreadyPrepared: boolean;
}>;

const EXTRACTION_TYPES: Readonly<Record<string, ExtractionDocumentType | undefined>> = Object.freeze({
  royalty_pass: "royalty_pass",
  delivery_challan: "delivery_challan",
  invoice: "supplier_invoice",
  government_tender: "tender_notice",
});

function sourceDocumentId(segment: SegmentedDocument): string {
  return `source:${segment.sourceSha256}:${segment.firstPage}:${segment.lastPage}`;
}

function dateOnly(value: string | undefined): string | undefined {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) return undefined;
  return value;
}

function pagesForSegment(database: Database, segment: SegmentedDocument): readonly StoredPage[] {
  return Object.freeze(database.query<StoredPage, [string, number, number]>(`
    SELECT p.page_number AS pageNumber, a.bytes AS image, p.document_type AS documentType,
      p.confidence_basis_points AS confidenceBasisPoints
    FROM ingest_pages p JOIN ingest_assets a ON a.sha256 = p.image_sha256
    WHERE p.document_sha256 = ? AND p.page_number BETWEEN ? AND ? ORDER BY p.page_number
  `).all(segment.sourceSha256, segment.firstPage, segment.lastPage));
}

/**
 * This is the only creation point for ledger/report source_documents from a
 * Stage 3 upload.  The original content SHA-256 plus the inclusive segmented
 * range is persisted and uniquely indexed, so every ledger sourceDocumentId
 * reliably joins to the immutable ingestion record.
 */
function persistSourceDocument(database: Database, segment: SegmentedDocument): string {
  const id = sourceDocumentId(segment);
  database.transaction(() => {
    database.run(`INSERT OR IGNORE INTO source_documents
      (id, ingest_source_sha256, ingest_first_page, ingest_last_page, document_status)
      VALUES (?, ?, ?, ?, 'classified')`, [id, segment.sourceSha256, segment.firstPage, segment.lastPage]);
    for (let pageNumber = segment.firstPage; pageNumber <= segment.lastPage; pageNumber += 1) {
      database.run("INSERT OR IGNORE INTO document_pages (id, document_id, page_number) VALUES (?, ?, ?)",
        [`${id}:page:${pageNumber}`, id, pageNumber]);
    }
  })();
  return id;
}

function markNeedsReview(database: Database, id: string): void {
  database.run("UPDATE source_documents SET document_status = 'needs_review' WHERE id = ?", [id]);
}

function exactVendorId(database: Database, name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  return (database.query<Vendor, [string]>("SELECT id FROM vendors WHERE name = ? AND status = 'active'").get(name)?.id);
}

function field<Type extends ExtractionDocumentType>(document: RolledDocument<Type>, name: string): FieldValue | undefined {
  const rolled = (document.fields as Record<string, Readonly<{ values: readonly Readonly<{ value: FieldValue }>[]; disagreement?: true }>>)[name];
  return rolled === undefined || rolled.disagreement === true ? undefined : rolled.values[0]?.value;
}

async function extractSegment(options: BatchPipelineOptions, id: string, segment: SegmentedDocument, pages: readonly StoredPage[], type: ExtractionDocumentType): Promise<RolledDocument<ExtractionDocumentType> | undefined> {
  const extracted = [];
  for (const page of pages) {
    const response = await extractPageFields(options.extractionProvider, {
      document: id, documentType: type, page: page.pageNumber, confidenceBasisPoints: page.confidenceBasisPoints,
      recordedAt: options.reviewedAt, image: { label: `page-${page.pageNumber}`, mediaType: "image/png", bytes: page.image },
    });
    if (!response.ok) return undefined;
    extracted.push(response.value);
  }
  return rollExtractedPages(extracted) as RolledDocument<ExtractionDocumentType>;
}

function accrueDelivery(ledger: AccrualLedger, database: Database, id: string, extracted: RolledDocument<ExtractionDocumentType>, reviewedAt: string): ReturnType<AccrualLedger["accrue"]> | undefined {
  const royalty = extracted.documentType === "royalty_pass";
  if (!royalty && extracted.documentType !== "delivery_challan") return undefined;
  const vendorName = field(extracted, royalty ? "quarryOrVendor" : "vendor");
  const vendorId = typeof vendorName === "string" ? exactVendorId(database, vendorName) : undefined;
  if (vendorId !== undefined) database.run("UPDATE source_documents SET vendor_id = ? WHERE id = ?", [vendorId, id]);
  const reference = field(extracted, royalty ? "passNumber" : "challanNumber");
  const incurredOn = field(extracted, royalty ? "passDate" : "challanDate");
  const quantity = field(extracted, royalty ? "netWeight" : "quantity");
  const printedAmount = royalty ? field(extracted, "amount") : undefined;
  return ledger.accrue({ id: `accrual:${id}`, sourceDocumentId: id, vendorId,
    paperReference: typeof reference === "string" ? reference : undefined,
    incurredOn: dateOnly(typeof incurredOn === "string" ? incurredOn : undefined),
    quantityThousandths: typeof quantity === "number" ? quantity : undefined,
    printedAmountPaise: typeof printedAmount === "number" ? printedAmount : undefined,
    extractionConfidenceBasisPoints: 10_000, reviewedAt });
}

function supplierInvoice(database: Database, id: string, extracted: RolledDocument<ExtractionDocumentType>): SupplierInvoiceForMatch | undefined {
  if (extracted.documentType !== "supplier_invoice") return undefined;
  const vendorName = field(extracted, "vendor");
  const invoiceDate = field(extracted, "invoiceDate");
  const amount = field(extracted, "amount");
  if (typeof vendorName !== "string" || typeof invoiceDate !== "string" || typeof amount !== "number" || dateOnly(invoiceDate) === undefined) return undefined;
  const vendorId = exactVendorId(database, vendorName);
  if (vendorId !== undefined) {
    database.run("UPDATE source_documents SET vendor_id = ? WHERE id = ?", [vendorId, id]);
    const bank = field(extracted, "supplierBankDetails");
    if (typeof bank === "object" && bank !== null) saveExtractedSupplierBankDetails(database, vendorId, bank);
  }
  const reference = field(extracted, "invoiceNumber");
  return { id: `invoice:${id}`, sourceDocumentId: id, documentType: "supplier_invoice", vendorId, vendorName,
    invoiceReference: typeof reference === "string" ? reference : undefined, invoiceDate, amountPaise: amount };
}

/**
 * Runs one persisted, deterministic batch: production ingest/classify,
 * segmentation, extraction/rollup, ledger accrual, match, then a simulated
 * payment-run draft. It never executes a payment or calls a bank.
 */
export async function runBatchPipeline(options: BatchPipelineOptions): Promise<BatchPipelineResult> {
  migrateStore(options.database);
  const ingestion = await ingestPdf(options.pdfPath, { database: options.database, provider: options.classificationProvider, renderer: options.renderer, config: options.config });
  const segments = await segmentPdf({ database: options.database, sourceSha256: ingestion.documentHash, provider: options.boundaryProvider });
  const queue = new ReviewQueue(options.database);
  const ledger = new AccrualLedger(options.database, queue);
  const documents: PipelineDocumentResult[] = [];
  const accruals: Array<ReturnType<AccrualLedger["accrue"]>> = [];
  const invoices: SupplierInvoiceForMatch[] = [];

  for (const segment of segments) {
    const id = persistSourceDocument(options.database, segment);
    const pages = pagesForSegment(options.database, segment);
    const type = EXTRACTION_TYPES[pages[0]?.documentType ?? ""];
    if (type === undefined) {
      markNeedsReview(options.database, id);
      documents.push({ sourceDocumentId: id, sourceSha256: segment.sourceSha256, firstPage: segment.firstPage, lastPage: segment.lastPage, kind: "needs_review", reason: "unsupported_page_type" });
      continue;
    }
    const extracted = await extractSegment(options, id, segment, pages, type);
    if (extracted === undefined) {
      markNeedsReview(options.database, id);
      documents.push({ sourceDocumentId: id, sourceSha256: segment.sourceSha256, firstPage: segment.firstPage, lastPage: segment.lastPage, kind: "needs_review", reason: "extraction_failed" });
      continue;
    }
    const accrual = accrueDelivery(ledger, options.database, id, extracted, options.reviewedAt);
    if (accrual !== undefined) accruals.push(accrual);
    const invoice = supplierInvoice(options.database, id, extracted);
    if (extracted.documentType === "supplier_invoice" && invoice === undefined) {
      markNeedsReview(options.database, id);
      documents.push({ sourceDocumentId: id, sourceSha256: segment.sourceSha256, firstPage: segment.firstPage, lastPage: segment.lastPage, kind: "needs_review", reason: "incomplete_invoice" });
      continue;
    }
    if (invoice !== undefined) invoices.push(invoice);
    documents.push({ sourceDocumentId: id, sourceSha256: segment.sourceSha256, firstPage: segment.firstPage, lastPage: segment.lastPage, kind: "extracted" });
  }

  const matches = new ThreeWayMatcher(options.database, queue).run({ invoices, matchedOn: options.matchedOn, reviewedAt: options.reviewedAt });
  const paymentRunExists = options.database.query("SELECT id FROM payment_runs WHERE id = ?").get(options.paymentRunId) !== null;
  const paymentRun = paymentRunExists ? undefined : new PaymentRuns(options.database, queue).create({ id: options.paymentRunId, runOn: options.paymentRunOn, reviewedAt: options.reviewedAt });
  return Object.freeze({ ingestion, sourceDocuments: Object.freeze(documents), accruals: Object.freeze(accruals), matches: Object.freeze(matches), ...(paymentRun === undefined ? {} : { paymentRun }), paymentRunAlreadyPrepared: paymentRunExists });
}
