import { Database } from "bun:sqlite";
import { resolve } from "node:path";

import { buildReport } from "../src/report/report.ts";

const [storePath, outputPath] = process.argv.slice(2);
if (storePath === undefined || outputPath === undefined || process.argv.length !== 4) {
  throw new Error("usage: bun run report <persisted-store.sqlite> <report.html>");
}
const database = new Database(resolve(storePath), { readonly: true });
try {
  await Bun.write(resolve(outputPath), buildReport(database));
} finally {
  database.close();
}
