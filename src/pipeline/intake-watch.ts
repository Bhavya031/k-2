import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, parse } from "node:path";

import type { BatchPipelineResult } from "./batch.ts";
import { runBatchCommand } from "./cli.ts";

export type IntakeFolders = Readonly<{ intake: string; processed: string; failed: string }>;

/** Default locations are relative to the command's working directory. */
export const defaultIntakeFolders: IntakeFolders = Object.freeze({
  intake: "intake",
  processed: "processed",
  failed: "failed",
});

type FileStat = Readonly<{ size: number }>;

export type IntakeFileSystem = Readonly<{
  mkdir(path: string, options: Readonly<{ recursive: true }>): Promise<void>;
  readdir(path: string): Promise<readonly string[]>;
  stat(path: string): Promise<FileStat>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  writeFile(path: string, contents: string): Promise<void>;
}>;

export type IntakeClock = Readonly<{ now(): Date }>;
export type ProductionBatchEntrypoint = (args: readonly string[]) => Promise<BatchPipelineResult>;
/** Converts one supported raster image to a temporary, single-page PDF. */
export type IntakeImageNormalizer = (sourceImage: string, temporaryPdf: string) => Promise<void>;

export type IntakeWatchDependencies = Readonly<{
  filesystem?: IntakeFileSystem;
  clock?: IntakeClock;
  runBatch?: ProductionBatchEntrypoint;
  normalizeImage?: IntakeImageNormalizer;
  sleep?: (milliseconds: number) => Promise<void>;
  onPoll?: (result: IntakePollResult) => void;
}>;

export type IntakeProcessingResult = Readonly<{
  filename: string;
  destination: string;
  duplicate: boolean;
}>;

export type IntakeFailure = Readonly<{
  filename: string;
  destination: string;
  errorSidecar: string;
  error: string;
}>;

export type IntakePollResult = Readonly<{
  pending: readonly string[];
  processed: readonly IntakeProcessingResult[];
  failed: readonly IntakeFailure[];
}>;

export type IntakeWatcher = Readonly<{
  poll(): Promise<IntakePollResult>;
}>;

const systemFileSystem: IntakeFileSystem = Object.freeze({
  mkdir: async (path, options) => { await mkdir(path, options); },
  readdir, stat, rename,
  remove: async (path) => { await rm(path, { force: true }); },
  writeFile,
});
const systemClock: IntakeClock = Object.freeze({ now: () => new Date() });
const systemSleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

function intakeKind(filename: string): "pdf" | "image" | undefined {
  const extension = extname(filename).toLowerCase();
  if (extension === ".pdf") return "pdf";
  if (extension === ".jpg" || extension === ".jpeg" || extension === ".png") return "image";
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(filesystem: IntakeFileSystem, path: string): Promise<boolean> {
  try {
    await filesystem.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function destinationFor(filesystem: IntakeFileSystem, directory: string, filename: string): Promise<string> {
  const parts = parse(filename);
  let candidate = join(directory, filename);
  let suffix = 1;
  while (await exists(filesystem, candidate)) {
    candidate = join(directory, `${parts.name}.${suffix}${parts.ext}`);
    suffix += 1;
  }
  return candidate;
}

function failureSidecar(destination: string): string {
  return `${destination}.error.txt`;
}

async function normalizeWithImg2pdf(sourceImage: string, temporaryPdf: string): Promise<void> {
  const child = Bun.spawn({ cmd: ["img2pdf", "--output", temporaryPdf, sourceImage], stdout: "pipe", stderr: "pipe" });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(child.stderr).text();
    throw new Error(`img2pdf failed: ${stderr.trim()}`);
  }
}

/**
 * Polls a three-folder PDF/JPEG/PNG intake. A file becomes eligible only after
 * its size is identical in two consecutive polls. Raster images are normalized
 * by img2pdf to a temporary single-page PDF before being handed to the same
 * production batch-command entrypoint as `bun run batch`; no pipeline work is
 * implemented here.
 */
export function createIntakeWatcher(
  folders: IntakeFolders,
  batchArguments: readonly string[],
  dependencies: IntakeWatchDependencies = {},
): IntakeWatcher {
  const filesystem = dependencies.filesystem ?? systemFileSystem;
  const clock = dependencies.clock ?? systemClock;
  const runBatch = dependencies.runBatch ?? runBatchCommand;
  const normalizeImage = dependencies.normalizeImage ?? normalizeWithImg2pdf;
  const observedSizes = new Map<string, number>();
  const temporaryDirectory = join(folders.intake, ".k2-intake-watch");
  let temporarySequence = 0;

  async function pendingFiles(): Promise<readonly string[]> {
    return Object.freeze((await filesystem.readdir(folders.intake)).filter((filename) => intakeKind(filename) !== undefined).sort((left, right) => left.localeCompare(right)));
  }

  return Object.freeze({
    async poll(): Promise<IntakePollResult> {
      await Promise.all([folders.intake, folders.processed, folders.failed, temporaryDirectory].map((directory) => filesystem.mkdir(directory, { recursive: true })));
      const filenames = await pendingFiles();
      const currentPaths = new Set(filenames.map((filename) => join(folders.intake, filename)));
      for (const path of observedSizes.keys()) if (!currentPaths.has(path)) observedSizes.delete(path);

      const stable: string[] = [];
      for (const filename of filenames) {
        const path = join(folders.intake, filename);
        const size = (await filesystem.stat(path)).size;
        if (observedSizes.get(path) === size) stable.push(filename);
        observedSizes.set(path, size);
      }

      const processed: IntakeProcessingResult[] = [];
      const failed: IntakeFailure[] = [];
      for (const filename of stable) {
        const source = join(folders.intake, filename);
        const kind = intakeKind(filename)!;
        const temporaryPdf = kind === "image" ? join(temporaryDirectory, `${parse(filename).name}.${temporarySequence++}.pdf`) : undefined;
        try {
          if (temporaryPdf !== undefined) await normalizeImage(source, temporaryPdf);
          const result = await runBatch(["--pdf", temporaryPdf ?? source, ...batchArguments]);
          const destination = await destinationFor(filesystem, folders.processed, filename);
          await filesystem.rename(source, destination);
          observedSizes.delete(source);
          processed.push(Object.freeze({ filename, destination, duplicate: result.ingestion.duplicate }));
        } catch (error) {
          const message = errorMessage(error);
          const destination = await destinationFor(filesystem, folders.failed, filename);
          const sidecar = failureSidecar(destination);
          try {
            await filesystem.rename(source, destination);
            await filesystem.writeFile(sidecar, `${JSON.stringify({ source: filename, failedAt: clock.now().toISOString(), error: message })}\n`);
            observedSizes.delete(source);
            failed.push(Object.freeze({ filename, destination, errorSidecar: sidecar, error: message }));
          } catch (moveError) {
            failed.push(Object.freeze({ filename, destination, errorSidecar: sidecar, error: `${message}; could not move to failed: ${errorMessage(moveError)}` }));
          }
        } finally {
          if (temporaryPdf !== undefined) await filesystem.remove(temporaryPdf);
        }
      }

      return Object.freeze({ pending: await pendingFiles(), processed: Object.freeze(processed), failed: Object.freeze(failed) });
    },
  });
}

export async function watchIntakeFolders(
  folders: IntakeFolders,
  batchArguments: readonly string[],
  pollMilliseconds: number,
  dependencies: IntakeWatchDependencies = {},
): Promise<never> {
  const watcher = createIntakeWatcher(folders, batchArguments, dependencies);
  const sleep = dependencies.sleep ?? systemSleep;
  for (;;) {
    const result = await watcher.poll();
    dependencies.onPoll?.(result);
    await sleep(pollMilliseconds);
  }
}

export function errorSidecarForFailedFile(path: string): string {
  return failureSidecar(path);
}
