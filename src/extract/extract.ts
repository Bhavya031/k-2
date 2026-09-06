import {
  confidence,
  documentId,
  fact,
  money,
  quantity,
  type Confidence,
  type DocumentId,
  type Fact,
  type Money,
  type ProvenanceInput,
  type Quantity,
} from "../foundation/value-types.ts";
import { askStructured, type BoundaryResult, type LabelledImage, type StructuredProvider, type StructuredSchema, type ValidationIssue } from "../model/boundary.ts";

/** Document types supported by the extraction half of Stage 4. */
export const extractionDocumentTypes = ["royalty_pass", "delivery_challan", "supplier_invoice", "tender_notice"] as const;
export type ExtractionDocumentType = (typeof extractionDocumentTypes)[number];

/** Fields a model may return for each supported document type. */
export const extractionFields = Object.freeze({
  royalty_pass: Object.freeze(["passNumber", "passDate", "quarryOrVendor", "netWeight", "vehicle", "amount"]),
  delivery_challan: Object.freeze(["challanNumber", "challanDate", "vendor", "quantity", "vehicle"]),
  supplier_invoice: Object.freeze(["invoiceNumber", "invoiceDate", "vendor", "amount", "taxAmounts", "supplierBankDetails"]),
  tender_notice: Object.freeze(["noticeNumber", "issuingOffice", "workItems", "dates"]),
} satisfies Record<ExtractionDocumentType, readonly string[]>);

type PageFacts<T> = { readonly [Field in keyof T]?: Fact<T[Field]> };
type RolledFacts<T> = { readonly [Field in keyof T]?: RolledField<T[Field]> };
type RawPageFields<T> = { readonly [Field in keyof T]?: T[Field] };

export type SupplierBankDetails = Readonly<{
  accountNumber?: string;
  ifscCode?: string;
  bankName?: string;
  branch?: string;
}>;

export type RoyaltyPassFields = Readonly<{
  passNumber: string;
  passDate: string;
  quarryOrVendor: string;
  netWeight: Quantity;
  vehicle: string;
  amount: Money;
}>;
export type DeliveryChallanFields = Readonly<{
  challanNumber: string;
  challanDate: string;
  vendor: string;
  quantity: Quantity;
  vehicle: string;
}>;
export type SupplierInvoiceFields = Readonly<{
  invoiceNumber: string;
  invoiceDate: string;
  vendor: string;
  amount: Money;
  taxAmounts: Readonly<Record<string, Money>>;
  supplierBankDetails: SupplierBankDetails;
}>;
export type TenderNoticeFields = Readonly<{
  noticeNumber: string;
  issuingOffice: string;
  workItems: readonly string[];
  dates: readonly string[];
}>;

export type FieldsFor<Type extends ExtractionDocumentType> =
  Type extends "royalty_pass" ? RoyaltyPassFields
    : Type extends "delivery_challan" ? DeliveryChallanFields
      : Type extends "supplier_invoice" ? SupplierInvoiceFields
        : TenderNoticeFields;

export type ExtractedPage<Type extends ExtractionDocumentType> = Readonly<{
  document: DocumentId;
  documentType: Type;
  fields: PageFacts<FieldsFor<Type>>;
}>;

export type PageExtractionRequest<Type extends ExtractionDocumentType> = Readonly<{
  document: unknown;
  documentType: Type;
  page: unknown;
  confidenceBasisPoints: unknown;
  recordedAt: unknown;
  image: LabelledImage;
}>;

export type RolledField<T> = Readonly<{
  values: readonly Fact<T>[];
  /** Present only when the pages show more than one distinct value. */
  disagreement?: true;
}>;

export type FieldDisagreement = Readonly<{ field: string }>;
export type RolledDocument<Type extends ExtractionDocumentType> = Readonly<{
  document: DocumentId;
  documentType: Type;
  fields: RolledFacts<FieldsFor<Type>>;
  disagreements: readonly FieldDisagreement[];
}>;

type RawRoyaltyPassFields = Omit<RoyaltyPassFields, "netWeight" | "amount"> & { netWeight: Quantity; amount: Money };
type RawDeliveryChallanFields = Omit<DeliveryChallanFields, "quantity"> & { quantity: Quantity };
type RawSupplierInvoiceFields = SupplierInvoiceFields;
type RawTenderNoticeFields = TenderNoticeFields;
type RawFields<Type extends ExtractionDocumentType> =
  Type extends "royalty_pass" ? RawRoyaltyPassFields
    : Type extends "delivery_challan" ? RawDeliveryChallanFields
      : Type extends "supplier_invoice" ? RawSupplierInvoiceFields
        : RawTenderNoticeFields;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function optionalText(input: Record<string, unknown>, key: string, errors: ValidationIssue[]): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push({ path: key, message: "must be a non-empty string when shown" });
    return undefined;
  }
  return value.trim();
}

function optionalTextList(input: Record<string, unknown>, key: string, errors: ValidationIssue[]): readonly string[] | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    errors.push({ path: key, message: "must be a non-empty list of non-empty strings when shown" });
    return undefined;
  }
  return Object.freeze(value.map((item) => (item as string).trim()));
}

/** Converts only an exact printed whole-kilogram weight into thousandths of a tonne. */
export function printedKilogramsToQuantity(value: unknown): Quantity | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{1,3}(?:,\d{3})*|\d+)\s*kg$/i.exec(value.trim());
  if (match === null) return undefined;
  const kilograms = Number(match[1].replaceAll(",", ""));
  const checked = quantity(kilograms);
  return checked.ok ? checked.value : undefined;
}

/** Converts printed rupees-and-paise text to an exact safe integer paise count. */
export function printedAmountToPaise(value: unknown): Money | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(?:₹\s*|INR\s*)?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/i.exec(value.trim());
  if (match === null) return undefined;
  const rupees = match[1].replaceAll(",", "");
  const paise = (match[2] ?? "").padEnd(2, "0");
  const exactIntegerText = `${rupees}${paise}`;
  const checked = money(Number(exactIntegerText));
  return checked.ok ? checked.value : undefined;
}

function optionalQuantity(input: Record<string, unknown>, key: string, errors: ValidationIssue[]): Quantity | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  const converted = printedKilogramsToQuantity(value);
  if (converted === undefined) errors.push({ path: key, message: "must be an exact printed whole-kilogram value such as 12,420 kg" });
  return converted;
}

function optionalMoney(input: Record<string, unknown>, key: string, errors: ValidationIssue[]): Money | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  const converted = printedAmountToPaise(value);
  if (converted === undefined) errors.push({ path: key, message: "must be a printed rupees-and-paise string" });
  return converted;
}

function optionalTaxes(input: Record<string, unknown>, errors: ValidationIssue[]): Readonly<Record<string, Money>> | undefined {
  const value = input.taxAmounts;
  if (value === undefined || value === null) return undefined;
  const taxes = object(value);
  if (taxes === undefined || Object.keys(taxes).length === 0) {
    errors.push({ path: "taxAmounts", message: "must be a non-empty object when shown" });
    return undefined;
  }
  const result: Record<string, Money> = {};
  for (const [name, amount] of Object.entries(taxes)) {
    if (name.trim().length === 0) {
      errors.push({ path: "taxAmounts", message: "tax names must not be blank" });
      continue;
    }
    const parsed = printedAmountToPaise(amount);
    if (parsed === undefined) errors.push({ path: `taxAmounts.${name}`, message: "must be a printed rupees-and-paise string" });
    else result[name.trim()] = parsed;
  }
  return Object.freeze(result);
}

function optionalBankDetails(input: Record<string, unknown>, errors: ValidationIssue[]): SupplierBankDetails | undefined {
  const value = input.supplierBankDetails;
  if (value === undefined || value === null) return undefined;
  const details = object(value);
  if (details === undefined) {
    errors.push({ path: "supplierBankDetails", message: "must be an object when shown" });
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const key of ["accountNumber", "ifscCode", "bankName", "branch"] as const) {
    const text = optionalText(details, key, errors);
    if (text !== undefined) result[key] = text;
  }
  if (Object.keys(result).length === 0) errors.push({ path: "supplierBankDetails", message: "must contain at least one printed bank detail" });
  return Object.freeze(result) as SupplierBankDetails;
}

function assignIfShown(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

function validateRawFields<Type extends ExtractionDocumentType>(type: Type, value: unknown): { ok: true; value: RawPageFields<RawFields<Type>> } | { ok: false; errors: readonly ValidationIssue[] } {
  const input = object(value);
  if (input === undefined) return { ok: false, errors: [{ path: "$", message: "must be an object" }] };
  const errors: ValidationIssue[] = [];
  for (const key of Object.keys(input)) {
    if (!extractionFields[type].includes(key)) errors.push({ path: key, message: "is not a field for this document type" });
  }
  let fields: RawPageFields<RawFields<Type>>;
  switch (type) {
    case "royalty_pass": {
      const result: Record<string, unknown> = {};
      assignIfShown(result, "passNumber", optionalText(input, "passNumber", errors));
      assignIfShown(result, "passDate", optionalText(input, "passDate", errors));
      assignIfShown(result, "quarryOrVendor", optionalText(input, "quarryOrVendor", errors));
      assignIfShown(result, "netWeight", optionalQuantity(input, "netWeight", errors));
      assignIfShown(result, "vehicle", optionalText(input, "vehicle", errors));
      assignIfShown(result, "amount", optionalMoney(input, "amount", errors));
      fields = result as RawPageFields<RawFields<Type>>;
      break;
    }
    case "delivery_challan": {
      const result: Record<string, unknown> = {};
      assignIfShown(result, "challanNumber", optionalText(input, "challanNumber", errors));
      assignIfShown(result, "challanDate", optionalText(input, "challanDate", errors));
      assignIfShown(result, "vendor", optionalText(input, "vendor", errors));
      assignIfShown(result, "quantity", optionalQuantity(input, "quantity", errors));
      assignIfShown(result, "vehicle", optionalText(input, "vehicle", errors));
      fields = result as RawPageFields<RawFields<Type>>;
      break;
    }
    case "supplier_invoice": {
      const result: Record<string, unknown> = {};
      assignIfShown(result, "invoiceNumber", optionalText(input, "invoiceNumber", errors));
      assignIfShown(result, "invoiceDate", optionalText(input, "invoiceDate", errors));
      assignIfShown(result, "vendor", optionalText(input, "vendor", errors));
      assignIfShown(result, "amount", optionalMoney(input, "amount", errors));
      assignIfShown(result, "taxAmounts", optionalTaxes(input, errors));
      assignIfShown(result, "supplierBankDetails", optionalBankDetails(input, errors));
      fields = result as RawPageFields<RawFields<Type>>;
      break;
    }
    case "tender_notice": {
      const result: Record<string, unknown> = {};
      assignIfShown(result, "noticeNumber", optionalText(input, "noticeNumber", errors));
      assignIfShown(result, "issuingOffice", optionalText(input, "issuingOffice", errors));
      assignIfShown(result, "workItems", optionalTextList(input, "workItems", errors));
      assignIfShown(result, "dates", optionalTextList(input, "dates", errors));
      fields = result as RawPageFields<RawFields<Type>>;
      break;
    }
  }
  return errors.length === 0 ? { ok: true, value: Object.freeze(fields) } : { ok: false, errors: Object.freeze(errors) };
}

function extractionSchema<Type extends ExtractionDocumentType>(documentType: Type): StructuredSchema<RawPageFields<RawFields<Type>>> {
  const fields = extractionFields[documentType];
  return {
    name: `${documentType}_field_extraction`,
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(fields.map((field) => [field, { type: ["string", "null"] }])),
      required: [...fields],
    },
    validate: (value) => validateRawFields(documentType, value),
  };
}

function sourceFor(request: PageExtractionRequest<ExtractionDocumentType>): Readonly<{ document: DocumentId; source: ProvenanceInput }> {
  const sourceDocument = documentId(request.document);
  const sourceConfidence = confidence(request.confidenceBasisPoints);
  if (!sourceDocument.ok) throw new Error(sourceDocument.issues[0]!.message);
  if (!sourceConfidence.ok) throw new Error(sourceConfidence.issues[0]!.message);
  return Object.freeze({ document: sourceDocument.value, source: { document: sourceDocument.value, page: request.page, confidence: sourceConfidence.value, recordedAt: request.recordedAt } });
}

function attachFacts<Type extends ExtractionDocumentType>(request: PageExtractionRequest<Type>, raw: RawPageFields<RawFields<Type>>): ExtractedPage<Type> {
  const origin = sourceFor(request);
  const fields: Record<string, Fact<unknown>> = {};
  for (const [key, value] of Object.entries(raw)) {
    const sourced = fact(value, origin.source);
    if (!sourced.ok) throw new Error(sourced.issues.map((issue) => `${issue.field}: ${issue.message}`).join("; "));
    fields[key] = sourced.value;
  }
  return Object.freeze({ document: origin.document, documentType: request.documentType, fields: Object.freeze(fields) as PageFacts<FieldsFor<Type>> });
}

/** One structured model call reads one segmented document page; absent paper fields remain omitted. */
export async function extractPageFields<Type extends ExtractionDocumentType>(provider: StructuredProvider, request: PageExtractionRequest<Type>): Promise<BoundaryResult<ExtractedPage<Type>>> {
  const origin = sourceFor(request);
  const response = await askStructured(provider, {
    prompt: `Read only fields visibly printed on this ${request.documentType.replaceAll("_", " ")} page. Omit every field not shown; do not infer values. Amounts must be copied as printed rupees-and-paise text and weights as printed whole kilograms ending in kg.`,
    images: [request.image],
    schema: extractionSchema(request.documentType),
  });
  return response.ok
    ? Object.freeze({ ...response, value: attachFacts({ ...request, document: origin.document }, response.value) })
    : response;
}

function stableValue(value: unknown): string {
  return JSON.stringify(value);
}

export type ResolvedField<T> = Readonly<{ value: T | undefined; competingValueCount: number }>;

/** Chooses deterministic page evidence while preserving disagreement metadata. */
export function resolveFieldValues<T>(values: readonly Fact<T>[]): ResolvedField<T> {
  if (values.length === 0) return Object.freeze({ value: undefined, competingValueCount: 0 });
  const candidates = new Map<string, Fact<T>[]>();
  for (const entry of values) candidates.set(stableValue(entry.value), [...(candidates.get(stableValue(entry.value)) ?? []), entry]);
  const ordered = [...candidates.values()].map((facts) => {
    const best = [...facts].sort((left, right) => Number(right.provenance.confidence) - Number(left.provenance.confidence)
      || left.provenance.page - right.provenance.page)[0]!;
    return Object.freeze({ count: facts.length, best });
  }).sort((left, right) => right.count - left.count
    || Number(right.best.provenance.confidence) - Number(left.best.provenance.confidence)
    || left.best.provenance.page - right.best.provenance.page);
  return Object.freeze({ value: ordered[0]!.best.value, competingValueCount: ordered.length });
}

/** Deterministically rolls already-extracted pages. It has no provider parameter and makes no model call. */
export function rollExtractedPages<Type extends ExtractionDocumentType>(pages: readonly ExtractedPage<Type>[]): RolledDocument<Type> {
  if (pages.length === 0) throw new Error("Cannot roll zero extracted pages");
  const first = pages[0]!;
  if (pages.some((page) => page.document !== first.document || page.documentType !== first.documentType)) throw new Error("All rolled pages must belong to one document and type");
  const collected = new Map<string, Fact<unknown>[]>();
  for (const page of pages) {
    for (const [field, sourced] of Object.entries(page.fields)) {
      const values = collected.get(field) ?? [];
      values.push(sourced as Fact<unknown>);
      collected.set(field, values);
    }
  }
  const fields: Record<string, RolledField<unknown>> = {};
  const disagreements: FieldDisagreement[] = [];
  for (const [field, values] of collected) {
    const distinct = new Set(values.map((value) => stableValue(value.value)));
    const disagreement = distinct.size > 1;
    fields[field] = Object.freeze({ values: Object.freeze(values), ...(disagreement ? { disagreement: true as const } : {}) });
    if (disagreement) disagreements.push(Object.freeze({ field }));
  }
  return Object.freeze({ document: first.document, documentType: first.documentType, fields: Object.freeze(fields) as RolledFacts<FieldsFor<Type>>, disagreements: Object.freeze(disagreements) });
}
