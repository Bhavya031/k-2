import { Database } from "bun:sqlite";
import { ReviewQueue, type ReviewValue } from "../review/queue.ts";
import { inr } from "../report/report.ts";

const integer = (value: unknown, name: string): number => { if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`); return value; };
export type ReviewDetail = Readonly<{ id: string; subjectId: string; prompt: string; evidence: string; priority: number; state: string; claimedBy: string | null; deliveryDocumentId: string | null; invoiceDocumentId: string | null; variancePaise: number | null; cause: string | null; valueKind: string | null; value: string | null }>;

export function reviewDetails(database: Database): readonly ReviewDetail[] {
  return (database.query(`SELECT r.id,r.subject_id AS subjectId,r.decision_prompt AS prompt,r.evidence,r.priority,r.state,r.claimed_by AS claimedBy,
    a.source_document_id AS deliveryDocumentId, m.invoice_source_document_id AS invoiceDocumentId,m.variance_paise AS variancePaise,m.variance_cause AS cause,
    rv.value_kind AS valueKind,COALESCE(rv.value_text,CAST(rv.value_integer AS TEXT)) AS value
    FROM review_items r LEFT JOIN accrual_matches m ON m.invoice_source_document_id=r.subject_id
    LEFT JOIN accruals a ON a.id=m.accrual_id LEFT JOIN review_values rv ON rv.review_item_id=r.id
    WHERE r.state IN ('pending','claimed') ORDER BY r.priority DESC,r.created_at,r.id`).all() as Array<Record<string, unknown>>).map((row) => Object.freeze({
      id: row.id as string, subjectId: row.subjectId as string, prompt: row.prompt as string, evidence: row.evidence as string, priority: integer(row.priority,"priority"), state: row.state as string, claimedBy: row.claimedBy as string | null,
      deliveryDocumentId: row.deliveryDocumentId as string | null, invoiceDocumentId: (row.invoiceDocumentId as string | null) ?? row.subjectId as string, variancePaise: row.variancePaise === null ? null : integer(row.variancePaise,"variancePaise"), cause: row.cause as string | null, valueKind: row.valueKind as string | null, value: row.value as string | null,
    }));
}
export function reviewValue(kind: unknown, value: unknown): ReviewValue {
  if (kind === "text") { if (typeof value !== "string" || value.trim() === "") throw new Error("text correction must not be empty"); return { kind, value: value.trim() }; }
  if (kind !== "money_paise" && kind !== "quantity_thousandths" && kind !== "rate_basis_points") throw new Error("correction field must be a queued field");
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) throw new Error("numeric correction must be an integer");
  const number = Number(value); integer(number,"correction"); return { kind, value: number };
}
export function decideReview(queue: ReviewQueue, input: Readonly<{ itemId: string; actor: string; outcome: "approve"|"reject"|"correct"; kind?: unknown; value?: unknown }>): void {
  const correctedValue = input.outcome === "correct" ? reviewValue(input.kind,input.value) : undefined;
  queue.decide(input.itemId,{ outcome: input.outcome, decidedBy: input.actor, decidedAt: new Date().toISOString(), ...(correctedValue === undefined ? {} : { correctedValue }) });
}
export function varianceLabel(detail: ReviewDetail): string { return detail.variancePaise === null ? "No monetary variance recorded" : `${inr(detail.variancePaise)} signed difference · ${detail.cause === "quantity_variance" ? "Quantity differs between documents" : detail.cause === "rate_variance" ? "Agreed rate differs" : "Difference needs human review"}`; }
