import { describe, expect, it } from "vitest";
import {
  minorOrZero,
  normaliseMoneyInput,
  parseMinorOrThrow,
  tryParseMinor,
} from "@/lib/purchases/money-input";

describe("tryParseMinor", () => {
  it("never throws on in-progress input", () => {
    for (const v of ["12.", "-", " ", "", ".", "abc", "1,2", "1..2", "--5", "1e5", null, undefined]) {
      expect(() => tryParseMinor(v as never, "GBP")).not.toThrow();
    }
  });

  it("parses plain decimals", () => {
    expect(tryParseMinor("12.50", "GBP")).toBe(1250n);
    expect(tryParseMinor("12", "GBP")).toBe(1200n);
    expect(tryParseMinor("0.05", "GBP")).toBe(5n);
  });

  it("accepts a trailing or leading decimal point", () => {
    expect(tryParseMinor("12.", "GBP")).toBe(1200n);
    expect(tryParseMinor(".5", "GBP")).toBe(50n);
  });

  it("accepts thousands separators and currency symbols", () => {
    expect(tryParseMinor("1,250.00", "GBP")).toBe(125000n);
    expect(tryParseMinor("£1,250", "GBP")).toBe(125000n);
    expect(tryParseMinor("1,234,567.89", "USD")).toBe(123456789n);
  });

  it("rejects malformed grouping", () => {
    expect(tryParseMinor("1,25", "GBP")).toBeNull();
    expect(tryParseMinor("12,34,567", "GBP")).toBeNull();
  });

  it("returns null for blank or non-numeric", () => {
    expect(tryParseMinor("", "GBP")).toBeNull();
    expect(tryParseMinor("-", "GBP")).toBeNull();
    expect(tryParseMinor("abc", "GBP")).toBeNull();
    expect(tryParseMinor(Number.NaN, "GBP")).toBeNull();
  });

  it("keeps the sign and respects currency decimals", () => {
    expect(tryParseMinor("-3.20", "GBP")).toBe(-320n);
    expect(tryParseMinor("1000", "JPY")).toBe(1000n);
    expect(tryParseMinor("1.234", "KWD")).toBe(1234n);
  });
});

describe("minorOrZero / parseMinorOrThrow", () => {
  it("treats invalid input as zero for live totals", () => {
    expect(minorOrZero("12.", "GBP")).toBe(1200n);
    expect(minorOrZero("-", "GBP")).toBe(0n);
  });

  it("throws a readable error on submit", () => {
    expect(() => parseMinorOrThrow("abc", "GBP", "Payment amount")).toThrow(
      "Payment amount is not a valid amount",
    );
    expect(parseMinorOrThrow("1,000.10", "GBP")).toBe(100010n);
  });
});

describe("normaliseMoneyInput", () => {
  it("normalises numbers", () => {
    expect(normaliseMoneyInput(5)).toBe("5.000000");
    expect(normaliseMoneyInput(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
