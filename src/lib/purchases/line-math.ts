/**
 * Purchase document line math in integer minor units.
 * Tax uses basis points (10000 = 100%). Half-up on tax.
 */

export type LineInput = {
  quantity: number;
  unit_price_minor: bigint | number;
  discount_minor?: bigint | number;
  tax_rate_bps?: number;
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

/** net = max(0, round(qty * unit) - discount); tax = round(net * bps / 10000) */
export function computeLineAmounts(input: LineInput): LineComputed {
  if (!(input.quantity > 0) || !Number.isFinite(input.quantity)) {
    throw new Error("Quantity must be a positive number");
  }
  const unit = asBig(input.unit_price_minor);
  if (unit < 0n) throw new Error("Unit price cannot be negative");
  const discount = asBig(input.discount_minor);
  if (discount < 0n) throw new Error("Discount cannot be negative");
  const bps = input.tax_rate_bps ?? 0;
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
    throw new Error("Tax rate must be 0–10000 basis points");
  }

  // quantity may be fractional — compute via string-safe integer scaling (6 dp)
  const qtyScaled = BigInt(Math.round(input.quantity * 1_000_000));
  const extended = (unit * qtyScaled) / 1_000_000n;
  let net = extended - discount;
  if (net < 0n) throw new Error("Discount exceeds line net");

  // half-up tax
  const tax = (net * BigInt(bps) + 5000n) / 10000n;
  return { net_minor: net, tax_minor: tax, gross_minor: net + tax };
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
  return asBig(bill.total_minor) - asBig(bill.amount_paid_minor) - asBig(bill.amount_credited_minor);
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
