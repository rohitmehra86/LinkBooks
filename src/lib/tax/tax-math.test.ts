import { describe, expect, it } from "vitest";
import { computeTaxLine, isRateEffective } from "./tax-math";

describe("computeTaxLine exclusive", () => {
  it("applies half-up tax on net", () => {
    const r = computeTaxLine({
      quantity: 1,
      unit_price_minor: 1000,
      tax_rate_bps: 2000,
      treatment: "exclusive",
    });
    expect(r.net_minor).toBe(1000n);
    expect(r.tax_minor).toBe(200n);
    expect(r.gross_minor).toBe(1200n);
  });

  it("subtracts discount before tax", () => {
    const r = computeTaxLine({
      quantity: 2,
      unit_price_minor: 1000,
      discount_minor: 100,
      tax_rate_bps: 1000,
      treatment: "exclusive",
    });
    expect(r.net_minor).toBe(1900n);
    expect(r.tax_minor).toBe(190n);
  });
});

describe("computeTaxLine inclusive", () => {
  it("extracts tax from gross with half-up net", () => {
    const r = computeTaxLine({
      quantity: 1,
      unit_price_minor: 1200,
      tax_rate_bps: 2000,
      treatment: "inclusive",
    });
    expect(r.gross_minor).toBe(1200n);
    expect(r.net_minor).toBe(1000n);
    expect(r.tax_minor).toBe(200n);
  });

  it("zero rate keeps whole as net", () => {
    const r = computeTaxLine({
      quantity: 1,
      unit_price_minor: 500,
      tax_rate_bps: 0,
      treatment: "inclusive",
    });
    expect(r).toEqual({ net_minor: 500n, tax_minor: 0n, gross_minor: 500n });
  });
});

describe("isRateEffective", () => {
  it("respects active window", () => {
    const rate = {
      effective_from: "2024-01-01",
      effective_to: "2024-12-31",
      is_active: true,
    };
    expect(isRateEffective(rate, "2024-06-01")).toBe(true);
    expect(isRateEffective(rate, "2023-12-31")).toBe(false);
    expect(isRateEffective(rate, "2025-01-01")).toBe(false);
    expect(isRateEffective({ ...rate, is_active: false }, "2024-06-01")).toBe(false);
  });
});
