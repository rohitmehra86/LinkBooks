import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { ensureFiscalPeriodForDate } from "@/lib/accounting/posting-engine";
import { findControlAccountIds } from "@/lib/accounting/control-accounts";
import {
  fetchAccountBalanceAsOf,
  loadAccountMetas,
  loadCompanyMeta,
  type Sb,
} from "@/lib/accounting/ledger-data";
import { fiscalYearContaining } from "@/lib/accounting/fiscal-year";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(v: unknown, label: string): string {
  if (typeof v !== "string" || !ISO.test(v)) throw new Error(`${label} must be YYYY-MM-DD`);
  return v;
}

async function countRows(
  supabase: Sb,
  table: string,
  filters: (q: unknown) => unknown,
): Promise<number> {
  const base = (
    supabase as unknown as { from: (t: string) => { select: (c: string, o: object) => unknown } }
  )
    .from(table)
    .select("id", { count: "exact", head: true });
  const res = await (filters(base) as PromiseLike<{
    count: number | null;
    error: { message: string } | null;
  }>);
  if (res.error) throw new Error(res.error.message);
  return res.count ?? 0;
}

type Filterable = {
  eq: (c: string, v: unknown) => Filterable;
  in: (c: string, v: unknown[]) => Filterable;
  lte: (c: string, v: unknown) => Filterable;
  gte: (c: string, v: unknown) => Filterable;
};

/** Creates (or returns) the financial year containing a date. */
export const createFinancialYear = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; date: string }) => ({
    companyId: assertUuid(input?.companyId),
    date: isoDate(input?.date, "Date"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "accounting.post");
    const res = await ensureFiscalPeriodForDate(context.supabase, data.companyId, data.date);
    if (!res.ok) {
      if (res.reason === "rpc_missing") {
        throw new Error(
          "Financial years cannot be created yet: the database update 20261024130100 has not been applied.",
        );
      }
      throw new Error(res.reason);
    }
    return { periodId: res.periodId };
  });

export type PeriodCloseFacts = {
  periodEnd: string;
  unreconciledBankLines: number;
  draftDocuments: number;
  arControlFound: boolean;
  apControlFound: boolean;
  openingBalanceMinor: number | null;
  taxReturn: { applicable: boolean; filed: boolean } | null;
  yearEnd: { fyEnd: string; closed: boolean } | null;
};

/** Raw facts for the close checklist. Read-only. AR/AP tie-outs come from the aged reports. */
export const getPeriodCloseFacts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; periodEnd: string }) => ({
    companyId: assertUuid(input?.companyId),
    periodEnd: isoDate(input?.periodEnd, "Period end"),
  }))
  .handler(async ({ data, context }): Promise<PeriodCloseFacts> => {
    await assertCompanyMember(context.supabase, data.companyId);
    const sb = context.supabase as unknown as Sb;
    const meta = await loadCompanyMeta(sb, data.companyId);
    const accounts = await loadAccountMetas(sb, data.companyId);

    const unreconciledBankLines = await countRows(sb, "bank_transactions", (q) =>
      (q as Filterable)
        .eq("company_id", data.companyId)
        .in("status", ["uncategorised", "matched"])
        .lte("txn_date", data.periodEnd),
    );
    const draftInvoices = await countRows(sb, "sales_invoices", (q) =>
      (q as Filterable)
        .eq("company_id", data.companyId)
        .in("status", ["draft"])
        .lte("invoice_date", data.periodEnd),
    );
    const draftBills = await countRows(sb, "purchase_bills", (q) =>
      (q as Filterable)
        .eq("company_id", data.companyId)
        .in("status", ["draft", "awaiting_approval"])
        .lte("bill_date", data.periodEnd),
    );

    const arIds = findControlAccountIds(accounts, "ar");
    const apIds = findControlAccountIds(accounts, "ap");
    const obIds = findControlAccountIds(accounts, "opening_balance");
    let openingBalanceMinor: number | null = null;
    if (obIds.length > 0) {
      let net = 0n;
      for (const id of obIds) {
        net += await fetchAccountBalanceAsOf(
          sb,
          data.companyId,
          meta.baseCurrency,
          id,
          data.periodEnd,
        );
      }
      openingBalanceMinor = Number(net);
    }

    // Tax returns exist only once migration 20261024130200 is applied; absence means "not used".
    let taxReturn: PeriodCloseFacts["taxReturn"] = null;
    const { data: ts } = await context.supabase
      .from("company_tax_settings" as never)
      .select("tax_regime" as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    const regime = (ts as { tax_regime?: string } | null)?.tax_regime ?? "none";
    if (regime !== "none") {
      const { data: filed, error } = await context.supabase
        .from("tax_returns" as never)
        .select("id" as never)
        .eq("company_id" as never, data.companyId as never)
        .eq("status" as never, "filed" as never)
        .gte("period_end" as never, data.periodEnd as never)
        .limit(1);
      if (!error) taxReturn = { applicable: true, filed: (filed ?? []).length > 0 };
    }

    let yearEnd: PeriodCloseFacts["yearEnd"] = null;
    const fy = fiscalYearContaining(data.periodEnd, meta.fyEndMonth, meta.fyEndDay);
    if (fy.end === data.periodEnd) {
      const { data: closing } = await context.supabase
        .from("journals" as never)
        .select("id" as never)
        .eq("company_id" as never, data.companyId as never)
        .eq(
          "idempotency_key" as never,
          `year_end_close:${data.companyId}:${data.periodEnd}` as never,
        )
        .maybeSingle();
      yearEnd = { fyEnd: data.periodEnd, closed: Boolean(closing) };
    }

    return {
      periodEnd: data.periodEnd,
      unreconciledBankLines,
      draftDocuments: draftInvoices + draftBills,
      arControlFound: arIds.length > 0,
      apControlFound: apIds.length > 0,
      openingBalanceMinor,
      taxReturn,
      yearEnd,
    };
  });
