/**
 * Reverse-charge VAT on purchase bills (TX-04). Pure maths and journal planning.
 *
 * A reverse-charge line is one whose tax code has treatment `reverse_charge`. The supplier
 * charges no tax, so the bill stores `tax_minor = 0` (the payable is the net amount) and keeps
 * the code's rate in `tax_rate_bps`. The buyer self-assesses the tax:
 *   Dr input tax (recoverable)  /  Cr output tax        for the same amount.
 * Net effect on the tax accounts is zero when fully recoverable. In the return the amount is
 * in box 1 (output) and box 4 (input).
 *
 * "Self-assessed" means: reverse-charge code AND stored tax of zero. Older bills that stored
 * a non-zero tax on a reverse-charge code keep their original posting (input tax only).
 */

/** round(net * rateBps / 10000), half away from zero. Rounded once per line. */
export function reverseChargeTaxMinor(netMinor: bigint, rateBps: number): bigint {
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000) {
    throw new Error("Tax rate must be 0 to 10000 basis points");
  }
  if (netMinor === 0n || rateBps === 0) return 0n;
  const n = netMinor * BigInt(rateBps);
  return n >= 0n ? (n + 5000n) / 10000n : -((-n + 5000n) / 10000n);
}

export function isSelfAssessedReverseCharge(
  treatment: string | null | undefined,
  storedTaxMinor: bigint,
): boolean {
  return treatment === "reverse_charge" && storedTaxMinor === 0n;
}

export type ReverseChargeLineInput = {
  netMinor: bigint;
  rateBps: number;
  /** Tax code treatment, null when the line has none. */
  treatment: string | null;
  /** Stored tax on the bill line. */
  storedTaxMinor: bigint;
  /** Whether the tax code lets the buyer reclaim the tax. */
  recoverable: boolean;
};

export type ReverseChargePlan = {
  /** Notional tax per input line (0 for lines that are not self-assessed). */
  perLine: bigint[];
  /** Extra debit to add to each line's expense account (non-recoverable part). */
  expenseUplift: bigint[];
  /** Dr input tax account. */
  inputDebit: bigint;
  /** Cr output tax account. */
  outputCredit: bigint;
};

/**
 * Splits the self-assessed tax of a bill into journal amounts. Always balanced:
 * inputDebit + sum(expenseUplift) === outputCredit.
 */
export function planReverseCharge(lines: ReverseChargeLineInput[]): ReverseChargePlan {
  const perLine: bigint[] = [];
  const expenseUplift: bigint[] = [];
  let inputDebit = 0n;
  let outputCredit = 0n;
  for (const l of lines) {
    if (l.netMinor < 0n) throw new Error("Bill line amounts cannot be negative");
    if (!isSelfAssessedReverseCharge(l.treatment, l.storedTaxMinor)) {
      perLine.push(0n);
      expenseUplift.push(0n);
      continue;
    }
    const tax = reverseChargeTaxMinor(l.netMinor, l.rateBps);
    perLine.push(tax);
    outputCredit += tax;
    if (l.recoverable) {
      expenseUplift.push(0n);
      inputDebit += tax;
    } else {
      expenseUplift.push(tax);
    }
  }
  return { perLine, expenseUplift, inputDebit, outputCredit };
}
