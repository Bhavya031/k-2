import { Database } from "bun:sqlite";

import type { PaymentRunReviewDecision, PaymentRunReviewPort, PaymentRunView } from "../messaging/phone-intake.ts";
import { ReviewQueue } from "../review/queue.ts";

const paymentRunReviewItemId = (runId: string): string => `payment-run-approval:${runId}`;
const isSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

function integer(value: unknown, name: string): number {
  if (!isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
  return value;
}

function paymentRunItem(runId: string, reference: string, runOn: string) {
  return Object.freeze({
    id: paymentRunReviewItemId(runId),
    subjectId: runId,
    decisionPrompt: `Approve or reject prepared payment run ${reference} dated ${runOn}.`,
    evidence: `Synthetic/simulated prepared payment run ${reference}; approval prepares a file only and never moves money.`,
    priority: 100,
  });
}

/**
 * Local-only payment-run review adapter. It uses ReviewQueue for its decision
 * audit; its sole state effects are the documented draft/review/voided changes.
 */
export class PaymentRunPhoneReviewAdapter implements PaymentRunReviewPort {
  constructor(
    private readonly database: Database,
    private readonly queue: ReviewQueue,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async readPaymentRun(runId: string): Promise<PaymentRunView | undefined> {
    const run = this.database.query(`SELECT reference, run_on AS runOn, status FROM payment_runs WHERE id = ?`).get(runId) as {
      reference: string | null; runOn: string; status: string;
    } | null;
    if (run === null) return undefined;
    const rows = this.database.query(`
      SELECT p.status, p.gross_paise AS gross, p.tds_paise AS tds, p.retention_paise AS retention, p.net_paise AS net,
        a.vendor_id AS vendorId
      FROM payment_run_lines p JOIN accruals a ON a.id = p.accrual_id
      WHERE p.payment_run_id = ? ORDER BY p.id ASC
    `).all(runId) as Array<{ status: string; gross: unknown; tds: unknown; retention: unknown; net: unknown; vendorId: string }>;
    const totals = rows.reduce((total, row) => ({
      grossPaise: total.grossPaise + BigInt(integer(row.gross, "gross_paise")),
      tdsPaise: total.tdsPaise + BigInt(integer(row.tds, "tds_paise")),
      retentionPaise: total.retentionPaise + BigInt(integer(row.retention, "retention_paise")),
      netPaise: total.netPaise + BigInt(integer(row.net, "net_paise")),
    }), { grossPaise: 0n, tdsPaise: 0n, retentionPaise: 0n, netPaise: 0n });
    const held = rows.filter((row) => row.status === "held");
    const firstHeld = held[0];
    const hold = firstHeld === undefined ? null : this.database.query(`
      SELECT decision_prompt AS reason FROM review_items
      WHERE id = ?
    `).get(`payment-held:${runId}:${firstHeld.vendorId}`) as { reason: string } | null;
    return Object.freeze({
      runId,
      reference: run.reference ?? runId,
      runOn: run.runOn,
      status: run.status,
      vendorCount: new Set(rows.map((row) => row.vendorId)).size,
      lineCount: rows.length,
      heldLineCount: held.length,
      firstHoldReason: hold?.reason ?? (firstHeld === undefined ? undefined : "payment hold requires review"),
      ...totals,
    });
  }

  async decidePaymentRun(decision: PaymentRunReviewDecision): Promise<"approved" | "rejected" | "all_held" | "already_decided"> {
    const view = await this.readPaymentRun(decision.runId);
    if (view === undefined || view.status !== "draft") return "already_decided";
    if (decision.kind === "approve" && view.lineCount > 0 && view.heldLineCount === view.lineCount) return "all_held";

    const item = paymentRunItem(view.runId, view.reference, view.runOn);
    this.queue.enqueue({ ...item, createdAt: this.now() });
    if (!this.queue.claim(item.id, decision.actorId, this.now())) return "already_decided";
    this.queue.decideWithEffect(item.id, {
      outcome: decision.kind,
      decidedBy: decision.actorId,
      decidedAt: this.now(),
    }, () => {
      if (decision.kind === "approve") {
        const lines = this.database.run("UPDATE payment_run_lines SET status = 'approved' WHERE payment_run_id = ? AND status = 'draft'", [decision.runId]);
        if (lines.changes === 0) throw new Error("payment run has no draft lines to approve");
        const run = this.database.run("UPDATE payment_runs SET status = 'review' WHERE id = ? AND status = 'draft'", [decision.runId]);
        if (run.changes !== 1) throw new Error("payment run was already decided");
        return;
      }
      const run = this.database.run("UPDATE payment_runs SET status = 'voided' WHERE id = ? AND status = 'draft'", [decision.runId]);
      if (run.changes !== 1) throw new Error("payment run was already decided");
    });
    return decision.kind === "approve" ? "approved" : "rejected";
  }
}
