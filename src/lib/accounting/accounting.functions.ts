import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { postJournal, reverseJournal } from "@/lib/accounting/posting-engine";
import {
  accountBalanceAsOf,
  buildAccountTransactions,
  buildAgingReport,
  buildBalanceSheet,
  buildCashFlowFromBank,
  buildGeneralLedger,
  buildJournalReport,
  buildProfitAndLoss,
  buildTaxSummary,
  buildTrialBalance,
  type AgingDoc,
  type PostedLine,
} from "@/lib/accounting/reporting";
import { billOutstanding } from "@/lib/purchases/line-math";
import { invoiceOutstanding } from "@/lib/sales/line-helpers";

function companyIdInput(input: { companyId: string }) {
  return { companyId: assertUuid(input?.companyId) };
}

export type AccountRow = {
  id: string;
  code: string;
  name: string;
  account_type: string;
  subtype: string | null;
  normal_balance: string;
  is_system: boolean;
  is_postable: boolean;
  is_control: boolean;
  is_active: boolean;
};

export const listAccounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(companyIdInput)
  .handler(async ({ data, context }): Promise<AccountRow[]> => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await context.supabase
      .from("accounts" as never)
      .select(
        "id, code, name, account_type, subtype, normal_balance, is_system, is_postable, is_control, is_active" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("code" as never);
    if (error) throw new Error(error.message);
    return (rows ?? []) as AccountRow[];
  });

export type PeriodRow = {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
};

export const listPeriods = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(companyIdInput)
  .handler(async ({ data, context }): Promise<PeriodRow[]> => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await context.supabase
      .from("accounting_periods" as never)
      .select("id, name, start_date, end_date, status" as never)
      .eq("company_id" as never, data.companyId as never)
      .order("start_date" as never);
    if (error) throw new Error(error.message);
    return (rows ?? []) as PeriodRow[];
  });

export const lockPeriod = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { periodId: string }) => ({ periodId: assertUuid(input?.periodId, "period") }))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("lock_accounting_period" as never, {
      _period_id: data.periodId,
    } as never);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const unlockPeriod = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { periodId: string }) => ({ periodId: assertUuid(input?.periodId, "period") }))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("unlock_accounting_period" as never, {
      _period_id: data.periodId,
    } as never);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export type JournalListItem = {
  id: string;
  journal_number: number;
  journal_date: string;
  status: string;
  memo: string | null;
  source_type: string;
  currency_code: string;
};

export const listJournals = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(companyIdInput)
  .handler(async ({ data, context }): Promise<JournalListItem[]> => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await context.supabase
      .from("journals" as never)
      .select("id, journal_number, journal_date, status, memo, source_type, currency_code" as never)
      .eq("company_id" as never, data.companyId as never)
      .order("journal_number" as never, { ascending: false } as never)
      .limit(100);
    if (error) throw new Error(error.message);
    return (rows ?? []) as JournalListItem[];
  });

export const postManualJournal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      journalDate: string;
      memo?: string;
      idempotencyKey?: string;
      lines: Array<{
        accountId: string;
        description?: string;
        debitMinor: number;
        creditMinor: number;
      }>;
    }) => {
      const companyId = assertUuid(input?.companyId);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.journalDate ?? "")) {
        throw new Error("Choose a valid posting date.");
      }
      if (!Array.isArray(input.lines) || input.lines.length < 2) {
        throw new Error("Enter at least two journal lines.");
      }
      return {
        companyId,
        journalDate: input.journalDate,
        memo: (input.memo ?? "").trim().slice(0, 500),
        idempotencyKey: (input.idempotencyKey ?? "").trim().slice(0, 200) || undefined,
        lines: input.lines.map((l) => ({
          accountId: assertUuid(l.accountId, "account"),
          description: (l.description ?? "").trim().slice(0, 300),
          debitMinor: Number(l.debitMinor) || 0,
          creditMinor: Number(l.creditMinor) || 0,
        })),
      };
    },
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "journals.manual");
    const result = await postJournal(context.supabase, {
      company_id: data.companyId,
      journal_date: data.journalDate,
      ...(data.memo ? { memo: data.memo } : {}),
      source_type: "manual",
      ...(data.idempotencyKey ? { idempotency_key: data.idempotencyKey } : {}),
      lines: data.lines.map((l) => ({
        account_id: l.accountId,
        ...(l.description ? { description: l.description } : {}),
        debit_minor: l.debitMinor,
        credit_minor: l.creditMinor,
      })),
    });
    return result;
  });

export const reversePostedJournal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { journalId: string; idempotencyKey?: string }) => ({
    journalId: assertUuid(input?.journalId, "journal"),
    idempotencyKey: (input.idempotencyKey ?? "").trim() || undefined,
  }))
  .handler(async ({ data, context }) => {
    return reverseJournal(context.supabase, data.journalId, data.idempotencyKey);
  });

async function loadPostedLines(
  supabase: Parameters<typeof assertCompanyMember>[0],
  companyId: string,
): Promise<PostedLine[]> {
  const { data: rows, error } = await supabase
    .from("journal_lines" as never)
    .select(
      "account_id, debit_minor, credit_minor, description, journals!inner(id, journal_number, journal_date, status, company_id, memo, source_type, currency_code, fx_rate_to_base), accounts!inner(code, name, account_type, subtype)" as never,
    )
    .eq("company_id" as never, companyId as never);
  if (error) throw new Error(error.message);

  type Raw = {
    account_id: string;
    debit_minor: number;
    credit_minor: number;
    description: string | null;
    accounts: {
      code: string;
      name: string;
      account_type: PostedLine["account_type"];
      subtype: string | null;
    };
    journals: {
      id: string;
      journal_number: number;
      journal_date: string;
      status: string;
      company_id: string;
      memo: string | null;
      source_type: string;
      currency_code: string | null;
      fx_rate_to_base: number | string | null;
    };
  };

  return ((rows ?? []) as unknown as Raw[])
    .filter((r) => r.journals.status === "posted")
    .map((r) => ({
      account_id: r.account_id,
      account_code: r.accounts.code,
      account_name: r.accounts.name,
      account_type: r.accounts.account_type,
      account_subtype: r.accounts.subtype,
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
}

export const getTrialBalance = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; from?: string; to?: string }) => ({
    companyId: assertUuid(input?.companyId),
    from: input.from,
    to: input.to,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const lines = await loadPostedLines(context.supabase, data.companyId);
    const result = buildTrialBalance(lines, {
      ...(data.from ? { from: data.from } : {}),
      ...(data.to ? { to: data.to } : {}),
    });
    return {
      rows: result.rows.map((r) => ({
        ...r,
        debit_minor: Number(r.debit_minor),
        credit_minor: Number(r.credit_minor),
      })),
      totalDebit: Number(result.totalDebit),
      totalCredit: Number(result.totalCredit),
      balances: result.balances,
    };
  });

export const getProfitAndLoss = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; from: string; to: string }) => ({
    companyId: assertUuid(input?.companyId),
    from: input.from,
    to: input.to,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const lines = await loadPostedLines(context.supabase, data.companyId);
    const result = buildProfitAndLoss(lines, { from: data.from, to: data.to });
    return {
      income: Number(result.income),
      expense: Number(result.expense),
      net: Number(result.net),
      revenue: Number(result.revenue),
      contraRevenue: Number(result.contraRevenue),
      costOfSales: Number(result.costOfSales),
      grossProfit: Number(result.grossProfit),
      operatingExpense: Number(result.operatingExpense),
      otherNet: Number(result.otherNet),
      sections: result.sections.map((s) => ({
        ...s,
        total_minor: Number(s.total_minor),
        rows: s.rows.map((r) => ({
          ...r,
          debit_minor: Number(r.debit_minor),
          credit_minor: Number(r.credit_minor),
        })),
      })),
      rows: result.rows.map((r) => ({
        ...r,
        debit_minor: Number(r.debit_minor),
        credit_minor: Number(r.credit_minor),
      })),
    };
  });

export const getBalanceSheet = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; asOf: string }) => ({
    companyId: assertUuid(input?.companyId),
    asOf: input.asOf,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const lines = await loadPostedLines(context.supabase, data.companyId);
    const result = buildBalanceSheet(lines, { asOf: data.asOf });
    return {
      assets: Number(result.assets),
      liabilities: Number(result.liabilities),
      equity: Number(result.equity),
      retainedEarningsMinor: Number(result.retainedEarningsMinor),
      equationHolds: result.equationHolds,
      rows: result.rows.map((r) => ({
        ...r,
        debit_minor: Number(r.debit_minor),
        credit_minor: Number(r.credit_minor),
      })),
      sections: result.sections.map((s) => ({
        id: s.id,
        label: s.label,
        total_minor: Number(s.total_minor),
        rows: s.rows.map((r) => ({
          ...r,
          debit_minor: Number(r.debit_minor),
          credit_minor: Number(r.credit_minor),
        })),
      })),
    };
  });

export const getGeneralLedger = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; accountId: string; from?: string; to?: string }) => ({
    companyId: assertUuid(input?.companyId),
    accountId: assertUuid(input?.accountId, "account"),
    from: input.from,
    to: input.to,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const lines = await loadPostedLines(context.supabase, data.companyId);
    const result = buildGeneralLedger(lines, {
      accountId: data.accountId,
      ...(data.from ? { from: data.from } : {}),
      ...(data.to ? { to: data.to } : {}),
    });
    return result.map((l) => ({
      ...l,
      debit_minor: Number(l.debit_minor),
      credit_minor: Number(l.credit_minor),
    }));
  });

export const getAccountTransactions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; accountId: string; from: string; to: string }) => ({
    companyId: assertUuid(input.companyId),
    accountId: assertUuid(input.accountId, "account"),
    from: input.from,
    to: input.to,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const lines = await loadPostedLines(context.supabase, data.companyId);
    const result = buildAccountTransactions(lines, {
      accountId: data.accountId,
      from: data.from,
      to: data.to,
    });
    return {
      opening_balance_minor: Number(result.opening_balance_minor),
      closing_balance_minor: Number(result.closing_balance_minor),
      rows: result.rows.map((l) => ({
        ...l,
        debit_minor: Number(l.debit_minor),
        credit_minor: Number(l.credit_minor),
        opening_balance_minor: Number(l.opening_balance_minor),
        running_balance_minor: Number(l.running_balance_minor),
      })),
    };
  });

export const getAgedReceivables = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; asOf: string }) => ({
    companyId: assertUuid(input.companyId),
    asOf: input.asOf,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await context.supabase
      .from("sales_invoices" as never)
      .select(
        "id, contact_id, invoice_date, due_date, invoice_number, status, total_minor, amount_paid_minor, amount_credited_minor, posted_journal_id, contacts(name)" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .in("status" as never, ["authorised", "partly_paid"] as never);
    if (error) throw new Error(error.message);

    const raw = (rows ?? []) as Array<{
      id: string;
      contact_id: string;
      invoice_date: string;
      due_date: string;
      invoice_number: string | null;
      total_minor: number;
      amount_paid_minor: number;
      amount_credited_minor: number;
      posted_journal_id: string | null;
      contacts: { name: string } | null;
    }>;
    // Only documents posted to the ledger belong in AR ageing (excludes volume UI shells).
    const posted = raw.filter((r) => Boolean(r.posted_journal_id));
    const excludedUnposted = raw.length - posted.length;

    const docs: AgingDoc[] = posted.map((r) => ({
      id: r.id,
      contact_id: r.contact_id,
      contact_name: r.contacts?.name ?? "Unknown",
      doc_date: r.invoice_date,
      due_date: r.due_date,
      reference: r.invoice_number,
      outstanding_minor: invoiceOutstanding({
        total_minor: r.total_minor,
        amount_paid_minor: r.amount_paid_minor,
        amount_credited_minor: r.amount_credited_minor,
      }),
    }));

    const aged = buildAgingReport(docs, { asOf: data.asOf });
    const lines = await loadPostedLines(context.supabase, data.companyId);
    const { data: arAcc } = await context.supabase
      .from("accounts" as never)
      .select("id" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("code" as never, "1100" as never)
      .maybeSingle();
    const arId = (arAcc as { id: string } | null)?.id;
    const controlBalance = arId ? accountBalanceAsOf(lines, arId, data.asOf) : 0n;
    const variance = aged.total - controlBalance;

    return {
      rows: aged.rows.map((r) => ({
        ...r,
        current: Number(r.current),
        b_1_30: Number(r.b_1_30),
        b_31_60: Number(r.b_31_60),
        b_61_90: Number(r.b_61_90),
        b_90_plus: Number(r.b_90_plus),
        total: Number(r.total),
        docs: r.docs.map((d) => ({ ...d, outstanding_minor: Number(d.outstanding_minor) })),
      })),
      total: Number(aged.total),
      byBucket: {
        current: Number(aged.byBucket.current),
        "1_30": Number(aged.byBucket["1_30"]),
        "31_60": Number(aged.byBucket["31_60"]),
        "61_90": Number(aged.byBucket["61_90"]),
        "90_plus": Number(aged.byBucket["90_plus"]),
      },
      arControlBalanceMinor: Number(controlBalance),
      varianceMinor: Number(variance),
      tiesToControl: variance === 0n,
      excludedUnpostedCount: excludedUnposted,
      diagnostic:
        variance === 0n
          ? null
          : "Subledger total differs from AR control (1100). Check manual journals to AR, unallocated receipts, or documents posted without allocation updates.",
    };
  });

export const getAgedPayables = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; asOf: string }) => ({
    companyId: assertUuid(input.companyId),
    asOf: input.asOf,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await context.supabase
      .from("purchase_bills" as never)
      .select(
        "id, contact_id, bill_date, due_date, supplier_invoice_number, status, total_minor, amount_paid_minor, amount_credited_minor, posted_journal_id, contacts(name)" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .in("status" as never, ["authorised", "partly_paid"] as never);
    if (error) throw new Error(error.message);

    const raw = (rows ?? []) as Array<{
      id: string;
      contact_id: string;
      bill_date: string;
      due_date: string;
      supplier_invoice_number: string | null;
      total_minor: number;
      amount_paid_minor: number;
      amount_credited_minor: number;
      posted_journal_id: string | null;
      contacts: { name: string } | null;
    }>;
    const posted = raw.filter((r) => Boolean(r.posted_journal_id));
    const excludedUnposted = raw.length - posted.length;

    const docs: AgingDoc[] = posted.map((r) => ({
      id: r.id,
      contact_id: r.contact_id,
      contact_name: r.contacts?.name ?? "Unknown",
      doc_date: r.bill_date,
      due_date: r.due_date,
      reference: r.supplier_invoice_number,
      outstanding_minor: billOutstanding({
        total_minor: r.total_minor,
        amount_paid_minor: r.amount_paid_minor,
        amount_credited_minor: r.amount_credited_minor,
      }),
    }));

    const aged = buildAgingReport(docs, { asOf: data.asOf });
    const lines = await loadPostedLines(context.supabase, data.companyId);
    const { data: apAcc } = await context.supabase
      .from("accounts" as never)
      .select("id" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("code" as never, "2000" as never)
      .maybeSingle();
    const apId = (apAcc as { id: string } | null)?.id;
    // AP is credit-normal; outstanding docs should equal credit balance (negated debit-credit)
    const controlSigned = apId ? accountBalanceAsOf(lines, apId, data.asOf) : 0n;
    const controlBalance = -controlSigned;
    const variance = aged.total - controlBalance;

    return {
      rows: aged.rows.map((r) => ({
        ...r,
        current: Number(r.current),
        b_1_30: Number(r.b_1_30),
        b_31_60: Number(r.b_31_60),
        b_61_90: Number(r.b_61_90),
        b_90_plus: Number(r.b_90_plus),
        total: Number(r.total),
        docs: r.docs.map((d) => ({ ...d, outstanding_minor: Number(d.outstanding_minor) })),
      })),
      total: Number(aged.total),
      byBucket: {
        current: Number(aged.byBucket.current),
        "1_30": Number(aged.byBucket["1_30"]),
        "31_60": Number(aged.byBucket["31_60"]),
        "61_90": Number(aged.byBucket["61_90"]),
        "90_plus": Number(aged.byBucket["90_plus"]),
      },
      apControlBalanceMinor: Number(controlBalance),
      varianceMinor: Number(variance),
      tiesToControl: variance === 0n,
      excludedUnpostedCount: excludedUnposted,
      diagnostic:
        variance === 0n
          ? null
          : "Subledger total differs from AP control (2000). Check manual journals to AP or bills without posted journals.",
    };
  });

export const getCashFlow = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; from: string; to: string }) => ({
    companyId: assertUuid(input.companyId),
    from: input.from,
    to: input.to,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const lines = await loadPostedLines(context.supabase, data.companyId);
    const { data: banks } = await context.supabase
      .from("bank_accounts" as never)
      .select("gl_account_id" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("is_active" as never, true as never);
    let bankIds = ((banks ?? []) as Array<{ gl_account_id: string }>).map((b) => b.gl_account_id);
    if (!bankIds.length) {
      const { data: bankAcc } = await context.supabase
        .from("accounts" as never)
        .select("id" as never)
        .eq("company_id" as never, data.companyId as never)
        .eq("code" as never, "1000" as never)
        .maybeSingle();
      if (bankAcc) bankIds = [(bankAcc as { id: string }).id];
    }
    const result = buildCashFlowFromBank(lines, {
      from: data.from,
      to: data.to,
      bankAccountIds: bankIds,
    });
    return {
      operating: Number(result.operating),
      investing: Number(result.investing),
      financing: Number(result.financing),
      net_change: Number(result.net_change),
      opening_cash: Number(result.opening_cash),
      closing_cash: Number(result.closing_cash),
      closing_cash_ledger: Number(result.closing_cash_ledger),
      reconciles: result.reconciles,
      rows: result.rows.map((r) => ({ ...r, amount_minor: Number(r.amount_minor) })),
      method: "bank_direct_proxy",
      limitation: result.limitation,
    };
  });

export const getTaxReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; from: string; to: string }) => ({
    companyId: assertUuid(input.companyId),
    from: input.from,
    to: input.to,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const lines = await loadPostedLines(context.supabase, data.companyId);
    const { data: settings } = await context.supabase
      .from("company_tax_settings" as never)
      .select("output_tax_account_id, input_tax_account_id, tax_regime, jurisdiction_code" as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    const s = settings as {
      output_tax_account_id: string | null;
      input_tax_account_id: string | null;
      tax_regime: string;
      jurisdiction_code: string | null;
    } | null;

    const taxIds: string[] = [];
    if (s?.output_tax_account_id) taxIds.push(s.output_tax_account_id);
    if (s?.input_tax_account_id) taxIds.push(s.input_tax_account_id);
    if (!taxIds.length) {
      const { data: taxAccs } = await context.supabase
        .from("accounts" as never)
        .select("id, code" as never)
        .eq("company_id" as never, data.companyId as never)
        .in("code" as never, ["2100", "1200"] as never);
      for (const a of (taxAccs ?? []) as Array<{ id: string }>) taxIds.push(a.id);
    }

    const result = buildTaxSummary(lines, {
      from: data.from,
      to: data.to,
      taxAccountIds: taxIds,
    });
    return {
      regime: s?.tax_regime ?? "none",
      jurisdictionCode: s?.jurisdiction_code ?? null,
      output_credit_minor: Number(result.output_credit_minor),
      input_debit_minor: Number(result.input_debit_minor),
      net_payable_minor: Number(result.net_payable_minor),
      rows: result.rows.map((r) => ({
        ...r,
        debit_minor: Number(r.debit_minor),
        credit_minor: Number(r.credit_minor),
      })),
      detail: result.detail.map((l) => ({
        ...l,
        debit_minor: Number(l.debit_minor),
        credit_minor: Number(l.credit_minor),
      })),
      complianceNote:
        "Summary of posted tax control account movements only. Not a filed VAT/GST/sales-tax return.",
    };
  });

export const getJournalReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; from?: string; to?: string; status?: string }) => ({
      companyId: assertUuid(input.companyId),
      from: input.from,
      to: input.to,
      status: input.status,
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: journals, error } = await context.supabase
      .from("journals" as never)
      .select(
        "id, journal_number, journal_date, status, source_type, memo, journal_lines(debit_minor, credit_minor)" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("journal_date" as never)
      .limit(500);
    if (error) throw new Error(error.message);
    const mapped = ((journals ?? []) as Array<{
      id: string;
      journal_number: number;
      journal_date: string;
      status: string;
      source_type: string;
      memo: string | null;
      journal_lines: Array<{ debit_minor: number; credit_minor: number }>;
    }>).map((j) => ({
      id: j.id,
      journal_number: j.journal_number,
      journal_date: j.journal_date,
      status: j.status,
      source_type: j.source_type,
      memo: j.memo,
      lines: j.journal_lines,
    }));
    const rows = buildJournalReport(mapped, {
      ...(data.from ? { from: data.from } : {}),
      ...(data.to ? { to: data.to } : {}),
      ...(data.status ? { status: data.status } : {}),
    });
    return rows.map((r) => ({
      ...r,
      total_debit_minor: Number(r.total_debit_minor),
      total_credit_minor: Number(r.total_credit_minor),
    }));
  });

export const getAuditReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; from?: string; to?: string }) => ({
    companyId: assertUuid(input.companyId),
    from: input.from,
    to: input.to,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "audit.view");
    let q = context.supabase
      .from("audit_events" as never)
      .select("id, action, entity_type, entity_id, details, created_at, actor_user_id" as never)
      .eq("company_id" as never, data.companyId as never)
      .order("created_at" as never, { ascending: false })
      .limit(200);
    if (data.from) q = q.gte("created_at" as never, `${data.from}T00:00:00Z` as never);
    if (data.to) q = q.lte("created_at" as never, `${data.to}T23:59:59Z` as never);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

/** Ensure CoA + periods exist for companies created before the engine migration. */
export const ensureLedgerMasters = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(companyIdInput)
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "accounts.manage");
    const { error: a } = await context.supabase.rpc("seed_default_chart_of_accounts" as never, {
      _company_id: data.companyId,
    } as never);
    if (a) throw new Error(a.message);
    const { error: p } = await context.supabase.rpc("seed_default_accounting_periods" as never, {
      _company_id: data.companyId,
    } as never);
    if (p) throw new Error(p.message);
    return { ok: true };
  });
