import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import type { StructuredProvider } from "../src/model/boundary.ts";
import { loadConfig } from "../src/config.ts";
import { ingestPdf, PopplerPdfRenderer, type PdfRenderer } from "../src/ingest/ingest.ts";

const realTenderPdf = resolve(import.meta.dir, "../demo/documents/notice-25-of-2025-26.pdf");
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1]);
const config = loadConfig({ DATABASE_PATH: ":memory:", MODEL_PROVIDER: "local", MODEL_MAX_CONCURRENCY: "2" });

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function syntheticClassifier(onRequest?: () => Promise<void>): StructuredProvider {
  return {
    async request() {
      await onRequest?.();
      return { data: { documentType: "government_tender", confidenceBasisPoints: 9_500, summary: "Visibly synthetic tender classification fixture.", labels: ["synthetic-fixture", "tender"] } };
    },
  };
}

async function concatenatedTenderFixture(): Promise<Readonly<{ pdf: string; directory: string }>> {
  const directory = await mkdtemp(join(tmpdir(), "k2-poppler-padding-"));
  const pdf = join(directory, "twelve-pages.pdf");
  const child = Bun.spawn({ cmd: ["qpdf", "--empty", "--pages", realTenderPdf, realTenderPdf, realTenderPdf, realTenderPdf, "--", pdf], stdout: "pipe", stderr: "pipe" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`qpdf fixture creation failed: ${(await new Response(child.stderr).text()).trim()}`);
  return Object.freeze({ pdf, directory });
}

describe("Stage 3 PDF ingestion", () => {
  test("PopplerPdfRenderer reads page 8 when Poppler pads a multi-page output suffix", async () => {
    const fixture = await concatenatedTenderFixture();
    try {
      const bytes = await new PopplerPdfRenderer().renderPage(fixture.pdf, 8);
      expect([...bytes.slice(0, 8)]).toEqual([...png.slice(0, 8)]);
      expect(bytes.length).toBeGreaterThan(8);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  test("ingests a tracked real multi-page government tender without altering its source bytes", async () => {
    const before = new Uint8Array(await readFile(realTenderPdf));
    const database = new Database(":memory:");
    const result = await ingestPdf(realTenderPdf, { database, provider: syntheticClassifier(), renderer: new PopplerPdfRenderer(), config });
    const after = new Uint8Array(await readFile(realTenderPdf));

    expect(result).toMatchObject({ duplicate: false, pageCount: 3, classifiedPages: 3, unreadablePages: 0 });
    expect(sha256(after)).toBe(sha256(before));
    expect(database.query<{ bytes: Uint8Array }, [string]>("SELECT bytes FROM ingest_assets WHERE sha256 = ?").get(result.documentHash)?.bytes).toEqual(before);
    expect(database.query<{ count: number }, [string]>("SELECT count(*) AS count FROM ingest_pages WHERE document_sha256 = ?").get(result.documentHash)?.count).toBe(3);
    expect(database.query<{ count: number }, [string]>("SELECT count(*) AS count FROM ingest_pages WHERE document_sha256 = ? AND document_type = 'government_tender'").get(result.documentHash)?.count).toBe(3);
    expect(database.query<{ count: number }, [string]>("SELECT count(*) AS count FROM ingest_assets WHERE asset_type = 'rendered_page'").get(result.documentHash)?.count).toBe(3);
  });

  test("content-addresses a real tender re-upload and creates no duplicate document, page, or asset", async () => {
    const database = new Database(":memory:");
    const options = { database, provider: syntheticClassifier(), renderer: new PopplerPdfRenderer(), config };
    const first = await ingestPdf(realTenderPdf, options);
    const documentCount = database.query<{ count: number }, []>("SELECT count(*) AS count FROM ingest_documents").get()!.count;
    const pageCount = database.query<{ count: number }, []>("SELECT count(*) AS count FROM ingest_pages").get()!.count;
    const assetCount = database.query<{ count: number }, []>("SELECT count(*) AS count FROM ingest_assets").get()!.count;
    const second = await ingestPdf(realTenderPdf, options);

    expect(first.duplicate).toBe(false);
    expect(second).toMatchObject({ duplicate: true, documentHash: first.documentHash, pageCount: 3 });
    expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM ingest_documents").get()!.count).toBe(documentCount);
    expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM ingest_pages").get()!.count).toBe(pageCount);
    expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM ingest_assets").get()!.count).toBe(assetCount);
  });

  test("bounds rendering and model calls by the configured concurrency limit", async () => {
    let rendering = 0;
    let maxRendering = 0;
    let classifying = 0;
    let maxClassifying = 0;
    const renderer: PdfRenderer = {
      async countPages() { return 3; },
      async renderPage() {
        rendering += 1;
        maxRendering = Math.max(maxRendering, rendering);
        await Bun.sleep(10);
        rendering -= 1;
        return png;
      },
    };
    const provider = syntheticClassifier(async () => {
      classifying += 1;
      maxClassifying = Math.max(maxClassifying, classifying);
      await Bun.sleep(10);
      classifying -= 1;
    });

    const result = await ingestPdf(realTenderPdf, { database: new Database(":memory:"), provider, renderer, config });

    expect(result.classifiedPages).toBe(3);
    expect(maxRendering).toBe(2);
    expect(maxClassifying).toBe(2);
  });

  test("records a damaged rendered page explicitly as unreadable without asking the model to guess", async () => {
    let calls = 0;
    const renderer: PdfRenderer = {
      async countPages() { return 2; },
      async renderPage(_path, pageNumber) { return pageNumber === 2 ? new Uint8Array([0, 1, 2]) : png; },
    };
    const provider = syntheticClassifier(async () => { calls += 1; });
    const database = new Database(":memory:");

    const result = await ingestPdf(realTenderPdf, { database, provider, renderer, config });

    expect(result).toMatchObject({ pageCount: 2, classifiedPages: 1, unreadablePages: 1 });
    expect(calls).toBe(1);
    expect(database.query<{ document_type: string; classification_status: string }, []>("SELECT document_type, classification_status FROM ingest_pages WHERE page_number = 2").get()).toEqual({ document_type: "unreadable", classification_status: "unreadable" });
  });
});
