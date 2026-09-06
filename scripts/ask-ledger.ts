import { resolve } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createConfiguredProvider } from "../src/model/boundary.ts";
import { startLedgerServer } from "../src/asking/server.ts";

const config = loadConfig();
const server = startLedgerServer({ databasePath: resolve(config.databasePath), provider: createConfiguredProvider(config), port: 3000 });
console.log(`K-2 Ask the ledger is listening at ${server.url}`);

// Keep the localhost server alive; it has no background work other than requests.
setInterval(() => {}, 2_147_483_647);
