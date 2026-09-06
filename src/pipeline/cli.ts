import { Database } from "bun:sqlite";

import { loadConfig, type AppConfig } from "../config.ts";
import { createConfiguredProvider, type StructuredProvider } from "../model/boundary.ts";
import { createSegmentationProvider } from "../segmentation/segment.ts";
import type { PdfRenderer } from "../ingest/ingest.ts";
import { runBatchPipeline, type BatchPipelineResult } from "./batch.ts";

export type BatchCommandDependencies = Readonly<{
  loadConfig?: () => AppConfig;
  openDatabase?: (path: string) => Database;
  createProvider?: (config: AppConfig) => StructuredProvider;
  createBoundaryProvider?: (config: AppConfig) => StructuredProvider;
  write?: (contents: string) => void;
  renderer?: PdfRenderer;
  closeDatabase?: (database: Database) => void;
}>;

function requiredOption(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing required option ${name}`);
  return value;
}

/**
 * The production batch-command entrypoint.  It delegates every pipeline step
 * to the merged stage modules through runBatchPipeline; it contains no ingest,
 * extraction, accounting, matching, or payment logic of its own.
 */
export async function runBatchCommand(args: readonly string[], dependencies: BatchCommandDependencies = {}): Promise<BatchPipelineResult> {
  const config = (dependencies.loadConfig ?? loadConfig)();
  const database = (dependencies.openDatabase ?? ((path: string) => new Database(path)))(config.databasePath);
  try {
    const provider = (dependencies.createProvider ?? createConfiguredProvider)(config);
    const result = await runBatchPipeline({
      database, pdfPath: requiredOption(args, "--pdf"), config,
      classificationProvider: provider,
      boundaryProvider: (dependencies.createBoundaryProvider ?? createSegmentationProvider)(config),
      extractionProvider: provider, renderer: dependencies.renderer,
      paymentRunId: requiredOption(args, "--payment-run-id"), paymentRunOn: requiredOption(args, "--payment-run-on"),
      matchedOn: requiredOption(args, "--matched-on"), reviewedAt: requiredOption(args, "--reviewed-at"),
    });
    (dependencies.write ?? ((contents: string) => process.stdout.write(contents)))(`${JSON.stringify({ documentHash: result.ingestion.documentHash, sourceDocuments: result.sourceDocuments.length, accruals: result.accruals.length, matches: result.matches.length, paymentRunAlreadyPrepared: result.paymentRunAlreadyPrepared })}\n`);
    return result;
  } finally {
    (dependencies.closeDatabase ?? ((connection: Database) => connection.close()))(database);
  }
}

void (async () => {
  if (import.meta.main) await runBatchCommand(process.argv.slice(2));
})();
