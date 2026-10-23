import type { PostJournalInput } from "@/lib/accounting/posting-engine";

/** Prefix the reports use to recognise a closing journal (P&L excludes it, TB / BS keep it). */
export const YEAR_END_MEMO_PREFIX = "Year-end close";

export type PlBalance = {
  account_id: string;
  /** debit minus credit in base currency over the financial year */
  net_debit_minor: bigint;
};

export type YearEndClosePlan = {
  netProfitMinor: bigint;
  lines: Array<{
    account_id: string;
    debit_minor: bigint;
    credit_minor: bigint;
    description: string;
  }>;
};

/**
 * Plan of the closing entry: every income / expense account with a balance is brought to zero
 * and the net result moves to retained earnings. Pure and always balanced.
 */
export function planYearEndClose(
  balances: PlBalance[],
  retainedEarningsAccountId: string,
): YearEndClosePlan {
  const lines: YearEndClosePlan["lines"] = [];
  let net = 0n; // credit minus debit of the P&L accounts = profit
  for (const b of balances) {
    if (b.net_debit_minor === 0n) continue;
    net -= b.net_debit_minor;
    // Reverse the balance: a debit balance is cleared with a credit and vice versa.
    lines.push(
      b.net_debit_minor > 0n
        ? {
            account_id: b.account_id,
            debit_minor: 0n,
            credit_minor: b.net_debit_minor,
            description: "Close to retained earnings",
          }
        : {
            account_id: b.account_id,
            debit_minor: -b.net_debit_minor,
            credit_minor: 0n,
            description: "Close to retained earnings",
          },
    );
  }
  if (lines.length > 0 && net !== 0n) {
    lines.push(
      net > 0n
        ? {
            account_id: retainedEarningsAccountId,
            debit_minor: 0n,
            credit_minor: net,
            description: "Profit for the year",
          }
        : {
            account_id: retainedEarningsAccountId,
            debit_minor: -net,
            credit_minor: 0n,
            description: "Loss for the year",
          },
    );
  }
  return { netProfitMinor: net, lines };
}

export function yearEndIdempotencyKey(companyId: string, fyEnd: string): string {
  return `year_end_close:${companyId}:${fyEnd}`;
}

export function buildYearEndJournal(args: {
  companyId: string;
  fyStart: string;
  fyEnd: string;
  baseCurrency: string;
  plan: YearEndClosePlan;
}): PostJournalInput {
  if (args.plan.lines.length === 0)
    throw new Error("Nothing to close: no income or expense balances in this year.");
  return {
    company_id: args.companyId,
    journal_date: args.fyEnd,
    currency_code: args.baseCurrency,
    source_type: "other",
    idempotency_key: yearEndIdempotencyKey(args.companyId, args.fyEnd),
    memo: `${YEAR_END_MEMO_PREFIX} ${args.fyStart} to ${args.fyEnd}`,
    lines: args.plan.lines,
  };
}
