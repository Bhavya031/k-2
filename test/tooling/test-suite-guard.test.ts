import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "bun:test";

import {
  assertProjectHasTests,
  findProjectTestFiles
} from "../../src/tooling/test-suite-guard.ts";

const temporaryDirectories: string[] = [];
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function makeProject(): string {
  const directory = mkdtempSync(join(tmpdir(), "k-2-test-suite-guard-"));
  temporaryDirectories.push(directory);
  return directory;
}

test("finds project test files", () => {
  const project = makeProject();
  mkdirSync(join(project, "test"));
  writeFileSync(join(project, "test", "example.test.ts"), "");

  expect(findProjectTestFiles(project)).toEqual([
    join(project, "test", "example.test.ts")
  ]);
});

test("fails when only node_modules contains a test file", () => {
  const project = makeProject();
  mkdirSync(join(project, "node_modules", "dependency", "test"), {
    recursive: true
  });
  writeFileSync(
    join(project, "node_modules", "dependency", "test", "dependency.test.ts"),
    ""
  );

  expect(() => assertProjectHasTests(project)).toThrow(
    "No project test files found outside ignored directories."
  );
});


test("test command fails for an empty project", () => {
  const project = makeProject();
  mkdirSync(join(project, "scripts"), { recursive: true });
  mkdirSync(join(project, "src", "tooling"), { recursive: true });
  copyFileSync(
    join(repositoryRoot, "scripts", "test.ts"),
    join(project, "scripts", "test.ts")
  );
  copyFileSync(
    join(repositoryRoot, "src", "tooling", "test-suite-guard.ts"),
    join(project, "src", "tooling", "test-suite-guard.ts")
  );

  const result = Bun.spawnSync({
    cmd: [process.execPath, "scripts/test.ts"],
    cwd: project,
    stderr: "pipe",
    stdout: "pipe"
  });

  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain(
    "No project test files found outside ignored directories."
  );
});


test("typecheck command rejects a semantic TypeScript error", () => {
  const invalidSource = join(
    repositoryRoot,
    "src",
    "tooling",
    "typecheck-proof.invalid.ts"
  );
  writeFileSync(invalidSource, 'const bad: number = "not a number";\n');

  try {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", "typecheck"],
      cwd: repositoryRoot,
      stderr: "pipe",
      stdout: "pipe"
    });

    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain(
      "Type 'string' is not assignable to type 'number'."
    );
  } finally {
    unlinkSync(invalidSource);
  }
});
