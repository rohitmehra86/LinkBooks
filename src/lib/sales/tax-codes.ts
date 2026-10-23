/**
 * Sales tax-code lookup (AR-19). The tax_codes table is authoritative: when a line carries a
 * tax_code_id the server derives the rate from the code, never from the browser.
 */
import type { SalesClient } from "@/lib/sales/rpc";
import { isRateEffective } from "@/lib/tax/tax-math";

export type SalesTaxCode = {
  id: string;
  code: string;
  name: string;
  rate_bps: number;
  treatment: string;
  applies_to: string;
};

type RawCode = {
  id: string;
  code: string;
  name: string;
  treatment: string | null;
  applies_to: string;
  is_active: boolean;
  tax_rates: {
    rate_bps: number;
    effective_from: string;
    effective_to: string | null;
    is_active: boolean;
  } | null;
};

export async function loadSalesTaxCodes(
  supabase: SalesClient,
  companyId: string,
  onDate?: string,
): Promise<SalesTaxCode[]> {
  const { data, error } = await supabase
    .from("tax_codes" as never)
    .select(
      "id, code, name, treatment, applies_to, is_active, tax_rates(rate_bps, effective_from, effective_to, is_active)" as never,
    )
    .eq("company_id" as never, companyId as never)
    .eq("is_active" as never, true as never)
    .in("applies_to" as never, ["sales", "both"] as never)
    .order("code" as never);
  if (error) throw new Error(error.message);
  const date = onDate ?? new Date().toISOString().slice(0, 10);
  return ((data ?? []) as unknown as RawCode[])
    .filter((c) => c.tax_rates && isRateEffective(c.tax_rates, date))
    .map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      rate_bps: c.tax_rates!.rate_bps,
      treatment: c.treatment ?? "standard",
      applies_to: c.applies_to,
    }));
}

/** Replace each line's rate with its tax code's rate; reject codes that are unknown or not for sales. */
export async function applyTaxCodeRates<
  T extends { taxCodeId?: string | null; taxRateBps?: number },
>(supabase: SalesClient, companyId: string, lines: T[], onDate?: string): Promise<T[]> {
  if (!lines.some((l) => l.taxCodeId)) return lines;
  const codes = await loadSalesTaxCodes(supabase, companyId, onDate);
  const byId = new Map(codes.map((c) => [c.id, c]));
  return lines.map((l, i) => {
    if (!l.taxCodeId) return l;
    const code = byId.get(l.taxCodeId);
    if (!code) {
      throw new Error(`Line ${i + 1}: tax code is not available for sales on this date`);
    }
    return { ...l, taxRateBps: code.rate_bps };
  });
}
