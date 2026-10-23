import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { fetchAllPages, type PageResult } from "@/lib/accounting/fetch-all";
import { addDaysIso, addMonthsIso, monthStart, todayIso } from "@/lib/accounting/fiscal-year";
import { loadAccountMetas, loadCompanyMeta, type Sb } from "@/lib/accounting/ledger-data";
import {
  buildBudgetColumns,
  fiscalMonthStarts,
  naturalActual,
  type BudgetAccountKind,
  type ReportView,
} from "@/lib/budgets/budget-math";
import {
  buildBudgetVsActual,
  type MonthActivity,
  type MonthAmount,
} from "@/lib/budgets/budget-report";
import {
  BUDGET_MIGRATION,
  callRpc,
  companyIdOf,
  isMissingRelation,
  isoDate,
  num,
  wholeMinor,
} from "@/lib/planning/rpc";

type Row = Record<string, unknown>;

export type BudgetSummary = {
  id: string;
  name: string;
  fiscal_year_start: string;
  notes: string | null;
  updated_at: string;
};

export type BudgetAccount = { id: string; code: string; name: string; kind: BudgetAccountKind };

async function budgetAccounts(sb: Sb, companyId: string): Promise<BudgetAccount[]> {
  const metas = await loadAccountMetas(sb, companyId);
  return metas
    .filter(
      (a) =>
        (a.account_type === "income" || a.account_type === "expense") &&
        a.is_active &&
        a.is_postable,
    )
    .map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      kind: a.account_type as BudgetAccountKind,
    }))
    .sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }));
}

async function loadBudgetHead(sb: Sb, companyId: string, budgetId: string): Promise<BudgetSummary> {
  const { data, error } = await sb
    .from("budgets" as never)
    .select("id, name, fiscal_year_start, notes, updated_at" as never)
    .eq("id" as never, budgetId as never)
    .eq("company_id" as never, companyId as never)
    .maybeSingle();
  if (error) throw new Error(isMissingRelation(error) ? BUDGET_MIGRATION : error.message);
  if (!data) throw new Error("Budget not found.");
  return data as unknown as BudgetSummary;
}

async function loadBudgetLines(sb: Sb, budgetId: string): Promise<MonthAmount[]> {
  const rows = await fetchAllPages<{
    account_id: string;
    period_month: string;
    amount_minor: number;
  }>(
    (from, to) =>
      sb
        .from("budget_lines" as never)
        .select("account_id, period_month, amount_minor" as never)
        .eq("budget_id" as never, budgetId as never)
        .order("account_id" as never)
        .order("period_month" as never)
        .range(from, to) as unknown as PromiseLike<
        PageResult<{ account_id: string; period_month: string; amount_minor: number }>
      >,
  );
  return rows.map((r) => ({
    accountId: r.account_id,
    month: r.period_month,
    amountMinor: num(r.amount_minor),
  }));
}

/** Monthly debit/credit per account over a range, from the SQL aggregate (no row cap). */
async function monthlyActivity(
  sb: Sb,
  companyId: string,
  from: string,
  to: string,
): Promise<MonthActivity[]> {
  const rows = await callRpc<
    Array<{ account_id: string; month: string; debit_minor: number; credit_minor: number }>
  >(
    sb,
    "ledger_monthly_activity",
    { _company_id: companyId, _from: from, _to: to, _exclude_year_end_close: true },
    "Actuals are not available yet: the database update 20261025400000 has not been applied.",
  );
  return (rows ?? []).map((r) => ({
    accountId: r.account_id,
    month: r.month,
    debitMinor: num(r.debit_minor),
    creditMinor: num(r.credit_minor),
  }));
}

export const listBudgets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: companyIdOf(input) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await context.supabase
      .from("budgets" as never)
      .select("id, name, fiscal_year_start, notes, updated_at" as never)
      .eq("company_id" as never, data.companyId as never)
      .order("fiscal_year_start" as never, { ascending: false } as never)
      .order("name" as never)
      .limit(500);
    if (error) {
      if (isMissingRelation(error)) return { available: false, budgets: [] as BudgetSummary[] };
      throw new Error(error.message);
    }
    return { available: true, budgets: (rows ?? []) as unknown as BudgetSummary[] };
  });

/** A budget with its lines and the accounts it can use, for the editor grid. */
export const getBudget = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; budgetId: string }) => ({
    companyId: companyIdOf(input),
    budgetId: assertUuid(input?.budgetId, "budget"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const sb = context.supabase as unknown as Sb;
    const [meta, head, lines, accounts] = await Promise.all([
      loadCompanyMeta(sb, data.companyId),
      loadBudgetHead(sb, data.companyId, data.budgetId),
      loadBudgetLines(sb, data.budgetId),
      budgetAccounts(sb, data.companyId),
    ]);
    return {
      budget: head,
      currency: meta.baseCurrency,
      months: fiscalMonthStarts(head.fiscal_year_start),
      accounts,
      lines,
    };
  });

export const saveBudget = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      budgetId?: string | null;
      name: string;
      fiscalYearStart: string;
      notes?: string | null;
    }) => ({
      companyId: companyIdOf(input),
      budgetId: input.budgetId ? assertUuid(input.budgetId, "budget") : null,
      name: (input.name ?? "").trim(),
      fiscalYearStart: isoDate(input.fiscalYearStart, "Fiscal year start"),
      notes: (input.notes ?? "").trim() || null,
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "accounts.manage");
    if (!data.name) throw new Error("Enter a budget name.");
    const id = await callRpc<string>(
      context.supabase,
      "save_budget",
      {
        _company_id: data.companyId,
        _budget_id: data.budgetId,
        _name: data.name,
        _fiscal_year_start: data.fiscalYearStart,
        _notes: data.notes,
      },
      BUDGET_MIGRATION,
    );
    return { id };
  });

export const saveBudgetLines = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      budgetId: string;
      mode: "replace" | "merge";
      /** One entry per account: the 12 monthly amounts in fiscal order (minor units). */
      rows: Array<{ accountId: string; months: number[] }>;
    }) => {
      if (!Array.isArray(input?.rows)) throw new Error("No budget rows to save.");
      return {
        companyId: companyIdOf(input),
        budgetId: assertUuid(input.budgetId, "budget"),
        mode: input.mode === "merge" ? ("merge" as const) : ("replace" as const),
        rows: input.rows.map((r) => {
          if (!Array.isArray(r?.months) || r.months.length !== 12) {
            throw new Error("Each budget row needs twelve monthly amounts.");
          }
          return {
            accountId: assertUuid(r.accountId, "account"),
            months: r.months.map((m) => wholeMinor(m, "Budget amount")),
          };
        }),
      };
    },
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "accounts.manage");
    const sb = context.supabase as unknown as Sb;
    const head = await loadBudgetHead(sb, data.companyId, data.budgetId);
    const months = fiscalMonthStarts(head.fiscal_year_start);
    const lines: Array<{ account_id: string; period_month: string; amount_minor: number }> = [];
    for (const r of data.rows) {
      r.months.forEach((amount, i) => {
        if (data.mode === "replace" && amount === 0) return;
        lines.push({ account_id: r.accountId, period_month: months[i]!, amount_minor: amount });
      });
    }
    const stored = await callRpc<number>(
      context.supabase,
      "save_budget_lines",
      { _budget_id: data.budgetId, _lines: lines, _mode: data.mode },
      BUDGET_MIGRATION,
    );
    return { stored: num(stored) };
  });

export const deleteBudget = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; budgetId: string }) => ({
    companyId: companyIdOf(input),
    budgetId: assertUuid(input?.budgetId, "budget"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "accounts.manage");
    await callRpc<null>(
      context.supabase,
      "delete_budget",
      { _budget_id: data.budgetId },
      BUDGET_MIGRATION,
    );
    return { ok: true as const };
  });

/**
 * Actual results for the twelve months starting at `fiscalYearStart`, one row per income/expense
 * account (natural sign). The editor uses it for "copy from last year's actuals".
 */
export const getYearActuals = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; fiscalYearStart: string }) => ({
    companyId: companyIdOf(input),
    fiscalYearStart: isoDate(input.fiscalYearStart, "Fiscal year start"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const sb = context.supabase as unknown as Sb;
    const start = monthStart(data.fiscalYearStart);
    const months = fiscalMonthStarts(start);
    const end = addDaysIso(addMonthsIso(start, 12), -1);
    const [accounts, activity] = await Promise.all([
      budgetAccounts(sb, data.companyId),
      monthlyActivity(sb, data.companyId, start, end),
    ]);
    const kindOf = new Map(accounts.map((a) => [a.id, a.kind]));
    const out = new Map<string, number[]>();
    for (const a of activity) {
      const kind = kindOf.get(a.accountId);
      if (!kind) continue;
      const idx = months.indexOf(a.month);
      if (idx < 0) continue;
      const row = out.get(a.accountId) ?? Array.from({ length: 12 }, () => 0);
      row[idx] = (row[idx] ?? 0) + naturalActual(kind, a.debitMinor, a.creditMinor);
      out.set(a.accountId, row);
    }
    return {
      rows: [...out.entries()]
        .map(([accountId, m]) => ({ accountId, months: m }))
        .filter((r) => r.months.some((v) => v !== 0)),
    };
  });

const VIEWS: ReportView[] = ["month", "quarter", "ytd"];

export const getBudgetVsActual = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; budgetId: string; view?: string; to?: string }) => ({
    companyId: companyIdOf(input),
    budgetId: assertUuid(input?.budgetId, "budget"),
    view: (VIEWS.includes(input?.view as ReportView) ? input.view : "month") as ReportView,
    to: input?.to ? isoDate(input.to, "To") : todayIso(),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const sb = context.supabase as unknown as Sb;
    const [meta, head, lines, accounts] = await Promise.all([
      loadCompanyMeta(sb, data.companyId),
      loadBudgetHead(sb, data.companyId, data.budgetId),
      loadBudgetLines(sb, data.budgetId),
      budgetAccounts(sb, data.companyId),
    ]);
    const months = fiscalMonthStarts(head.fiscal_year_start);
    const yearEnd = addDaysIso(addMonthsIso(monthStart(head.fiscal_year_start), 12), -1);
    // Clamp the selected date into the budget's year so the report always has a sensible range.
    const through = data.to > yearEnd ? yearEnd : data.to;
    const columns = buildBudgetColumns(data.view, months, through);
    const emptyReport = buildBudgetVsActual({ accounts, budget: [], actuals: [], columns: [] });
    if (columns.length === 0) {
      return {
        currency: meta.baseCurrency,
        budget: head,
        through,
        view: data.view,
        report: emptyReport,
        notStarted: true,
        unbudgetedActualsMinor: 0,
      };
    }
    const activity = await monthlyActivity(sb, data.companyId, months[0]!, through);
    const report = buildBudgetVsActual({ accounts, budget: lines, actuals: activity, columns });
    // Actuals on accounts that are archived or no longer postable are not hidden: surface the total.
    const known = new Set(accounts.map((a) => a.id));
    const metas = await loadAccountMetas(sb, data.companyId);
    const plIds = new Map(
      metas
        .filter((a) => a.account_type === "income" || a.account_type === "expense")
        .map((a) => [a.id, a.account_type as BudgetAccountKind]),
    );
    let unbudgeted = 0;
    for (const a of activity) {
      const kind = plIds.get(a.accountId);
      if (kind && !known.has(a.accountId))
        unbudgeted += naturalActual(kind, a.debitMinor, a.creditMinor);
    }
    return {
      currency: meta.baseCurrency,
      budget: head,
      through,
      view: data.view,
      report,
      notStarted: false,
      unbudgetedActualsMinor: unbudgeted,
    };
  });
