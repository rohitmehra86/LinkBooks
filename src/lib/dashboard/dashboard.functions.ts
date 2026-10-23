import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { fetchAllPages, type PageResult } from "@/lib/accounting/fetch-all";
import { findControlAccountIds } from "@/lib/accounting/control-accounts";
import {
  fiscalYearContaining,
  previousFiscalYear,
  addMonthsIso,
  monthStart,
  todayIso,
} from "@/lib/accounting/fiscal-year";
import {
  accountMap,
  balancesToLines,
  fetchAccountBalanceAsOf,
  fetchLedgerBalances,
  loadAccountMetas,
  loadCompanyMeta,
  loadPostedLines,
  type Sb,
} from "@/lib/accounting/ledger-data";
import { buildProfitAndLoss } from "@/lib/accounting/reporting";
import { billOutstanding } from "@/lib/purchases/line-math";
import { invoiceOutstanding } from "@/lib/sales/line-helpers";
import {
  ageOutstandingByCurrency,
  monthlyCashSeries,
  type CurrencyAgeing,
  type OutstandingDoc,
} from "@/lib/dashboard/snapshot-math";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function ageingJson(rows: CurrencyAgeing[]) {
  return rows.map((r) => ({
    currency: r.currency,
    count: r.count,
    current: Number(r.current),
    b_1_30: Number(r.b_1_30),
    b_31_60: Number(r.b_31_60),
    b_61_90: Number(r.b_61_90),
    b_90_plus: Number(r.b_90_plus),
    total: Number(r.total),
    overdue: Number(r.overdue),
  }));
}

async function countRows(
  supabase: Sb,
  table: string,
  companyId: string,
  filters: Array<[string, string | string[]]>,
): Promise<number> {
  let q = supabase
    .from(table as never)
    .select("id" as never, { count: "exact", head: true } as never)
    .eq("company_id" as never, companyId as never);
  for (const [col, val] of filters) {
    q = Array.isArray(val) ? q.in(col as never, val as never) : q.eq(col as never, val as never);
  }
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

type OpenDoc = {
  id: string;
  due_date: string;
  currency_code: string;
  total_minor: number;
  amount_paid_minor: number;
  amount_credited_minor: number;
  posted_journal_id: string | null;
};

async function openDocs(
  supabase: Sb,
  table: "sales_invoices" | "purchase_bills",
  companyId: string,
): Promise<OpenDoc[]> {
  return fetchAllPages<OpenDoc>(
    (from, to) =>
      supabase
        .from(table as never)
        .select(
          "id, due_date, currency_code, total_minor, amount_paid_minor, amount_credited_minor, posted_journal_id" as never,
        )
        .eq("company_id" as never, companyId as never)
        .in("status" as never, ["authorised", "partly_paid"] as never)
        .order("id" as never)
        .range(from, to) as unknown as PromiseLike<PageResult<OpenDoc>>,
  );
}

/**
 * Everything the dashboard shows, from real data only (U-01..U-05).
 * Money is returned as integer minor-unit numbers; foreign-currency document ageing is kept
 * per currency and never converted or added together.
 */
export const getDashboardSnapshot = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; asOf?: string }) => {
    if (input.asOf !== undefined && !ISO.test(input.asOf))
      throw new Error("asOf must be YYYY-MM-DD");
    return { companyId: assertUuid(input.companyId), asOf: input.asOf ?? todayIso() };
  })
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    await assertCompanyMember(sb, data.companyId);
    const asOf = data.asOf;
    const [meta, accounts] = await Promise.all([
      loadCompanyMeta(sb, data.companyId),
      loadAccountMetas(sb, data.companyId),
    ]);
    const base = meta.baseCurrency;
    const byId = accountMap(accounts);
    const fy = fiscalYearContaining(asOf, meta.fyEndMonth, meta.fyEndDay);
    const prevFy = previousFiscalYear(asOf, meta.fyEndMonth, meta.fyEndDay);

    // Bank accounts: ledger balance and unreconciled count
    const { data: bankRows, error: bankErr } = await sb
      .from("bank_accounts" as never)
      .select("id, name, currency_code, gl_account_id" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("is_active" as never, true as never)
      .order("name" as never);
    if (bankErr) throw new Error(bankErr.message);
    const banks = (bankRows ?? []) as unknown as Array<{
      id: string;
      name: string;
      currency_code: string;
      gl_account_id: string;
    }>;
    const bankSummaries = await Promise.all(
      banks.map(async (b) => {
        const [balance, unreconciled] = await Promise.all([
          fetchAccountBalanceAsOf(sb, data.companyId, base, b.gl_account_id, asOf),
          countRows(sb, "bank_transactions", data.companyId, [
            ["bank_account_id", b.id],
            ["status", ["uncategorised", "matched"]],
          ]),
        ]);
        return {
          id: b.id,
          name: b.name,
          currency: b.currency_code,
          ledgerBalanceMinor: Number(balance),
          unreconciledCount: unreconciled,
        };
      }),
    );
    const bankGlIds = [
      ...new Set([
        ...banks.map((b) => b.gl_account_id),
        ...findControlAccountIds(accounts, "bank"),
      ]),
    ];

    // Ageing from open documents posted to the ledger (same population as the aged reports)
    const [invoices, bills] = await Promise.all([
      openDocs(sb, "sales_invoices", data.companyId),
      openDocs(sb, "purchase_bills", data.companyId),
    ]);
    const toOutstanding = (d: OpenDoc, kind: "ar" | "ap"): OutstandingDoc => ({
      due_date: d.due_date,
      currency_code: d.currency_code,
      outstanding_minor: BigInt(
        (kind === "ar" ? invoiceOutstanding : billOutstanding)({
          total_minor: d.total_minor,
          amount_paid_minor: d.amount_paid_minor,
          amount_credited_minor: d.amount_credited_minor,
        }),
      ),
    });
    const receivables = ageOutstandingByCurrency(
      invoices.filter((d) => d.posted_journal_id).map((d) => toOutstanding(d, "ar")),
      asOf,
    );
    const payables = ageOutstandingByCurrency(
      bills.filter((d) => d.posted_journal_id).map((d) => toOutstanding(d, "ap")),
      asOf,
    );

    // 12-month cash in / out from bank ledger lines
    const cashFrom = addMonthsIso(monthStart(asOf), -11);
    const bankLines = bankGlIds.length
      ? await loadPostedLines(sb, data.companyId, base, {
          from: cashFrom,
          to: asOf,
          accountIds: bankGlIds,
        })
      : [];
    const cash = monthlyCashSeries(bankLines, asOf, 12).map((m) => ({
      month: m.month,
      in_minor: Number(m.in_minor),
      out_minor: Number(m.out_minor),
    }));

    // Net profit this financial year vs last (year-end closing journals excluded)
    const profitFor = async (from: string, to: string) => {
      const bal = await fetchLedgerBalances(sb, data.companyId, base, {
        from,
        to,
        excludeYearEndClose: true,
      });
      const lines = balancesToLines(bal, byId, to, base).filter(
        (l) => l.account_type === "income" || l.account_type === "expense",
      );
      const pl = buildProfitAndLoss(lines, { from, to });
      return { net: pl.net, revenue: pl.revenue, balances: bal };
    };
    const [thisFy, lastFy] = await Promise.all([
      profitFor(fy.start, asOf),
      profitFor(prevFy.start, prevFy.end),
    ]);

    // Items waiting for approval
    const [{ data: claimRows }, { data: awaitingBills }] = await Promise.all([
      sb
        .from("employee_expense_claims" as never)
        .select("amount_minor, currency_code" as never)
        .eq("company_id" as never, data.companyId as never)
        .eq("status" as never, "submitted" as never),
      sb
        .from("purchase_bills" as never)
        .select("total_minor, currency_code" as never)
        .eq("company_id" as never, data.companyId as never)
        .eq("status" as never, "awaiting_approval" as never),
    ]);
    const sumByCurrency = (rows: Array<{ currency_code: string; v: number }>) => {
      const m = new Map<string, { currency: string; count: number; total: number }>();
      for (const r of rows) {
        const x = m.get(r.currency_code) ?? { currency: r.currency_code, count: 0, total: 0 };
        x.count += 1;
        x.total += Number(r.v);
        m.set(r.currency_code, x);
      }
      return [...m.values()];
    };
    const claims = sumByCurrency(
      ((claimRows ?? []) as unknown as Array<{ amount_minor: number; currency_code: string }>).map(
        (r) => ({
          currency_code: r.currency_code,
          v: r.amount_minor,
        }),
      ),
    );
    const billsAwaiting = sumByCurrency(
      (
        (awaitingBills ?? []) as unknown as Array<{ total_minor: number; currency_code: string }>
      ).map((r) => ({
        currency_code: r.currency_code,
        v: r.total_minor,
      })),
    );

    // Watchlist accounts: balance sheet accounts as at today, P&L accounts for the financial year
    const watch = accounts.filter((a) => a.show_on_dashboard_watchlist && a.is_active);
    const fyBalance = new Map(
      thisFy.balances.map((b) => [b.account_id, b.debit_minor - b.credit_minor]),
    );
    const watchlist = await Promise.all(
      watch.map(async (a) => {
        const isPl = a.account_type === "income" || a.account_type === "expense";
        const net = isPl
          ? (fyBalance.get(a.id) ?? 0n)
          : await fetchAccountBalanceAsOf(sb, data.companyId, base, a.id, asOf);
        const normalDebit = a.account_type === "asset" || a.account_type === "expense";
        return {
          id: a.id,
          code: a.code,
          name: a.name,
          basis: isPl ? ("financial_year" as const) : ("as_at" as const),
          balanceMinor: Number(normalDebit ? net : -net),
        };
      }),
    );

    // Real task counts
    const [uncategorised, draftInvoices, draftBills] = await Promise.all([
      countRows(sb, "bank_transactions", data.companyId, [["status", "uncategorised"]]),
      countRows(sb, "sales_invoices", data.companyId, [["status", "draft"]]),
      countRows(sb, "purchase_bills", data.companyId, [["status", "draft"]]),
    ]);
    const { data: periodRows } = await sb
      .from("accounting_periods" as never)
      .select("name, start_date, end_date, status" as never)
      .eq("company_id" as never, data.companyId as never)
      .lte("start_date" as never, asOf as never)
      .gte("end_date" as never, asOf as never)
      .maybeSingle();
    const period = periodRows as {
      name: string;
      start_date: string;
      end_date: string;
      status: string;
    } | null;
    const { data: lockedRows } = await sb
      .from("accounting_periods" as never)
      .select("end_date" as never)
      .eq("company_id" as never, data.companyId as never)
      .in("status" as never, ["locked", "closed"] as never)
      .order("end_date" as never, { ascending: false } as never)
      .limit(1);
    const lockedThrough =
      ((lockedRows ?? []) as unknown as Array<{ end_date: string }>)[0]?.end_date ?? null;

    return {
      asOf,
      currency: base,
      financialYear: {
        start: fy.start,
        end: fy.end,
        previousStart: prevFy.start,
        previousEnd: prevFy.end,
      },
      banks: bankSummaries,
      receivables: ageingJson(receivables),
      payables: ageingJson(payables),
      cash,
      profit: {
        thisYearMinor: Number(thisFy.net),
        lastYearMinor: Number(lastFy.net),
        thisYearRevenueMinor: Number(thisFy.revenue),
        lastYearRevenueMinor: Number(lastFy.revenue),
      },
      approvals: { expenseClaims: claims, bills: billsAwaiting },
      watchlist,
      tasks: {
        uncategorisedBankLines: uncategorised,
        draftInvoices,
        draftBills,
        currentPeriod: period
          ? {
              name: period.name,
              status: period.status,
              start: period.start_date,
              end: period.end_date,
            }
          : null,
        lockedThrough,
      },
      hasLedgerActivity:
        bankLines.length > 0 ||
        thisFy.balances.length > 0 ||
        lastFy.net !== 0n ||
        receivables.length + payables.length > 0,
    };
  });
