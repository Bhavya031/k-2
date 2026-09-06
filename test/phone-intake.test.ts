import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config.ts";
import {
  startPhoneIntake,
  type IgnoredSenderRecorder,
  type MessagingTransport,
  type PhoneInbound,
  type PhonePhoto,
  type PhoneMessage,
  type QueueDecision,
  type QueueDocumentView,
  type ReviewDecisionPort,
  type Stage3PhotoIngestionPort,
} from "../src/messaging/phone-intake.ts";

const syntheticPhoto = Object.freeze({
  filename: "invented-driver-photo.jpg",
  mediaType: "image/jpeg" as const,
  bytes: new Uint8Array([9, 8, 7, 6]),
});
const syntheticDocument = Object.freeze({
  reviewItemId: "synthetic-review-17",
  documentId: "synthetic-document-17",
  documentType: "delivery_challan",
  values: Object.freeze({ vendor: "Invented Quarry Supplies", quantity: "12.420 tonnes" }),
  reviewReason: "Synthetic fixture: confidence needs a human check.",
});

class FakeTransport implements MessagingTransport {
  handler: ((message: PhoneInbound) => Promise<void>) | undefined;
  readonly sent: PhoneMessage[] = [];

  receive(handler: (message: PhoneInbound) => Promise<void>): void {
    this.handler = handler;
  }

  async send(message: PhoneMessage): Promise<void> {
    this.sent.push(message);
  }

  async deliver(message: PhoneInbound): Promise<void> {
    await this.handler?.(message);
  }
}

class FakeStage3Pipeline implements Stage3PhotoIngestionPort {
  readonly received: string[] = [];
  readonly documentIds = new Set<string>();

  async ingestPhoto(input: Readonly<{ senderId: string; photo: PhonePhoto }>) {
    this.received.push(`${input.senderId}:${input.photo.filename}`);
    this.documentIds.add("synthetic-document-17");
    return Object.freeze({ documentId: "synthetic-document-17", documentType: "delivery_challan" as const, duplicate: this.received.length > 1 });
  }
}

class FakeReviewPort implements ReviewDecisionPort {
  readonly decisions: QueueDecision[] = [];
  async readDocument(documentId: string): Promise<QueueDocumentView | undefined> {
    return documentId === syntheticDocument.documentId ? syntheticDocument : undefined;
  }
  async decide(decision: QueueDecision): Promise<void> {
    this.decisions.push(decision);
  }
}

class FakeIgnoredRecorder implements IgnoredSenderRecorder {
  readonly ignored: Array<{ senderId: string; reason: "not_allowed" }> = [];
  async recordIgnoredSender(senderId: string, reason: "not_allowed"): Promise<void> {
    this.ignored.push({ senderId, reason });
  }
}

function configuredPhoneIntake() {
  const config = loadConfig({
    DATABASE_PATH: ":memory:",
    MODEL_PROVIDER: "local",
    MESSAGING_BOT_TOKEN: "synthetic-phone-token",
    MESSAGING_ALLOWED_SENDERS: "synthetic-driver-17",
  });
  const transport = new FakeTransport();
  const ingestion = new FakeStage3Pipeline();
  const review = new FakeReviewPort();
  const ignoredSenders = new FakeIgnoredRecorder();
  return { config, transport, ingestion, review, ignoredSenders };
}

describe("Stage 5 Piece B messaging phone intake", () => {
  test("routes an allowed synthetic photograph to the Stage 3 ingestion port and presents its classified review document", async () => {
    const dependencies = configuredPhoneIntake();
    expect(startPhoneIntake(dependencies)).toEqual({ available: true });

    await dependencies.transport.deliver({ kind: "photo", senderId: "synthetic-driver-17", photo: syntheticPhoto });

    expect(dependencies.ingestion.received).toEqual(["synthetic-driver-17:invented-driver-photo.jpg"]);
    expect(dependencies.transport.sent).toHaveLength(1);
    expect(dependencies.transport.sent[0]?.text).toContain("delivery_challan");
    expect(dependencies.transport.sent[0]?.text).toContain("Invented Quarry Supplies");
    expect(dependencies.transport.sent[0]?.text).toContain("Synthetic fixture");
    expect(dependencies.transport.sent[0]?.buttons?.map((button) => button.label)).toEqual(["मंज़ूर / Approve", "सुधार / Correct", "अस्वीकार / Reject"]);
  });

  test("attaches an exact duplicate synthetic photograph to the one document returned by Stage 3", async () => {
    const dependencies = configuredPhoneIntake();
    startPhoneIntake(dependencies);

    await dependencies.transport.deliver({ kind: "photo", senderId: "synthetic-driver-17", photo: syntheticPhoto });
    await dependencies.transport.deliver({ kind: "photo", senderId: "synthetic-driver-17", photo: syntheticPhoto });

    expect(dependencies.ingestion.received).toHaveLength(2);
    expect(dependencies.ingestion.documentIds).toEqual(new Set(["synthetic-document-17"]));
    expect(dependencies.transport.sent).toHaveLength(2);
  });

  test("ignores and records an unknown sender without replying or calling intake", async () => {
    const dependencies = configuredPhoneIntake();
    startPhoneIntake(dependencies);

    await dependencies.transport.deliver({ kind: "photo", senderId: "unknown-synthetic-sender", photo: syntheticPhoto });

    expect(dependencies.ignoredSenders.ignored).toEqual([{ senderId: "unknown-synthetic-sender", reason: "not_allowed" }]);
    expect(dependencies.ingestion.received).toEqual([]);
    expect(dependencies.transport.sent).toEqual([]);
  });

  test("is absent and does not attach a handler when no bot token is configured", async () => {
    const dependencies = configuredPhoneIntake();
    const withoutToken = loadConfig({ DATABASE_PATH: ":memory:", MODEL_PROVIDER: "local", MESSAGING_ALLOWED_SENDERS: "synthetic-driver-17" });

    expect(startPhoneIntake({ ...dependencies, config: withoutToken })).toEqual({ available: false });
    await dependencies.transport.deliver({ kind: "photo", senderId: "synthetic-driver-17", photo: syntheticPhoto });
    expect(dependencies.transport.handler).toBeUndefined();
    expect(dependencies.ingestion.received).toEqual([]);
  });

  test("sends approve, reject, and prompted one-value correction decisions through the injected shared queue API", async () => {
    const dependencies = configuredPhoneIntake();
    startPhoneIntake(dependencies);

    await dependencies.transport.deliver({ kind: "action", senderId: "synthetic-driver-17", action: { kind: "approve", reviewItemId: "synthetic-review-17", documentId: "synthetic-document-17" } });
    await dependencies.transport.deliver({ kind: "action", senderId: "synthetic-driver-17", action: { kind: "correct", reviewItemId: "synthetic-review-17", documentId: "synthetic-document-17", field: "vendor" } });
    expect(dependencies.transport.sent.at(-1)?.text).toContain("one replacement value for vendor");
    await dependencies.transport.deliver({ kind: "text", senderId: "synthetic-driver-17", text: "  Invented Quarry Revised  " });
    await dependencies.transport.deliver({ kind: "action", senderId: "synthetic-driver-17", action: { kind: "reject", reviewItemId: "synthetic-review-17", documentId: "synthetic-document-17" } });

    expect(dependencies.review.decisions).toEqual([
      { kind: "approve", reviewItemId: "synthetic-review-17", documentId: "synthetic-document-17", actorId: "synthetic-driver-17" },
      { kind: "correct", reviewItemId: "synthetic-review-17", documentId: "synthetic-document-17", actorId: "synthetic-driver-17", field: "vendor", value: "Invented Quarry Revised" },
      { kind: "reject", reviewItemId: "synthetic-review-17", documentId: "synthetic-document-17", actorId: "synthetic-driver-17" },
    ]);
  });
});
