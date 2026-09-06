import { Database } from "bun:sqlite";

import type { AppConfig } from "../config.ts";
import { createConfiguredProvider, askStructured, type ProviderFactories, type StructuredProvider, type StructuredSchema } from "../model/boundary.ts";

const WINDOW_SIZE = 8;
const WINDOW_OVERLAP = 1;
const WINDOW_STEP = WINDOW_SIZE - WINDOW_OVERLAP;

export type BoundaryJudgement = Readonly<{
  pageNumber: number;
  startsDocument: boolean;
  confidenceBasisPoints: number;
}>;

export type SegmentedDocument = Readonly<{
  sourceSha256: string;
  firstPage: number;
  lastPage: number;
  name: string;
  boundaryConfidenceBasisPoints: number;
}>;

export type SegmentPdfOptions = Readonly<{
  database: Database;
  sourceSha256: string;
  provider: StructuredProvider;
}>;

type IngestPage = Readonly<{
  pageNumber: number;
  image: Uint8Array;
  documentType: string;
  summary: string;
  labelsJson: string;
}>;

function assertSourceSha256(sourceSha256: string): void {
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) {
    throw new Error("sourceSha256 must be a lowercase SHA-256 digest");
  }
}

function boundarySchema(expectedPages: readonly number[]): StructuredSchema<readonly BoundaryJudgement[]> {
  return {
    name: "transaction_boundaries",
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["judgements"],
      properties: {
        judgements: {
          type: "array",
          minItems: expectedPages.length,
          maxItems: expectedPages.length,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["pageNumber", "startsDocument", "confidenceBasisPoints"],
            properties: {
              pageNumber: { type: "integer", minimum: 1 },
              startsDocument: { type: "boolean" },
              confidenceBasisPoints: { type: "integer", minimum: 0, maximum: 10_000 },
            },
          },
        },
      },
    },
    validate(value) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, errors: [{ path: "$", message: "must be an object" }] };
      const judgements = (value as Record<string, unknown>).judgements;
      if (!Array.isArray(judgements) || judgements.length !== expectedPages.length) return { ok: false, errors: [{ path: "judgements", message: "must include exactly one judgement for every labelled page" }] };
      const byPage = new Map<number, BoundaryJudgement>();
      for (const judgement of judgements) {
        if (typeof judgement !== "object" || judgement === null || Array.isArray(judgement)) return { ok: false, errors: [{ path: "judgements", message: "must contain objects" }] };
        const candidate = judgement as Record<string, unknown>;
        if (!Number.isSafeInteger(candidate.pageNumber) || !expectedPages.includes(candidate.pageNumber as number)) return { ok: false, errors: [{ path: "judgements.pageNumber", message: "must name a labelled page" }] };
        if (typeof candidate.startsDocument !== "boolean") return { ok: false, errors: [{ path: "judgements.startsDocument", message: "must be boolean" }] };
        if (!Number.isSafeInteger(candidate.confidenceBasisPoints) || (candidate.confidenceBasisPoints as number) < 0 || (candidate.confidenceBasisPoints as number) > 10_000) return { ok: false, errors: [{ path: "judgements.confidenceBasisPoints", message: "must be an integer between 0 and 10000" }] };
        if (byPage.has(candidate.pageNumber as number)) return { ok: false, errors: [{ path: "judgements.pageNumber", message: "must not repeat a page" }] };
        byPage.set(candidate.pageNumber as number, Object.freeze({ pageNumber: candidate.pageNumber as number, startsDocument: candidate.startsDocument, confidenceBasisPoints: candidate.confidenceBasisPoints as number }));
      }
      if (expectedPages.some((pageNumber) => !byPage.has(pageNumber))) return { ok: false, errors: [{ path: "judgements", message: "must cover every labelled page" }] };
      return { ok: true, value: Object.freeze(expectedPages.map((pageNumber) => byPage.get(pageNumber)!)) };
    },
  };
}

/** Produces 8-page windows with a one-page overlap; the final window is the necessary shorter tail. */
export function segmentationWindows(pageCount: number): readonly Readonly<{ firstPage: number; lastPage: number }>[] {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new Error("pageCount must be a positive safe integer");
  const windows: Array<Readonly<{ firstPage: number; lastPage: number }>> = [];
  for (let firstPage = 1; firstPage <= pageCount; firstPage += WINDOW_STEP) {
    windows.push(Object.freeze({ firstPage, lastPage: Math.min(firstPage + WINDOW_SIZE - 1, pageCount) }));
    if (firstPage + WINDOW_SIZE - 1 >= pageCount) break;
  }
  return Object.freeze(windows);
}

export function migrateSegmentationStore(database: Database): void {
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS segmented_documents (
      source_sha256 TEXT NOT NULL REFERENCES ingest_documents(source_sha256),
      first_page INTEGER NOT NULL CHECK (typeof(first_page) = 'integer' AND first_page > 0),
      last_page INTEGER NOT NULL CHECK (typeof(last_page) = 'integer' AND last_page >= first_page),
      deterministic_name TEXT NOT NULL,
      boundary_confidence_basis_points INTEGER NOT NULL CHECK (typeof(boundary_confidence_basis_points) = 'integer' AND boundary_confidence_basis_points >= 0 AND boundary_confidence_basis_points <= 10000),
      PRIMARY KEY (source_sha256, first_page),
      UNIQUE (source_sha256, deterministic_name)
    ) STRICT;
  `);
}

/** Uses BOUNDARY_MODEL when configured; otherwise it deliberately uses the standard configured model. */
export function createSegmentationProvider(config: AppConfig, factories?: ProviderFactories): StructuredProvider {
  return createConfiguredProvider(config, factories);
}

function deterministicName(sourceSha256: string, firstPage: number, lastPage: number): string {
  return `transaction-${sourceSha256.slice(0, 16)}-pages-${String(firstPage).padStart(3, "0")}-${String(lastPage).padStart(3, "0")}`;
}

function promptForWindow(window: Readonly<{ firstPage: number; lastPage: number }>): string {
  return [
    `Judge transaction boundaries for pages ${window.firstPage}-${window.lastPage}.`,
    "Return one judgement for every labelled page.",
    "A document is one transaction, not one physical sheet: a royalty pass plus its attached weighbridge slip is one document; a carbon copy stays with its pass; and a multi-page invoice is one document.",
    "Do not attempt to split a single physical page into multiple documents.",
  ].join(" ");
}

function storedPages(database: Database, sourceSha256: string): readonly IngestPage[] {
  const pages = database.query<IngestPage, [string]>(`
    SELECT p.page_number AS pageNumber, a.bytes AS image, p.document_type AS documentType, p.summary AS summary, p.labels_json AS labelsJson
    FROM ingest_pages p
    JOIN ingest_assets a ON a.sha256 = p.image_sha256
    WHERE p.document_sha256 = ?
    ORDER BY p.page_number
  `).all(sourceSha256);
  if (pages.length === 0) throw new Error("No Stage 3 per-page rows found for sourceSha256");
  if (pages.some((page, index) => page.pageNumber !== index + 1)) throw new Error("Stage 3 per-page rows must be contiguous from page 1");
  return Object.freeze(pages.map((page) => Object.freeze(page)));
}

/**
 * The later window wins for its one shared page. This deterministic rule gives
 * the overlapping window the contextual view of the following pages, and is
 * applied even when its boundary judgement disagrees with the earlier window.
 */
export async function segmentPdf(options: SegmentPdfOptions): Promise<readonly SegmentedDocument[]> {
  assertSourceSha256(options.sourceSha256);
  migrateSegmentationStore(options.database);
  const pages = storedPages(options.database, options.sourceSha256);
  const chosen = new Map<number, BoundaryJudgement>();

  for (const window of segmentationWindows(pages.length)) {
    const pageWindow = pages.slice(window.firstPage - 1, window.lastPage);
    const expectedPages = pageWindow.map((page) => page.pageNumber);
    const result = await askStructured(options.provider, {
      prompt: promptForWindow(window),
      images: pageWindow.map((page) => Object.freeze({ label: `page-${page.pageNumber} (${page.documentType}; ${page.summary}; ${page.labelsJson})`, mediaType: "image/png" as const, bytes: page.image })),
      schema: boundarySchema(expectedPages),
    });
    if (!result.ok) throw result.error;
    for (const judgement of result.value) chosen.set(judgement.pageNumber, judgement);
  }

  const starts = pages.map((page) => chosen.get(page.pageNumber)!);
  starts[0] = Object.freeze({ pageNumber: 1, startsDocument: true, confidenceBasisPoints: 10_000 });
  const documents: SegmentedDocument[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    if (!starts[index]!.startsDocument) continue;
    const firstPage = starts[index]!.pageNumber;
    const nextStart = starts.slice(index + 1).find((judgement) => judgement.startsDocument);
    const lastPage = nextStart === undefined ? pages.length : nextStart.pageNumber - 1;
    documents.push(Object.freeze({ sourceSha256: options.sourceSha256, firstPage, lastPage, name: deterministicName(options.sourceSha256, firstPage, lastPage), boundaryConfidenceBasisPoints: starts[index]!.confidenceBasisPoints }));
  }

  options.database.transaction(() => {
    options.database.query("DELETE FROM segmented_documents WHERE source_sha256 = ?").run(options.sourceSha256);
    for (const document of documents) {
      options.database.query("INSERT INTO segmented_documents (source_sha256, first_page, last_page, deterministic_name, boundary_confidence_basis_points) VALUES (?, ?, ?, ?, ?)").run(document.sourceSha256, document.firstPage, document.lastPage, document.name, document.boundaryConfidenceBasisPoints);
    }
  })();
  return Object.freeze(documents);
}
