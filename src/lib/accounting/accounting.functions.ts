import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { postJournal, reverseJournal } from "@/lib/accounting/posting-engine";

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
  .inputValidator((input: { periodId: string }) => ({
    periodId: assertUuid(input?.periodId, "period"),
  }))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc(
      "lock_accounting_period" as never,
      {
        _period_id: data.periodId,
      } as never,
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const unlockPeriod = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { periodId: string }) => ({
    periodId: assertUuid(input?.periodId, "period"),
  }))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc(
      "unlock_accounting_period" as never,
      {
        _period_id: data.periodId,
      } as never,
    );
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
  source_id: string | null;
  currency_code: string;
  reverses_journal_id: string | null;
  reversed_by_journal_id: string | null;
  total_debit_minor: number;
};

export const listJournals = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      search?: string;
      source?: string;
      from?: string;
      to?: string;
      limit?: number;
    }) => {
      const date = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
      return {
        companyId: assertUuid(input?.companyId),
        search: (input.search ?? "").trim().slice(0, 80),
        source: (input.source ?? "").trim().slice(0, 40),
        from: date(input.from),
        to: date(input.to),
        limit: Math.min(500, Math.max(1, Math.floor(input.limit ?? 100))),
      };
    },
  )
  .handler(async ({ data, context }): Promise<JournalListItem[]> => {
    await assertCompanyMember(context.supabase, data.companyId);
    let query = context.supabase
      .from("journals" as never)
      .select(
        "id, journal_number, journal_date, status, memo, source_type, source_id, currency_code, reverses_journal_id, reversed_by_journal_id, journal_lines(debit_minor)" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("journal_date" as never, { ascending: false } as never)
      .order("journal_number" as never, { ascending: false } as never)
      .limit(data.limit);
    if (data.source) query = query.eq("source_type" as never, data.source as never);
    if (data.from) query = query.gte("journal_date" as never, data.from as never);
    if (data.to) query = query.lte("journal_date" as never, data.to as never);
    if (data.search) {
      const term = data.search.replace(/[%,()]/g, " ");
      const asNumber = Number(term);
      query =
        Number.isInteger(asNumber) && asNumber > 0
          ? query.or(`journal_number.eq.${asNumber},memo.ilike.%${term}%`)
          : query.ilike("memo" as never, `%${term}%` as never);
    }
    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);
    return (
      (rows ?? []) as unknown as Array<
        Omit<JournalListItem, "total_debit_minor"> & {
          journal_lines: Array<{ debit_minor: number }>;
        }
      >
    ).map(({ journal_lines, ...rest }) => ({
      ...rest,
      total_debit_minor: (journal_lines ?? []).reduce(
        (sum, line) => sum + Number(line.debit_minor),
        0,
      ),
    }));
  });

export type JournalDetail = {
  id: string;
  journal_number: number;
  journal_date: string;
  status: string;
  memo: string | null;
  source_type: string;
  currency_code: string;
  reverses_journal_id: string | null;
  lines: Array<{
    id: string;
    line_no: number;
    description: string | null;
    debit_minor: number;
    credit_minor: number;
    account_code: string;
    account_name: string;
  }>;
};

export const getJournalDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; journalId: string }) => ({
    companyId: assertUuid(input?.companyId),
    journalId: assertUuid(input?.journalId, "journal"),
  }))
  .handler(async ({ data, context }): Promise<JournalDetail> => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: row, error } = await context.supabase
      .from("journals" as never)
      .select(
        "id, journal_number, journal_date, status, memo, source_type, currency_code, reverses_journal_id, journal_lines(id, line_no, description, debit_minor, credit_minor, accounts(code, name))" as never,
      )
      .eq("id" as never, data.journalId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Journal not found");
    const j = row as unknown as Omit<JournalDetail, "lines"> & {
      journal_lines: Array<{
        id: string;
        line_no: number;
        description: string | null;
        debit_minor: number;
        credit_minor: number;
        accounts: { code: string; name: string } | null;
      }>;
    };
    const { journal_lines, ...rest } = j;
    return {
      ...rest,
      lines: (journal_lines ?? [])
        .slice()
        .sort((x, y) => x.line_no - y.line_no)
        .map((l) => ({
          id: l.id,
          line_no: l.line_no,
          description: l.description,
          debit_minor: Number(l.debit_minor),
          credit_minor: Number(l.credit_minor),
          account_code: l.accounts?.code ?? "",
          account_name: l.accounts?.name ?? "",
        })),
    };
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
    const { data: wf } = await context.supabase
      .from("company_workflow_settings" as never)
      .select("accounting_require_journal_memo" as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (
      (wf as { accounting_require_journal_memo?: boolean } | null)
        ?.accounting_require_journal_memo &&
      !data.memo
    ) {
      throw new Error("A journal memo is required by organisation settings.");
    }
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

/** Ensure CoA + periods exist for companies created before the engine migration. */
export const ensureLedgerMasters = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(companyIdInput)
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "accounts.manage");
    const { error: a } = await context.supabase.rpc(
      "seed_default_chart_of_accounts" as never,
      {
        _company_id: data.companyId,
      } as never,
    );
    if (a) throw new Error(a.message);
    const { error: p } = await context.supabase.rpc(
      "seed_default_accounting_periods" as never,
      {
        _company_id: data.companyId,
      } as never,
    );
    if (p) throw new Error(p.message);
    return { ok: true };
  });
