import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, test } from "bun:test";

import { ReviewQueue } from "../src/review/queue";
import { migrateStore } from "../src/store/schema";

const databases: Database[] = [];
const databaseFiles: string[] = [];
const CREATED = "2026-09-06T11:00:00.000Z";
const CLAIMED = "2026-09-06T11:01:00.000Z";
const DECIDED = "2026-09-06T11:02:00.000Z";

function openStore(path = ":memory:"): Database {
  const database = new Database(path);
  databases.push(database);
  migrateStore(database);
  return database;
}

function enqueue(queue: ReviewQueue, id: string, priority: number, createdAt = CREATED): void {
  queue.enqueue({
    id,
    subjectId: `synthetic-document-${id}`,
    decisionPrompt: "Confirm the simulated quarry weight",
    evidence: `Synthetic evidence for ${id}; this is not company data.`,
    priority,
    createdAt,
  });
}

function raceClaims(path: string): Promise<Array<string | null>> {
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  return Promise.all(["synthetic-reviewer-a", "synthetic-reviewer-b"].map((claimant) =>
    new Promise<string | null>((resolve, reject) => {
      const worker = new Worker(new URL("./fixtures/review-claim-worker.ts", import.meta.url), {
        workerData: { path, claimant, claimedAt: CLAIMED, gate },
      });
      worker.once("message", (message: string | null) => resolve(message));
      worker.once("error", reject);
    }),
  ));
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  while (databaseFiles.length > 0) {
    const path = databaseFiles.pop()!;
    try { rmSync(path); } catch { /* test cleanup */ }
  }
});

describe("Stage 5 review queue", () => {
  test("claims highest priority first and resolves priority ties oldest-first", () => {
    const queue = new ReviewQueue(openStore());
    enqueue(queue, "low", 1, "2026-09-06T10:00:00.000Z");
    enqueue(queue, "newer-high", 10, "2026-09-06T10:02:00.000Z");
    enqueue(queue, "older-high", 10, "2026-09-06T10:01:00.000Z");

    expect(queue.claimNext("synthetic-reviewer", CLAIMED)?.id).toBe("older-high");
    expect(queue.claimNext("synthetic-reviewer", "2026-09-06T11:01:01.000Z")?.id).toBe("newer-high");
    expect(queue.claimNext("synthetic-reviewer", "2026-09-06T11:01:02.000Z")?.id).toBe("low");
  });

  test("races two database sessions to claim one item and exactly one receives it", async () => {
    const path = `/tmp/k2-synthetic-review-race-${crypto.randomUUID()}.sqlite`;
    databaseFiles.push(path);
    const first = new ReviewQueue(openStore(path));
    enqueue(first, "only-item", 100);

    const claims = await raceClaims(path);

    expect(claims.filter((claim) => claim === "only-item")).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
  });

  test("the losing concurrent claimant takes the next item when one exists", async () => {
    const path = `/tmp/k2-synthetic-review-next-${crypto.randomUUID()}.sqlite`;
    databaseFiles.push(path);
    const first = new ReviewQueue(openStore(path));
    enqueue(first, "first", 100);
    enqueue(first, "second", 90);

    const claims = await raceClaims(path);

    expect(claims.sort()).toEqual(["first", "second"]);
  });

  test("correcting replaces the extracted integer value with human provenance and blocks later automation", () => {
    const queue = new ReviewQueue(openStore());
    queue.enqueue({
      id: "simulated-weight",
      subjectId: "synthetic-document-weight",
      decisionPrompt: "Confirm the simulated quantity",
      evidence: "Synthetic weighbridge evidence; not real company data.",
      priority: 9,
      createdAt: CREATED,
      extractedValue: { kind: "quantity_thousandths", value: 12_420 },
    });
    queue.claimNext("synthetic-accountant", CLAIMED);
    queue.decide("simulated-weight", {
      outcome: "correct",
      correctedValue: { kind: "quantity_thousandths", value: 12_400 },
      decidedBy: "synthetic-accountant",
      decidedAt: DECIDED,
    });
    queue.recordAutomatedExtraction("simulated-weight", { kind: "quantity_thousandths", value: 99_999 });

    expect(queue.valueFor("simulated-weight")).toEqual({
      value: { kind: "quantity_thousandths", value: 12_400 },
      provenance: "human",
    });
  });

  test("each outcome writes its audit record, including correction value, in the decision transaction", () => {
    const database = openStore();
    const queue = new ReviewQueue(database);
    enqueue(queue, "approve", 3);
    enqueue(queue, "reject", 2);
    enqueue(queue, "correct", 1);
    for (const [id, outcome, correctedValue] of [
      ["approve", "approve", undefined],
      ["reject", "reject", undefined],
      ["correct", "correct", { kind: "money_paise", value: 1_250 }],
    ] as const) {
      queue.claimNext("synthetic-accountant", CLAIMED);
      queue.decide(id, { outcome, correctedValue, decidedBy: "synthetic-accountant", decidedAt: DECIDED });
    }

    expect(database.query("SELECT review_item_id, outcome, corrected_value_integer, decided_by, decided_at FROM review_decision_audit ORDER BY id").all())
      .toEqual([
        { review_item_id: "approve", outcome: "approve", corrected_value_integer: null, decided_by: "synthetic-accountant", decided_at: DECIDED },
        { review_item_id: "reject", outcome: "reject", corrected_value_integer: null, decided_by: "synthetic-accountant", decided_at: DECIDED },
        { review_item_id: "correct", outcome: "correct", corrected_value_integer: 1250, decided_by: "synthetic-accountant", decided_at: DECIDED },
      ]);
    expect(database.query("SELECT count(*) AS count FROM review_items WHERE state = 'decided'").get()).toEqual({ count: 3 });
  });

  test("an audit write failure rolls back the decision so no unaudited decision is applied", () => {
    const database = openStore();
    const queue = new ReviewQueue(database);
    enqueue(queue, "audit-outage", 1);
    queue.claimNext("synthetic-accountant", CLAIMED);
    database.exec(`CREATE TRIGGER simulated_audit_outage BEFORE INSERT ON review_decision_audit
      BEGIN SELECT RAISE(ABORT, 'synthetic audit outage'); END;`);

    expect(() => queue.decide("audit-outage", {
      outcome: "approve", decidedBy: "synthetic-accountant", decidedAt: DECIDED,
    })).toThrow("synthetic audit outage");
    expect(database.query("SELECT state FROM review_items WHERE id = 'audit-outage'").get()).toEqual({ state: "claimed" });
    expect(database.query("SELECT count(*) AS count FROM review_decision_audit").get()).toEqual({ count: 0 });
  });

  test("database constraints reject REAL money and negative quantities in review values", () => {
    const database = openStore();
    const queue = new ReviewQueue(database);
    enqueue(queue, "integer-constraints", 1);

    expect(() => database.run(
      `INSERT INTO review_values (review_item_id, value_kind, value_integer, provenance)
       VALUES (?, 'money_paise', ?, 'automated')`, ["integer-constraints", 12.5],
    )).toThrow("cannot store REAL value in INTEGER column review_values.value_integer");
    expect(() => database.run(
      `INSERT INTO review_values (review_item_id, value_kind, value_integer, provenance)
       VALUES (?, 'quantity_thousandths', ?, 'automated')`, ["integer-constraints", -1],
    )).toThrow("CHECK constraint failed");
  });
});
