import { describe, expect, it } from "vitest";
import { formatAmount, formatDate, formatMoney, resolveLocale } from "./format";

describe("formatMoney (U-08)", () => {
  it("defaults to en-GB and formats minor units with the currency decimals", () => {
    expect(formatMoney(123456, "GBP")).toBe("£1,234.56");
    expect(formatMoney(100000, "JPY", "en-GB")).toBe("¥100,000");
    expect(formatMoney(1234567, "KWD", "en-GB")).toBe("KWD\u00a01,234.567");
  });
  it("honours the company locale", () => {
    expect(formatAmount(123456789, "EUR", "de-DE")).toBe("1.234.567,89");
    expect(formatAmount(123456789, "INR", "en-IN")).toBe("12,34,567.89");
  });
  it("negatives, brackets and zero", () => {
    expect(formatMoney(-500, "GBP")).toBe("-£5.00");
    expect(formatMoney(-500, "GBP", "en-GB", { brackets: true })).toBe("(£5.00)");
    expect(formatMoney(0n, "GBP")).toBe("£0.00");
  });
  it("accepts bigint and numeric strings, and never loses minor units", () => {
    expect(formatAmount(9007199254740993n, "USD", "en-US")).toBe("90,071,992,547,409.93");
    expect(formatAmount("12345", "USD", "en-US")).toBe("123.45");
  });
  it("falls back on an invalid locale", () => {
    expect(resolveLocale("xx-invalid-locale-!!")).toBe("en-GB");
    expect(resolveLocale(null)).toBe("en-GB");
  });
});

describe("formatDate", () => {
  it("honours explicit company date formats without timezone shift", () => {
    expect(formatDate("2026-03-05", "en-GB", "DD/MM/YYYY")).toBe("05/03/2026");
    expect(formatDate("2026-03-05", "en-US", "MM/DD/YYYY")).toBe("03/05/2026");
    expect(formatDate("2026-03-05", "en-GB", "YYYY-MM-DD")).toBe("2026-03-05");
  });
  it("uses the locale convention otherwise and tolerates empty values", () => {
    expect(formatDate("2026-03-05", "en-GB")).toBe("05/03/2026");
    expect(formatDate("2026-03-05", "en-US")).toBe("03/05/2026");
    expect(formatDate(null)).toBe("");
    expect(formatDate("2026-03-05T23:30:00Z", "en-GB", "DD/MM/YYYY")).toBe("05/03/2026");
  });
});
