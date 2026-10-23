/**
 * Sales line math with half-up rounding on quantity × unit price (AR-20).
 *
 * The shared `computeTaxLine` truncates `quantity × price` (1.5 × 3.33 → 4.99). Sales uses this
 * wrapper instead: it rounds the extended amount half-up to a whole minor unit, then delegates
 * the discount / tax maths to the shared function (which already rounds tax half-up).
 * Purchases keep using the shared function unchanged.
 */
import { computeTaxLine, type TaxLineInput, type TaxLineResult } from "@/lib/tax/tax-math";

const QTY_SCALE = 1_000_000n;

function asBig(v: bigint | number | undefined): bigint {
  if (v === undefined) return 0n;
  return typeof v === "number" ? BigInt(Math.round(v)) : v;
}

/** Round half-up (away from zero for ties) integer division; denominator must be positive. */
export function halfUpDivide(numer: bigint, denom: bigint): bigint {
  if (denom <= 0n) throw new Error("Invalid divisor");
  if (numer >= 0n) return (numer + denom / 2n) / denom;
  return -((-numer + denom / 2n) / denom);
}

/** quantity (up to 6 decimals) × unit price in minor units, rounded half-up to a minor unit. */
export function extendedAmountMinor(quantity: number, unitPriceMinor: bigint | number): bigint {
  if (!(quantity > 0) || !Number.isFinite(quantity)) {
    throw new Error("Quantity must be a positive number");
  }
  const unit = asBig(unitPriceMinor);
  if (unit < 0n) throw new Error("Unit price cannot be negative");
  const qtyScaled = BigInt(Math.round(quantity * 1_000_000));
  return halfUpDivide(unit * qtyScaled, QTY_SCALE);
}

export function computeTaxLineRounded(input: TaxLineInput): TaxLineResult {
  const extended = extendedAmountMinor(input.quantity, input.unit_price_minor);
  return computeTaxLine({
    quantity: 1,
    unit_price_minor: extended,
    discount_minor: input.discount_minor ?? 0,
    tax_rate_bps: input.tax_rate_bps,
    treatment: input.treatment,
  });
}
