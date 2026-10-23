/**
 * Fixed-asset depreciation maths (pure, integer minor units, monthly convention).
 *
 * This mirrors `public.fa_month_amount` in the database migration, which is the source of truth when
 * depreciation is posted. This copy drives the projected schedule and is covered by unit tests.
 *
 * Conventions
 *  - The first period is the month that contains the depreciation start date (full month).
 *  - `openingAccumulatedMinor` is depreciation already taken before the start date (brought forward
 *    from another system). It is not posted again.
 *  - Straight line: depreciable amount = cost − residual − opening accumulated, spread over
 *    `usefulLifeMonths` (counted from the start month). Each month is the rounded share; the last
 *    month takes whatever remains, so the total is exact and the asset ends at its residual value.
 *  - Reducing balance: each month = (net book value − residual) × annual rate ÷ 12, rounded half up.
 *    It approaches the residual value and never goes below it.
 */

import { addMonthsIso, monthEnd, monthStart } from "@/lib/accounting/fiscal-year";
import { roundDiv } from "@/lib/budgets/budget-math";

export type DepreciationMethod = "straight_line" | "reducing_balance" | "none";

export const DEPRECIATION_METHODS: ReadonlyArray<{ value: DepreciationMethod; label: string }> = [
  { value: "straight_line", label: "Straight line" },
  { value: "reducing_balance", label: "Reducing balance" },
  { value: "none", label: "No depreciation (e.g. land)" },
];

export type DepreciableAsset = {
  method: DepreciationMethod;
  costMinor: number;
  residualMinor: number;
  openingAccumulatedMinor: number;
  /** Straight line only. */
  usefulLifeMonths: number | null;
  /** Reducing balance only: annual rate in basis points (2000 = 20% a year). */
  annualRateBps: number | null;
};

/** Validation messages for an asset definition; an empty list means it is usable. */
export function validateAssetTerms(a: DepreciableAsset): string[] {
  const errs: string[] = [];
  const ints: Array<[string, number]> = [
    ["Cost", a.costMinor],
    ["Residual value", a.residualMinor],
    ["Opening accumulated depreciation", a.openingAccumulatedMinor],
  ];
  for (const [label, v] of ints) {
    if (!Number.isSafeInteger(v) || v < 0) errs.push(`${label} must be zero or more.`);
  }
  if (a.costMinor <= 0) errs.push("Cost must be greater than zero.");
  if (a.residualMinor > a.costMinor) errs.push("Residual value cannot exceed cost.");
  if (a.openingAccumulatedMinor + a.residualMinor > a.costMinor) {
    errs.push("Residual value plus opening depreciation cannot exceed cost.");
  }
  if (a.method === "straight_line") {
    if (!a.usefulLifeMonths || !Number.isInteger(a.usefulLifeMonths) || a.usefulLifeMonths < 1) {
      errs.push("Straight line needs a useful life of at least 1 month.");
    } else if (a.usefulLifeMonths > 1200) {
      errs.push("Useful life cannot exceed 1,200 months.");
    }
  }
  if (a.method === "reducing_balance") {
    const r = a.annualRateBps;
    if (!r || !Number.isInteger(r) || r < 1 || r > 10_000) {
      errs.push("Reducing balance needs an annual rate between 0.01% and 100%.");
    }
  }
  return errs;
}

/** Amount to depreciate before the residual value is reached. */
export function depreciableBase(a: DepreciableAsset): number {
  return Math.max(0, a.costMinor - a.residualMinor - a.openingAccumulatedMinor);
}

/**
 * Depreciation for the `monthIndex`-th month (1 = start month), given what has already been
 * depreciated since the start date (`postedMinor`, excluding opening accumulated depreciation).
 */
export function monthlyDepreciation(
  a: DepreciableAsset,
  monthIndex: number,
  postedMinor: number,
): number {
  if (a.method === "none" || monthIndex < 1) return 0;
  const base = depreciableBase(a);
  const remaining = Math.max(0, base - postedMinor);
  if (remaining === 0) return 0;
  if (a.method === "straight_line") {
    const life = a.usefulLifeMonths ?? 0;
    if (life < 1 || monthIndex > life) return 0;
    if (monthIndex === life) return remaining;
    const share = Number(roundDiv(BigInt(base), BigInt(life)));
    return Math.min(share, remaining);
  }
  // reducing balance
  const rate = a.annualRateBps ?? 0;
  if (rate < 1) return 0;
  const amount = Number(roundDiv(BigInt(remaining) * BigInt(rate), 120_000n));
  return Math.min(amount, remaining);
}

/** 1-based month index of `periodEnd` relative to the month of `startDate` (0 or negative = before start). */
export function monthIndexFor(startDate: string, periodEnd: string): number {
  const sy = Number(startDate.slice(0, 4));
  const sm = Number(startDate.slice(5, 7));
  const py = Number(periodEnd.slice(0, 4));
  const pm = Number(periodEnd.slice(5, 7));
  return (py - sy) * 12 + (pm - sm) + 1;
}

export type ScheduleRow = {
  monthIndex: number;
  periodEnd: string;
  amountMinor: number;
  accumulatedMinor: number;
  netBookValueMinor: number;
};

/**
 * Projected schedule from the start month. `maxMonths` caps reducing-balance tails; the schedule also
 * stops once nothing is left to depreciate. Accumulated includes opening depreciation.
 */
export function buildSchedule(
  a: DepreciableAsset,
  startDate: string,
  maxMonths = 600,
): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  if (a.method === "none") return rows;
  const limit =
    a.method === "straight_line" ? Math.min(a.usefulLifeMonths ?? 0, maxMonths) : maxMonths;
  let posted = 0;
  const first = monthStart(startDate);
  for (let k = 1; k <= limit; k++) {
    const amount = monthlyDepreciation(a, k, posted);
    if (amount === 0 && a.method === "reducing_balance") break;
    posted += amount;
    const accumulated = a.openingAccumulatedMinor + posted;
    rows.push({
      monthIndex: k,
      periodEnd: monthEnd(addMonthsIso(first, k - 1)),
      amountMinor: amount,
      accumulatedMinor: accumulated,
      netBookValueMinor: a.costMinor - accumulated,
    });
  }
  return rows;
}

/** Journal lines (account ids supplied by the caller) for one asset's monthly depreciation. */
export function depreciationLines(
  amountMinor: number,
  expenseAccountId: string,
  accumulatedAccountId: string,
  description: string,
) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new Error("Depreciation amount must be a positive integer in minor units.");
  }
  return [
    { account_id: expenseAccountId, description, debit_minor: amountMinor, credit_minor: 0 },
    { account_id: accumulatedAccountId, description, debit_minor: 0, credit_minor: amountMinor },
  ];
}

export type DisposalOutcome = {
  costMinor: number;
  accumulatedMinor: number;
  netBookValueMinor: number;
  proceedsMinor: number;
  /** Positive = gain on disposal, negative = loss. */
  gainLossMinor: number;
};

export function disposalOutcome(
  costMinor: number,
  accumulatedMinor: number,
  proceedsMinor: number,
): DisposalOutcome {
  for (const v of [costMinor, accumulatedMinor, proceedsMinor]) {
    if (!Number.isSafeInteger(v) || v < 0)
      throw new Error("Amounts must be whole minor units ≥ 0.");
  }
  if (accumulatedMinor > costMinor) throw new Error("Accumulated depreciation exceeds cost.");
  const nbv = costMinor - accumulatedMinor;
  return {
    costMinor,
    accumulatedMinor,
    netBookValueMinor: nbv,
    proceedsMinor,
    gainLossMinor: proceedsMinor - nbv,
  };
}

/**
 * Balanced disposal journal: remove cost and accumulated depreciation, bring in proceeds, and take
 * the difference to the gain/loss account. Mirrors `dispose_fixed_asset` in the database.
 */
export function disposalLines(
  outcome: DisposalOutcome,
  accounts: {
    assetAccountId: string;
    accumulatedAccountId: string;
    proceedsAccountId: string | null;
    gainLossAccountId: string | null;
  },
  description: string,
) {
  const lines: Array<{
    account_id: string;
    description: string;
    debit_minor: number;
    credit_minor: number;
  }> = [];
  const push = (account_id: string, debit: number, credit: number) =>
    lines.push({ account_id, description, debit_minor: debit, credit_minor: credit });
  if (outcome.accumulatedMinor > 0)
    push(accounts.accumulatedAccountId, outcome.accumulatedMinor, 0);
  if (outcome.proceedsMinor > 0) {
    if (!accounts.proceedsAccountId) throw new Error("A proceeds account is required.");
    push(accounts.proceedsAccountId, outcome.proceedsMinor, 0);
  }
  if (outcome.gainLossMinor !== 0) {
    if (!accounts.gainLossAccountId) throw new Error("A gain/loss account is required.");
    if (outcome.gainLossMinor < 0) push(accounts.gainLossAccountId, -outcome.gainLossMinor, 0);
    else push(accounts.gainLossAccountId, 0, outcome.gainLossMinor);
  }
  push(accounts.assetAccountId, 0, outcome.costMinor);
  return lines;
}
