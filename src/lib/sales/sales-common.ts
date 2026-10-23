/** Shared server-side helpers for the sales functions (kept out of the *.functions.ts bundles). */
import { assertUuid } from "@/lib/company-validation";
import type { SalesLineInput } from "@/lib/sales/line-helpers";
import { escapeLikeLiteral } from "@/lib/sales/list-filters";
import { todayInTimezone } from "@/lib/sales/dates";
import type { SalesClient } from "@/lib/sales/rpc";

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function parseSalesLineInputs(lines: SalesLineInput[]): SalesLineInput[] {
  if (!Array.isArray(lines) || !lines.length) throw new Error("At least one line is required");
  return lines.map((l, i) => {
    const description = (l.description ?? "").trim();
    if (!description) throw new Error(`Line ${i + 1}: description is required`);
    if (!l.accountId) throw new Error(`Line ${i + 1}: account is required`);
    const productId =
      l.productId && String(l.productId).trim()
        ? assertUuid(String(l.productId), `line ${i + 1} product`)
        : null;
    const taxCodeId =
      l.taxCodeId && String(l.taxCodeId).trim()
        ? assertUuid(String(l.taxCodeId), `line ${i + 1} tax code`)
        : null;
    return {
      description,
      accountId: assertUuid(String(l.accountId), `line ${i + 1} account`),
      quantity: Number(l.quantity),
      unitPriceMinor: Math.round(Number(l.unitPriceMinor)),
      discountMinor: Math.round(Number(l.discountMinor ?? 0)),
      taxRateBps: Math.round(Number(l.taxRateBps ?? 0)),
      taxCodeId,
      productId,
    };
  });
}

export async function loadTaxTreatment(
  supabase: SalesClient,
  companyId: string,
): Promise<"exclusive" | "inclusive"> {
  const { data, error } = await supabase
    .from("company_tax_settings" as never)
    .select("prices_include_tax" as never)
    .eq("company_id" as never, companyId as never)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { prices_include_tax?: boolean } | null)?.prices_include_tax
    ? "inclusive"
    : "exclusive";
}

export type CompanyDefaults = { baseCurrency: string; timezone: string; today: string };

export async function loadCompanyDefaults(
  supabase: SalesClient,
  companyId: string,
): Promise<CompanyDefaults> {
  const { data, error } = await supabase
    .from("companies" as never)
    .select("base_currency, timezone" as never)
    .eq("id" as never, companyId as never)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const c = data as { base_currency?: string; timezone?: string } | null;
  const timezone = c?.timezone ?? "UTC";
  return {
    baseCurrency: (c?.base_currency ?? "USD").toUpperCase(),
    timezone,
    today: todayInTimezone(timezone),
  };
}

/** Currency + FX validation shared by all document saves (AR-10). */
export function normaliseCurrencyAndFx(
  currencyCode: string,
  baseCurrency: string,
  fxRate: unknown,
): { currencyCode: string; fxRateToBase: number } {
  const code = (currencyCode ?? "").toUpperCase().trim() || baseCurrency;
  if (!/^[A-Z]{3}$/.test(code)) throw new Error("Currency must be a 3-letter code");
  if (code === baseCurrency) return { currencyCode: code, fxRateToBase: 1 };
  const fx = Number(fxRate);
  if (!(fx > 0) || !Number.isFinite(fx)) {
    throw new Error(`An exchange rate to ${baseCurrency} is required for ${code} documents`);
  }
  return { currencyCode: code, fxRateToBase: fx };
}

// ---------------------------------------------------------------------------------------------
// Line preparation + list helpers shared by every sales server module
// ---------------------------------------------------------------------------------------------
import { requireAccountInCompany } from "@/lib/purchases/accounts";
import { validateSalesLines, type SalesLineComputed } from "@/lib/sales/line-helpers";
import { applyTaxCodeRates } from "@/lib/sales/tax-codes";

/**
 * Parse -> apply server-side tax-code rates -> compute (half-up, tax treatment from
 * company_tax_settings) -> verify every account belongs to the company.
 */
export async function prepareSalesLines(
  supabase: SalesClient,
  companyId: string,
  raw: SalesLineInput[],
  docDate: string,
): Promise<SalesLineComputed[]> {
  const parsed = parseSalesLineInputs(raw);
  const withRates = await applyTaxCodeRates(supabase, companyId, parsed, docDate);
  const treatment = await loadTaxTreatment(supabase, companyId);
  const lines = validateSalesLines(withRates, { treatment });
  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.accountId)) continue;
    seen.add(l.accountId);
    await requireAccountInCompany(supabase, companyId, l.accountId);
  }
  return lines;
}

/** Contact ids whose name matches `term` (for list search across the customer name). */
export async function searchContactIds(
  supabase: SalesClient,
  companyId: string,
  term: string,
): Promise<string[]> {
  const t = term.trim().slice(0, 100);
  if (!t) return [];
  const { data, error } = await supabase
    .from("contacts" as never)
    .select("id" as never)
    .eq("company_id" as never, companyId as never)
    .ilike("name" as never, `%${escapeLikeLiteral(t)}%` as never)
    .limit(200);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

export function assertReason(reason: unknown, label = "A reason"): string {
  const r = typeof reason === "string" ? reason.trim() : "";
  if (r.length < 3) throw new Error(`${label} is required (at least 3 characters)`);
  return r.slice(0, 500);
}

export function optionalIsoDate(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  const s = String(value);
  if (!isIsoDate(s)) throw new Error(`${label} must be YYYY-MM-DD`);
  return s;
}

/** Embedded child rows come back unordered; sort by line_order (then id) for a stable document. */
export function sortLines<T extends { line_order?: number | null; id?: string }>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) => (a.line_order ?? 0) - (b.line_order ?? 0) || (a.id ?? "").localeCompare(b.id ?? ""),
  );
}

/** Minimal structural type of a PostgREST list query so filter helpers can be shared. */
export type ListQuery = {
  eq(c: never, v: never): ListQuery;
  in(c: never, v: never): ListQuery;
  lt(c: never, v: never): ListQuery;
  gt(c: never, v: never): ListQuery;
  gte(c: never, v: never): ListQuery;
  lte(c: never, v: never): ListQuery;
  or(v: never): ListQuery;
  order(c: never, o?: never): ListQuery;
  range(
    from: number,
    to: number,
  ): PromiseLike<{
    data: unknown[] | null;
    error: { message: string } | null;
    count?: number | null;
  }>;
};
