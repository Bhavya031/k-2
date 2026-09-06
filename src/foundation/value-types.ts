/** Dependency-free vocabulary for values that cross finance boundaries. */

declare const moneyBrand: unique symbol;
declare const quantityBrand: unique symbol;
declare const rateBrand: unique symbol;
declare const confidenceBrand: unique symbol;
declare const documentBrand: unique symbol;
declare const recordedTimeBrand: unique symbol;
declare const skipReasonBrand: unique symbol;

export type Money = number & { readonly [moneyBrand]: "MoneyPaise" };
export type Quantity = number & { readonly [quantityBrand]: "QuantityThousandths" };
export type Rate = number & { readonly [rateBrand]: "RateBasisPoints" };
export type Confidence = number & { readonly [confidenceBrand]: "ConfidenceBasisPoints" };
export type DocumentId = string & { readonly [documentBrand]: "DocumentId" };
export type RecordedTime = string & { readonly [recordedTimeBrand]: "RecordedTime" };
export type SkipReason = string & { readonly [skipReasonBrand]: "SkipReason" };

export const MAX_BASIS_POINTS = 10_000;

export type ValidationIssue = Readonly<{
  field: string;
  message: string;
}>;

export type ValidationResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; issues: readonly ValidationIssue[] }>;

const valid = <T>(value: T): ValidationResult<T> => Object.freeze({ ok: true, value });
const invalid = <T>(field: string, message: string): ValidationResult<T> =>
  Object.freeze({ ok: false, issues: Object.freeze([{ field, message }]) });

const isInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

export function money(value: unknown): ValidationResult<Money> {
  return isInteger(value)
    ? valid(value as Money)
    : invalid("money", "must be a safe integer count of paise");
}

export function quantity(value: unknown): ValidationResult<Quantity> {
  if (!isInteger(value)) {
    return invalid("quantity", "must be a safe integer count of thousandths");
  }
  return value >= 0
    ? valid(value as Quantity)
    : invalid("quantity", "must not be negative");
}

function basisPoints<T>(field: string, value: unknown): ValidationResult<T> {
  if (!isInteger(value)) {
    return invalid(field, "must be a safe integer count of basis points");
  }
  return value >= 0 && value <= MAX_BASIS_POINTS
    ? valid(value as T)
    : invalid(field, `must be between 0 and ${MAX_BASIS_POINTS} basis points`);
}

export function rate(value: unknown): ValidationResult<Rate> {
  return basisPoints<Rate>("rate", value);
}

export function confidence(value: unknown): ValidationResult<Confidence> {
  return basisPoints<Confidence>("confidence", value);
}

export function documentId(value: unknown): ValidationResult<DocumentId> {
  return typeof value === "string" && value.trim().length > 0
    ? valid(value as DocumentId)
    : invalid("document", "must be a non-empty document identifier");
}

export function recordedTime(value: unknown): ValidationResult<RecordedTime> {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return valid(value.toISOString() as RecordedTime);
  }

  if (typeof value !== "string") {
    return invalid("recordedAt", "must be a valid canonical ISO-8601 timestamp");
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || value !== parsed.toISOString()) {
    return invalid("recordedAt", "must be a valid canonical ISO-8601 timestamp");
  }

  return valid(value as RecordedTime);
}

export type Provenance = Readonly<{
  document: DocumentId;
  page: number;
  confidence: Confidence;
  recordedAt: RecordedTime;
}>;

export type ProvenanceInput = Readonly<{
  document: unknown;
  page: unknown;
  confidence: unknown;
  recordedAt: unknown;
}>;

export function provenance(value: unknown): ValidationResult<Provenance> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("provenance", "must include document, page, confidence, and recordedAt");
  }

  const input = value as Partial<ProvenanceInput>;
  const source = documentId(input.document);
  const certainty = confidence(input.confidence);
  const time = recordedTime(input.recordedAt);
  const page = isInteger(input.page) && input.page >= 1
    ? valid(input.page)
    : invalid<number>("page", "must be a positive safe integer");
  const issues = [source, page, certainty, time].flatMap((result) =>
    result.ok ? [] : result.issues,
  );

  if (!source.ok || !page.ok || !certainty.ok || !time.ok) {
    return Object.freeze({ ok: false, issues: Object.freeze(issues) });
  }

  return valid(Object.freeze({
    document: source.value,
    page: page.value,
    confidence: certainty.value,
    recordedAt: time.value,
  }));
}

export type Fact<T> = Readonly<{
  value: T;
  provenance: Provenance;
}>;

/** A fact is constructed only after its source record has passed validation. */
export function fact<T>(value: T, source: unknown): ValidationResult<Fact<T>> {
  const validatedSource = provenance(source);
  return validatedSource.ok
    ? valid(Object.freeze({ value, provenance: validatedSource.value }))
    : validatedSource;
}

export type ProcessedItem<TInput, TOutput> = Readonly<{
  item: TInput;
  value: TOutput;
}>;

export type SkippedItem<TInput> = Readonly<{
  item: TInput;
  reason: SkipReason;
}>;

export type BulkOperationOutcome<TInput, TOutput> = Readonly<{
  processed: readonly ProcessedItem<TInput, TOutput>[];
  skipped: readonly SkippedItem<TInput>[];
}>;

export function skipReason(value: unknown): ValidationResult<SkipReason> {
  return typeof value === "string" && value.trim().length > 0
    ? valid(value as SkipReason)
    : invalid("reason", "must explicitly explain why an item was skipped");
}

export function skipped<TInput>(item: TInput, reason: unknown): ValidationResult<SkippedItem<TInput>> {
  const validatedReason = skipReason(reason);
  return validatedReason.ok
    ? valid(Object.freeze({ item, reason: validatedReason.value }))
    : validatedReason;
}

export function bulkOutcome<TInput, TOutput>(
  processed: readonly ProcessedItem<TInput, TOutput>[],
  skippedItems: readonly SkippedItem<TInput>[],
): BulkOperationOutcome<TInput, TOutput> {
  return Object.freeze({
    processed: Object.freeze([...processed]),
    skipped: Object.freeze([...skippedItems]),
  });
}
