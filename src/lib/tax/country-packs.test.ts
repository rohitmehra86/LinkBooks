import { describe, expect, it } from "vitest";
import {
  packsForCountry,
  suggestedRegimeForCountry,
  verificationStatusLabel,
  TAX_COUNTRY_PACKS,
} from "./country-packs";
import { computeTaxLine, taxPostsToControlAccount } from "./tax-math";

describe("country packs", () => {
  it("suggests VAT for GB and sales_tax for US", () => {
    expect(suggestedRegimeForCountry("GB")).toBe("vat");
    expect(suggestedRegimeForCountry("US")).toBe("sales_tax");
    expect(suggestedRegimeForCountry("IN")).toBe("gst");
  });

  it("never marks filing as implemented", () => {
    for (const p of TAX_COUNTRY_PACKS) {
      expect(p.filingStatus).toBe("not_implemented");
    }
  });

  it("labels generic packs as unverified", () => {
    const us = packsForCountry("US")[0]!;
    expect(us.verificationStatus).toBe("generic_unverified");
    expect(verificationStatusLabel(us.verificationStatus)).toMatch(/unverified/i);
  });

  it("GB pack distinguishes zero-rated capability in features or limitations", () => {
    const gb = packsForCountry("GB")[0]!;
    expect(gb.id).toBe("gb_vat_config");
    expect(gb.knownLimitations.some((l) => /MTD/i.test(l))).toBe(true);
  });
});

describe("tax math integrity", () => {
  it("exclusive 20% on 100.00 -> tax 20.00", () => {
    const r = computeTaxLine({
      quantity: 1,
      unit_price_minor: 10000,
      tax_rate_bps: 2000,
      treatment: "exclusive",
    });
    expect(r.net_minor).toBe(10000n);
    expect(r.tax_minor).toBe(2000n);
    expect(r.gross_minor).toBe(12000n);
  });

  it("inclusive 20% on 120.00 -> net 100.00 tax 20.00", () => {
    const r = computeTaxLine({
      quantity: 1,
      unit_price_minor: 12000,
      tax_rate_bps: 2000,
      treatment: "inclusive",
    });
    expect(r.gross_minor).toBe(12000n);
    expect(r.net_minor).toBe(10000n);
    expect(r.tax_minor).toBe(2000n);
  });

  it("exempt/outside_scope with zero tax do not post to control", () => {
    expect(taxPostsToControlAccount("exempt", 0n)).toBe(false);
    expect(taxPostsToControlAccount("outside_scope", 0n)).toBe(false);
    expect(taxPostsToControlAccount("standard", 2000n)).toBe(true);
  });
});
