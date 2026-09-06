import { Database } from "bun:sqlite";

import { ReviewQueue } from "../review/queue.ts";

export const PRINTED_AMOUNT_TOLERANCE_PAISE = 1;
export const VENDOR_RATE_REVIEW_PRIORITY = 100;
export const DELIVERY_DATA_REVIEW_PRIORITY = 50;
export const PRINTED_AMOUNT_REVIEW_PRIORITY = 75;

export type MissingAccrualReason = "missing vendor" | "missing reference" | "missing date" | "missing quantity" | "missing rate";

export type DeliveryForAccrual = Readonly<{
  id: string;
  sourceDocumentId: string;
  vendorId?: string;
  paperReference?: string;
  printedAmountPaise?: number;
  quantityThousandths?: number;
  unit?: string;
  incurredOn?: string;
  extractionConfidenceBasisPoints: number;
  reviewedAt: string;
}>;

export type AccrualResult =
  | Readonly<{ kind: "accrued"; accrualId: string; amountPaise: number }>
  | Readonly<{ kind: "already-accrued"; accrualId: string }>
  | Readonly<{ kind: "skipped"; reason: MissingAccrualReason; reviewItemId: string }>;

type Terms = Readonly<{ rate_paise_per_tonne: number }>;
type AccrualRow = Readonly<{ id: string }>;

const isSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const nonEmpty = (value: string | undefined): value is string => value !== undefined && value.trim().length > 0;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function assertDateOnly(value: string, field: string): void {
  if (!DATE_ONLY.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be a Gregorian YYYY-MM-DD date`);
  }
}

function assertInteger(value: unknown, field: string, minimum = Number.MIN_SAFE_INTEGER): asserts value is number {
  if (!isSafeInteger(value) || value < minimum) throw new Error(`${field} must be a safe integer${minimum === 0 ? " that is not negative" : ""}`);
}

/** Formula is intentionally one integer division: thousandths of a tonne times paise per tonne. */
export function priceAccrual(quantityMilli: number, ratePaisePerTonne: number): number {
  assertInteger(quantityMilli, "quantityThousandths", 0);
  assertInteger(ratePaisePerTonne, "ratePaisePerTonne", 0);
  const price = (BigInt(quantityMilli) * BigInt(ratePaisePerTonne)) / 1000n;
  if (price > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("accrual amount exceeds safe integer range");
  return Number(price);
}

function missingReason(delivery: DeliveryForAccrual, rateAvailable: boolean): MissingAccrualReason | undefined {
  if (!nonEmpty(delivery.vendorId)) return "missing vendor";
  if (!nonEmpty(delivery.paperReference)) return "missing reference";
  if (!nonEmpty(delivery.incurredOn)) return "missing date";
  if (delivery.quantityThousandths === undefined) return "missing quantity";
  if (!rateAvailable) return "missing rate";
  return undefined;
}

function reviewDetails(reason: MissingAccrualReason): Readonly<{ priority: number; prompt: string }> {
  if (reason === "missing rate") return {
    priority: VENDOR_RATE_REVIEW_PRIORITY,
    prompt: "Set the agreed vendor rate per tonne before this delivery can be accrued.",
  };
  return {
    priority: DELIVERY_DATA_REVIEW_PRIORITY,
    prompt: `Provide the ${reason} for this delivery before it can be accrued.`,
  };
}

/**
 * Books delivery costs with deterministic arithmetic. It never calls a model and
 * uses the existing ReviewQueue for every missing delivery fact or disagreement.
 */
export class AccrualLedger {
  constructor(private readonly database: Database, private readonly reviewQueue: ReviewQueue) {}

  accrue(delivery: DeliveryForAccrual): AccrualResult {
    if (!nonEmpty(delivery.id) || !nonEmpty(delivery.sourceDocumentId)) throw new Error("delivery and source document identifiers must not be empty");
    assertInteger(delivery.extractionConfidenceBasisPoints, "extractionConfidenceBasisPoints", 0);
    if (delivery.extractionConfidenceBasisPoints > 10_000) throw new Error("extractionConfidenceBasisPoints must not exceed 10000");
    if (delivery.quantityThousandths !== undefined) assertInteger(delivery.quantityThousandths, "quantityThousandths", 0);
    if (delivery.printedAmountPaise !== undefined) assertInteger(delivery.printedAmountPaise, "printedAmountPaise");
    if (nonEmpty(delivery.incurredOn)) assertDateOnly(delivery.incurredOn, "incurredOn");

    const already = this.database.query("SELECT id FROM accruals WHERE source_document_id = ?").get(delivery.sourceDocumentId) as AccrualRow | null;
    if (already !== null) return { kind: "already-accrued", accrualId: already.id };

    const terms = nonEmpty(delivery.vendorId)
      ? this.database.query("SELECT rate_paise_per_tonne FROM vendor_terms WHERE vendor_id = ?").get(delivery.vendorId) as Terms | null
      : null;
    const reason = missingReason(delivery, terms !== null);
    if (reason !== undefined) return this.skipWithReview(delivery, reason);

    // The precedence check above establishes these are present, and DB foreign keys establish their identities.
    const amountPaise = priceAccrual(delivery.quantityThousandths!, terms!.rate_paise_per_tonne);
    this.database.transaction(() => {
      this.database.run(
        `INSERT INTO accruals
          (id, source_document_id, vendor_id, paper_reference, amount_paise, printed_amount_paise,
           quantity_thousandths, unit, incurred_on, status, extraction_confidence_basis_points)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'incurred', ?)`,
        [delivery.id, delivery.sourceDocumentId, delivery.vendorId!, delivery.paperReference!.trim(), amountPaise,
          delivery.printedAmountPaise ?? null, delivery.quantityThousandths!, delivery.unit?.trim() || "tonne",
          delivery.incurredOn!, delivery.extractionConfidenceBasisPoints],
      );
      if (delivery.printedAmountPaise !== undefined && Math.abs(delivery.printedAmountPaise - amountPaise) > PRINTED_AMOUNT_TOLERANCE_PAISE) {
        this.enqueueOnce(`printed-discrepancy:${delivery.sourceDocumentId}`, delivery.sourceDocumentId,
          "Review the printed delivery amount: it differs from the agreed-rate accrual by more than 1 paise.",
          `Printed amount ${delivery.printedAmountPaise} paise; computed agreed-rate amount ${amountPaise} paise.`,
          PRINTED_AMOUNT_REVIEW_PRIORITY, delivery.reviewedAt);
      }
    })();
    return { kind: "accrued", accrualId: delivery.id, amountPaise };
  }

  private skipWithReview(delivery: DeliveryForAccrual, reason: MissingAccrualReason): AccrualResult {
    const details = reviewDetails(reason);
    const reviewItemId = `accrual-missing:${delivery.sourceDocumentId}`;
    this.enqueueOnce(reviewItemId, delivery.sourceDocumentId, details.prompt,
      `Synthetic/simulated delivery ${delivery.sourceDocumentId} is missing ${reason}; no accrual was created.`,
      details.priority, delivery.reviewedAt);
    return { kind: "skipped", reason, reviewItemId };
  }

  private enqueueOnce(id: string, subjectId: string, decisionPrompt: string, evidence: string, priority: number, createdAt: string): void {
    const existing = this.database.query("SELECT id FROM review_items WHERE id = ?").get(id);
    if (existing !== null) return;
    this.reviewQueue.enqueue({ id, subjectId, decisionPrompt, evidence, priority, createdAt });
  }
}

export type VendorTerms = Readonly<{
  vendorId: string;
  ratePaisePerTonne: number;
  effectiveOn: string;
  tdsSection: string;
  tdsRateBasisPoints: number;
  retentionBasisPoints: number;
  paymentDays: number;
  beneficiaryName?: string;
  beneficiaryAccountNumber?: string;
  beneficiaryIfsc?: string;
  beneficiaryBankName?: string;
}>;

/** Stores the single currently agreed term set for a vendor. */
export function saveVendorTerms(database: Database, terms: VendorTerms): void {
  if (!nonEmpty(terms.vendorId) || !nonEmpty(terms.tdsSection)) throw new Error("vendor and TDS section must not be empty");
  assertDateOnly(terms.effectiveOn, "effectiveOn");
  assertInteger(terms.ratePaisePerTonne, "ratePaisePerTonne", 0);
  assertInteger(terms.tdsRateBasisPoints, "tdsRateBasisPoints", 0);
  assertInteger(terms.retentionBasisPoints, "retentionBasisPoints", 0);
  assertInteger(terms.paymentDays, "paymentDays", 0);
  if (terms.tdsRateBasisPoints > 10_000 || terms.retentionBasisPoints > 10_000) throw new Error("basis point rates must not exceed 10000");
  database.run(
    `INSERT INTO vendor_terms (vendor_id, rate_paise_per_tonne, effective_on, tds_section, tds_rate_basis_points,
      retention_basis_points, payment_days, beneficiary_name, beneficiary_account_number, beneficiary_ifsc, beneficiary_bank_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(vendor_id) DO UPDATE SET rate_paise_per_tonne = excluded.rate_paise_per_tonne,
      effective_on = excluded.effective_on, tds_section = excluded.tds_section,
      tds_rate_basis_points = excluded.tds_rate_basis_points, retention_basis_points = excluded.retention_basis_points,
      payment_days = excluded.payment_days, beneficiary_name = excluded.beneficiary_name,
      beneficiary_account_number = excluded.beneficiary_account_number, beneficiary_ifsc = excluded.beneficiary_ifsc,
      beneficiary_bank_name = excluded.beneficiary_bank_name`,
    [terms.vendorId, terms.ratePaisePerTonne, terms.effectiveOn, terms.tdsSection.trim(), terms.tdsRateBasisPoints,
      terms.retentionBasisPoints, terms.paymentDays, terms.beneficiaryName ?? null, terms.beneficiaryAccountNumber ?? null,
      terms.beneficiaryIfsc ?? null, terms.beneficiaryBankName ?? null],
  );
}
