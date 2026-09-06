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
    expect(money(1_250)).toEqual({ ok: true, value: 1_250 });
    expect(money(-1_250)).toEqual({ ok: true, value: -1_250 });
  });

  test("rejects non-integer and unsafe money", () => {
    expect(money(12.5)).toEqual({
      ok: false,
      issues: [{ field: "money", message: "must be a safe integer count of paise" }],
    });
    expect(money(Number.MAX_SAFE_INTEGER + 1).ok).toBeFalse();
  });

  test("stores quantity only as non-negative integer thousandths", () => {
    expect(quantity(12_420)).toEqual({ ok: true, value: 12_420 });
    expect(quantity(-1)).toEqual({
      ok: false,
      issues: [{ field: "quantity", message: "must not be negative" }],
    });
    expect(quantity(12.42).ok).toBeFalse();
  });

  test("bounds rates and confidence in integer basis points", () => {
    expect(rate(200)).toEqual({ ok: true, value: 200 });
    expect(confidence(MAX_BASIS_POINTS)).toEqual({ ok: true, value: MAX_BASIS_POINTS });
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
    expect(result).toEqual({
      ok: true,
      value: { value: "12.420 MT", provenance: source },
    });
  });

  test("rejects facts whose provenance omits a source field", () => {
    const result = fact("12.420 MT", { ...source, document: "", page: 0 });
    expect(result).toEqual({
      ok: false,
      issues: [
        { field: "document", message: "must be a non-empty document identifier" },
        { field: "page", message: "must be a positive safe integer" },
      ],
    });
  });

  test("rejects unbounded confidence and invalid recorded times", () => {
    expect(provenance({ ...source, confidence: 10_001 }).ok).toBeFalse();
    expect(recordedTime("2026-09-06").ok).toBeFalse();
    expect(recordedTime("not-a-timestamp")).toEqual({
      ok: false,
      issues: [{ field: "recordedAt", message: "must be a valid canonical ISO-8601 timestamp" }],
    });
    expect(recordedTime(new Date("2026-09-06T03:14:15.000Z"))).toEqual({
      ok: true,
      value: source.recordedAt,
    });
  });
});

describe("bulk operation outcomes", () => {
  test("retains an explicitly-reasoned skipped item alongside processed items", () => {
    const skippedItem = skipped("synthetic-page-2", "already handled by intake");
    expect(skippedItem.ok).toBeTrue();
    if (!skippedItem.ok) return;

    expect(bulkOutcome([{ item: "synthetic-page-1", value: "stored" }], [skippedItem.value])).toEqual({
      processed: [{ item: "synthetic-page-1", value: "stored" }],
      skipped: [{ item: "synthetic-page-2", reason: "already handled by intake" }],
    });
  });

  test("does not permit an unexplained skipped item", () => {
    expect(skipped("synthetic-page-2", "")).toEqual({
      ok: false,
      issues: [{ field: "reason", message: "must explicitly explain why an item was skipped" }],
    });
  });
});
