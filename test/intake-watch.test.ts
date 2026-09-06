import { describe, expect, test } from "bun:test";
import { basename, dirname } from "node:path";

import { createIntakeWatcher, defaultIntakeFolders, type IntakeFileSystem } from "../src/pipeline/intake-watch.ts";
import { intakeFoldersFromArguments, runIntakeWatchCommand } from "../src/pipeline/intake-watch-cli.ts";
import type { BatchPipelineResult } from "../src/pipeline/batch.ts";

class SyntheticFiles implements IntakeFileSystem {
  readonly files = new Map<string, string>();

  add(path: string, contents: string): void { this.files.set(path, contents); }
  get(path: string): string | undefined { return this.files.get(path); }
  names(directory: string): readonly string[] { return [...this.files.keys()].filter((path) => dirname(path) === directory).map((path) => basename(path)).sort(); }

  async mkdir(): Promise<void> {}
  async readdir(path: string): Promise<readonly string[]> { return this.names(path); }
  async stat(path: string): Promise<Readonly<{ size: number }>> {
    const contents = this.files.get(path);
    if (contents === undefined) throw new Error(`not found: ${path}`);
    return { size: new TextEncoder().encode(contents).byteLength };
  }
  async rename(from: string, to: string): Promise<void> {
    const contents = this.files.get(from);
    if (contents === undefined) throw new Error(`not found: ${from}`);
    this.files.delete(from);
    this.files.set(to, contents);
  }
  async remove(path: string): Promise<void> { this.files.delete(path); }
  async writeFile(path: string, contents: string): Promise<void> { this.files.set(path, contents); }
}

class SyntheticBatch {
  readonly paths: string[] = [];
  readonly arguments: Array<readonly string[]> = [];
  readonly results = new Set<string>();
  readonly failures = new Set<string>();

  constructor(private readonly files: SyntheticFiles) {}

  async run(args: readonly string[]): Promise<BatchPipelineResult> {
    const pdf = args[args.indexOf("--pdf") + 1]!;
    this.paths.push(pdf);
    this.arguments.push(args);
    if (this.failures.has(basename(pdf))) throw new Error(`synthetic failure for ${basename(pdf)}`);
    const contents = this.files.get(pdf)!;
    const duplicate = this.results.has(contents);
    this.results.add(contents);
    return { ingestion: { duplicate } } as BatchPipelineResult;
  }
}

const folders = Object.freeze({ intake: "synthetic/intake", processed: "synthetic/processed", failed: "synthetic/failed" });
const batchArguments = Object.freeze(["--payment-run-id", "synthetic-draft", "--payment-run-on", "2026-09-06", "--matched-on", "2026-09-06", "--reviewed-at", "2026-09-06T12:00:00.000Z"]);
const clock = Object.freeze({ now: () => new Date("2026-09-06T12:34:56.000Z") });

describe("polled document intake", () => {
  test("processes an arrived PDF only after its size is unchanged across two polls and then reports no pending work", async () => {
    const files = new SyntheticFiles();
    const batch = new SyntheticBatch(files);
    files.add("synthetic/intake/arrival.pdf", "synthetic arrival");
    const watcher = createIntakeWatcher(folders, batchArguments, { filesystem: files, clock, runBatch: (args) => batch.run(args) });

    expect(await watcher.poll()).toEqual({ pending: ["arrival.pdf"], processed: [], failed: [] });
    expect(batch.paths).toEqual([]);

    const completed = await watcher.poll();
    expect(completed).toEqual({ pending: [], processed: [{ filename: "arrival.pdf", destination: "synthetic/processed/arrival.pdf", duplicate: false }], failed: [] });
    expect(batch.arguments).toEqual([["--pdf", "synthetic/intake/arrival.pdf", ...batchArguments]]);
    expect(files.get("synthetic/processed/arrival.pdf")).toBe("synthetic arrival");
  });

  test("ignores a changing PDF until a later poll observes the new size unchanged", async () => {
    const files = new SyntheticFiles();
    const batch = new SyntheticBatch(files);
    files.add("synthetic/intake/copying.pdf", "first");
    const watcher = createIntakeWatcher(folders, batchArguments, { filesystem: files, clock, runBatch: (args) => batch.run(args) });

    await watcher.poll();
    files.add("synthetic/intake/copying.pdf", "second, larger synthetic copy");
    expect(await watcher.poll()).toEqual({ pending: ["copying.pdf"], processed: [], failed: [] });
    expect(batch.paths).toEqual([]);

    expect((await watcher.poll()).processed).toEqual([{ filename: "copying.pdf", destination: "synthetic/processed/copying.pdf", duplicate: false }]);
  });

  test("moves a failing PDF and timestamped sidecar to failed while continuing with the next stable PDF", async () => {
    const files = new SyntheticFiles();
    const batch = new SyntheticBatch(files);
    files.add("synthetic/intake/bad.pdf", "synthetic bad");
    files.add("synthetic/intake/good.pdf", "synthetic good");
    batch.failures.add("bad.pdf");
    const watcher = createIntakeWatcher(folders, batchArguments, { filesystem: files, clock, runBatch: (args) => batch.run(args) });

    await watcher.poll();
    const result = await watcher.poll();

    expect(result.pending).toEqual([]);
    expect(result.processed).toEqual([{ filename: "good.pdf", destination: "synthetic/processed/good.pdf", duplicate: false }]);
    expect(result.failed).toEqual([{ filename: "bad.pdf", destination: "synthetic/failed/bad.pdf", errorSidecar: "synthetic/failed/bad.pdf.error.txt", error: "synthetic failure for bad.pdf" }]);
    expect(files.get("synthetic/failed/bad.pdf.error.txt")).toBe('{"source":"bad.pdf","failedAt":"2026-09-06T12:34:56.000Z","error":"synthetic failure for bad.pdf"}\n');
    expect(batch.paths).toEqual(["synthetic/intake/bad.pdf", "synthetic/intake/good.pdf"]);
  });

  test("passes duplicate byte drops through the production entrypoint but creates one content-addressed result", async () => {
    const files = new SyntheticFiles();
    const batch = new SyntheticBatch(files);
    files.add("synthetic/intake/first.pdf", "identical synthetic bytes");
    files.add("synthetic/intake/retry.pdf", "identical synthetic bytes");
    const watcher = createIntakeWatcher(folders, batchArguments, { filesystem: files, clock, runBatch: (args) => batch.run(args) });

    await watcher.poll();
    const result = await watcher.poll();

    expect(result.processed.map((item) => item.duplicate)).toEqual([false, true]);
    expect(batch.results.size).toBe(1);
    expect(files.names(folders.processed)).toEqual(["first.pdf", "retry.pdf"]);
  });

  test("normalizes stable JPEG/PNG files through the production-PDF adapter, cleans temporary PDFs, and preserves content-addressed duplicates", async () => {
    const files = new SyntheticFiles();
    const batch = new SyntheticBatch(files);
    const normalized: Array<readonly string[]> = [];
    files.add("synthetic/intake/camera-one.jpg", "identical synthetic image bytes");
    files.add("synthetic/intake/camera-two.png", "identical synthetic image bytes");
    const watcher = createIntakeWatcher(folders, batchArguments, {
      filesystem: files, clock, runBatch: (args) => batch.run(args),
      normalizeImage: async (source, temporaryPdf) => {
        normalized.push([source, temporaryPdf]);
        files.add(temporaryPdf, `single-page synthetic PDF: ${files.get(source)!}`);
      },
    });

    await watcher.poll();
    const result = await watcher.poll();

    expect(normalized).toEqual([
      ["synthetic/intake/camera-one.jpg", "synthetic/intake/.k2-intake-watch/camera-one.0.pdf"],
      ["synthetic/intake/camera-two.png", "synthetic/intake/.k2-intake-watch/camera-two.1.pdf"],
    ]);
    expect(batch.paths).toEqual([
      "synthetic/intake/.k2-intake-watch/camera-one.0.pdf",
      "synthetic/intake/.k2-intake-watch/camera-two.1.pdf",
    ]);
    expect(result.processed.map((item) => item.duplicate)).toEqual([false, true]);
    expect(batch.results.size).toBe(1);
    expect(files.names(folders.processed)).toEqual(["camera-one.jpg", "camera-two.png"]);
    expect(files.names("synthetic/intake/.k2-intake-watch")).toEqual([]);
  });

  test("defines the documented defaults and lets one-shot mode truthfully retain an unconfirmed PDF as pending", async () => {
    expect(defaultIntakeFolders).toEqual({ intake: "intake", processed: "processed", failed: "failed" });
    expect(intakeFoldersFromArguments([])).toEqual(defaultIntakeFolders);
    const files = new SyntheticFiles();
    const batch = new SyntheticBatch(files);
    files.add("custom/in/ready.pdf", "synthetic ready");
    let output = "";
    await runIntakeWatchCommand(["--once", "--intake-dir", "custom/in", "--processed-dir", "custom/ok", "--failed-dir", "custom/no", ...batchArguments], { filesystem: files, clock, runBatch: (args) => batch.run(args), write: (contents) => { output += contents; } });
    expect(batch.paths).toEqual([]);
    expect(files.get("custom/in/ready.pdf")).toBe("synthetic ready");
    expect(output).toBe('{"pending":["ready.pdf"],"processed":[],"failed":[]}\n');
  });
});
