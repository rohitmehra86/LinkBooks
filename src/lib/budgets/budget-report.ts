/**
 * Budget vs Actual report builder (pure). Inputs are integer minor units in the company base
 * currency; nothing is invented: an account appears only if it has a budget or an actual.
 */

import {
  computeVariance,
  naturalActual,
  type BudgetAccountKind,
  type BudgetColumn,
  type Variance,
} from "@/lib/budgets/budget-math";

export type BudgetReportAccount = {
  id: string;
  code: string;
  name: string;
  kind: BudgetAccountKind;
};

export type MonthAmount = { accountId: string; month: string; amountMinor: number };
export type MonthActivity = {
  accountId: string;
  month: string;
  debitMinor: number;
  creditMinor: number;
};

export type VarianceCell = { budgetMinor: number; actualMinor: number } & Variance;

export type VarianceRow = {
  accountId: string;
  code: string;
  name: string;
  cells: VarianceCell[];
};

export type VarianceSection = {
  kind: BudgetAccountKind;
  rows: VarianceRow[];
  totals: VarianceCell[];
};

export type BudgetVsActual = {
  columns: Array<{ key: string; label: string }>;
  income: VarianceSection;
  expense: VarianceSection;
  /** Income − expenses. Variance is actual − budget (favourable positive). */
  net: VarianceCell[];
};

function cell(kind: BudgetAccountKind, budget: number, actual: number): VarianceCell {
  return { budgetMinor: budget, actualMinor: actual, ...computeVariance(kind, budget, actual) };
}

export function buildBudgetVsActual(input: {
  accounts: readonly BudgetReportAccount[];
  budget: readonly MonthAmount[];
  actuals: readonly MonthActivity[];
  columns: readonly BudgetColumn[];
}): BudgetVsActual {
  const budgetBy = new Map<string, number>();
  for (const b of input.budget) {
    const k = `${b.accountId}|${b.month}`;
    budgetBy.set(k, (budgetBy.get(k) ?? 0) + b.amountMinor);
  }
  const activityBy = new Map<string, { d: number; c: number }>();
  for (const a of input.actuals) {
    const k = `${a.accountId}|${a.month}`;
    const prev = activityBy.get(k) ?? { d: 0, c: 0 };
    activityBy.set(k, { d: prev.d + a.debitMinor, c: prev.c + a.creditMinor });
  }

  const sections: Record<BudgetAccountKind, VarianceSection> = {
    income: { kind: "income", rows: [], totals: [] },
    expense: { kind: "expense", rows: [], totals: [] },
  };
  const budgetTotals: Record<BudgetAccountKind, number[]> = {
    income: input.columns.map(() => 0),
    expense: input.columns.map(() => 0),
  };
  const actualTotals: Record<BudgetAccountKind, number[]> = {
    income: input.columns.map(() => 0),
    expense: input.columns.map(() => 0),
  };

  const ordered = [...input.accounts].sort((a, b) =>
    a.code.localeCompare(b.code, undefined, { numeric: true }),
  );
  for (const acct of ordered) {
    let touched = false;
    const cells = input.columns.map((col, ci) => {
      let budget = 0;
      let actual = 0;
      for (const m of col.months) {
        const k = `${acct.id}|${m}`;
        budget += budgetBy.get(k) ?? 0;
        const act = activityBy.get(k);
        if (act) actual += naturalActual(acct.kind, act.d, act.c);
      }
      if (budget !== 0 || actual !== 0) touched = true;
      budgetTotals[acct.kind][ci] = (budgetTotals[acct.kind][ci] ?? 0) + budget;
      actualTotals[acct.kind][ci] = (actualTotals[acct.kind][ci] ?? 0) + actual;
      return cell(acct.kind, budget, actual);
    });
    if (touched) {
      sections[acct.kind].rows.push({
        accountId: acct.id,
        code: acct.code,
        name: acct.name,
        cells,
      });
    }
  }
  for (const kind of ["income", "expense"] as const) {
    sections[kind].totals = input.columns.map((_, ci) =>
      cell(kind, budgetTotals[kind][ci] ?? 0, actualTotals[kind][ci] ?? 0),
    );
  }
  const net = input.columns.map((_, ci) => {
    const budget = (budgetTotals.income[ci] ?? 0) - (budgetTotals.expense[ci] ?? 0);
    const actual = (actualTotals.income[ci] ?? 0) - (actualTotals.expense[ci] ?? 0);
    // Profit behaves like income: more than budget is favourable.
    return cell("income", budget, actual);
  });
  return {
    columns: input.columns.map((c) => ({ key: c.key, label: c.label })),
    income: sections.income,
    expense: sections.expense,
    net,
  };
}
