import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { findControlAccounts } from "@/lib/accounting/control-accounts";
import { fiscalYearContaining } from "@/lib/accounting/fiscal-year";
import {
  fetchLedgerBalances,
  loadAccountMetas,
  loadCompanyMeta,
  type Sb,
} from "@/lib/accounting/ledger-data";
import { postJournal } from "@/lib/accounting/posting-engine";
import { buildYearEndJournal, planYearEndClose } from "@/lib/accounting/year-end";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

async function plan(supabase: Sb, companyId: string, fyEnd: string) {
  const meta = await loadCompanyMeta(supabase, companyId);
  const fy = fiscalYearContaining(fyEnd, meta.fyEndMonth, meta.fyEndDay);
  if (fy.end !== fyEnd)
    throw new Error(`${fyEnd} is not a financial year end (expected ${fy.end}).`);
  const accounts = await loadAccountMetas(supabase, companyId);
  const re = findControlAccounts(
    accounts.filter((a) => a.account_type === "equity"),
    "retained_earnings",
  )[0];
  if (!re)
    throw new Error(
      "No retained earnings account found. Add an equity account with the retained earnings kind.",
    );
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const bal = await fetchLedgerBalances(supabase, companyId, meta.baseCurrency, {
    from: fy.start,
    to: fy.end,
    excludeYearEndClose: true,
  });
  const pl = bal
    .filter((b) => {
      const t = byId.get(b.account_id)?.account_type;
      return t === "income" || t === "expense";
    })
    .map((b) => ({ account_id: b.account_id, net_debit_minor: b.debit_minor - b.credit_minor }));
  return { meta, fy, re, byId, plan: planYearEndClose(pl, re.id) };
}

export const previewYearEndClose = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; fyEnd: string }) => {
    if (!ISO.test(input?.fyEnd ?? "")) throw new Error("fyEnd must be YYYY-MM-DD");
    return { companyId: assertUuid(input.companyId), fyEnd: input.fyEnd };
  })
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const p = await plan(context.supabase, data.companyId, data.fyEnd);
    // Already closed?
    const { data: existing } = await context.supabase
      .from("journals" as never)
      .select("id, journal_number" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("idempotency_key" as never, `year_end_close:${data.companyId}:${data.fyEnd}` as never)
      .maybeSingle();
    const ex = existing as { id: string; journal_number: number } | null;
    return {
      fyStart: p.fy.start,
      fyEnd: p.fy.end,
      retainedEarnings: { id: p.re.id, code: p.re.code, name: p.re.name },
      netProfitMinor: Number(p.plan.netProfitMinor),
      lines: p.plan.lines.map((l) => ({
        account_id: l.account_id,
        code: p.byId.get(l.account_id)?.code ?? "",
        name: p.byId.get(l.account_id)?.name ?? "",
        debit_minor: Number(l.debit_minor),
        credit_minor: Number(l.credit_minor),
      })),
      alreadyClosedJournalId: ex?.id ?? null,
      alreadyClosedJournalNumber: ex?.journal_number ?? null,
    };
  });

/**
 * Posts the closing journal. Never runs implicitly: the caller must pass `confirm: true`.
 * Goes through the single posting engine, so period locks and permissions apply.
 */
export const postYearEndClose = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; fyEnd: string; confirm: boolean }) => {
    if (!ISO.test(input?.fyEnd ?? "")) throw new Error("fyEnd must be YYYY-MM-DD");
    if (input?.confirm !== true) throw new Error("Closing a year needs explicit confirmation.");
    return { companyId: assertUuid(input.companyId), fyEnd: input.fyEnd };
  })
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "journals.manual");
    const p = await plan(context.supabase, data.companyId, data.fyEnd);
    const journal = buildYearEndJournal({
      companyId: data.companyId,
      fyStart: p.fy.start,
      fyEnd: p.fy.end,
      baseCurrency: p.meta.baseCurrency,
      plan: p.plan,
    });
    const { journalId } = await postJournal(context.supabase, journal);
    return { journalId, netProfitMinor: Number(p.plan.netProfitMinor) };
  });
