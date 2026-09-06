import { Database } from "bun:sqlite";
import { parentPort, workerData } from "node:worker_threads";

import { ReviewQueue } from "../../src/review/queue";

type ClaimWorkerData = Readonly<{
  path: string;
  claimant: string;
  claimedAt: string;
  gate: SharedArrayBuffer;
}>;

const data = workerData as ClaimWorkerData;
const arrivals = new Int32Array(data.gate);
Atomics.add(arrivals, 0, 1);
Atomics.notify(arrivals, 0);
while (Atomics.load(arrivals, 0) < 2) Atomics.wait(arrivals, 0, 1);

const database = new Database(data.path);
const claim = new ReviewQueue(database).claimNext(data.claimant, data.claimedAt);
database.close();
parentPort?.postMessage(claim?.id ?? null);
