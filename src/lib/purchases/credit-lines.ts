/** Pure helpers for the supplier credit note form (multi-line, credit from a bill). Integer minor units only. */

export type CreditFormLine = {
  key: string;
  description: string;
  accountId: string;
  net: string;
  tax: string;
};

export type BillForCredit = {
  id: string;
  status: string;
  currency_code: string | null;
  fx_rate_to_base: number | null;
  total_minor: number;
  amount_paid_minor: number;
  amount_credited_minor: number;
  lines: Array<{
    description: string;
    account_id: string | null;
    net_minor: number;
    tax_minor: number;
  }>;
};

/** Bills a credit can be applied to: posted and not void. */
export function billAcceptsCredit(status: string): boolean {
  return status === "authorised" || status === "partly_paid";
}

export function billOutstandingMinor(
  b: Pick<BillForCredit, "total_minor" | "amount_paid_minor" | "amount_credited_minor">,
): number {
  return Math.max(0, b.total_minor - b.amount_paid_minor - b.amount_credited_minor);
}

/** Decimal text for a minor amount using the currency's number of decimals. */
export function minorToText(minor: number, decimals: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  if (decimals === 0) return `${sign}${abs}`;
  const unit = 10 ** decimals;
  const whole = Math.floor(abs / unit);
  const frac = String(abs % unit).padStart(decimals, "0");
  return `${sign}${whole}.${frac}`;
}

/** Form lines that credit the bill in full. Lines without an account are skipped (they cannot be posted). */
export function linesFromBill(
  bill: BillForCredit,
  decimals: number,
  makeKey: () => string,
): CreditFormLine[] {
  return bill.lines
    .filter((l) => l.account_id && l.net_minor > 0)
    .map((l) => ({
      key: makeKey(),
      description: l.description,
      accountId: l.account_id as string,
      net: minorToText(l.net_minor, decimals),
      tax: minorToText(l.tax_minor, decimals),
    }));
}

/** How much of a credit total to apply to a bill: never more than the bill still owes. */
export function suggestedAllocationMinor(totalMinor: number, bill: BillForCredit): number {
  return Math.min(Math.max(0, totalMinor), billOutstandingMinor(bill));
}
