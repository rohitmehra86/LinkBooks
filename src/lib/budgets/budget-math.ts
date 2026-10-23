/**
 * Budget arithmetic (pure). All money is integer minor units; percentages are integer basis points.
 * A budget covers one fiscal year as 12 monthly amounts per income / expense account.
 */

import { addMonthsIso, monthStart } from "@/lib/accounting/fiscal-year";

export type BudgetAccountKind = "income" | "expense";

/** Month starts (YYYY-MM-01) of the twelve months of the fiscal year beginning at `fyStart`. */
export function fiscalMonthStarts(fyStart: string, count = 12): string[] {
  const first = monthStart(fyStart);
  return Array.from({ length: count }, (_, i) => addMonthsIso(first, i));
}

/** Round half away from zero for a non-negative divisor, using integer maths only. */
export function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("Divisor must be positive");
  const neg = numerator < 0n;
  const abs = neg ? -numerator : numerator;
  const q = (abs * 2n + denominator) / (denominator * 2n);
  return neg ? -q : q;
}

/** Apply an uplift in basis points (1000 = +10%, -500 = -5%) to an amount; rounds half away from zero. */
export function applyUpliftBps(minor: number, bps: number): number {
  if (!Number.isInteger(minor)) throw new Error("Amount must be an integer in minor units");
  if (!Number.isInteger(bps)) throw new Error("Uplift must be whole basis points");
  return Number(roundDiv(BigInt(minor) * BigInt(10_000 + bps), 10_000n));
}

/** Copy the value at `fromIndex` into every later month ("fill right"). */
export function fillRight(row: readonly number[], fromIndex: number): number[] {
  if (fromIndex < 0 || fromIndex >= row.length) return [...row];
  const v = row[fromIndex] ?? 0;
  return row.map((x, i) => (i > fromIndex ? v : x));
}

/** Split an annual total across months; the last month takes the rounding remainder. */
export function spreadEvenly(total: number, months = 12): number[] {
  if (!Number.isInteger(total)) throw new Error("Amount must be an integer in minor units");
  if (months < 1) return [];
  const each = Number(roundDiv(BigInt(total), BigInt(months)));
  const out = Array.from({ length: months }, () => each);
  out[months - 1] = total - each * (months - 1);
  return out;
}

export function sumMinorNumbers(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/** Natural actual for an account kind from base-currency debit/credit totals. */
export function naturalActual(kind: BudgetAccountKind, debit: number, credit: number): number {
  return kind === "income" ? credit - debit : debit - credit;
}

export type VarianceStatus = "favourable" | "unfavourable" | "on_budget";

export type Variance = {
  /** Favourable is positive: income actual − budget, expense budget − actual. */
  varianceMinor: number;
  /** Variance as basis points of the budget magnitude; null when the budget is zero. */
  variancePctBps: number | null;
  status: VarianceStatus;
};

export function computeVariance(kind: BudgetAccountKind, budget: number, actual: number): Variance {
  const varianceMinor = kind === "income" ? actual - budget : budget - actual;
  const base = Math.abs(budget);
  const variancePctBps =
    base === 0 ? null : Number(roundDiv(BigInt(varianceMinor) * 10_000n, BigInt(base)));
  const status: VarianceStatus =
    varianceMinor > 0 ? "favourable" : varianceMinor < 0 ? "unfavourable" : "on_budget";
  return { varianceMinor, variancePctBps, status };
}

export type ReportView = "month" | "quarter" | "ytd";

export type BudgetColumn = { key: string; label: string; months: string[] };

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function monthLabel(monthStartIso: string): string {
  const m = Number(monthStartIso.slice(5, 7));
  return `${MONTH_NAMES[m - 1] ?? "?"} ${monthStartIso.slice(2, 4)}`;
}

/**
 * Columns for Budget vs Actual. `months` are the 12 fiscal month starts; `throughMonth` (any date)
 * is the last month compared. Later months are never shown: no actuals exist yet, so a variance
 * would mislead. Every view ends with a "Year to date" total column.
 */
export function buildBudgetColumns(
  view: ReportView,
  months: readonly string[],
  throughMonth: string,
): BudgetColumn[] {
  const limit = monthStart(throughMonth);
  const elapsed = months.filter((m) => m <= limit);
  if (elapsed.length === 0) return [];
  const ytd: BudgetColumn = { key: "ytd", label: "Year to date", months: elapsed };
  if (view === "ytd") {
    const last = elapsed[elapsed.length - 1]!;
    return [{ key: "current", label: monthLabel(last), months: [last] }, ytd];
  }
  if (view === "quarter") {
    const cols: BudgetColumn[] = [];
    for (let q = 0; q * 3 < months.length; q++) {
      const inQuarter = months.slice(q * 3, q * 3 + 3).filter((m) => m <= limit);
      if (inQuarter.length > 0) {
        cols.push({ key: `q${q + 1}`, label: `Q${q + 1}`, months: inQuarter });
      }
    }
    return [...cols, ytd];
  }
  return [...elapsed.map((m) => ({ key: m, label: monthLabel(m), months: [m] })), ytd];
}
