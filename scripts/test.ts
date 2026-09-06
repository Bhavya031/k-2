import { resolve } from "node:path";

import { assertProjectHasTests } from "../src/tooling/test-suite-guard.ts";

const projectRoot = resolve(import.meta.dir, "..");
assertProjectHasTests(projectRoot);

const result = Bun.spawnSync({
  cmd: [process.execPath, "test"],
  cwd: projectRoot,
  stdout: "inherit",
  stderr: "inherit"
});

process.exit(result.exitCode);
