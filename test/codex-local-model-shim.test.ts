import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import { decodeImageBytes, extractJson, runCodexShim, type CodexExecutor } from "../scripts/codex-local-model-shim.ts";

describe("Codex local model shim", () => {
  test.each([
    ["JSON-stringified Uint8Array object", { 0: 8, 1: 9, 2: 10 }],
    ["plain numeric array", [8, 9, 10]],
    ["base64", "CAkK"],
  ])("decodes %s image bytes", (_kind, value) => {
    expect([...decodeImageBytes(value)]).toEqual([8, 9, 10]);
  });

  test("writes images and schema, invokes the required Codex command, extracts JSON, and cleans its temporary directory", () => {
    let observedDirectory: string | undefined;
    const executor: CodexExecutor = ({ cmd, cwd, outputPath }) => {
      observedDirectory = cwd;
      expect(cmd.slice(0, 6)).toEqual(["codex", "exec", "--model", "test-model", "--output-schema", `${cwd}/schema.json`]);
      expect(cmd).toContain("-i");
      expect(cmd).toContain(`${cwd}/001-page_one.png`);
      expect(cmd).toContain("--sandbox");
      expect(cmd).toContain("read-only");
      expect(cmd).toContain("--skip-git-repo-check");
      expect(readFileSync(`${cwd}/schema.json`, "utf8")).toBe('{"type":"object"}');
      expect([...readFileSync(`${cwd}/001-page_one.png`)]).toEqual([1, 2, 3]);
      writeFileSync(outputPath, "Here is the result:\n```json\n{\"answer\": 7}\n```");
      return { exitCode: 0, stderr: "" };
    };

    expect(runCodexShim({ prompt: "synthetic prompt", images: [{ label: "page one", mediaType: "image/png", bytes: [1, 2, 3] }], schema: { type: "object" }, validationErrors: [{ path: "answer", message: "required" }] }, executor, "test-model")).toEqual({ answer: 7 });
    expect(observedDirectory).toBeDefined();
    expect(existsSync(observedDirectory!)).toBe(false);
  });

  test("extracts a bare embedded JSON array and rejects output with no JSON", () => {
    expect(extractJson("result: [1, 2, 3] done")).toEqual([1, 2, 3]);
    expect(() => extractJson("no structured response")).toThrow("no JSON value in Codex output");
  });
});
