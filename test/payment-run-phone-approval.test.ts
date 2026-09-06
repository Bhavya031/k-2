import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config.ts";
import {
  sendPaymentRunApprovalMessage,
  startPhoneIntake,
  type IgnoredSenderRecorder,
  type MessagingTransport,
  type PhoneInbound,
  type PhoneMessage,
  type Stage3PhotoIngestionPort,
} from "../src/messaging/phone-intake.ts";
import { PaymentRunPhoneReviewAdapter } from "../src/payments/approval.ts";
import { ReviewQueue, ReviewQueuePhoneAdapter } from "../src/review/queue.ts";
import { migrateStore } from "../src/store/schema.ts";

const TIME = "2026-09-06T12:02:00.000Z";
const ALLOWED = "synthetic-accountant-33";

class SyntheticTransport implements MessagingTransport {
  handler: ((message: PhoneInbound) => Promise<void>) | undefined;
  readonly sent: PhoneMessage[] = [];
  receive(handler: (message: PhoneInbound) => Promise<void>): void { this.handler = handler; }
  async send(message: PhoneMessage): Promise<void> { this.sent.push(message); }
  async deliver(message: PhoneInbound): Promise<void> { await this.handler?.(message); }
}

class SyntheticIngestion implements Stage3PhotoIngestionPort {
  async ingestPhoto() { return { documentId: "synthetic-document-unused", documentType: "delivery_challan" as const, duplicate: false }; }
}

class SyntheticIgnoredSenders implements IgnoredSenderRecorder {
  readonly records: string[] = [];
  async recordIgnoredSender(senderId: string): Promise<void> { this.records.push(senderId); }
}

function setup(options: Readonly<{ allHeld?: boolean; oneHeld?: boolean }> = {}) {
  const database = new Database(":memory:");
  migrateStore(database);
  const queue = new ReviewQueue(database);
  const runId = "synthetic-run-33";
  database.run("INSERT INTO payment_runs (id, run_on, reference, status) VALUES (?, ?, ?, 'draft')", [runId, "2026-09-06", "SYNTHETIC-APR-33"]);
  for (const [number, status] of [[1, options.allHeld || options.oneHeld ? "held" : "draft"], [2, options.allHeld ? "held" : "draft"]] as const) {
    const vendorId = `synthetic-vendor-${number}`;
    const documentId = `synthetic-document-${number}`;
    const accrualId = `synthetic-accrual-${number}`;
    database.run("INSERT INTO vendors (id, name, status) VALUES (?, ?, 'active')", [vendorId, `Synthetic Vendor ${number}`]);
    database.run("INSERT INTO source_documents (id, vendor_id, document_status) VALUES (?, ?, 'classified')", [documentId, vendorId]);
    database.run("INSERT INTO accruals (id, vendor_id, source_document_id, paper_reference, incurred_on, quantity_thousandths, unit, amount_paise, status, extraction_confidence_basis_points) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'invoiced', ?)", [accrualId, vendorId, documentId, `SYN-${number}`, "2026-09-01", 1_000, "tonnes", number === 1 ? 12_345 : 20_000, 10_000]);
    database.run("INSERT INTO payment_run_lines (id, payment_run_id, accrual_id, gross_paise, tds_paise, retention_paise, net_paise, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [`synthetic-line-${number}`, runId, accrualId, number === 1 ? 12_345 : 20_000, number === 1 ? 345 : 0, number === 1 ? 500 : 1_000, number === 1 ? 11_500 : 19_000, status]);
    if (status === "held") queue.enqueue({ id: `payment-held:${runId}:${vendorId}`, subjectId: vendorId, decisionPrompt: `Resolve payment hold: synthetic missing bank detail ${number}.`, evidence: "Synthetic/simulated hold fixture.", priority: 90, createdAt: TIME });
  }
  const transport = new SyntheticTransport();
  const ignored = new SyntheticIgnoredSenders();
  const paymentRuns = new PaymentRunPhoneReviewAdapter(database, queue, () => TIME);
  startPhoneIntake({
    config: loadConfig({ DATABASE_PATH: ":memory:", MODEL_PROVIDER: "local", MESSAGING_BOT_TOKEN: "synthetic-token", MESSAGING_ALLOWED_SENDERS: ALLOWED }),
    transport,
    ingestion: new SyntheticIngestion(),
    review: new ReviewQueuePhoneAdapter(queue, () => TIME),
    paymentRuns,
    ignoredSenders: ignored,
  });
  return { database, queue, transport, ignored, paymentRuns, runId };
}

describe("payment-run phone approval", () => {
  test("renders the synthetic reference and integer-paise net with only the required bilingual buttons", async () => {
    const fixture = setup({ oneHeld: true });
    expect(await sendPaymentRunApprovalMessage({
      config: loadConfig({ DATABASE_PATH: ":memory:", MODEL_PROVIDER: "local", MESSAGING_BOT_TOKEN: "synthetic-token", MESSAGING_ALLOWED_SENDERS: ALLOWED }),
      transport: fixture.transport, review: fixture.paymentRuns, recipientId: ALLOWED, paymentRunId: fixture.runId,
    })).toBe(true);
    const message = fixture.transport.sent[0]!;
    expect(message.text).toContain("SYNTHETIC-APR-33");
    expect(message.text).toContain("Net payable: ₹305.00");
    expect(message.text).toContain("Held lines: 1");
    expect(message.text).toContain("synthetic missing bank detail 1");
    expect(message.text).toContain("Approval prepares a file only; no money moves; a person sends it.");
    expect(message.buttons?.map((button) => button.label)).toEqual(["मंज़ूर / Approve", "अस्वीकार / Reject"]);
  });

  test("approves only draft lines, changes the draft run to review, and records its existing review audit", async () => {
    const fixture = setup({ oneHeld: true });
    await fixture.transport.deliver({ kind: "action", senderId: ALLOWED, action: { kind: "approve_payment_run", paymentRunId: fixture.runId } });
    expect(fixture.database.query("SELECT status FROM payment_runs WHERE id = ?").get(fixture.runId)).toEqual({ status: "review" });
    expect(fixture.database.query("SELECT id, status FROM payment_run_lines ORDER BY id").all()).toEqual([{ id: "synthetic-line-1", status: "held" }, { id: "synthetic-line-2", status: "approved" }]);
    expect(fixture.database.query("SELECT outcome, decided_by AS actor, decided_at AS time FROM review_decision_audit WHERE review_item_id = ?").get(`payment-run-approval:${fixture.runId}`)).toEqual({ outcome: "approve", actor: ALLOWED, time: TIME });
  });

  test("refuses approval of an all-held run without changing its draft state", async () => {
    const fixture = setup({ allHeld: true });
    await fixture.transport.deliver({ kind: "action", senderId: ALLOWED, action: { kind: "approve_payment_run", paymentRunId: fixture.runId } });
    expect(fixture.transport.sent.at(-1)?.text).toContain("all lines are held");
    expect(fixture.database.query("SELECT status FROM payment_runs WHERE id = ?").get(fixture.runId)).toEqual({ status: "draft" });
    expect(fixture.database.query("SELECT status FROM payment_run_lines ORDER BY id").all()).toEqual([{ status: "held" }, { status: "held" }]);
  });

  test("rejects a run by voiding only the run and leaving all lines intact", async () => {
    const fixture = setup({ oneHeld: true });
    await fixture.transport.deliver({ kind: "action", senderId: ALLOWED, action: { kind: "reject_payment_run", paymentRunId: fixture.runId } });
    expect(fixture.database.query("SELECT status FROM payment_runs WHERE id = ?").get(fixture.runId)).toEqual({ status: "voided" });
    expect(fixture.database.query("SELECT status FROM payment_run_lines ORDER BY id").all()).toEqual([{ status: "held" }, { status: "draft" }]);
  });

  test("replies already decided on a second press and leaves state and audit unchanged", async () => {
    const fixture = setup();
    const action = { kind: "approve_payment_run" as const, paymentRunId: fixture.runId };
    await fixture.transport.deliver({ kind: "action", senderId: ALLOWED, action });
    const before = fixture.database.query("SELECT status FROM payment_run_lines ORDER BY id").all();
    await fixture.transport.deliver({ kind: "action", senderId: ALLOWED, action });
    expect(fixture.transport.sent.at(-1)?.text).toContain("Already decided");
    expect(fixture.database.query("SELECT status FROM payment_run_lines ORDER BY id").all()).toEqual(before);
    expect(fixture.database.query("SELECT count(*) AS count FROM review_decision_audit WHERE review_item_id = ?").get(`payment-run-approval:${fixture.runId}`)).toEqual({ count: 1 });
  });

  test("records an unauthorized payment-run sender without output or state change", async () => {
    const fixture = setup();
    await fixture.transport.deliver({ kind: "action", senderId: "unauthorized-synthetic-33", action: { kind: "approve_payment_run", paymentRunId: fixture.runId } });
    expect(fixture.ignored.records).toEqual(["unauthorized-synthetic-33"]);
    expect(fixture.transport.sent).toEqual([]);
    expect(fixture.database.query("SELECT status FROM payment_runs WHERE id = ?").get(fixture.runId)).toEqual({ status: "draft" });
    expect(fixture.database.query("SELECT status FROM payment_run_lines ORDER BY id").all()).toEqual([{ status: "draft" }, { status: "draft" }]);
  });
});
