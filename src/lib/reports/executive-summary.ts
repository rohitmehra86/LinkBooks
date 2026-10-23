/**
 * Executive summary: a few headline figures for the period against the prior period.
 * Pure and integer-only: money in minor units, percentages and changes in basis points, days whole.
 */

import { roundDiv } from "@/lib/budgets/budget-math";

export type SummaryPeriod = {
  revenueMinor: number;
  costOfSalesMinor: number;
  grossProfitMinor: number;
  operatingExpenseMinor: number;
  netProfitMinor: number;
  cashReceivedMinor: number;
  cashSpentMinor: number;
  closingCashMinor: number;
  receivablesMinor: number;
  payablesMinor: number;
  assetsMinor: number;
  liabilitiesMinor: number;
  /** Days in the period (inclusive). */
  days: number;
};

export type SummaryRow = {
  key: string;
  label: string;
  group: "cash" | "profitability" | "position" | "performance";
  format: "money" | "bps" | "days";
  current: number | null;
  prior: number | null;
  /** Change versus prior in basis points of the prior value; null when it cannot be computed. */
  changeBps: number | null;
  /** Which direction counts as good, for colouring. */
  better: "higher" | "lower" | "neutral";
  note?: string;
};

/** (current − prior) ÷ |prior| in basis points; null when prior is zero. */
export function changeBps(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null || prior === 0) return null;
  return Number(roundDiv(BigInt(current - prior) * 10_000n, BigInt(Math.abs(prior))));
}

/** a ÷ b in basis points (margin); null when b is not positive. */
export function ratioBps(a: number, b: number): number | null {
  if (b <= 0) return null;
  return Number(roundDiv(BigInt(a) * 10_000n, BigInt(b)));
}

/** balance ÷ flow × days, rounded; null when there is no flow to measure against. */
export function daysOf(balance: number, flow: number, days: number): number | null {
  if (flow <= 0 || days <= 0) return null;
  return Number(roundDiv(BigInt(balance) * BigInt(days), BigInt(flow)));
}

export function buildExecutiveSummary(current: SummaryPeriod, prior: SummaryPeriod): SummaryRow[] {
  const rows: SummaryRow[] = [];
  const add = (
    key: string,
    label: string,
    group: SummaryRow["group"],
    format: SummaryRow["format"],
    cur: number | null,
    pri: number | null,
    better: SummaryRow["better"],
    note?: string,
  ) => {
    const row: SummaryRow = {
      key,
      label,
      group,
      format,
      current: cur,
      prior: pri,
      changeBps: format === "money" ? changeBps(cur, pri) : null,
      better,
    };
    if (note) row.note = note;
    rows.push(row);
  };
  const m = (k: keyof SummaryPeriod) => [current[k], prior[k]] as const;

  add("cash_received", "Cash received", "cash", "money", ...m("cashReceivedMinor"), "higher");
  add("cash_spent", "Cash spent", "cash", "money", ...m("cashSpentMinor"), "lower");
  add(
    "cash_net",
    "Net cash movement",
    "cash",
    "money",
    current.cashReceivedMinor - current.cashSpentMinor,
    prior.cashReceivedMinor - prior.cashSpentMinor,
    "higher",
    "Excludes transfers between your own bank accounts",
  );
  add("cash_closing", "Cash at end of period", "cash", "money", ...m("closingCashMinor"), "higher");

  add("revenue", "Revenue", "profitability", "money", ...m("revenueMinor"), "higher");
  add("gross_profit", "Gross profit", "profitability", "money", ...m("grossProfitMinor"), "higher");
  add(
    "operating_expense",
    "Operating expenses",
    "profitability",
    "money",
    ...m("operatingExpenseMinor"),
    "lower",
  );
  add("net_profit", "Net profit", "profitability", "money", ...m("netProfitMinor"), "higher");

  add("receivables", "Money owed to you", "position", "money", ...m("receivablesMinor"), "neutral");
  add("payables", "Money you owe", "position", "money", ...m("payablesMinor"), "neutral");
  add(
    "net_assets",
    "Net assets",
    "position",
    "money",
    current.assetsMinor - current.liabilitiesMinor,
    prior.assetsMinor - prior.liabilitiesMinor,
    "higher",
  );

  add(
    "gross_margin",
    "Gross margin",
    "performance",
    "bps",
    ratioBps(current.grossProfitMinor, current.revenueMinor),
    ratioBps(prior.grossProfitMinor, prior.revenueMinor),
    "higher",
  );
  add(
    "net_margin",
    "Net margin",
    "performance",
    "bps",
    ratioBps(current.netProfitMinor, current.revenueMinor),
    ratioBps(prior.netProfitMinor, prior.revenueMinor),
    "higher",
  );
  add(
    "debtor_days",
    "Debtor days",
    "performance",
    "days",
    daysOf(current.receivablesMinor, current.revenueMinor, current.days),
    daysOf(prior.receivablesMinor, prior.revenueMinor, prior.days),
    "lower",
    "Receivables at period end ÷ revenue × days; ignores tax and timing of sales within the period",
  );
  add(
    "creditor_days",
    "Creditor days",
    "performance",
    "days",
    daysOf(
      current.payablesMinor,
      current.costOfSalesMinor + current.operatingExpenseMinor,
      current.days,
    ),
    daysOf(prior.payablesMinor, prior.costOfSalesMinor + prior.operatingExpenseMinor, prior.days),
    "neutral",
    "Payables at period end ÷ (cost of sales + operating expenses) × days",
  );
  return rows;
}
