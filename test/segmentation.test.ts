import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config.ts";
import { migrateIngestStore } from "../src/ingest/ingest.ts";
import type { StructuredProvider } from "../src/model/boundary.ts";
import { createSegmentationProvider, migrateSegmentationStore, segmentPdf, segmentationWindows } from "../src/segmentation/segment.ts";

const sourceSha256 = "a".repeat(64);
const syntheticRanges = [[1, 4], [5, 7], [8, 12], [13, 15], [16, 20], [21, 25], [26, 29], [30, 34], [35, 37], [38, 40], [41, 42]] as const;

function syntheticDatabase(): Database {
  const database = new Database(":memory:");
  migrateIngestStore(database);
  database.query("INSERT INTO ingest_assets (sha256, asset_type, media_type, bytes) VALUES (?, 'original_pdf', 'application/pdf', ?)").run(sourceSha256, new Uint8Array([1]));
  database.query("INSERT INTO ingest_documents (source_sha256, original_filename, page_count) VALUES (?, ?, 42)").run(sourceSha256, "visibly-invented-42-page-batch.pdf");
  for (let pageNumber = 1; pageNumber <= 42; pageNumber += 1) {
    const imageSha256 = `${pageNumber.toString(16).padStart(2, "0")}${"b".repeat(62)}`;
    database.query("INSERT INTO ingest_assets (sha256, asset_type, media_type, bytes) VALUES (?, 'rendered_page', 'image/png', ?)").run(imageSha256, new Uint8Array([pageNumber]));
    database.query("INSERT INTO ingest_pages (document_sha256, page_number, image_sha256, classification_status, document_type, confidence_basis_points, summary, labels_json) VALUES (?, ?, ?, 'classified', 'royalty_pass', 9000, ?, '[\"visibly-invented\"]')").run(sourceSha256, pageNumber, imageSha256, `Visibly invented synthetic page ${pageNumber}.`);
  }
  return database;
}

function starts(pageNumber: number): boolean {
  return syntheticRanges.some(([firstPage]) => firstPage === pageNumber);
}

function syntheticBoundaryProvider(calls: number[][], disagreement = false): StructuredProvider {
  return {
    async request(request) {
      const pages = (request.images ?? []).map((image) => Number(/^page-(\d+)/.exec(image.label)![1]));
      calls.push(pages);
      return { data: { judgements: pages.map((pageNumber) => ({
        pageNumber,
        startsDocument: disagreement && pageNumber === 8 ? pages[0] === 8 : starts(pageNumber),
        confidenceBasisPoints: pageNumber === 1 ? 8_000 : 9_000,
      })) } };
    },
  };
}

describe("Stage 4 Piece A transaction segmentation", () => {
  test("uses eight-page windows with exactly one shared page, including the necessary shorter final tail", () => {
    expect(segmentationWindows(42)).toEqual([
      { firstPage: 1, lastPage: 8 }, { firstPage: 8, lastPage: 15 }, { firstPage: 15, lastPage: 22 },
      { firstPage: 22, lastPage: 29 }, { firstPage: 29, lastPage: 36 }, { firstPage: 36, lastPage: 42 },
    ]);
  });

  test("segments the visibly invented 42-page, 11-transaction fixture with its constructed ranges", async () => {
    const calls: number[][] = [];
    const documents = await segmentPdf({ database: syntheticDatabase(), sourceSha256, provider: syntheticBoundaryProvider(calls) });

    expect(documents).toHaveLength(11);
    expect(documents.map((document) => [document.firstPage, document.lastPage])).toEqual(syntheticRanges.map((range) => [...range]));
    expect(calls).toEqual([[1, 2, 3, 4, 5, 6, 7, 8], [8, 9, 10, 11, 12, 13, 14, 15], [15, 16, 17, 18, 19, 20, 21, 22], [22, 23, 24, 25, 26, 27, 28, 29], [29, 30, 31, 32, 33, 34, 35, 36], [36, 37, 38, 39, 40, 41, 42]]);
  });

  test("uses the later overlapping window deterministically when page 8 disagrees", async () => {
    const documents = await segmentPdf({ database: syntheticDatabase(), sourceSha256, provider: syntheticBoundaryProvider([], true) });

    expect(documents.map((document) => [document.firstPage, document.lastPage])).toEqual(syntheticRanges.map((range) => [...range]));
    expect(documents.find((document) => document.firstPage === 8)?.boundaryConfidenceBasisPoints).toBe(9_000);
  });

  test("repeats deterministic document names and replaces the stored segmentation", async () => {
    const database = syntheticDatabase();
    const first = await segmentPdf({ database, sourceSha256, provider: syntheticBoundaryProvider([]) });
    const second = await segmentPdf({ database, sourceSha256, provider: syntheticBoundaryProvider([]) });

    expect(second.map((document) => document.name)).toEqual(first.map((document) => document.name));
    expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM segmented_documents").get()!.count).toBe(11);
  });

  test("selects BOUNDARY_MODEL and otherwise falls back to the configured standard model without a real model call", () => {
    const configured = (boundaryModel?: string): string | undefined => {
      let selected: string | undefined;
      createSegmentationProvider(loadConfig({ DATABASE_PATH: ":memory:", MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "synthetic-key", ANTHROPIC_MODEL: "standard-synthetic-model", ...(boundaryModel === undefined ? {} : { BOUNDARY_MODEL: boundaryModel }) }), {
        anthropic: ({ model }) => { selected = model; return { async request() { throw new Error("real model must never be called"); } }; },
        local: () => { throw new Error("local model must not be acquired"); },
      });
      return selected;
    };
    expect(configured("stronger-synthetic-boundary-model")).toBe("stronger-synthetic-boundary-model");
    expect(configured()).toBe("standard-synthetic-model");
  });

  test("keeps model failures loud rather than silently manufacturing a document", async () => {
    const database = syntheticDatabase();
    await expect(segmentPdf({ database, sourceSha256, provider: { async request() { throw new Error("synthetic boundary outage"); } } })).rejects.toThrow("synthetic boundary outage");
    migrateSegmentationStore(database);
    expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM segmented_documents").get()!.count).toBe(0);
  });
});
