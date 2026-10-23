import { describe, expect, it } from "vitest";
import { parseMinorOrThrow, tryParseMinor } from "./money-input";

describe("tryParseMinor", () => {
  it("accepts thousands separators (BK-17)", () => {
    expect(tryParseMinor("12,500.00", "GBP")).toBe(1250000n);
    expect(tryParseMinor("1,234,567.89", "USD")).toBe(123456789n);
    expect(tryParseMinor("12 500.00", "GBP")).toBe(1250000n);
    expect(tryParseMinor("1'234.50", "CHF")).toBe(123450n);
  });

  it("reads a decimal comma when it is unambiguous or declared", () => {
    expect(tryParseMinor("1.234,56", "EUR")).toBe(123456n);
    expect(tryParseMinor("12,5", "EUR")).toBe(1250n);
    expect(tryParseMinor("12,50", "EUR")).toBe(1250n);
    expect(tryParseMinor("1.234", "EUR", { decimalSeparator: "," })).toBe(123400n);
    expect(tryParseMinor("1,234", "GBP")).toBe(123400n);
    expect(tryParseMinor("1,234", "GBP", { decimalSeparator: "," })).toBe(123n);
  });

  it("handles symbols, negatives and plain numbers", () => {
    expect(tryParseMinor("£1,200.50", "GBP")).toBe(120050n);
    expect(tryParseMinor("-12.50", "GBP")).toBe(-1250n);
    expect(tryParseMinor("(12.50)", "GBP")).toBe(-1250n);
    expect(tryParseMinor("12.50-", "GBP")).toBe(-1250n);
    expect(tryParseMinor("12", "GBP")).toBe(1200n);
    expect(tryParseMinor(".5", "GBP")).toBe(50n);
    expect(tryParseMinor(12.5, "GBP")).toBe(1250n);
  });

  it("supports CR / DR suffixes only when asked", () => {
    expect(tryParseMinor("12.50 CR", "GBP", { crDrSuffix: true })).toBe(1250n);
    expect(tryParseMinor("12.50DR", "GBP", { crDrSuffix: true })).toBe(-1250n);
    expect(tryParseMinor("12.50 DR", "GBP")).toBeNull();
  });

  it("uses the currency's decimal places", () => {
    expect(tryParseMinor("1,234", "JPY")).toBe(1234n);
    expect(tryParseMinor("1.234", "KWD")).toBe(1234n);
    expect(tryParseMinor("12.5", "JPY")).toBe(13n);
  });

  it("strict mode rejects digits the currency cannot hold", () => {
    expect(tryParseMinor("1.505", "GBP", { strict: true })).toBeNull();
    expect(tryParseMinor("1.500", "GBP", { strict: true })).toBe(150n);
  });

  it("never throws and returns null for garbage", () => {
    for (const bad of ["", "abc", "1.2.3", "--5", "1e5", "12,3,4,5.6.7", "   ", "NaN"]) {
      expect(() => tryParseMinor(bad, "GBP")).not.toThrow();
    }
    expect(tryParseMinor("abc", "GBP")).toBeNull();
    expect(tryParseMinor("", "GBP")).toBeNull();
    expect(tryParseMinor("1.2.3", "GBP")).toBeNull();
    expect(tryParseMinor(null, "GBP")).toBeNull();
    expect(tryParseMinor(Number.NaN, "GBP")).toBeNull();
    expect(tryParseMinor("-5", "GBP", { allowNegative: false })).toBeNull();
  });

  it("parseMinorOrThrow names the field", () => {
    expect(parseMinorOrThrow("1,000", "GBP")).toBe(100000n);
    expect(() => parseMinorOrThrow("x", "GBP", "Statement balance")).toThrow(/Statement balance/);
  });
});
