import { describe, expect, test } from "bun:test";
import {
  MAX_BASIS_POINTS,
  bulkOutcome,
  confidence,
  fact,
  money,
  provenance,
  quantity,
  rate,
  recordedTime,
  skipped,
} from "./value-types";

describe("integer finance values", () => {
  test("accepts integer paise, including signed monetary differences", () => {
    const positive = money(1_250);
    const negative = money(-1_250);
    expect(positive.ok).toBeTrue();
    expect(negative.ok).toBeTrue();
    if (!positive.ok || !negative.ok) return;

    expect(positive.value).toBe(1_250);
    expect(negative.value).toBe(-1_250);
  });

  test("rejects non-integer and unsafe money", () => {
    expect(money(12.5)).toEqual({
      ok: false,
      issues: [{ field: "money", message: "must be a safe integer count of paise" }],
    });
    expect(money(Number.MAX_SAFE_INTEGER + 1).ok).toBeFalse();
  });

  test("stores quantity only as non-negative integer thousandths", () => {
    const validQuantity = quantity(12_420);
    expect(validQuantity.ok).toBeTrue();
    if (!validQuantity.ok) return;
    expect(validQuantity.value).toBe(12_420);
    expect(quantity(-1)).toEqual({
      ok: false,
      issues: [{ field: "quantity", message: "must not be negative" }],
    });
    expect(quantity(12.42).ok).toBeFalse();
  });

  test("bounds rates and confidence in integer basis points", () => {
    const validRate = rate(200);
    const maximumConfidence = confidence(MAX_BASIS_POINTS);
    expect(validRate.ok).toBeTrue();
    expect(maximumConfidence.ok).toBeTrue();
    if (!validRate.ok || !maximumConfidence.ok) return;
    expect(validRate.value).toBe(200);
    expect(maximumConfidence.value).toBe(MAX_BASIS_POINTS);
    expect(rate(MAX_BASIS_POINTS + 1).ok).toBeFalse();
    expect(confidence(-1).ok).toBeFalse();
    expect(confidence(99.9).ok).toBeFalse();
  });
});

describe("provenance-backed facts", () => {
  const source = {
    document: "synthetic-delivery-001",
    page: 2,
    confidence: 9_500,
    recordedAt: "2026-09-06T03:14:15.000Z",
  };

  test("constructs a fact with complete, validated provenance", () => {
    const result = fact("12.420 MT", source);
    expect(result.ok).toBeTrue();
    if (!result.ok) return;

    expect(result.value.value).toBe("12.420 MT");
    expect(result.value.provenance.document).toBe(source.document);
    expect(result.value.provenance.page).toBe(source.page);
    expect(result.value.provenance.confidence).toBe(source.confidence);
    expect(result.value.provenance.recordedAt).toBe(source.recordedAt);
  });

  test("rejects facts whose provenance omits a source field", () => {
    const result = fact("12.420 MT", { ...source, document: "", page: 0 });
    expect(result.ok).toBeFalse();
    if (result.ok) return;

    expect(result.issues).toEqual([
      { field: "document", message: "must be a non-empty document identifier" },
      { field: "page", message: "must be a positive safe integer" },
    ]);
  });

  test("rejects unbounded confidence and invalid recorded times", () => {
    expect(provenance({ ...source, confidence: 10_001 }).ok).toBeFalse();
    expect(recordedTime("2026-09-06").ok).toBeFalse();
    expect(recordedTime("not-a-timestamp")).toEqual({
      ok: false,
      issues: [{ field: "recordedAt", message: "must be a valid canonical ISO-8601 timestamp" }],
    });
    const dateResult = recordedTime(new Date("2026-09-06T03:14:15.000Z"));
    expect(dateResult.ok).toBeTrue();
    if (!dateResult.ok) return;
    expect(dateResult.value).toBe(source.recordedAt);
  });
});

describe("bulk operation outcomes", () => {
  test("retains an explicitly-reasoned skipped item alongside processed items", () => {
    const skippedItem = skipped("synthetic-page-2", "already handled by intake");
    expect(skippedItem.ok).toBeTrue();
    if (!skippedItem.ok) return;

    const outcome = bulkOutcome([{ item: "synthetic-page-1", value: "stored" }], [skippedItem.value]);
    expect(outcome.processed).toEqual([{ item: "synthetic-page-1", value: "stored" }]);
    expect(outcome.skipped).toHaveLength(1);
    expect(outcome.skipped[0]?.item).toBe("synthetic-page-2");
    expect(outcome.skipped[0]?.reason).toBe("already handled by intake");
  });

  test("does not permit an unexplained skipped item", () => {
    expect(skipped("synthetic-page-2", "")).toEqual({
      ok: false,
      issues: [{ field: "reason", message: "must explicitly explain why an item was skipped" }],
    });
  });
});
