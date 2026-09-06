import { Database } from "bun:sqlite";

import { ReviewQueue } from "../review/queue.ts";

/** All matching scores use basis points to keep selection and persisted output integer-exact. */
export const SCORE_REFERENCE_BASIS_POINTS = 5_000;
export const SCORE_EXACT_MONEY_BASIS_POINTS = 3_000;
export const SCORE_WITHIN_TOLERANCE_BASIS_POINTS = 2_000;
export const SCORE_DATE_CLOSE_BASIS_POINTS = 2_000;
export const SCORE_VENDOR_ID_BASIS_POINTS = 1_000;
export const MINIMUM_MATCH_SCORE_BASIS_POINTS = 5_000;
export const MATCH_MARGIN_BASIS_POINTS = 1_000;
export const DEFAULT_MAX_INVOICE_DELAY_DAYS = 31;
export const DEFAULT_DATE_CLOSE_DAYS = 7;
export const DEFAULT_MONEY_TOLERANCE_PAISE = 100;
export const MATCH_REVIEW_PRIORITY = 80;

export type SupplierInvoiceForMatch = Readonly<{
  id: string;
  sourceDocumentId: string;
  documentType: "supplier_invoice";
  vendorId?: string;
  vendorName: string;
  invoiceReference?: string;
  invoiceDate: string;
  amountPaise: number;
  quantityThousandths?: number;
}>;

export type MatchRun = Readonly<{
  invoices: readonly SupplierInvoiceForMatch[];
  matchedOn: string;
  reviewedAt: string;
  maxInvoiceDelayDays?: number;
  dateCloseDays?: number;
  moneyTolerancePaise?: number;
}>;

export type MatchReason = "reference" | "exact_money" | "within_tolerance" | "date_close" | "vendor_id" | "vendor_name_variant";
export type VarianceCause = "quantity_variance" | "rate_variance" | "cause_unknown";
export type MatchStatus = "exact" | "within_tolerance" | "variance";

export type MatchResult = Readonly<{
  invoiceId: string;
  accrualId: string | null;
  kind: "matched" | "unmatched" | "already_matched";
  reason?: "below_threshold" | "insufficient_margin" | "invoice_claimed" | "no_candidate";
  scoreBasisPoints: number;
  runnerUpScoreBasisPoints: number;
  reasons: readonly MatchReason[];
  status?: MatchStatus;
  variancePaise?: number;
  varianceCause?: VarianceCause;
}>;

type AccrualCandidate = Readonly<{
  id: string;
  vendor_id: string;
  vendor_name: string;
  paper_reference: string;
  amount_paise: number;
  quantity_thousandths: number;
  incurred_on: string;
}>;

type ExistingMatch = Readonly<{ accrual_id: string; status: MatchStatus; score_basis_points: number; variance_paise: number; variance_cause: VarianceCause | null }>;
type Proposal = Readonly<{ invoice: SupplierInvoiceForMatch; accrual: AccrualCandidate; scoreBasisPoints: number; runnerUpScoreBasisPoints: number; reasons: readonly MatchReason[] }>;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MILLISECONDS = 86_400_000;

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`${field} must not be empty`);
}

function assertSafeInteger(value: number, field: string, minimum = Number.MIN_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${field} must be a safe integer${minimum === 0 ? " that is not negative" : ""}`);
}

function assertDateOnly(value: string, field: string): void {
  if (!DATE_ONLY.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be a Gregorian YYYY-MM-DD date`);
  }
}

/** Lowercase, collapse whitespace, then strip non-alphanumerics as required by the vendor hard gate. */
export function normalizeVendorName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, " ").replace(/[^a-z0-9]/g, "");
}

/** Bounded Levenshtein distance; callers use it only after the documented length check. */
export function boundedEditDistance(left: string, right: string, bound = 2): number {
  if (Math.abs(left.length - right.length) > bound) return bound + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = current[0]!;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const next = Math.min(previous[rightIndex]! + 1, current[rightIndex - 1]! + 1,
        previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1));
      current.push(next);
      rowMinimum = Math.min(rowMinimum, next);
    }
    if (rowMinimum > bound) return bound + 1;
    previous = current;
  }
  return previous[right.length]!;
}

function dateDifferenceDays(later: string, earlier: string): number {
  return (Date.parse(`${later}T00:00:00.000Z`) - Date.parse(`${earlier}T00:00:00.000Z`)) / DAY_MILLISECONDS;
}

function namesPassGate(invoiceName: string, accrualName: string): boolean {
  const normalizedInvoice = normalizeVendorName(invoiceName);
  const normalizedAccrual = normalizeVendorName(accrualName);
  return normalizedInvoice === normalizedAccrual
    || (normalizedInvoice.length >= 6 && normalizedAccrual.length >= 6 && boundedEditDistance(normalizedInvoice, normalizedAccrual) <= 2);
}

function vendorPassesGate(invoice: SupplierInvoiceForMatch, accrual: AccrualCandidate): boolean {
  return invoice.vendorId !== undefined && invoice.vendorId === accrual.vendor_id
    || (invoice.vendorId === undefined && namesPassGate(invoice.vendorName, accrual.vendor_name));
}

function score(invoice: SupplierInvoiceForMatch, accrual: AccrualCandidate, options: Required<Pick<MatchRun, "dateCloseDays" | "moneyTolerancePaise">>): Readonly<{ scoreBasisPoints: number; reasons: readonly MatchReason[] }> {
  const reasons: MatchReason[] = [];
  let total = 0;
  if (invoice.invoiceReference !== undefined && invoice.invoiceReference.trim() === accrual.paper_reference) {
    total += SCORE_REFERENCE_BASIS_POINTS;
    reasons.push("reference");
  }
  const difference = invoice.amountPaise - accrual.amount_paise;
  if (difference === 0) {
    total += SCORE_EXACT_MONEY_BASIS_POINTS;
    reasons.push("exact_money");
  } else if (Math.abs(difference) <= options.moneyTolerancePaise) {
    total += SCORE_WITHIN_TOLERANCE_BASIS_POINTS;
    reasons.push("within_tolerance");
  }
  if (dateDifferenceDays(invoice.invoiceDate, accrual.incurred_on) <= options.dateCloseDays) {
    total += SCORE_DATE_CLOSE_BASIS_POINTS;
    reasons.push("date_close");
  }
  if (invoice.vendorId !== undefined && invoice.vendorId === accrual.vendor_id) {
    total += SCORE_VENDOR_ID_BASIS_POINTS;
    reasons.push("vendor_id");
  } else if (normalizeVendorName(invoice.vendorName) !== normalizeVendorName(accrual.vendor_name)) {
    reasons.push("vendor_name_variant");
  }
  return { scoreBasisPoints: Math.min(10_000, Math.max(0, total)), reasons };
}

function matchStatus(variancePaise: number, tolerancePaise: number): MatchStatus {
  if (variancePaise === 0) return "exact";
  return Math.abs(variancePaise) <= tolerancePaise ? "within_tolerance" : "variance";
}

function varianceCause(invoice: SupplierInvoiceForMatch, accrual: AccrualCandidate): VarianceCause {
  if (invoice.quantityThousandths === undefined) return "cause_unknown";
  return invoice.quantityThousandths !== accrual.quantity_thousandths ? "quantity_variance" : "rate_variance";
}

/**
 * Deterministically writes only Stage 7 match rows. It does not prepare or execute payment runs.
 */
export class ThreeWayMatcher {
  constructor(private readonly database: Database, private readonly reviewQueue: ReviewQueue) {}

  run(input: MatchRun): readonly MatchResult[] {
    const options = this.validate(input);
    const invoices = [...input.invoices].sort((left, right) => left.id.localeCompare(right.id));
    const results: MatchResult[] = [];
    this.database.transaction(() => {
      const accruals = this.database.query(`SELECT a.id, a.vendor_id, v.name AS vendor_name, a.paper_reference,
        a.amount_paise, a.quantity_thousandths, a.incurred_on FROM accruals a JOIN vendors v ON v.id = a.vendor_id
        WHERE a.status = 'incurred' ORDER BY a.id ASC`).all() as AccrualCandidate[];
      const proposals: Proposal[] = [];
      for (const invoice of invoices) {
        const existing = this.database.query(`SELECT accrual_id, status, score_basis_points, variance_paise, variance_cause
          FROM accrual_matches WHERE invoice_source_document_id = ?`).get(invoice.sourceDocumentId) as ExistingMatch | null;
        if (existing !== null) {
          results.push({ invoiceId: invoice.id, accrualId: existing.accrual_id, kind: "already_matched", scoreBasisPoints: existing.score_basis_points,
            runnerUpScoreBasisPoints: 0, reasons: [], status: existing.status, variancePaise: existing.variance_paise,
            varianceCause: existing.variance_cause ?? undefined });
          continue;
        }
        const scored = accruals.filter((accrual) => vendorPassesGate(invoice, accrual)
          && dateDifferenceDays(invoice.invoiceDate, accrual.incurred_on) >= 0
          && dateDifferenceDays(invoice.invoiceDate, accrual.incurred_on) <= options.maxInvoiceDelayDays)
          .map((accrual) => ({ accrual, ...score(invoice, accrual, options) }))
          .sort((left, right) => right.scoreBasisPoints - left.scoreBasisPoints || left.accrual.id.localeCompare(right.accrual.id));
        const best = scored[0];
        const runnerUp = scored[1]?.scoreBasisPoints ?? 0;
        if (best === undefined) {
          results.push(this.unmatched(invoice, null, "no_candidate", 0, 0, [], input.reviewedAt));
        } else if (best.scoreBasisPoints < MINIMUM_MATCH_SCORE_BASIS_POINTS) {
          results.push(this.unmatched(invoice, null, "below_threshold", best.scoreBasisPoints, runnerUp, best.reasons, input.reviewedAt));
        } else if (best.scoreBasisPoints - runnerUp < MATCH_MARGIN_BASIS_POINTS) {
          results.push(this.unmatched(invoice, null, "insufficient_margin", best.scoreBasisPoints, runnerUp, best.reasons, input.reviewedAt));
        } else {
          proposals.push({ invoice, accrual: best.accrual, scoreBasisPoints: best.scoreBasisPoints, runnerUpScoreBasisPoints: runnerUp, reasons: best.reasons });
        }
      }
      const claims = new Map<string, Proposal>();
      for (const proposal of proposals.sort((left, right) => right.scoreBasisPoints - left.scoreBasisPoints || left.accrual.id.localeCompare(right.accrual.id))) {
        const winner = claims.get(proposal.accrual.id);
        if (winner !== undefined) {
          results.push(this.unmatched(proposal.invoice, null, "invoice_claimed", proposal.scoreBasisPoints, proposal.runnerUpScoreBasisPoints, proposal.reasons, input.reviewedAt));
        } else {
          claims.set(proposal.accrual.id, proposal);
        }
      }
      for (const proposal of [...claims.values()].sort((left, right) => left.invoice.id.localeCompare(right.invoice.id))) {
        results.push(this.persist(proposal, options.moneyTolerancePaise, input.matchedOn, input.reviewedAt));
      }
    })();
    return results.sort((left, right) => left.invoiceId.localeCompare(right.invoiceId));
  }

  private validate(input: MatchRun): Required<Pick<MatchRun, "maxInvoiceDelayDays" | "dateCloseDays" | "moneyTolerancePaise">> {
    assertDateOnly(input.matchedOn, "matchedOn");
    const options = { maxInvoiceDelayDays: input.maxInvoiceDelayDays ?? DEFAULT_MAX_INVOICE_DELAY_DAYS,
      dateCloseDays: input.dateCloseDays ?? DEFAULT_DATE_CLOSE_DAYS, moneyTolerancePaise: input.moneyTolerancePaise ?? DEFAULT_MONEY_TOLERANCE_PAISE };
    for (const [field, value] of Object.entries(options)) assertSafeInteger(value, field, 0);
    const seen = new Set<string>();
    for (const invoice of input.invoices) {
      assertNonEmpty(invoice.id, "invoice id"); assertNonEmpty(invoice.sourceDocumentId, "invoice source document id");
      assertNonEmpty(invoice.vendorName, "invoice vendor name"); assertDateOnly(invoice.invoiceDate, "invoiceDate");
      assertSafeInteger(invoice.amountPaise, "invoice amountPaise");
      if (invoice.quantityThousandths !== undefined) assertSafeInteger(invoice.quantityThousandths, "invoice quantityThousandths", 0);
      if (invoice.documentType !== "supplier_invoice") throw new Error("only supplier_invoice documents may be matched");
      if (seen.has(invoice.sourceDocumentId)) throw new Error("each invoice source document may appear once per run");
      seen.add(invoice.sourceDocumentId);
    }
    return options;
  }

  private unmatched(invoice: SupplierInvoiceForMatch, accrualId: string | null, reason: NonNullable<MatchResult["reason"]>, scoreBasisPoints: number,
    runnerUpScoreBasisPoints: number, reasons: readonly MatchReason[], reviewedAt: string): MatchResult {
    this.enqueueOnce(`invoice-unmatched:${invoice.sourceDocumentId}`, invoice.sourceDocumentId,
      "Review this synthetic/simulated supplier invoice: it was not matched to an incurred accrual.",
      `Synthetic/simulated invoice ${invoice.sourceDocumentId}; reason ${reason}; score ${scoreBasisPoints}; runner-up ${runnerUpScoreBasisPoints}.`, reviewedAt);
    return { invoiceId: invoice.id, accrualId, kind: "unmatched", reason, scoreBasisPoints, runnerUpScoreBasisPoints, reasons };
  }

  private persist(proposal: Proposal, tolerancePaise: number, matchedOn: string, reviewedAt: string): MatchResult {
    const variancePaise = proposal.invoice.amountPaise - proposal.accrual.amount_paise;
    const status = matchStatus(variancePaise, tolerancePaise);
    const cause = status === "variance" ? varianceCause(proposal.invoice, proposal.accrual) : undefined;
    this.database.run(`INSERT INTO accrual_matches (id, accrual_id, invoice_source_document_id, score_basis_points, variance_paise, variance_cause, status, matched_on)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [`match:${proposal.accrual.id}:${proposal.invoice.sourceDocumentId}`, proposal.accrual.id,
      proposal.invoice.sourceDocumentId, proposal.scoreBasisPoints, variancePaise, cause ?? null, status, matchedOn]);
    this.database.run("UPDATE accruals SET status = 'invoiced' WHERE id = ? AND status = 'incurred'", [proposal.accrual.id]);
    if (status === "variance") this.enqueueOnce(`invoice-variance:${proposal.invoice.sourceDocumentId}`, proposal.invoice.sourceDocumentId,
      "Review this synthetic/simulated invoice variance before it can clear.",
      `Synthetic/simulated invoice ${proposal.invoice.sourceDocumentId}; accrual ${proposal.accrual.id}; signed variance ${variancePaise} paise; cause ${cause}; invoice quantity ${proposal.invoice.quantityThousandths ?? "absent"}; accrual quantity ${proposal.accrual.quantity_thousandths}.`, reviewedAt);
    return { invoiceId: proposal.invoice.id, accrualId: proposal.accrual.id, kind: "matched", scoreBasisPoints: proposal.scoreBasisPoints,
      runnerUpScoreBasisPoints: proposal.runnerUpScoreBasisPoints, reasons: proposal.reasons, status, variancePaise, varianceCause: cause };
  }

  private enqueueOnce(id: string, subjectId: string, decisionPrompt: string, evidence: string, createdAt: string): void {
    if (this.database.query("SELECT id FROM review_items WHERE id = ?").get(id) !== null) return;
    this.reviewQueue.enqueue({ id, subjectId, decisionPrompt, evidence, priority: MATCH_REVIEW_PRIORITY, createdAt });
  }
}
