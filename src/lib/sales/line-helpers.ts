import { sumLines, deriveBillStatus, billOutstanding } from "@/lib/purchases/line-math";
import { computeTaxLine, type TaxTreatment } from "@/lib/tax/tax-math";

export { sumLines, deriveBillStatus as deriveInvoiceStatus, billOutstanding as invoiceOutstanding };
export type { TaxTreatment };

export type SalesLineInput = {
  description: string;
  accountId: string;
  quantity: number;
  unitPriceMinor: number;
  discountMinor?: number;
  taxRateBps?: number;
};

export type SalesLineComputed = SalesLineInput & {
  net_minor: bigint;
  tax_minor: bigint;
  gross_minor: bigint;
};

/**
 * Line tax uses org treatment: exclusive (default) or inclusive when prices_include_tax.
 * Rounding: half-up via computeTaxLine — same rules as tax-math tests.
 */
export function validateSalesLines(
  lines: SalesLineInput[],
  opts: { treatment?: TaxTreatment } = {},
): SalesLineComputed[] {
  if (!lines.length) throw new Error("At least one line is required");
  const treatment = opts.treatment ?? "exclusive";
  return lines.map((l, i) => {
    const description = (l.description ?? "").trim();
    if (!description) throw new Error(`Line ${i + 1}: description is required`);
    if (!l.accountId) throw new Error(`Line ${i + 1}: account is required`);
    const computed = computeTaxLine({
      quantity: l.quantity,
      unit_price_minor: l.unitPriceMinor,
      discount_minor: l.discountMinor ?? 0,
      tax_rate_bps: l.taxRateBps ?? 0,
      treatment,
    });
    return {
      description,
      accountId: l.accountId,
      quantity: l.quantity,
      unitPriceMinor: l.unitPriceMinor,
      discountMinor: l.discountMinor ?? 0,
      taxRateBps: l.taxRateBps ?? 0,
      ...computed,
    };
  });
}

export function nextDate(from: string, frequency: string): string {
  const d = new Date(`${from}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error("Invalid date");
  switch (frequency) {
    case "weekly":
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case "monthly":
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    case "quarterly":
      d.setUTCMonth(d.getUTCMonth() + 3);
      break;
    case "yearly":
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
    default:
      throw new Error("Unsupported frequency");
  }
  return d.toISOString().slice(0, 10);
}
