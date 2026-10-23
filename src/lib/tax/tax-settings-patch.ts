/**
 * Partial update of company_tax_settings (TX-02).
 *
 * `undefined` means "leave the column alone"; `null` (or an empty string for text) clears it.
 * This is what stops "Save registration" from wiping the default tax codes, filing frequency or
 * non-recoverable tax account that the form never sent.
 */

export type TaxSettingsInput = {
  taxRegime?: string | undefined;
  registrationNumber?: string | null | undefined;
  pricesIncludeTax?: boolean | undefined;
  filingFrequency?: string | null | undefined;
  taxBasis?: string | undefined;
  jurisdictionCode?: string | null | undefined;
  defaultSalesTaxCodeId?: string | null | undefined;
  defaultPurchaseTaxCodeId?: string | null | undefined;
  outputTaxAccountId?: string | null | undefined;
  inputTaxAccountId?: string | null | undefined;
  nonRecoverableTaxAccountId?: string | null | undefined;
  registrationDate?: string | null | undefined;
  registrationEndDate?: string | null | undefined;
};

export const TAX_REGIMES = ["none", "vat", "gst", "sales_tax", "other"] as const;
export const FILING_FREQUENCIES = [
  "monthly",
  "quarterly",
  "annually",
  "bi_monthly",
  "semi_annually",
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function optionalUuid(v: string | null | undefined, name: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (!UUID.test(v)) throw new Error(`${name} is not a valid id`);
  return v;
}

function optionalDate(v: string | null | undefined, name: string): string | null | undefined {
  if (v === undefined) return undefined;
  const t = (v ?? "").trim();
  if (!t) return null;
  if (!ISO.test(t)) throw new Error(`${name} must be YYYY-MM-DD`);
  return t;
}

/** Returns only the columns that were provided, in database column names. */
export function buildTaxSettingsPatch(input: TaxSettingsInput): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (input.taxRegime !== undefined) {
    if (!(TAX_REGIMES as readonly string[]).includes(input.taxRegime)) {
      throw new Error("Invalid tax regime");
    }
    patch["tax_regime"] = input.taxRegime;
  }
  if (input.registrationNumber !== undefined) {
    patch["registration_number"] = (input.registrationNumber ?? "").trim().slice(0, 80) || null;
  }
  if (input.pricesIncludeTax !== undefined) {
    patch["prices_include_tax"] = Boolean(input.pricesIncludeTax);
  }
  if (input.filingFrequency !== undefined) {
    const f = input.filingFrequency ? input.filingFrequency : null;
    if (f !== null && !(FILING_FREQUENCIES as readonly string[]).includes(f)) {
      throw new Error("Invalid filing frequency");
    }
    patch["filing_frequency"] = f;
  }
  if (input.taxBasis !== undefined) {
    if (!["invoice", "cash"].includes(input.taxBasis)) throw new Error("Invalid tax basis");
    patch["tax_basis"] = input.taxBasis;
  }
  if (input.jurisdictionCode !== undefined) {
    patch["jurisdiction_code"] =
      (input.jurisdictionCode ?? "").trim().toUpperCase().slice(0, 8) || null;
  }
  const defaultSales = optionalUuid(input.defaultSalesTaxCodeId, "Default sales tax code");
  if (defaultSales !== undefined) patch["default_sales_tax_code_id"] = defaultSales;
  const defaultPurchase = optionalUuid(input.defaultPurchaseTaxCodeId, "Default purchase tax code");
  if (defaultPurchase !== undefined) patch["default_purchase_tax_code_id"] = defaultPurchase;
  const output = optionalUuid(input.outputTaxAccountId, "Output tax account");
  if (output !== undefined) patch["output_tax_account_id"] = output;
  const inputAcc = optionalUuid(input.inputTaxAccountId, "Input tax account");
  if (inputAcc !== undefined) patch["input_tax_account_id"] = inputAcc;
  const nonRec = optionalUuid(input.nonRecoverableTaxAccountId, "Non-recoverable tax account");
  if (nonRec !== undefined) patch["non_recoverable_tax_account_id"] = nonRec;
  const regDate = optionalDate(input.registrationDate, "registrationDate");
  if (regDate !== undefined) patch["registration_date"] = regDate;
  const regEnd = optionalDate(input.registrationEndDate, "registrationEndDate");
  if (regEnd !== undefined) patch["registration_end_date"] = regEnd;
  return patch;
}
