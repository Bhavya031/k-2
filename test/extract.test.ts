import { describe, expect, test } from "bun:test";

import {
  extractPageFields,
  printedAmountToPaise,
  printedKilogramsToQuantity,
  resolveFieldValues,
  rollExtractedPages,
  type ExtractionDocumentType,
  type PageExtractionRequest,
} from "../src/extract/extract.ts";
import type { StructuredProvider } from "../src/model/boundary.ts";

const syntheticImage = Object.freeze({ label: "synthetic-page", mediaType: "image/png" as const, bytes: new Uint8Array([137, 80, 78, 71]) });

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
