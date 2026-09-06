import { Database } from "bun:sqlite";

import type { QueueDecision, QueueDocumentView, ReviewDecisionPort } from "../messaging/phone-intake.ts";

export type ReviewValue =
  | Readonly<{ kind: "text"; value: string }>
  | Readonly<{ kind: "money_paise"; value: number }>
  | Readonly<{ kind: "quantity_thousandths"; value: number }>
  | Readonly<{ kind: "rate_basis_points"; value: number }>;

export type EnqueueReviewItem = Readonly<{
  id: string;
  subjectId: string;
  decisionPrompt: string;
  evidence: string;
  priority: number;
  createdAt: string;
  extractedValue?: ReviewValue;
}>;

export type ReviewItem = Readonly<{
  id: string;
  subjectId: string;
  decisionPrompt: string;
  evidence: string;
  priority: number;
  createdAt: string;
  claimedBy: string;
  claimedAt: string;
}>;

export type Decision = Readonly<{
  outcome: "approve" | "correct" | "reject";
  decidedBy: string;
  decidedAt: string;
  correctedValue?: ReviewValue;
}>;

type StoredValue = Readonly<{
  value_kind: ReviewValue["kind"];
  value_text: string | null;
  value_integer: number | null;
  provenance: "automated" | "human";
}>;

const isNonEmptyString = (value: string): boolean => value.trim().length > 0;
const isSafeInteger = (value: number): boolean => Number.isSafeInteger(value);

function assertTimestamp(value: string, field: string): void {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${field} must be a canonical ISO-8601 timestamp`);
  }
}

function assertReviewValue(value: ReviewValue): void {
  if (value.kind === "text") {
    if (!isNonEmptyString(value.value)) throw new Error("text review values must not be empty");
    return;
  }
  if (!isSafeInteger(value.value)) throw new Error(`${value.kind} must be a safe integer`);
  if (value.kind === "quantity_thousandths" && value.value < 0) {
    throw new Error("quantity_thousandths must not be negative");
  }
  if (value.kind === "rate_basis_points" && (value.value < 0 || value.value > 10_000)) {
    throw new Error("rate_basis_points must be between 0 and 10000");
  }
}

function encodeValue(value: ReviewValue): readonly [ReviewValue["kind"], string | null, number | null] {
  assertReviewValue(value);
  return value.kind === "text"
    ? [value.kind, value.value, null]
    : [value.kind, null, value.value];
}

function decodeValue(value: StoredValue): ReviewValue {
  return value.value_kind === "text"
    ? { kind: "text", value: value.value_text! }
    : { kind: value.value_kind, value: value.value_integer! };
}

/**
 * Persistent, local-only review queue. Claiming is a single conditional UPDATE;
 * SQLite serializes competing writers so no two sessions can claim one item.
 */
export class ReviewQueue {
  constructor(private readonly database: Database) {
    // A competing writer waits for SQLite's atomic claim to finish, then claims the next item or none.
    this.database.exec("PRAGMA busy_timeout = 1000;");
  }

  enqueue(item: EnqueueReviewItem): void {
    if (![item.id, item.subjectId, item.decisionPrompt, item.evidence].every(isNonEmptyString)) {
      throw new Error("review item identifiers, prompt, and evidence must not be empty");
    }
    if (!isSafeInteger(item.priority)) throw new Error("priority must be a safe integer");
    assertTimestamp(item.createdAt, "createdAt");

    this.database.transaction(() => {
      this.database.run(
        `INSERT INTO review_items
          (id, subject_id, decision_prompt, evidence, priority, created_at, state)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        [item.id, item.subjectId, item.decisionPrompt, item.evidence, item.priority, item.createdAt],
      );
      if (item.extractedValue) this.writeAutomatedValue(item.id, item.extractedValue);
    })();
  }

  /** Returns highest priority first; ties resolve oldest-first, then id for exact timestamp ties. */
  claimNext(who: string, claimedAt: string): ReviewItem | null {
    if (!isNonEmptyString(who)) throw new Error("claimant must not be empty");
    assertTimestamp(claimedAt, "claimedAt");
    const row = this.database.query(`
      UPDATE review_items
      SET state = 'claimed', claimed_by = ?, claimed_at = ?
      WHERE id = (
        SELECT id FROM review_items
        WHERE state = 'pending'
        ORDER BY priority DESC, created_at ASC, id ASC
        LIMIT 1
      ) AND state = 'pending'
      RETURNING id, subject_id, decision_prompt, evidence, priority, created_at, claimed_by, claimed_at
    `).get(who, claimedAt) as Record<string, unknown> | null;
    return row === null ? null : {
      id: row.id as string, subjectId: row.subject_id as string,
      decisionPrompt: row.decision_prompt as string, evidence: row.evidence as string,
      priority: row.priority as number, createdAt: row.created_at as string,
      claimedBy: row.claimed_by as string, claimedAt: row.claimed_at as string,
    };
  }

  claim(itemId: string, who: string, claimedAt: string): boolean {
    if (!isNonEmptyString(itemId) || !isNonEmptyString(who)) throw new Error("item and claimant must not be empty");
    assertTimestamp(claimedAt, "claimedAt");
    return this.database.run(
      "UPDATE review_items SET state = 'claimed', claimed_by = ?, claimed_at = ? WHERE id = ? AND state = 'pending'",
      [who, claimedAt, itemId],
    ).changes === 1;
  }

  decide(itemId: string, decision: Decision): void {
    this.decideWithEffect(itemId, decision, () => {});
  }

  /** Records the existing audit row in the same local transaction as a reviewed state effect. */
  decideWithEffect(itemId: string, decision: Decision, effect: () => void): void {
    if (!isNonEmptyString(itemId) || !isNonEmptyString(decision.decidedBy)) {
      throw new Error("item and decision maker must not be empty");
    }
    assertTimestamp(decision.decidedAt, "decidedAt");
    if ((decision.outcome === "correct") !== (decision.correctedValue !== undefined)) {
      throw new Error("only a correction decision carries a corrected value");
    }

    this.database.transaction(() => {
      const updated = this.database.run(
        `UPDATE review_items
         SET state = 'decided', decision_outcome = ?, decided_by = ?, decided_at = ?
         WHERE id = ? AND state = 'claimed' AND claimed_by = ?`,
        [decision.outcome, decision.decidedBy, decision.decidedAt, itemId, decision.decidedBy],
      );
      if (updated.changes !== 1) throw new Error("review item must be claimed by the decision maker");

      const encoded = decision.correctedValue ? encodeValue(decision.correctedValue) : null;
      effect();
      if (decision.correctedValue) {
        this.database.run(
          `INSERT INTO review_values (review_item_id, value_kind, value_text, value_integer, provenance)
           VALUES (?, ?, ?, ?, 'human')
           ON CONFLICT(review_item_id) DO UPDATE SET
             value_kind = excluded.value_kind, value_text = excluded.value_text,
             value_integer = excluded.value_integer, provenance = 'human'`,
          [itemId, ...encoded!],
        );
      }
      this.database.run(
        `INSERT INTO review_decision_audit
          (review_item_id, outcome, corrected_value_kind, corrected_value_text, corrected_value_integer, decided_by, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [itemId, decision.outcome, ...(encoded ?? [null, null, null]), decision.decidedBy, decision.decidedAt],
      );
    })();
  }

  /** Later model extraction is retained only until a human has corrected this value. */
  recordAutomatedExtraction(itemId: string, value: ReviewValue): void {
    this.writeAutomatedValue(itemId, value);
  }

  private writeAutomatedValue(itemId: string, value: ReviewValue): void {
    const encoded = encodeValue(value);
    this.database.run(
      `INSERT INTO review_values (review_item_id, value_kind, value_text, value_integer, provenance)
       VALUES (?, ?, ?, ?, 'automated')
       ON CONFLICT(review_item_id) DO UPDATE SET
         value_kind = excluded.value_kind, value_text = excluded.value_text,
         value_integer = excluded.value_integer, provenance = 'automated'
       WHERE review_values.provenance = 'automated'`,
      [itemId, ...encoded],
    );
  }

  valueFor(itemId: string): Readonly<{ value: ReviewValue; provenance: "automated" | "human" }> | null {
    const row = this.database.query(
      "SELECT value_kind, value_text, value_integer, provenance FROM review_values WHERE review_item_id = ?",
    ).get(itemId) as StoredValue | null;
    return row === null ? null : { value: decodeValue(row), provenance: row.provenance };
  }

  documentFor(documentId: string): Readonly<{ id: string; documentId: string; decisionPrompt: string }> | null {
    const row = this.database.query(`
      SELECT id, subject_id, decision_prompt
      FROM review_items
      WHERE subject_id = ? AND state IN ('pending', 'claimed')
      ORDER BY priority DESC, created_at ASC, id ASC
      LIMIT 1
    `).get(documentId) as { id: string; subject_id: string; decision_prompt: string } | null;
    return row === null ? null : { id: row.id, documentId: row.subject_id, decisionPrompt: row.decision_prompt };
  }
}

/**
 * Adapts the persistent queue to the phone surface without giving transport code
 * direct database access. Each queue item exposes its single reviewed value as
 * `value`; a phone correction therefore cannot alter unrelated extracted facts.
 */
export class ReviewQueuePhoneAdapter implements ReviewDecisionPort {
  constructor(
    private readonly queue: ReviewQueue,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async readDocument(documentId: string): Promise<QueueDocumentView | undefined> {
    const row = this.queue.documentFor(documentId);
    if (row === null) return undefined;

    const stored = this.queue.valueFor(row.id);
    const values: Record<string, string> = stored === null ? {} : { value: String(stored.value.value) };
    return Object.freeze({
      reviewItemId: row.id,
      documentId: row.documentId,
      documentType: "review_item",
      values: Object.freeze(values),
      reviewReason: row.decisionPrompt,
    });
  }

  async decide(decision: QueueDecision): Promise<void> {
    const decidedAt = this.now();
    if (decision.kind === "approve" || decision.kind === "reject") {
      this.queue.decide(decision.reviewItemId, {
        outcome: decision.kind,
        decidedBy: decision.actorId,
        decidedAt,
      });
      return;
    }
    if (decision.field !== "value") throw new Error("phone corrections may replace only the queued value");
    const existing = this.queue.valueFor(decision.reviewItemId);
    if (existing === null) throw new Error("a correction needs an extracted value to replace");
    this.queue.decide(decision.reviewItemId, {
      outcome: "correct",
      correctedValue: phoneValue(existing.value.kind, decision.value),
      decidedBy: decision.actorId,
      decidedAt,
    });
  }
}

function phoneValue(kind: ReviewValue["kind"], value: string): ReviewValue {
  if (kind === "text") return { kind, value };
  if (!/^-?\d+$/.test(value)) throw new Error("numeric phone corrections must be integer units");
  const integer = Number(value);
  if (!Number.isSafeInteger(integer)) throw new Error("numeric phone corrections must be safe integers");
  return { kind, value: integer } as ReviewValue;
}
