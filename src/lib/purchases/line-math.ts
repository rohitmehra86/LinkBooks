/**
 * Purchase document line math in integer minor units.
 * Delegates to shared tax-math (exclusive/inclusive) so sales and purchases stay consistent.
 */

import { computeTaxLine, type TaxTreatment } from "@/lib/tax/tax-math";

export type LineInput = {
  quantity: number;
  unit_price_minor: bigint | number;
  discount_minor?: bigint | number;
  tax_rate_bps?: number;
  treatment?: TaxTreatment;
};

export type LineComputed = {
  net_minor: bigint;
  tax_minor: bigint;
  gross_minor: bigint;
};

function asBig(v: bigint | number | undefined): bigint {
  if (v === undefined) return 0n;
  return typeof v === "number" ? BigInt(v) : v;
}

/** Shared with sales: exclusive by default; inclusive when treatment is set. */
export function computeLineAmounts(input: LineInput): LineComputed {
  return computeTaxLine({
    quantity: input.quantity,
    unit_price_minor: input.unit_price_minor,
    discount_minor: input.discount_minor ?? 0,
    tax_rate_bps: input.tax_rate_bps ?? 0,
    treatment: input.treatment ?? "exclusive",
  });
}

export function sumLines(lines: LineComputed[]): {
  subtotal_minor: bigint;
  tax_minor: bigint;
  total_minor: bigint;
} {
  let subtotal = 0n;
  let tax = 0n;
  for (const l of lines) {
    subtotal += l.net_minor;
    tax += l.tax_minor;
  }
  return { subtotal_minor: subtotal, tax_minor: tax, total_minor: subtotal + tax };
}

export function billOutstanding(bill: {
  total_minor: bigint | number;
  amount_paid_minor: bigint | number;
  amount_credited_minor: bigint | number;
}): bigint {
  return (
    asBig(bill.total_minor) - asBig(bill.amount_paid_minor) - asBig(bill.amount_credited_minor)
  );
}

export function deriveBillStatus(bill: {
  status: string;
  total_minor: bigint | number;
  amount_paid_minor: bigint | number;
  amount_credited_minor: bigint | number;
}): "draft" | "authorised" | "partly_paid" | "paid" | "void" {
  if (bill.status === "draft" || bill.status === "void") return bill.status;
  const outstanding = billOutstanding(bill);
  if (outstanding <= 0n) return "paid";
  if (asBig(bill.amount_paid_minor) + asBig(bill.amount_credited_minor) > 0n) return "partly_paid";
  return "authorised";
}
