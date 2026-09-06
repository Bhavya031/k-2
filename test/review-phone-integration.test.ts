import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config.ts";
import {
  startPhoneIntake,
  type IgnoredSenderRecorder,
  type MessagingTransport,
  type PhoneInbound,
  type PhoneMessage,
  type Stage3PhotoIngestionPort,
} from "../src/messaging/phone-intake.ts";
import { ReviewQueue, ReviewQueuePhoneAdapter } from "../src/review/queue.ts";
import { migrateStore } from "../src/store/schema.ts";

const CREATED = "2026-09-06T12:00:00.000Z";
const CLAIMED = "2026-09-06T12:01:00.000Z";
const DECIDED = "2026-09-06T12:02:00.000Z";

class SyntheticPhoneTransport implements MessagingTransport {
  handler: ((message: PhoneInbound) => Promise<void>) | undefined;
  readonly sent: PhoneMessage[] = [];
  receive(handler: (message: PhoneInbound) => Promise<void>): void { this.handler = handler; }
  async send(message: PhoneMessage): Promise<void> { this.sent.push(message); }
  async deliver(message: PhoneInbound): Promise<void> { await this.handler?.(message); }
}

class SyntheticPhotoIngestion implements Stage3PhotoIngestionPort {
  received = 0;
  async ingestPhoto() {
    this.received += 1;
    return { documentId: "synthetic-document-18", documentType: "delivery_challan" as const, duplicate: false };
  }
}

class SyntheticIgnoredSenders implements IgnoredSenderRecorder {
  async recordIgnoredSender(): Promise<void> { throw new Error("the synthetic sender is allowed"); }
}

describe("Stage 5 real queue and phone integration", () => {
  test("a synthetic photo reaches a queued item, records a phone correction audit, and retains the human value", async () => {
    const database = new Database(":memory:");
    migrateStore(database);
    const queue = new ReviewQueue(database);
    queue.enqueue({
      id: "synthetic-review-18",
      subjectId: "synthetic-document-18",
      decisionPrompt: "Confirm the synthetic delivery quantity",
      evidence: "Synthetic photo evidence only; not company data.",
      priority: 50,
      createdAt: CREATED,
      extractedValue: { kind: "quantity_thousandths", value: 12_420 },
    });
    queue.claimNext("synthetic-driver-18", CLAIMED);

    const transport = new SyntheticPhoneTransport();
    const ingestion = new SyntheticPhotoIngestion();
    const port = new ReviewQueuePhoneAdapter(queue, () => DECIDED);
    expect(startPhoneIntake({
      config: loadConfig({
        DATABASE_PATH: ":memory:", MODEL_PROVIDER: "local",
        MESSAGING_BOT_TOKEN: "synthetic-token", MESSAGING_ALLOWED_SENDERS: "synthetic-driver-18",
      }),
      transport, ingestion, review: port, ignoredSenders: new SyntheticIgnoredSenders(),
    })).toEqual({ available: true });

    await transport.deliver({
      kind: "photo", senderId: "synthetic-driver-18",
      photo: { filename: "synthetic-photo.jpg", mediaType: "image/jpeg", bytes: new Uint8Array([1, 8]) },
    });
    await transport.deliver({
      kind: "action", senderId: "synthetic-driver-18",
      action: { kind: "correct", reviewItemId: "synthetic-review-18", documentId: "synthetic-document-18", field: "value" },
    });
    await transport.deliver({ kind: "text", senderId: "synthetic-driver-18", text: "12400" });
    queue.recordAutomatedExtraction("synthetic-review-18", { kind: "quantity_thousandths", value: 99_999 });

    expect(ingestion.received).toBe(1);
    expect(transport.sent[0]?.text).toContain("12420");
    expect(queue.valueFor("synthetic-review-18")).toEqual({
      value: { kind: "quantity_thousandths", value: 12_400 }, provenance: "human",
    });
    expect(database.query(`SELECT review_item_id, outcome, corrected_value_integer, decided_by, decided_at
      FROM review_decision_audit`).get()).toEqual({
      review_item_id: "synthetic-review-18", outcome: "correct", corrected_value_integer: 12_400,
      decided_by: "synthetic-driver-18", decided_at: DECIDED,
    });
    database.close();
  });
});
