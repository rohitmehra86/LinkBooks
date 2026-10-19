import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  assertCompanyMember,
  assertCompanyPermission,
} from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { seedDemoCompanyData } from "@/lib/demo/seed-demo";
import {
  DEMO_EXPECTED,
  DEMO_MODULE_STATUS,
  DEMO_COMPANY_NAME,
} from "@/lib/demo/demo-dataset";
import {
  buildAgingReport,
  buildBalanceSheet,
  buildProfitAndLoss,
  buildTrialBalance,
  type PostedLine,
} from "@/lib/accounting/reporting";

export const getDemoModuleStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => ({
    companyName: DEMO_COMPANY_NAME,
    modules: DEMO_MODULE_STATUS,
    disclaimer:
      "Demo Company uses sample data only. It is not a real financial record. The same posting engine and permissions apply as for live organisations.",
  }));

/**
 * Clear transactional demo data (RPC) then reseed via PostingEngine.
 * Hard-fails on non-demo companies.
 */
export const reseedDemoCompany = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({
    companyId: assertUuid(input.companyId),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "demo.reset");

    const { data: company } = await context.supabase
      .from("companies")
      .select("is_demo, name")
      .eq("id", data.companyId)
      .maybeSingle();
    if (!company?.is_demo) {
      throw new Error("Reseed denied: only Demo Company can be reseeded");
    }

    const { error } = await context.supabase.rpc("reset_demo_company" as never, {
      _company_id: data.companyId,
    } as never);
    if (error) throw new Error(error.message);

    const seeded = await seedDemoCompanyData(context.supabase, {
      companyId: data.companyId,
      userId: context.userId,
    });

    return {
      ok: true,
      companyName: company.name,
      ...seeded,
      expected: {
        asOf: DEMO_EXPECTED.asOf,
        netProfitMinor: String(DEMO_EXPECTED.netProfit),
        assetsMinor: String(DEMO_EXPECTED.assets),
        bankMinor: String(DEMO_EXPECTED.bank),
      },
    };
  });

/** Ensure demo has sample ledger after first open (idempotent). */
export const ensureDemoSeeded = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({
    companyId: assertUuid(input.companyId),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: company } = await context.supabase
      .from("companies")
      .select("is_demo")
      .eq("id", data.companyId)
      .maybeSingle();
    if (!company?.is_demo) {
      throw new Error("ensureDemoSeeded is only for Demo Company");
    }

    const { count } = await context.supabase
      .from("journals" as never)
      .select("id" as never, { count: "exact", head: true })
      .eq("company_id" as never, data.companyId as never)
      .eq("status" as never, "posted" as never);

    if ((count ?? 0) > 0) {
      return { seeded: false, reason: "already_has_journals" as const };
    }

    const result = await seedDemoCompanyData(context.supabase, {
      companyId: data.companyId,
      userId: context.userId,
    });
    return { seeded: true, reason: "seeded" as const, ...result };
  });

/**
 * Dashboard / verification snapshot from posted journals only (no fabricated metrics).
 */
export const getDemoLedgerSnapshot = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({
    companyId: assertUuid(input.companyId),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);

    const { data: company } = await context.supabase
      .from("companies")
      .select("is_demo, name, base_currency")
      .eq("id", data.companyId)
      .maybeSingle();
    if (!company) throw new Error("Company not found");

    const { data: rows, error } = await context.supabase
      .from("journal_lines" as never)
      .select(
        "account_id, debit_minor, credit_minor, description, journals!inner(id, journal_number, journal_date, status, company_id, memo, source_type, currency_code, fx_rate_to_base), accounts!inner(code, name, account_type)" as never,
      )
      .eq("company_id" as never, data.companyId as never);
    if (error) throw new Error(error.message);

    type Raw = {
      account_id: string;
      debit_minor: number;
      credit_minor: number;
      description: string | null;
      accounts: { code: string; name: string; account_type: PostedLine["account_type"] };
      journals: {
        id: string;
        journal_number: number;
        journal_date: string;
        status: string;
        memo: string | null;
        source_type: string;
        currency_code: string | null;
        fx_rate_to_base: number | string | null;
      };
    };

    const lines: PostedLine[] = ((rows ?? []) as unknown as Raw[])
      .filter((r) => r.journals.status === "posted")
      .map((r) => ({
        account_id: r.account_id,
        account_code: r.accounts.code,
        account_name: r.accounts.name,
        account_type: r.accounts.account_type,
        journal_date: r.journals.journal_date,
        debit_minor: BigInt(r.debit_minor),
        credit_minor: BigInt(r.credit_minor),
        fx_rate_to_base: r.journals.fx_rate_to_base,
        currency_code: r.journals.currency_code,
        journal_id: r.journals.id,
        journal_number: r.journals.journal_number,
        memo: r.journals.memo,
        source_type: r.journals.source_type,
        description: r.description,
      }));

    const asOf = DEMO_EXPECTED.asOf;
    const from = DEMO_EXPECTED.fyFrom;
    const tb = buildTrialBalance(lines, { to: asOf });
    const pl = buildProfitAndLoss(lines, { from, to: asOf });
    const bs = buildBalanceSheet(lines, { asOf });

    const { data: bankTxns } = await context.supabase
      .from("bank_transactions" as never)
      .select("id, status" as never)
      .eq("company_id" as never, data.companyId as never);
    const unreconciled = ((bankTxns ?? []) as Array<{ status: string }>).filter(
      (t) => t.status === "uncategorised",
    ).length;

    const openAr = lines
      .filter((l) => l.account_code === "1100")
      .reduce((n, l) => n + (BigInt(l.debit_minor) - BigInt(l.credit_minor)), 0n);
    const openAp = lines
      .filter((l) => l.account_code === "2000")
      .reduce((n, l) => n + (BigInt(l.credit_minor) - BigInt(l.debit_minor)), 0n);
    const bank = lines
      .filter((l) => l.account_code === "1000")
      .reduce((n, l) => n + (BigInt(l.debit_minor) - BigInt(l.credit_minor)), 0n);

    // Aging from open invoice docs when present
    const { data: invs } = await context.supabase
      .from("sales_invoices" as never)
      .select("id, contact_id, due_date, total_minor, amount_paid_minor, amount_credited_minor, status" as never)
      .eq("company_id" as never, data.companyId as never);
    const agingDocs = ((invs ?? []) as Array<{
      id: string;
      contact_id: string;
      due_date: string;
      total_minor: number;
      amount_paid_minor: number;
      amount_credited_minor: number;
      status: string;
    }>)
      .filter((i) => i.status !== "void" && i.status !== "draft")
      .map((i) => ({
        id: i.id,
        contact_id: i.contact_id,
        contact_name: "Customer",
        doc_date: i.due_date,
        due_date: i.due_date,
        reference: null as string | null,
        outstanding_minor: BigInt(
          i.total_minor - i.amount_paid_minor - i.amount_credited_minor,
        ),
      }))
      .filter((d) => d.outstanding_minor > 0n);
    const arAging = buildAgingReport(agingDocs, { asOf });

    const matchesExpected =
      company.is_demo &&
      tb.balances &&
      bs.equationHolds &&
      tb.totalDebit === DEMO_EXPECTED.trialBalanceDebit &&
      pl.net === DEMO_EXPECTED.netProfit &&
      bank === DEMO_EXPECTED.bank;

    return {
      isDemo: company.is_demo,
      companyName: company.name,
      currency: company.base_currency,
      asOf,
      journalLineCount: lines.length,
      trialBalanceBalances: tb.balances,
      trialBalanceDebit: String(tb.totalDebit),
      trialBalanceCredit: String(tb.totalCredit),
      income: String(pl.income),
      expense: String(pl.expense),
      netProfit: String(pl.net),
      assets: String(bs.assets),
      liabilities: String(bs.liabilities),
      equity: String(bs.equity),
      equationHolds: bs.equationHolds,
      bank: String(bank),
      receivables: String(openAr),
      payables: String(openAp),
      unreconciledBankTxns: unreconciled,
      arAgingTotal: String(arAging.total),
      matchesCanonicalDemoExpected: matchesExpected,
      expectedWhenFullySeeded: {
        trialBalanceDebit: String(DEMO_EXPECTED.trialBalanceDebit),
        netProfit: String(DEMO_EXPECTED.netProfit),
        bank: String(DEMO_EXPECTED.bank),
        assets: String(DEMO_EXPECTED.assets),
      },
    };
  });
