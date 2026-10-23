import { describe, expect, it } from "vitest";
import { computeTaxLine } from "@/lib/tax/tax-math";
import { computeTaxLineRounded, extendedAmountMinor, halfUpDivide } from "./line-math-rounded";

describe("halfUpDivide", () => {
  it("rounds ties up and handles negatives symmetrically", () => {
    expect(halfUpDivide(5n, 2n)).toBe(3n);
    expect(halfUpDivide(4n, 2n)).toBe(2n);
    expect(halfUpDivide(-5n, 2n)).toBe(-3n);
    expect(halfUpDivide(1n, 3n)).toBe(0n);
    expect(halfUpDivide(2n, 3n)).toBe(1n);
  });
});

describe("extendedAmountMinor", () => {
  it("rounds 1.5 x 3.33 to 5.00 (shared maths gives 4.99)", () => {
    expect(extendedAmountMinor(1.5, 333)).toBe(500n);
    const shared = computeTaxLine({
      quantity: 1.5,
      unit_price_minor: 333,
      tax_rate_bps: 0,
      treatment: "exclusive",
    });
    expect(shared.net_minor).toBe(499n);
  });

  it("keeps whole quantities exact", () => {
    expect(extendedAmountMinor(3, 1999)).toBe(5997n);
  });

  it("handles fractional quantities with 6 decimals", () => {
    expect(extendedAmountMinor(0.333333, 300)).toBe(100n);
    expect(extendedAmountMinor(2.5, 1)).toBe(3n);
  });

  it("rejects non-positive quantity and negative price", () => {
    expect(() => extendedAmountMinor(0, 100)).toThrow();
    expect(() => extendedAmountMinor(Number.NaN, 100)).toThrow();
    expect(() => extendedAmountMinor(1, -1)).toThrow();
  });
});

describe("computeTaxLineRounded", () => {
  it("exclusive: rounds extended amount then tax half-up", () => {
    const r = computeTaxLineRounded({
      quantity: 1.5,
      unit_price_minor: 333,
      tax_rate_bps: 2000,
      treatment: "exclusive",
    });
    expect(r.net_minor).toBe(500n);
    expect(r.tax_minor).toBe(100n);
    expect(r.gross_minor).toBe(600n);
  });

  it("inclusive: gross is the rounded extended amount, net+tax = gross", () => {
    const r = computeTaxLineRounded({
      quantity: 1.5,
      unit_price_minor: 333,
      tax_rate_bps: 2000,
      treatment: "inclusive",
    });
    expect(r.gross_minor).toBe(500n);
    expect(r.net_minor + r.tax_minor).toBe(500n);
    expect(r.net_minor).toBe(417n);
  });

  it("applies discount after rounding and rejects discount above the line", () => {
    const r = computeTaxLineRounded({
      quantity: 2,
      unit_price_minor: 1000,
      discount_minor: 500,
      tax_rate_bps: 0,
      treatment: "exclusive",
    });
    expect(r.net_minor).toBe(1500n);
    expect(() =>
      computeTaxLineRounded({
        quantity: 1,
        unit_price_minor: 100,
        discount_minor: 101,
        tax_rate_bps: 0,
        treatment: "exclusive",
      }),
    ).toThrow();
  });

  it("matches the shared function whenever quantity is a whole number", () => {
    for (const qty of [1, 2, 7]) {
      for (const price of [1, 99, 12345]) {
        for (const bps of [0, 500, 2000]) {
          const a = computeTaxLineRounded({
            quantity: qty,
            unit_price_minor: price,
            tax_rate_bps: bps,
            treatment: "exclusive",
          });
          const b = computeTaxLine({
            quantity: qty,
            unit_price_minor: price,
            tax_rate_bps: bps,
            treatment: "exclusive",
          });
          expect(a).toEqual(b);
        }
      }
    }
  });
});
