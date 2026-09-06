import { Database } from "bun:sqlite";

import { loadConfig } from "../config.ts";
import { createConfiguredProvider } from "../model/boundary.ts";
import { createSegmentationProvider } from "../segmentation/segment.ts";
import { runBatchPipeline } from "./batch.ts";

function requiredOption(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing required option ${name}`);
  return value;
}

/** One local command; it prepares a simulated payment draft and never sends it. */
async function main(): Promise<void> {
  const config = loadConfig();
  const args = process.argv.slice(2);
  const database = new Database(config.databasePath);
  try {
    const provider = createConfiguredProvider(config);
    const result = await runBatchPipeline({
      database, pdfPath: requiredOption(args, "--pdf"), config,
      classificationProvider: provider, boundaryProvider: createSegmentationProvider(config), extractionProvider: provider,
      paymentRunId: requiredOption(args, "--payment-run-id"), paymentRunOn: requiredOption(args, "--payment-run-on"),
      matchedOn: requiredOption(args, "--matched-on"), reviewedAt: requiredOption(args, "--reviewed-at"),
    });
    process.stdout.write(`${JSON.stringify({ documentHash: result.ingestion.documentHash, sourceDocuments: result.sourceDocuments.length, accruals: result.accruals.length, matches: result.matches.length, paymentRunAlreadyPrepared: result.paymentRunAlreadyPrepared })}\n`);
  } finally {
    database.close();
  }
}

void main();
