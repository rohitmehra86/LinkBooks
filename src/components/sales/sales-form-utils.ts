import { fromMinorUnits, toMinorUnits } from "@/lib/accounting/money";
import type { SalesLineInput } from "@/lib/sales/line-helpers";
import type { SalesLineFormState } from "@/components/sales/SalesDocumentLines";

/** Basis points <-> percent for display (2000 bps = "20"). */
export function bpsToPercentString(bps: number | string): string {
  const n = Number(bps);
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n) / 100);
}

export function percentStringToBps(pct: string): number {
  const n = Number(pct);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

export function lineFormToInput(l: SalesLineFormState, currency: string): SalesLineInput {
  return {
    description: l.description,
    accountId: l.accountId,
    quantity: Number(l.quantity),
    unitPriceMinor: Number(toMinorUnits(l.unitPrice || "0", currency)),
    discountMinor: Number(toMinorUnits(l.discount || "0", currency)),
    taxRateBps: Number(l.taxRateBps || 0),
    taxCodeId: l.taxCodeId || null,
    productId: l.productId || null,
  };
}

export type SavedLineRow = {
  description: string;
  account_id: string;
  quantity: number | string;
  unit_price_minor: number;
  discount_minor: number;
  tax_rate_bps: number;
  tax_code_id?: string | null;
  product_id?: string | null;
};

export function lineRowToForm(l: SavedLineRow, currency: string): SalesLineFormState {
  return {
    productId: l.product_id ?? "",
    description: l.description,
    accountId: l.account_id,
    quantity: String(l.quantity),
    unitPrice: fromMinorUnits(l.unit_price_minor, currency),
    discount: fromMinorUnits(l.discount_minor, currency),
    taxRateBps: String(l.tax_rate_bps),
    taxCodeId: l.tax_code_id ?? "",
  };
}

/** Currencies offered in the picker (base currency is always first). */
export const COMMON_CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "AUD",
  "CAD",
  "CHF",
  "INR",
  "JPY",
  "NZD",
  "SGD",
  "ZAR",
  "AED",
];

export function currencyOptions(base: string, extra: string[] = []): string[] {
  return [...new Set([base, ...extra, ...COMMON_CURRENCIES])];
}

/** Display an amount in a document's own currency (never the company base currency). */
export function money(minor: number | bigint, currency: string): string {
  return `${currency} ${fromMinorUnits(minor, currency)}`;
}
