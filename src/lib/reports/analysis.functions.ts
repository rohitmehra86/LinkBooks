import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember } from "@/lib/assert-company-access";
import { addDaysIso } from "@/lib/accounting/fiscal-year";
import { fetchLedgerBalances, loadCompanyMeta, type Sb } from "@/lib/accounting/ledger-data";
import {
  bankAccountIds,
  bsFor,
  controlBalance,
  loadCtx,
  plFor,
} from "@/lib/reports/report.functions";
import { buildExecutiveSummary, type SummaryPeriod } from "@/lib/reports/executive-summary";
import { buildIndirectCashFlow } from "@/lib/reports/indirect-cash-flow";
import { priorPeriodRange } from "@/lib/reports/statements";
import { callRpc, companyIdOf, isoDate, num, REPORT_MIGRATION } from "@/lib/planning/rpc";

type Range = { companyId: string; from: string; to: string };

function rangeInput(input: Range): Range {
  const from = isoDate(input?.from, "From");
  const to = isoDate(input?.to, "To");
  if (to < from) throw new Error("'To' date cannot be before 'From' date.");
  return { companyId: companyIdOf(input), from, to };
}

function asOfInput(input: { companyId: string; asOf: string }) {
  return { companyId: companyIdOf(input), asOf: isoDate(input?.asOf, "As at") };
}

/** Converts bigint-like and numeric string columns of an RPC row to numbers. */
function numeric<T extends Record<string, unknown>>(row: T, keys: ReadonlyArray<keyof T>): T {
  const out = { ...row };
  for (const k of keys) out[k] = num(row[k]) as T[keyof T];
  return out;
}

async function rpcReport<Row extends Record<string, unknown>>(
  supabase: unknown,
  fn: string,
  args: Record<string, unknown>,
  numericKeys: ReadonlyArray<keyof Row>,
): Promise<Row[]> {
  const rows = await callRpc<Row[] | null>(supabase, fn, args, REPORT_MIGRATION);
  return (rows ?? []).map((r) => numeric(r, numericKeys));
}

function daysInclusive(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

/* ------------------------------------------------------------------ */
/* Cash summary                                                        */
/* ------------------------------------------------------------------ */

export type CashSummaryRow = {
  bank_account_id: string;
  bank_account_name: string;
  gl_account_id: string;
  gl_account_code: string;
  opening_minor: number;
  received_minor: number;
  spent_minor: number;
  transfers_in_minor: number;
  transfers_out_minor: number;
  closing_minor: number;
};

const CASH_KEYS = [
  "opening_minor",
  "received_minor",
  "spent_minor",
  "transfers_in_minor",
  "transfers_out_minor",
  "closing_minor",
] as const;

export const getCashSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(rangeInput)
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const sb = context.supabase as unknown as Sb;
    const [meta, rows] = await Promise.all([
      loadCompanyMeta(sb, data.companyId),
      rpcReport<CashSummaryRow>(
        sb,
        "report_cash_summary",
        { _company_id: data.companyId, _from: data.from, _to: data.to },
        CASH_KEYS,
      ),
    ]);
    return { currency: meta.baseCurrency, from: data.from, to: data.to, rows };
  });

/* ------------------------------------------------------------------ */
/* General ledger summary                                              */
/* ------------------------------------------------------------------ */

export type GlSummaryRow = {
  account_id: string;
  account_code: string;
  account_name: string;
  account_type: string;
  opening_minor: number;
  debit_minor: number;
  credit_minor: number;
  closing_minor: number;
  line_count: number;
};

export const getGlSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(rangeInput)
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const sb = context.supabase as unknown as Sb;
    const [meta, rows] = await Promise.all([
      loadCompanyMeta(sb, data.companyId),
      rpcReport<GlSummaryRow>(
        sb,
        "report_gl_summary",
        { _company_id: data.companyId, _from: data.from, _to: data.to },
        ["opening_minor", "debit_minor", "credit_minor", "closing_minor", "line_count"],
      ),
    ]);
    return { currency: meta.baseCurrency, from: data.from, to: data.to, rows };
  });

/* ------------------------------------------------------------------ */
/* Sales / purchases analysis                                          */
/* ------------------------------------------------------------------ */

export type SalesByContactRow = {
  contact_id: string;
  contact_name: string;
  invoice_count: number;
  credit_note_count: number;
  net_minor: number;
  tax_minor: number;
  gross_minor: number;
};

export const getSalesByContact = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(rangeInput)
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const sb = context.supabase as unknown as Sb;
    const [meta, rows] = await Promise.all([
      loadCompanyMeta(sb, data.companyId),
      rpcReport<SalesByContactRow>(
        sb,
        "report_sales_by_contact",
        { _company_id: data.companyId, _from: data.from, _to: data.to },
        ["invoice_count", "credit_note_count", "net_minor", "tax_minor", "gross_minor"],
      ),
    ]);
    return { currency: meta.baseCurrency, from: data.from, to: data.to, rows };
  });

export type SalesByItemRow = {
  product_id: string | null;
  item_code: string | null;
  item_name: string | null;
  quantity: number;
  line_count: number;
  net_minor: number;
  tax_minor: number;
};

export const getSalesByItem = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(rangeInput)
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const sb = context.supabase as unknown as Sb;
    const [meta, rows] = await Promise.all([
      loadCompanyMeta(sb, data.companyId),
      rpcReport<SalesByItemRow>(
        sb,
        "report_sales_by_item",
        { _company_id: data.companyId, _from: data.from, _to: data.to },
        ["quantity", "line_count", "net_minor", "tax_minor"],
      ),
    ]);
    return { currency: meta.baseCurrency, from: data.from, to: data.to, rows };
  });

export type PurchasesBySupplierRow = {
  contact_id: string;
  contact_name: string;
  bill_count: number;
  credit_note_count: number;
  net_minor: number;
  tax_minor: number;
  gross_minor: number;
};

export const getPurchasesBySupplier = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(rangeInput)
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const sb = context.supabase as unknown as Sb;
    const [meta, rows] = await Promise.all([
      loadCompanyMeta(sb, data.companyId),
      rpcReport<PurchasesBySupplierRow>(
        sb,
        "report_purchases_by_supplier",
        { _company_id: data.companyId, _from: data.from, _to: data.to },
        ["bill_count", "credit_note_count", "net_minor", "tax_minor", "gross_minor"],
      ),
    ]);
    return { currency: meta.baseCurrency, from: data.from, to: data.to, rows };
  });

/* ------------------------------------------------------------------ */
/* Bank reconciliation summary                                         */
/* ------------------------------------------------------------------ */

export type BankReconSummaryRow = {
  bank_account_id: string;
  bank_account_name: string;
  currency_code: string;
  gl_account_id: string;
  book_balance_minor: number;
  last_reconciled_date: string | null;
  last_statement_balance_minor: number | null;
  uncleared_line_count: number;
  uncleared_net_minor: number;
  uncoded_statement_count: number;
  uncoded_statement_minor: number;
  difference_minor: number | null;
};

export const getBankReconSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(asOfInput)
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const sb = context.supabase as unknown as Sb;
    const rows = await callRpc<BankReconSummaryRow[] | null>(
      sb,
      "report_bank_reconciliation_summary",
      { _company_id: data.companyId, _as_of: data.asOf },
      REPORT_MIGRATION,
    );
    const meta = await loadCompanyMeta(sb, data.companyId);
    return {
      currency: meta.baseCurrency,
      asOf: data.asOf,
      rows: (rows ?? []).map((r) => ({
        ...r,
        book_balance_minor: num(r.book_balance_minor),
        last_statement_balance_minor:
          r.last_statement_balance_minor === null ? null : num(r.last_statement_balance_minor),
        uncleared_line_count: num(r.uncleared_line_count),
        uncleared_net_minor: num(r.uncleared_net_minor),
        uncoded_statement_count: num(r.uncoded_statement_count),
        uncoded_statement_minor: num(r.uncoded_statement_minor),
        difference_minor: r.difference_minor === null ? null : num(r.difference_minor),
      })),
    };
  });

/* ------------------------------------------------------------------ */
/* Executive summary                                                   */
/* ------------------------------------------------------------------ */

async function periodFigures(
  ctx: Awaited<ReturnType<typeof loadCtx>>,
  from: string,
  to: string,
): Promise<SummaryPeriod> {
  const sb = ctx.supabase;
  const [pl, bs, ar, ap, cash] = await Promise.all([
    plFor(ctx, from, to),
    bsFor(ctx, to),
    controlBalance(ctx, "ar", to),
    controlBalance(ctx, "ap", to),
    rpcReport<CashSummaryRow>(
      sb,
      "report_cash_summary",
      { _company_id: ctx.meta.id, _from: from, _to: to },
      CASH_KEYS,
    ),
  ]);
  return {
    revenueMinor: Number(pl.revenue + pl.contraRevenue),
    costOfSalesMinor: Number(pl.costOfSales),
    grossProfitMinor: Number(pl.grossProfit),
    operatingExpenseMinor: Number(pl.operatingExpense),
    netProfitMinor: Number(pl.net),
    cashReceivedMinor: cash.reduce((s, r) => s + r.received_minor, 0),
    cashSpentMinor: cash.reduce((s, r) => s + r.spent_minor, 0),
    closingCashMinor: cash.reduce((s, r) => s + r.closing_minor, 0),
    receivablesMinor: Number(ar.net),
    payablesMinor: Number(-ap.net),
    assetsMinor: Number(bs.assets),
    liabilitiesMinor: Number(bs.liabilities),
    days: daysInclusive(from, to),
  };
}

export const getExecutiveSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(rangeInput)
  .handler(async ({ data, context }) => {
    const ctx = await loadCtx(context.supabase as unknown as Sb, data.companyId);
    const prior = priorPeriodRange(data.from, data.to);
    const [current, previous] = await Promise.all([
      periodFigures(ctx, data.from, data.to),
      periodFigures(ctx, prior.from, prior.to),
    ]);
    return {
      currency: ctx.meta.baseCurrency,
      from: data.from,
      to: data.to,
      priorFrom: prior.from,
      priorTo: prior.to,
      rows: buildExecutiveSummary(current, previous),
    };
  });

/* ------------------------------------------------------------------ */
/* Cash flow, indirect method                                          */
/* ------------------------------------------------------------------ */

export const getCashFlowIndirect = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(rangeInput)
  .handler(async ({ data, context }) => {
    const ctx = await loadCtx(context.supabase as unknown as Sb, data.companyId);
    const base = ctx.meta.baseCurrency;
    const bankIds = await bankAccountIds(ctx);
    const bankSet = new Set(bankIds);
    const openingDate = addDaysIso(data.from, -1);
    const [period, opening, closing, depRows] = await Promise.all([
      fetchLedgerBalances(ctx.supabase, ctx.meta.id, base, {
        from: data.from,
        to: data.to,
        excludeYearEndClose: true,
      }),
      fetchLedgerBalances(ctx.supabase, ctx.meta.id, base, { to: openingDate }),
      fetchLedgerBalances(ctx.supabase, ctx.meta.id, base, { to: data.to }),
      depreciationExpenseAccounts(ctx.supabase, data.companyId),
    ]);
    const sumBank = (rows: typeof opening) =>
      rows
        .filter((b) => bankSet.has(b.account_id))
        .reduce((n, b) => n + b.debit_minor - b.credit_minor, 0n);
    const result = buildIndirectCashFlow({
      accounts: ctx.accounts,
      movements: period.map((b) => ({
        accountId: b.account_id,
        debitMinor: Number(b.debit_minor),
        creditMinor: Number(b.credit_minor),
      })),
      bankAccountIds: bankIds,
      depreciationAccountIds: depRows,
      openingCashMinor: Number(sumBank(opening)),
      closingCashLedgerMinor: Number(sumBank(closing)),
    });
    return {
      currency: base,
      from: data.from,
      to: data.to,
      bankAccountCount: bankIds.length,
      ...result,
      basis:
        "Indirect method from the posted ledger (year-end closing journals excluded). A gain or loss on disposal stays in net profit and the asset's net book value shows under investing.",
    };
  });

/** Expense accounts the fixed-asset register depreciates into; empty before that module exists. */
async function depreciationExpenseAccounts(sb: Sb, companyId: string): Promise<string[]> {
  const { data, error } = await sb
    .from("fixed_assets" as never)
    .select("expense_account_id" as never)
    .eq("company_id" as never, companyId as never)
    .limit(1000);
  if (error) return [];
  return [
    ...new Set(
      ((data ?? []) as Array<{ expense_account_id: string }>).map((r) => r.expense_account_id),
    ),
  ];
}
