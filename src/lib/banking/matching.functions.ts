import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { fetchAllPages } from "@/lib/banking/fetch-all";
import {
  DEFAULT_MATCH_WINDOW_DAYS,
  MAX_MATCH_LINES,
  rankCandidates,
} from "@/lib/banking/matching";
import { callRpc } from "@/lib/banking/rpc";
import {
  linkedLineIds,
  loadBankAccount,
  loadBankTxn,
  type AnyClient,
} from "@/lib/banking/server-helpers";

type RpcMatchResult = { linked: number; bank_transaction_ids: string[] };

/**
 * BK-01: undo coding / matching of a statement line (reverses a bank-originated journal, removes the link,
 * returns the line to "uncategorised", writes an audit event) — all inside one database transaction.
 * Reports "Unavailable until database update is applied" when the RPC is not installed yet.
 */
export const unmatchBankTransaction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; bankTransactionId: string; reason?: string }) => ({
    companyId: assertUuid(input.companyId),
    bankTransactionId: assertUuid(input.bankTransactionId),
    reason: (input.reason ?? "").trim().slice(0, 500) || null,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "banking.categorise");
    const r = await callRpc<{
      already: boolean;
      reversed_journal_ids: string[];
      unmatched_transaction_ids: string[];
    }>(context.supabase as AnyClient, "unmatch_bank_transaction", {
      _company_id: data.companyId,
      _bank_transaction_id: data.bankTransactionId,
      _reason: data.reason,
    });
    return {
      already: Boolean(r?.already),
      reversedJournalCount: r?.reversed_journal_ids?.length ?? 0,
      unmatchedCount: r?.unmatched_transaction_ids?.length ?? 0,
    };
  });

export type MatchCandidateRow = {
  lineId: string;
  journalId: string;
  journalNumber: number;
  date: string;
  source: string;
  description: string;
  amountMinor: number;
  dayDistance: number;
  exact: boolean;
};

export const listMatchCandidates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; bankTransactionId: string; windowDays?: number }) => ({
    companyId: assertUuid(input.companyId),
    bankTransactionId: assertUuid(input.bankTransactionId),
    windowDays: Math.min(90, Math.max(0, Math.round(Number(input.windowDays ?? DEFAULT_MATCH_WINDOW_DAYS)))),
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyMember(supabase, data.companyId);
    const txn = await loadBankTxn(supabase, data.companyId, data.bankTransactionId);
    const account = await loadBankAccount(supabase, data.companyId, txn.bank_account_id);

    const shift = (iso: string, days: number) => {
      const d = new Date(`${iso}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    };
    const from = shift(txn.txn_date, -data.windowDays);
    const to = shift(txn.txn_date, data.windowDays);

    type Row = {
      id: string;
      journal_id: string;
      description: string | null;
      debit_minor: number;
      credit_minor: number;
      journals: {
        journal_number: number;
        journal_date: string;
        source_type: string;
        memo: string | null;
      };
    };
    const lines = await fetchAllPages<Row>((a, b) =>
      supabase
        .from("journal_lines" as never)
        .select(
          "id, journal_id, description, debit_minor, credit_minor, journals!inner(journal_number, journal_date, status, source_type, memo, reversed_by_journal_id, reverses_journal_id)" as never,
        )
        .eq("company_id" as never, data.companyId as never)
        .eq("account_id" as never, account.gl_account_id as never)
        .eq("journals.status" as never, "posted" as never)
        .is("journals.reversed_by_journal_id" as never, null as never)
        .is("journals.reverses_journal_id" as never, null as never)
        .gte("journals.journal_date" as never, from as never)
        .lte("journals.journal_date" as never, to as never)
        .order("id" as never)
        .range(a, b) as never,
    );

    const linked = await linkedLineIds(
      supabase,
      data.companyId,
      lines.map((l) => l.id),
    );
    const candidates = lines
      .filter((l) => !linked.has(l.id))
      .map((l) => ({
        lineId: l.id,
        journalId: l.journal_id,
        journalNumber: l.journals.journal_number,
        date: l.journals.journal_date,
        source: l.journals.source_type,
        description: l.description ?? l.journals.memo ?? "",
        amountMinor: l.debit_minor - l.credit_minor,
      }));
    const ranked = rankCandidates(
      { txnDate: txn.txn_date, amountMinor: txn.amount_minor },
      candidates,
      data.windowDays,
    ).slice(0, 150);

    const { data: others, error: oErr } = await supabase
      .from("bank_transactions" as never)
      .select("id, txn_date, amount_minor, description" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("bank_account_id" as never, txn.bank_account_id as never)
      .eq("status" as never, "uncategorised" as never)
      .neq("id" as never, txn.id as never)
      .gte("txn_date" as never, from as never)
      .lte("txn_date" as never, to as never)
      .order("txn_date" as never)
      .limit(100);
    if (oErr) throw new Error(oErr.message);

    return {
      transaction: {
        id: txn.id,
        txnDate: txn.txn_date,
        amountMinor: txn.amount_minor,
        description: txn.description,
        status: txn.status,
      },
      currencyCode: account.currency_code,
      windowDays: data.windowDays,
      maxLines: MAX_MATCH_LINES,
      candidates: ranked as MatchCandidateRow[],
      otherStatementLines: (others ?? []) as unknown as Array<{
        id: string;
        txn_date: string;
        amount_minor: number;
        description: string | null;
      }>,
    };
  });

/** One statement line ↔ one or several existing bank-ledger lines that add up exactly (RPC validates again). */
export const matchBankTransaction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; bankTransactionId: string; journalLineIds: string[] }) => {
    const ids = [...new Set((input.journalLineIds ?? []).map((id) => assertUuid(id, "Journal line")))];
    if (ids.length === 0) throw new Error("Select at least one ledger line");
    if (ids.length > MAX_MATCH_LINES) throw new Error(`Select at most ${MAX_MATCH_LINES} ledger lines`);
    return {
      companyId: assertUuid(input.companyId),
      bankTransactionId: assertUuid(input.bankTransactionId),
      journalLineIds: ids,
    };
  })
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyMember(supabase, data.companyId);
    const r = await callRpc<RpcMatchResult>(supabase, "match_bank_transaction", {
      _company_id: data.companyId,
      _bank_transaction_id: data.bankTransactionId,
      _journal_line_ids: data.journalLineIds,
    });
    return { linked: r?.linked ?? data.journalLineIds.length };
  });

/** Several statement lines ↔ one ledger line (e.g. a bank deposit made of several receipts). */
export const matchStatementLinesToJournalLine = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; bankTransactionIds: string[]; journalLineId: string }) => {
    const ids = [...new Set((input.bankTransactionIds ?? []).map((id) => assertUuid(id, "Transaction")))];
    if (ids.length === 0) throw new Error("Select at least one statement line");
    if (ids.length > MAX_MATCH_LINES) throw new Error(`Select at most ${MAX_MATCH_LINES} statement lines`);
    return {
      companyId: assertUuid(input.companyId),
      bankTransactionIds: ids,
      journalLineId: assertUuid(input.journalLineId, "Journal line"),
    };
  })
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyMember(supabase, data.companyId);
    const r = await callRpc<RpcMatchResult>(supabase, "match_bank_transactions_to_journal_line", {
      _company_id: data.companyId,
      _bank_transaction_ids: data.bankTransactionIds,
      _journal_line_id: data.journalLineId,
    });
    return { linked: r?.linked ?? data.bankTransactionIds.length };
  });
