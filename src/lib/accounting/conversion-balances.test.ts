import { describe, expect, it } from "vitest";
import {
  buildConversionPayload,
  isDocumentControlAccount,
  openingDateFor,
  validateConversion,
  type ConversionInput,
} from "@/lib/accounting/conversion-balances";

const base: ConversionInput = {
  conversionDate: "2026-01-01",
  baseCurrency: "GBP",
  tb: [],
  invoices: [],
  bills: [],
  acceptDifference: false,
};

const inv = (over: Partial<ConversionInput["invoices"][number]> = {}) => ({
  contactId: "c1",
  reference: "INV-1",
  documentDate: "2025-12-01",
  currencyCode: "GBP",
  amountMinor: 50000n,
  ...over,
});

describe("openingDateFor", () => {
  it("is the day before the conversion date", () => {
    expect(openingDateFor("2026-01-01")).toBe("2025-12-31");
    expect(openingDateFor("2024-03-01")).toBe("2024-02-29");
  });
  it("rejects invalid dates", () => {
    expect(openingDateFor("2026-13-01")).toBeNull();
    expect(openingDateFor("")).toBeNull();
  });
});

describe("validateConversion", () => {
  it("balances trial balance plus opening documents", () => {
    const v = validateConversion({
      ...base,
      tb: [
        { accountId: "bank", debitMinor: 100000n, creditMinor: 0n },
        { accountId: "eq", debitMinor: 0n, creditMinor: 130000n },
      ],
      invoices: [inv()],
      bills: [inv({ reference: "B-1", contactId: "s1", amountMinor: 20000n })],
    });
    expect(v.errors).toEqual([]);
    expect(v.summary.difference).toBe(0n);
    expect(v.summary.debits).toBe(150000n);
    expect(v.summary.credits).toBe(150000n);
    expect(v.canPost).toBe(true);
    expect(v.summary.openingDate).toBe("2025-12-31");
  });

  it("shows the difference and blocks posting when unbalanced", () => {
    const v = validateConversion({
      ...base,
      tb: [{ accountId: "bank", debitMinor: 100000n, creditMinor: 0n }],
    });
    expect(v.summary.difference).toBe(100000n);
    expect(v.summary.balanced).toBe(false);
    expect(v.canPost).toBe(false);
    expect(v.errors.join(" ")).toMatch(/do not balance/);
  });

  it("allows an explicitly accepted difference and reports the plug", () => {
    const v = validateConversion({
      ...base,
      acceptDifference: true,
      tb: [
        { accountId: "bank", debitMinor: 100000n, creditMinor: 0n },
        { accountId: "eq", debitMinor: 0n, creditMinor: 40000n },
      ],
    });
    expect(v.canPost).toBe(true);
    expect(v.summary.plugMinor).toBe(60000n);
  });

  it("rejects a debit and a credit on one line, negatives and duplicate accounts", () => {
    const v = validateConversion({
      ...base,
      acceptDifference: true,
      tb: [
        { accountId: "a", debitMinor: 5n, creditMinor: 5n },
        { accountId: "b", debitMinor: -1n, creditMinor: 0n },
        { accountId: "c", debitMinor: 5n, creditMinor: 0n },
        { accountId: "c", debitMinor: 5n, creditMinor: 0n },
      ],
    });
    expect(v.errors.length).toBeGreaterThanOrEqual(3);
    expect(v.canPost).toBe(false);
  });

  it("requires documents to pre-date the conversion date and have unique references per contact", () => {
    const v = validateConversion({
      ...base,
      acceptDifference: true,
      invoices: [inv({ documentDate: "2026-01-01" }), inv(), inv()],
    });
    expect(v.errors.join(" ")).toMatch(/before the conversion date/);
    expect(v.errors.join(" ")).toMatch(/used twice/);
  });

  it("requires a conversion-date rate for foreign documents and one rate per currency", () => {
    const missing = validateConversion({
      ...base,
      acceptDifference: true,
      invoices: [inv({ currencyCode: "EUR" })],
    });
    expect(missing.errors.join(" ")).toMatch(/exchange rate for EUR/);

    const two = validateConversion({
      ...base,
      acceptDifference: true,
      invoices: [
        inv({ currencyCode: "EUR", fxRate: "1.10" }),
        inv({ reference: "INV-2", currencyCode: "EUR", fxRate: "1.20" }),
      ],
    });
    expect(two.errors.join(" ")).toMatch(/one conversion-date exchange rate/);
  });

  it("converts foreign receivables at the conversion rate for the balance check", () => {
    const v = validateConversion({
      ...base,
      tb: [{ accountId: "eq", debitMinor: 0n, creditMinor: 110000n }],
      invoices: [inv({ currencyCode: "EUR", fxRate: "1.10", amountMinor: 100000n })],
    });
    expect(v.summary.receivablesBase).toBe(110000n);
    expect(v.summary.difference).toBe(0n);
    expect(v.canPost).toBe(true);
  });

  it("is decimal aware for JPY documents in a GBP book", () => {
    const v = validateConversion({
      ...base,
      acceptDifference: true,
      invoices: [inv({ currencyCode: "JPY", fxRate: "0.0067", amountMinor: 1000n })],
    });
    // 1000 JPY * 0.0067 GBP = 6.70 GBP = 670 pence
    expect(v.summary.receivablesBase).toBe(670n);
  });

  it("requires at least one balance", () => {
    expect(validateConversion(base).errors.join(" ")).toMatch(/at least one opening balance/);
  });
});

describe("buildConversionPayload", () => {
  it("builds the RPC payload with only non-empty trial balance lines", () => {
    const p = buildConversionPayload("co", {
      ...base,
      tb: [
        { accountId: "a", debitMinor: 100n, creditMinor: 0n },
        { accountId: "z", debitMinor: 0n, creditMinor: 0n },
      ],
      invoices: [inv({ currencyCode: "EUR", fxRate: "1.1" })],
    });
    expect(p.tb_lines).toEqual([{ account_id: "a", debit_minor: 100, credit_minor: 0 }]);
    expect(p.invoices[0]).toMatchObject({
      currency_code: "EUR",
      fx_rate_to_base: "1.1",
      amount_minor: 50000,
      due_date: "2025-12-01",
    });
    expect(p.post_difference_to_opening_equity).toBe(false);
  });
});

describe("isDocumentControlAccount", () => {
  it("flags receivable / payable control accounts", () => {
    expect(isDocumentControlAccount({ account_kind: "accounts_receivable" })).toBe(true);
    expect(isDocumentControlAccount({ system_key: "ap" })).toBe(true);
    expect(isDocumentControlAccount({ account_kind: "bank" })).toBe(false);
  });
});
