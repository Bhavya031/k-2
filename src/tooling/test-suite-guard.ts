import { readdirSync } from "node:fs";
import { join } from "node:path";

const ignoredDirectoryNames = new Set([".git", "node_modules"]);
const testFilePattern = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;

export function findProjectTestFiles(projectRoot: string): string[] {
  const testFiles: string[] = [];

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        if (!ignoredDirectoryNames.has(entry.name)) {
          visit(path);
        }
        continue;
      }

      if (entry.isFile() && testFilePattern.test(entry.name)) {
        testFiles.push(path);
      }
    }
  }

  visit(projectRoot);
  return testFiles;
}

export function assertProjectHasTests(projectRoot: string): void {
  if (findProjectTestFiles(projectRoot).length === 0) {
    throw new Error("No project test files found outside ignored directories.");
  }
}
