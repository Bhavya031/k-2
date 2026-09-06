#!/usr/bin/env bun
/**
 * LOCAL_MODEL_COMMAND adapter for a Codex CLI subscription.
 *
 * It accepts one JSON object on stdin using the LocalProvider contract and
 * writes only the schema value to stdout.  Codex receives paths, not image
 * bytes, so the possibly JSON-shaped byte representation is decoded here.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ShimImage = Readonly<{ label: string; mediaType: string; bytes: unknown }>;
export type ShimInput = Readonly<{
  prompt: string;
  images?: readonly ShimImage[];
  schema: unknown;
  validationErrors?: unknown;
}>;

type Invocation = Readonly<{ cmd: readonly string[]; cwd: string; outputPath: string }>;
export type CodexExecutor = (invocation: Invocation) => Readonly<{ exitCode: number; stderr: string }>;

const extensions: Readonly<Record<string, string>> = Object.freeze({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
});

function byte(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error("image bytes must be integers from 0 through 255");
  }
  return value;
}

/** Decode native JSON encodings of Uint8Array, a numeric array, or base64. */
export function decodeImageBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value.map(byte));
  if (typeof value === "string") return Uint8Array.from(Buffer.from(value, "base64"));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record).map(([key, entry]) => {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) throw new Error("image byte object keys must be numeric indices");
      return [Number(key), byte(entry)] as const;
    }).sort(([left], [right]) => left - right);
    if (entries.some(([index], position) => index !== position)) throw new Error("image byte object indices must be contiguous from zero");
    return Uint8Array.from(entries.map(([, entry]) => entry));
  }
  throw new Error("unsupported image byte encoding");
}

/** Extract a JSON value even when a CLI version adds a fence or short prose. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/i)?.[1];
  for (const candidate of [fenced, text]) {
    if (candidate === undefined) continue;
    const trimmed = candidate.trim();
    try { return JSON.parse(trimmed); } catch { /* seek an embedded object or array */ }
    const start = trimmed.search(/[\[{]/);
    if (start < 0) continue;
    for (let end = trimmed.length; end > start; end -= 1) {
      const possible = trimmed.slice(start, end).trimEnd();
      if (!/[\]}]$/.test(possible)) continue;
      try { return JSON.parse(possible); } catch { /* keep searching */ }
    }
  }
  throw new Error(`no JSON value in Codex output: ${text.slice(0, 600)}`);
}

function defaultExecutor(invocation: Invocation): Readonly<{ exitCode: number; stderr: string }> {
  const result = Bun.spawnSync({ cmd: [...invocation.cmd], cwd: invocation.cwd, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  return Object.freeze({ exitCode: result.exitCode, stderr: new TextDecoder().decode(result.stderr) });
}

export function safeFilename(label: string): string {
  return (label.replace(/[^a-zA-Z0-9_.-]+/g, "_") || "image").slice(0, 80);
}

/** Runs exactly one isolated Codex structured-output invocation. */
export function runCodexShim(input: ShimInput, executor: CodexExecutor = defaultExecutor, model = process.env.K2_SHIM_MODEL ?? "gpt-5.3-codex"): unknown {
  if (typeof input.prompt !== "string") throw new Error("prompt must be a string");
  const directory = mkdtempSync(join(tmpdir(), "k2-codex-shim-"));
  try {
    const schemaPath = join(directory, "schema.json");
    const outputPath = join(directory, "output.json");
    writeFileSync(schemaPath, JSON.stringify(input.schema));
    const imagePaths = (input.images ?? []).map((image, index) => {
      const path = join(directory, `${String(index + 1).padStart(3, "0")}-${safeFilename(image.label)}.${extensions[image.mediaType] ?? "png"}`);
      writeFileSync(path, decodeImageBytes(image.bytes));
      return path;
    });
    const repair = input.validationErrors === undefined
      ? ""
      : `\nPrevious output failed schema validation. Correct these errors: ${JSON.stringify(input.validationErrors)}`;
    const command = ["codex", "exec", "--model", model, "--output-schema", schemaPath, "-o", outputPath,
      ...imagePaths.flatMap((path) => ["-i", path]), "--sandbox", "read-only", "--skip-git-repo-check", `${input.prompt}${repair}`];
    const result = executor(Object.freeze({ cmd: Object.freeze(command), cwd: directory, outputPath }));
    if (result.exitCode !== 0) throw new Error(`Codex local model command failed with exit code ${result.exitCode}: ${result.stderr}`);
    return extractJson(readFileSync(outputPath, "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const input = JSON.parse(await Bun.stdin.text()) as ShimInput;
  process.stdout.write(JSON.stringify(runCodexShim(input)));
}
