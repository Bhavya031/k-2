import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { Database } from "bun:sqlite";

import type { AppConfig } from "../config.ts";
import { askStructured, type StructuredProvider, type StructuredSchema } from "../model/boundary.ts";

export const documentTypes = ["government_tender", "royalty_pass", "delivery_challan", "invoice", "other", "unreadable"] as const;
export type DocumentType = (typeof documentTypes)[number];

export type PageClassification = Readonly<{
  documentType: DocumentType;
  confidenceBasisPoints: number;
  summary: string;
  labels: readonly string[];
}>;

export interface PdfRenderer {
  countPages(pdfPath: string): Promise<number>;
  renderPage(pdfPath: string, pageNumber: number): Promise<Uint8Array>;
}

export type IngestOptions = Readonly<{
  database: Database;
  provider: StructuredProvider;
  renderer?: PdfRenderer;
  config: Pick<AppConfig, "modelMaxConcurrency">;
}>;

export type IngestResult = Readonly<{
  documentHash: string;
  duplicate: boolean;
  pageCount: number;
  classifiedPages: number;
  unreadablePages: number;
  skipped: readonly Readonly<{ pageNumber: number; reason: string }> [];
}>;

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
}

function classificationSchema(): StructuredSchema<PageClassification> {
  return {
    name: "page_classification",
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["documentType", "confidenceBasisPoints", "summary", "labels"],
      properties: {
        documentType: { enum: documentTypes },
        confidenceBasisPoints: { type: "integer", minimum: 0, maximum: 10_000 },
        summary: { type: "string", minLength: 1, maxLength: 500 },
        labels: { type: "array", items: { type: "string", minLength: 1, maxLength: 100 }, maxItems: 20 },
      },
    },
    validate(value) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, errors: [{ path: "$", message: "must be an object" }] };
      const candidate = value as Record<string, unknown>;
      const type = candidate.documentType;
      const confidence = candidate.confidenceBasisPoints;
      const summary = candidate.summary;
      const labels = candidate.labels;
      if (!documentTypes.includes(type as DocumentType)) return { ok: false, errors: [{ path: "documentType", message: "must be a known document type" }] };
      if (!Number.isSafeInteger(confidence) || (confidence as number) < 0 || (confidence as number) > 10_000) return { ok: false, errors: [{ path: "confidenceBasisPoints", message: "must be an integer between 0 and 10000" }] };
      if (typeof summary !== "string" || summary.trim().length === 0 || summary.length > 500) return { ok: false, errors: [{ path: "summary", message: "must be a short non-empty summary" }] };
      if (!Array.isArray(labels) || labels.length > 20 || labels.some((label) => typeof label !== "string" || label.trim().length === 0 || label.length > 100)) return { ok: false, errors: [{ path: "labels", message: "must be short non-empty strings" }] };
      return { ok: true, value: Object.freeze({ documentType: type as DocumentType, confidenceBasisPoints: confidence as number, summary, labels: Object.freeze(labels as string[]) }) };
    },
  };
}

async function runLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  assertPositiveSafeInteger(limit, "maxConcurrency");
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await work(items[index]!);
    }
  }));
}

export function migrateIngestStore(database: Database): void {
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS ingest_assets (
      sha256 TEXT PRIMARY KEY,
      asset_type TEXT NOT NULL CHECK (asset_type IN ('original_pdf', 'rendered_page')),
      media_type TEXT NOT NULL CHECK (media_type IN ('application/pdf', 'image/png')),
      bytes BLOB NOT NULL CHECK (typeof(bytes) = 'blob' AND length(bytes) > 0)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS ingest_documents (
      source_sha256 TEXT PRIMARY KEY REFERENCES ingest_assets(sha256),
      original_filename TEXT NOT NULL,
      page_count INTEGER NOT NULL CHECK (typeof(page_count) = 'integer' AND page_count > 0)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS ingest_pages (
      document_sha256 TEXT NOT NULL REFERENCES ingest_documents(source_sha256),
      page_number INTEGER NOT NULL CHECK (typeof(page_number) = 'integer' AND page_number > 0),
      image_sha256 TEXT NOT NULL REFERENCES ingest_assets(sha256),
      classification_status TEXT NOT NULL CHECK (classification_status IN ('classified', 'unreadable', 'needs_review')),
      document_type TEXT NOT NULL CHECK (document_type IN ('government_tender', 'royalty_pass', 'delivery_challan', 'invoice', 'other', 'unreadable')),
      confidence_basis_points INTEGER NOT NULL CHECK (typeof(confidence_basis_points) = 'integer' AND confidence_basis_points >= 0 AND confidence_basis_points <= 10000),
      summary TEXT NOT NULL,
      labels_json TEXT NOT NULL,
      PRIMARY KEY (document_sha256, page_number)
    ) STRICT;
  `);
}

async function commandText(command: readonly string[]): Promise<string> {
  const child = Bun.spawn({ cmd: [...command], stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`${command[0]} failed: ${stderr.trim()}`);
  return stdout;
}

export class PopplerPdfRenderer implements PdfRenderer {
  async countPages(pdfPath: string): Promise<number> {
    const output = await commandText(["pdfinfo", pdfPath]);
    const match = /^Pages:\s+(\d+)$/m.exec(output);
    if (match === null) throw new Error("pdfinfo did not report a page count");
    const pages = Number(match[1]);
    assertPositiveSafeInteger(pages, "PDF page count");
    return pages;
  }

  async renderPage(pdfPath: string, pageNumber: number): Promise<Uint8Array> {
    assertPositiveSafeInteger(pageNumber, "pageNumber");
    const directory = await mkdtemp(join(tmpdir(), "k2-render-"));
    const prefix = join(directory, "page");
    try {
      await commandText(["pdftoppm", "-png", "-r", "150", "-f", String(pageNumber), "-l", String(pageNumber), pdfPath, prefix]);
      return new Uint8Array(await readFile(`${prefix}-${pageNumber}.png`));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function unreadable(pageNumber: number, image: Uint8Array): Readonly<{ pageNumber: number; image: Uint8Array; classification: PageClassification }> {
  return Object.freeze({
    pageNumber,
    image,
    classification: Object.freeze({ documentType: "unreadable", confidenceBasisPoints: 10_000, summary: "Rendered page is unreadable.", labels: Object.freeze(["unreadable"]) }),
  });
}

/** Stores original PDF bytes and rendered page image bytes in distinct assets. */
export async function ingestPdf(pdfPath: string, options: IngestOptions): Promise<IngestResult> {
  const maxConcurrency = options.config.modelMaxConcurrency ?? 1;
  assertPositiveSafeInteger(maxConcurrency, "MODEL_MAX_CONCURRENCY");
  migrateIngestStore(options.database);
  const original = new Uint8Array(await readFile(pdfPath));
  const documentHash = sha256(original);
  const exists = options.database.query<{ source_sha256: string }, [string]>("SELECT source_sha256 FROM ingest_documents WHERE source_sha256 = ?").get(documentHash);
  if (exists !== null) return Object.freeze({ documentHash, duplicate: true, pageCount: options.database.query<{ page_count: number }, [string]>("SELECT page_count FROM ingest_documents WHERE source_sha256 = ?").get(documentHash)!.page_count, classifiedPages: 0, unreadablePages: 0, skipped: Object.freeze([]) });

  const renderer = options.renderer ?? new PopplerPdfRenderer();
  const pageCount = await renderer.countPages(pdfPath);
  const pageNumbers = Array.from({ length: pageCount }, (_, index) => index + 1);
  const pages: Array<Readonly<{ pageNumber: number; image: Uint8Array; classification: PageClassification }> | undefined> = new Array(pageCount);
  const skipped: Array<Readonly<{ pageNumber: number; reason: string }>> = [];
  const schema = classificationSchema();

  await runLimited(pageNumbers, maxConcurrency, async (pageNumber) => {
    const image = await renderer.renderPage(pdfPath, pageNumber);
    if (!isPng(image)) {
      pages[pageNumber - 1] = unreadable(pageNumber, image);
      return;
    }
    const model = await askStructured(options.provider, {
      prompt: "Classify this page image. Return unreadable only when the image cannot be read; do not guess.",
      images: [{ label: `page-${pageNumber}`, mediaType: "image/png", bytes: image }],
      schema,
    });
    if (!model.ok) {
      skipped.push(Object.freeze({ pageNumber, reason: "model classification failed; page stored for review" }));
      pages[pageNumber - 1] = Object.freeze({ pageNumber, image, classification: Object.freeze({ documentType: "other", confidenceBasisPoints: 0, summary: "Classification needs review.", labels: Object.freeze(["needs_review"]) }) });
      return;
    }
    pages[pageNumber - 1] = Object.freeze({ pageNumber, image, classification: model.value });
  });

  options.database.transaction(() => {
    options.database.query("INSERT INTO ingest_assets (sha256, asset_type, media_type, bytes) VALUES (?, 'original_pdf', 'application/pdf', ?)").run(documentHash, original);
    options.database.query("INSERT INTO ingest_documents (source_sha256, original_filename, page_count) VALUES (?, ?, ?)").run(documentHash, basename(pdfPath), pageCount);
    for (const page of pages) {
      if (page === undefined) throw new Error("Every PDF page must have a stored result");
      const imageHash = sha256(page.image);
      const needsReview = skipped.some((item) => item.pageNumber === page.pageNumber);
      options.database.query("INSERT OR IGNORE INTO ingest_assets (sha256, asset_type, media_type, bytes) VALUES (?, 'rendered_page', 'image/png', ?)").run(imageHash, page.image);
      options.database.query("INSERT INTO ingest_pages (document_sha256, page_number, image_sha256, classification_status, document_type, confidence_basis_points, summary, labels_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(documentHash, page.pageNumber, imageHash, page.classification.documentType === "unreadable" ? "unreadable" : needsReview ? "needs_review" : "classified", page.classification.documentType, page.classification.confidenceBasisPoints, page.classification.summary, JSON.stringify(page.classification.labels));
    }
  })();

  return Object.freeze({ documentHash, duplicate: false, pageCount, classifiedPages: pages.filter((page) => page?.classification.documentType !== "unreadable").length, unreadablePages: pages.filter((page) => page?.classification.documentType === "unreadable").length, skipped: Object.freeze(skipped) });
}
