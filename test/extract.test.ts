import { describe, expect, test } from "bun:test";

import {
  extractPageFields,
  extractionFields,
  printedAmountToPaise,
  printedKilogramsToQuantity,
  resolveFieldValues,
  rollExtractedPages,
  type ExtractionDocumentType,
  type PageExtractionRequest,
} from "../src/extract/extract.ts";
import type { StructuredProvider, StructuredRequest } from "../src/model/boundary.ts";

const syntheticImage = Object.freeze({ label: "synthetic-page", mediaType: "image/png" as const, bytes: new Uint8Array([137, 80, 78, 71]) });
const expectedExtractionFields = Object.freeze({
  royalty_pass: ["passNumber", "passDate", "quarryOrVendor", "netWeight", "vehicle", "amount"],
  delivery_challan: ["challanNumber", "challanDate", "vendor", "quantity", "vehicle"],
  supplier_invoice: ["invoiceNumber", "invoiceDate", "vendor", "amount", "taxAmounts", "supplierBankDetails"],
  tender_notice: ["noticeNumber", "issuingOffice", "workItems", "dates"],
} satisfies Record<ExtractionDocumentType, readonly string[]>);

function syntheticProvider(...responses: unknown[]): StructuredProvider & { readonly calls: () => number } {
  let calls = 0;
  return {
    async request() {
      const response = responses[calls];
      calls += 1;
      return { data: response };
    },
    calls: () => calls,
  };
}

function schemaCapturingProvider(response: unknown): StructuredProvider & { readonly requests: readonly StructuredRequest[] } {
  const requests: StructuredRequest[] = [];
  return {
    async request(request) {
      requests.push(request);
      return { data: response };
    },
    get requests() {
      return requests;
    },
  };
}

function request<Type extends ExtractionDocumentType>(documentType: Type, page = 1): PageExtractionRequest<Type> {
  return {
    document: "synthetic-document-17",
    documentType,
    page,
    confidenceBasisPoints: 9_500,
    recordedAt: "2026-09-06T10:00:00.000Z",
    image: syntheticImage,
  };
}

describe("Stage 4 field extraction", () => {
  test("publishes every royalty-pass field as a required nullable string", async () => {
    const provider = schemaCapturingProvider(Object.fromEntries(expectedExtractionFields.royalty_pass.map((field) => [field, null])));

    expect(extractionFields.royalty_pass).toEqual(expectedExtractionFields.royalty_pass);
    const result = await extractPageFields(provider, request("royalty_pass"));
    const schema = provider.requests[0]!.schema.jsonSchema as { properties: Record<string, unknown>; required: readonly string[]; additionalProperties: boolean };

    expect(result.ok).toBe(true);
    expect(Object.keys(schema.properties)).toEqual([...extractionFields.royalty_pass]);
    expect(schema.required).toEqual(extractionFields.royalty_pass);
    expect(schema.additionalProperties).toBe(false);
    for (const field of extractionFields.royalty_pass) expect(schema.properties[field]).toEqual({ type: ["string", "null"] });
  });

  test("publishes every other document type's fields as required nullable strings matching the shared field list", async () => {
    const documentTypes = ["delivery_challan", "supplier_invoice", "tender_notice"] as const;

    for (const documentType of documentTypes) {
      const provider = schemaCapturingProvider(Object.fromEntries(expectedExtractionFields[documentType].map((field) => [field, null])));
      const result = await extractPageFields(provider, request(documentType));
      const schema = provider.requests[0]!.schema.jsonSchema as { properties: Record<string, unknown>; required: readonly string[]; additionalProperties: boolean };

      expect(result.ok).toBe(true);
      expect(extractionFields[documentType]).toEqual(expectedExtractionFields[documentType]);
      expect(Object.keys(schema.properties)).toEqual([...extractionFields[documentType]]);
      expect(schema.required).toEqual(extractionFields[documentType]);
      expect(schema.additionalProperties).toBe(false);
      for (const field of extractionFields[documentType]) expect(schema.properties[field]).toEqual({ type: ["string", "null"] });
    }
  });

  test("omits explicit null fields without errors and retains only mixed shown values with their current types", async () => {
    const allNull = schemaCapturingProvider(Object.fromEntries(extractionFields.delivery_challan.map((field) => [field, null])));
    const nullResult = await extractPageFields(allNull, request("delivery_challan"));
    expect(nullResult.ok).toBe(true);
    if (nullResult.ok) {
      expect(nullResult.value.fields).toEqual({});
      expect(nullResult.validationErrors).toEqual([]);
    }

    const mixed = schemaCapturingProvider({
      invoiceNumber: "SYN-INV-NULLS",
      invoiceDate: null,
      vendor: "Synthetic Aggregate",
      amount: "₹ 9,999.00",
      taxAmounts: { CGST: "₹ 450.00" },
      supplierBankDetails: null,
    });
    const mixedResult = await extractPageFields(mixed, request("supplier_invoice"));
    expect(mixedResult.ok).toBe(true);
    if (mixedResult.ok) {
      expect(Object.keys(mixedResult.value.fields)).toEqual(["invoiceNumber", "vendor", "amount", "taxAmounts"]);
      expect(mixedResult.value.fields.invoiceNumber?.value).toBe("SYN-INV-NULLS");
      expect(mixedResult.value.fields.vendor?.value).toBe("Synthetic Aggregate");
      expect(Number(mixedResult.value.fields.amount?.value)).toBe(999_900);
      expect(Object.fromEntries(Object.entries(mixedResult.value.fields.taxAmounts?.value ?? {}).map(([name, amount]) => [name, Number(amount)]))).toEqual({ CGST: 45_000 });
      expect("invoiceDate" in mixedResult.value.fields).toBe(false);
      expect("supplierBankDetails" in mixedResult.value.fields).toBe(false);
      expect(mixedResult.validationErrors).toEqual([]);
    }
  });

  test("extracts visibly printed royalty-pass fields, omits an absent vehicle, and converts kilograms at the paper boundary", async () => {
    const provider = syntheticProvider({
      passNumber: "SYN-RP-008",
      passDate: "06/09/2026",
      quarryOrVendor: "Synthetic Quarry",
      netWeight: "12,420 kg",
      amount: "₹ 1,250.75",
    });

    const result = await extractPageFields(provider, request("royalty_pass"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fields.passNumber?.value).toBe("SYN-RP-008");
      expect(Number(result.value.fields.netWeight?.value)).toBe(12_420);
      expect(Number(result.value.fields.amount?.value)).toBe(125_075);
      expect(Number.isInteger(result.value.fields.amount?.value)).toBe(true);
      expect("vehicle" in result.value.fields).toBe(false);
    }
    expect(provider.calls()).toBe(1);
  });

  test("uses exact integer parsers for printed kilograms and rupees without accepting fractional kilograms", () => {
    expect(Number(printedKilogramsToQuantity("12,420 kg"))).toBe(12_420);
    expect(printedKilogramsToQuantity("12,420.5 kg")).toBeUndefined();
    expect(Number(printedAmountToPaise("INR 3,001.05"))).toBe(300_105);
    expect(printedAmountToPaise("3,001.057")).toBeUndefined();
  });

  test("extracts the typed delivery challan, supplier invoice bank details and tender-notice fields", async () => {
    const provider = syntheticProvider(
      { challanNumber: "SYN-DC-12", challanDate: "06/09/2026", vendor: "Synthetic Aggregate", quantity: "9,250 kg", vehicle: "SYN-TRK-4" },
      { invoiceNumber: "SYN-INV-44", invoiceDate: "07/09/2026", vendor: "Synthetic Aggregate", amount: "₹ 9,999.00", taxAmounts: { CGST: "₹ 450.00", SGST: "₹ 450.00" }, supplierBankDetails: { accountNumber: "SYNTHETIC-ACCOUNT", ifscCode: "SYNB0000123", bankName: "Synthetic Bank" } },
      { noticeNumber: "SYN-NOTICE-3", issuingOffice: "Synthetic Works Office", workItems: ["Synthetic road base", "Synthetic transport"], dates: ["06/09/2026", "20/09/2026"] },
    );

    const challan = await extractPageFields(provider, request("delivery_challan"));
    const invoice = await extractPageFields(provider, request("supplier_invoice"));
    const notice = await extractPageFields(provider, request("tender_notice"));

    expect(challan.ok && Number(challan.value.fields.quantity?.value)).toBe(9_250);
    expect(invoice.ok && Number(invoice.value.fields.amount?.value)).toBe(999_900);
    expect(invoice.ok && Object.fromEntries(Object.entries(invoice.value.fields.taxAmounts?.value ?? {}).map(([name, amount]) => [name, Number(amount)]))).toEqual({ CGST: 45_000, SGST: 45_000 });
    expect(invoice.ok && invoice.value.fields.supplierBankDetails?.value).toEqual({ accountNumber: "SYNTHETIC-ACCOUNT", ifscCode: "SYNB0000123", bankName: "Synthetic Bank" });
    expect(notice.ok && notice.value.fields.workItems?.value).toEqual(["Synthetic road base", "Synthetic transport"]);
    expect(notice.ok && notice.value.fields.dates?.value).toEqual(["06/09/2026", "20/09/2026"]);
  });

  test("rolls extracted pages without a further model call and preserves conflicting values with a disagreement marker", async () => {
    const provider = syntheticProvider(
      { challanNumber: "SYN-DC-99", vendor: "Synthetic Aggregate", quantity: "10,000 kg" },
      { challanNumber: "SYN-DC-99", vendor: "Synthetic Aggregate", quantity: "10,500 kg" },
    );
    const first = await extractPageFields(provider, request("delivery_challan", 1));
    const second = await extractPageFields(provider, request("delivery_challan", 2));
    if (!first.ok || !second.ok) throw new Error("synthetic structured fixture must validate");
    const callsBeforeRollup = provider.calls();

    const rolled = rollExtractedPages([first.value, second.value]);

    expect(provider.calls()).toBe(callsBeforeRollup);
    expect(rolled.fields.quantity?.values.map((entry) => Number(entry.value))).toEqual([10_000, 10_500]);
    expect(rolled.fields.quantity?.disagreement).toBe(true);
    expect(rolled.disagreements).toEqual([{ field: "quantity" }]);
    expect(rolled.fields.challanNumber?.disagreement).toBeUndefined();
  });

  test("resolves A, A, B by frequency while retaining the vendor disagreement", async () => {
    const provider = syntheticProvider(
      { challanNumber: "SYN-1", vendor: "B", quantity: "1,000 kg" },
      { challanNumber: "SYN-1", vendor: "A", quantity: "1,000 kg" },
      { challanNumber: "SYN-1", vendor: "A", quantity: "1,000 kg" },
    );
    const first = await extractPageFields(provider, request("delivery_challan", 1));
    const second = await extractPageFields(provider, request("delivery_challan", 2));
    const third = await extractPageFields(provider, request("delivery_challan", 3));
    if (!first.ok || !second.ok || !third.ok) throw new Error("synthetic fixture must validate");
    const rolled = rollExtractedPages([first.value, second.value, third.value]);
    const resolved = resolveFieldValues(rolled.fields.vendor!.values);
    expect(resolved).toEqual({ value: "A", competingValueCount: 2 });
    expect(rolled.fields.vendor?.disagreement).toBe(true);
    expect(rolled.disagreements).toContainEqual({ field: "vendor" });
  });

  test("resolves equally frequent candidates by confidence then lower page number deterministically", async () => {
    const provider = syntheticProvider(
      { challanNumber: "SYN-2", vendor: "ગુજરાતી નામ", quantity: "1,000 kg" },
      { challanNumber: "SYN-2", vendor: "Latin name", quantity: "1,000 kg" },
    );
    const low = await extractPageFields(provider, { ...request("delivery_challan", 1), confidenceBasisPoints: 9000 });
    const high = await extractPageFields(provider, { ...request("delivery_challan", 2), confidenceBasisPoints: 9500 });
    if (!low.ok || !high.ok) throw new Error("synthetic fixture must validate");
    expect(resolveFieldValues([low.value.fields.vendor!, high.value.fields.vendor!])).toEqual({ value: "Latin name", competingValueCount: 2 });
    const first = resolveFieldValues([high.value.fields.vendor!, { ...low.value.fields.vendor!, provenance: { ...low.value.fields.vendor!.provenance, confidence: high.value.fields.vendor!.provenance.confidence } }]);
    const second = resolveFieldValues([{ ...low.value.fields.vendor!, provenance: { ...low.value.fields.vendor!.provenance, confidence: high.value.fields.vendor!.provenance.confidence } }, high.value.fields.vendor!]);
    expect(first).toEqual({ value: "ગુજરાતી નામ", competingValueCount: 2 });
    expect(second).toEqual(first);
  });

  test("returns undefined when no page produced a field", () => {
    expect(resolveFieldValues([])).toEqual({ value: undefined, competingValueCount: 0 });
  });
});
