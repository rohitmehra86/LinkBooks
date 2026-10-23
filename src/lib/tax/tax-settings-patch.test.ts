import { describe, expect, it } from "vitest";
import { buildTaxSettingsPatch } from "./tax-settings-patch";
import { buildTaxAdjustmentJournal } from "./tax-adjustment";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("TX-02 updateTaxSettings is a partial update", () => {
  it("saving registration touches only registration fields", () => {
    const patch = buildTaxSettingsPatch({
      taxRegime: "vat",
      registrationNumber: " GB123 ",
      pricesIncludeTax: true,
      registrationDate: "2026-01-01",
    });
    expect(Object.keys(patch).sort()).toEqual(
      ["prices_include_tax", "registration_date", "registration_number", "tax_regime"].sort(),
    );
    // Defaults the form never sent must not appear (they would be nulled)
    expect(patch).not.toHaveProperty("default_sales_tax_code_id");
    expect(patch).not.toHaveProperty("default_purchase_tax_code_id");
    expect(patch).not.toHaveProperty("filing_frequency");
    expect(patch).not.toHaveProperty("non_recoverable_tax_account_id");
    expect(patch["registration_number"]).toBe("GB123");
  });

  it("saving mappings touches only the two account columns", () => {
    const patch = buildTaxSettingsPatch({ outputTaxAccountId: UUID, inputTaxAccountId: null });
    expect(patch).toEqual({ output_tax_account_id: UUID, input_tax_account_id: null });
  });

  it("an explicit null clears a column; undefined leaves it", () => {
    const patch = buildTaxSettingsPatch({
      defaultSalesTaxCodeId: null,
      filingFrequency: undefined,
    });
    expect(patch).toEqual({ default_sales_tax_code_id: null });
  });

  it("validates values", () => {
    expect(() => buildTaxSettingsPatch({ taxRegime: "nope" })).toThrow();
    expect(() => buildTaxSettingsPatch({ taxBasis: "weird" })).toThrow();
    expect(() => buildTaxSettingsPatch({ filingFrequency: "sometimes" })).toThrow();
    expect(() => buildTaxSettingsPatch({ outputTaxAccountId: "not-a-uuid" })).toThrow();
    expect(() => buildTaxSettingsPatch({ registrationDate: "01/02/2026" })).toThrow();
  });

  it("an empty input produces an empty patch", () => {
    expect(buildTaxSettingsPatch({})).toEqual({});
  });
});

describe("TX-03 tax adjustment never puts free text in source_id", () => {
  const base = {
    companyId: UUID,
    journalDate: "2026-06-30",
    taxAccountId: "22222222-2222-4222-8222-222222222222",
    offsetAccountId: "33333333-3333-4333-8333-333333333333",
    amountMinor: 1250,
    direction: "increase_payable" as const,
    memo: "Rounding true-up",
    adjustmentKey: "adj-2026-06-30",
    currencyCode: "GBP",
  };
  it("leaves source_id unset and keys the journal by idempotency_key", () => {
    const j = buildTaxAdjustmentJournal(base);
    expect(j.source_id).toBeUndefined();
    expect(j.idempotency_key).toBe(`tax_adjustment:${UUID}:adj-2026-06-30`);
    expect(j.source_type).toBe("tax_adjustment");
  });
  it("builds balanced lines in both directions", () => {
    for (const direction of ["increase_payable", "decrease_payable"] as const) {
      const j = buildTaxAdjustmentJournal({ ...base, direction });
      const d = j.lines.reduce((n, l) => n + BigInt(l.debit_minor), 0n);
      const c = j.lines.reduce((n, l) => n + BigInt(l.credit_minor), 0n);
      expect(d).toBe(c);
      const taxLine = j.lines.find((l) => l.account_id === base.taxAccountId)!;
      expect(
        direction === "increase_payable"
          ? BigInt(taxLine.credit_minor)
          : BigInt(taxLine.debit_minor),
      ).toBe(1250n);
    }
  });
  it("accepts a real tax-return id as source_id", () => {
    const j = buildTaxAdjustmentJournal(base, "44444444-4444-4444-8444-444444444444");
    expect(j.source_id).toBe("44444444-4444-4444-8444-444444444444");
  });
  it("rejects identical accounts and non-positive amounts", () => {
    expect(() =>
      buildTaxAdjustmentJournal({ ...base, offsetAccountId: base.taxAccountId }),
    ).toThrow();
    expect(() => buildTaxAdjustmentJournal({ ...base, amountMinor: 0 })).toThrow();
  });
});
