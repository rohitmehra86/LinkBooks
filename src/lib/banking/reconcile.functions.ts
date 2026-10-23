import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { chunk, fetchAllPages } from "@/lib/banking/fetch-all";
import { callRpc, isMissingSchema } from "@/lib/banking/rpc";
import {
  bankReconciliationReport,
  buildStatementGroups,
  proposeOpeningBalance,
} from "@/lib/banking/recon-math";
import {
  ledgerBalanceAsOf,
  linkedLineIds,
  loadBankAccount,
  type AnyClient,
} from "@/lib/banking/server-helpers";

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

const LEDGER_ITEM_CAP = 2000;

type LedgerRow = {
  id: string;
  description: string | null;
  debit_minor: number;
  credit_minor: number;
  journals: {
    journal_number: number;
    journal_date: string;
    status: string;
    source_type: string;
    memo: string | null;
    reversed_by_journal_id: string | null;
    reverses_journal_id: string | null;
  };
};

export type LedgerItem = {
  lineId: string;
  date: string;
  journalNumber: number;
  source: string;
  description: string;
  amountMinor: number;
};

function toItem(row: LedgerRow): LedgerItem {
  return {
    lineId: row.id,
    date: row.journals.journal_date,
    journalNumber: row.journals.journal_number,
    source: row.journals.source_type,
    description: row.description ?? row.journals.memo ?? "",
    amountMinor: row.debit_minor - row.credit_minor,
  };
}

/**
 * Every posted line on the bank GL up to `asOf`, paged past the 1000-row PostgREST cap.
 * A journal and its reversal (when both fall on/before asOf) net to zero and never reach the bank,
 * so both are left out of the reconciliation lists.
 */
async function loadLedgerLines(
  supabase: AnyClient,
  companyId: string,
  glAccountId: string,
  asOf: string,
): Promise<LedgerRow[]> {
  const rows = await fetchAllPages<LedgerRow>((a, b) =>
    supabase
      .from("journal_lines" as never)
      .select(
        "id, description, debit_minor, credit_minor, journals!inner(journal_number, journal_date, status, source_type, memo, reversed_by_journal_id, reverses_journal_id)" as never,
      )
      .eq("company_id" as never, companyId as never)
      .eq("account_id" as never, glAccountId as never)
      .eq("journals.status" as never, "posted" as never)
      .lte("journals.journal_date" as never, asOf as never)
      .order("id" as never)
      .range(a, b) as never,
  );

  const relatedIds = new Set<string>();
  for (const r of rows) {
    if (r.journals.reversed_by_journal_id) relatedIds.add(r.journals.reversed_by_journal_id);
    if (r.journals.reverses_journal_id) relatedIds.add(r.journals.reverses_journal_id);
  }
  const relatedDate = new Map<string, string>();
  for (const part of chunk([...relatedIds], 150)) {
    const { data, error } = await supabase
      .from("journals" as never)
      .select("id, journal_date, status" as never)
      .in("id" as never, part as never);
    if (error) throw new Error(error.message);
    for (const j of (data ?? []) as unknown as Array<{ id: string; journal_date: string; status: string }>) {
      if (j.status === "posted") relatedDate.set(j.id, j.journal_date);
    }
  }
  return rows.filter((r) => {
    const partner = r.journals.reversed_by_journal_id ?? r.journals.reverses_journal_id;
    if (!partner) return true;
    const partnerDate = relatedDate.get(partner);
    return !(partnerDate && partnerDate <= asOf);
  });
}

type SessionRow = {
  id: string;
  bank_account_id: string;
  statement_date: string;
  statement_balance_minor: number;
  reconciled_balance_minor: number | null;
  opening_balance_minor: number | null;
  cleared_total_minor: number | null;
  status: string;
  completed_at: string | null;
  notes: string | null;
  created_at: string;
  void_reason: string | null;
};

const SESSION_COLUMNS_NEW =
  "id, bank_account_id, statement_date, statement_balance_minor, reconciled_balance_minor, opening_balance_minor, cleared_total_minor, status, completed_at, notes, created_at, void_reason";
const SESSION_COLUMNS_OLD =
  "id, bank_account_id, statement_date, statement_balance_minor, reconciled_balance_minor, status, completed_at, notes, created_at";

async function selectSessions(
  supabase: AnyClient,
  companyId: string,
  bankAccountId: string | null,
  limit: number,
): Promise<SessionRow[]> {
  const run = async (columns: string) => {
    let q = supabase
      .from("reconciliation_sessions" as never)
      .select(columns as never)
      .eq("company_id" as never, companyId as never)
      .order("statement_date" as never, { ascending: false })
      .order("created_at" as never, { ascending: false })
      .limit(limit);
    if (bankAccountId) q = q.eq("bank_account_id" as never, bankAccountId as never);
    return q;
  };
  let res = await run(SESSION_COLUMNS_NEW);
  if (res.error && isMissingSchema(res.error)) res = await run(SESSION_COLUMNS_OLD);
  if (res.error) throw new Error(res.error.message);
  return ((res.data ?? []) as unknown as Array<Partial<SessionRow>>).map((s) => ({
    opening_balance_minor: null,
    cleared_total_minor: null,
    void_reason: null,
    ...s,
  })) as SessionRow[];
}

export const listReconciliationSessions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; bankAccountId?: string }) => ({
    companyId: assertUuid(input.companyId),
    bankAccountId: input.bankAccountId ? assertUuid(input.bankAccountId) : null,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    return selectSessions(context.supabase as AnyClient, data.companyId, data.bankAccountId, 50);
  });

/** IDs of journal lines already cleared by completed sessions of this bank account (optionally up to a session). */
async function clearedLineIds(
  supabase: AnyClient,
  companyId: string,
  sessions: readonly SessionRow[],
): Promise<Set<string>> {
  const out = new Set<string>();
  const ids = sessions.filter((s) => s.status === "completed").map((s) => s.id);
  for (const part of chunk(ids, 50)) {
    const rows = await fetchAllPages<{ journal_line_id: string | null }>((a, b) =>
      supabase
        .from("reconciliation_session_lines" as never)
        .select("id, journal_line_id" as never)
        .eq("company_id" as never, companyId as never)
        .in("session_id" as never, part as never)
        .not("journal_line_id" as never, "is" as never, null as never)
        .order("id" as never)
        .range(a, b) as never,
    ).catch((e: Error) => {
      // Table not installed yet → nothing has ever been cleared through the new flow.
      if (/reconciliation_session_lines|schema cache|does not exist/i.test(e.message)) return [];
      throw e;
    });
    for (const r of rows) if (r.journal_line_id) out.add(r.journal_line_id);
  }
  return out;
}

/**
 * Reconciliation workspace (superset of the previous version).
 * - ledger balance via SQL SUM (no 1000-row cap)
 * - matched statement lines grouped with their ledger lines (tick a group to clear it)
 * - bank-ledger lines with no statement line ("ledger only") that can be ticked or left outstanding
 * - opening balance proposal from the last completed session
 */
export const getReconciliationWorkspace = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; bankAccountId: string; statementDate: string }) => {
    if (!isIsoDate(input.statementDate)) throw new Error("Statement date must be YYYY-MM-DD");
    return {
      companyId: assertUuid(input.companyId),
      bankAccountId: assertUuid(input.bankAccountId),
      statementDate: input.statementDate,
    };
  })
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyPermission(supabase, data.companyId, "banking.reconcile");
    const account = await loadBankAccount(supabase, data.companyId, data.bankAccountId);
    const glId = account.gl_account_id;

    const [ledgerBalance, ledgerRows, sessions] = await Promise.all([
      ledgerBalanceAsOf(supabase, data.companyId, glId, data.statementDate),
      loadLedgerLines(supabase, data.companyId, glId, data.statementDate),
      selectSessions(supabase, data.companyId, data.bankAccountId, 200),
    ]);

    const cleared = await clearedLineIds(supabase, data.companyId, sessions);
    const linked = await linkedLineIds(
      supabase,
      data.companyId,
      ledgerRows.map((r) => r.id),
    );
    const ledgerOnlyAll = ledgerRows
      .filter((r) => !linked.has(r.id) && !cleared.has(r.id))
      .map(toItem)
      .sort((a, b) => (a.date === b.date ? a.journalNumber - b.journalNumber : a.date < b.date ? -1 : 1));
    const ledgerOnlyTotal = ledgerOnlyAll.reduce((acc, i) => acc + BigInt(i.amountMinor), 0n);

    // Matched statement lines (not yet reconciled) on or before the statement date.
    type Txn = { id: string; txn_date: string; amount_minor: number; description: string | null };
    const matched = await fetchAllPages<Txn>((a, b) =>
      supabase
        .from("bank_transactions" as never)
        .select("id, txn_date, amount_minor, description" as never)
        .eq("company_id" as never, data.companyId as never)
        .eq("bank_account_id" as never, data.bankAccountId as never)
        .eq("status" as never, "matched" as never)
        .lte("txn_date" as never, data.statementDate as never)
        .order("txn_date" as never)
        .order("id" as never)
        .range(a, b) as never,
    );

    const links: Array<{ bankTransactionId: string; journalLineId: string }> = [];
    for (const part of chunk(
      matched.map((t) => t.id),
      150,
    )) {
      const { data: rows, error } = await supabase
        .from("reconciliation_links" as never)
        .select("bank_transaction_id, journal_line_id" as never)
        .eq("company_id" as never, data.companyId as never)
        .in("bank_transaction_id" as never, part as never);
      if (error) throw new Error(error.message);
      for (const r of (rows ?? []) as unknown as Array<{ bank_transaction_id: string; journal_line_id: string }>) {
        links.push({ bankTransactionId: r.bank_transaction_id, journalLineId: r.journal_line_id });
      }
    }

    const itemByLine = new Map<string, LedgerItem>();
    for (const r of ledgerRows) itemByLine.set(r.id, toItem(r));
    const missingLines = [...new Set(links.map((l) => l.journalLineId))].filter((id) => !itemByLine.has(id));
    for (const part of chunk(missingLines, 150)) {
      const { data: rows, error } = await supabase
        .from("journal_lines" as never)
        .select(
          "id, description, debit_minor, credit_minor, journals!inner(journal_number, journal_date, status, source_type, memo, reversed_by_journal_id, reverses_journal_id)" as never,
        )
        .in("id" as never, part as never);
      if (error) throw new Error(error.message);
      for (const r of (rows ?? []) as unknown as LedgerRow[]) itemByLine.set(r.id, toItem(r));
    }

    const ledgerAmounts = new Map<string, number>();
    for (const [id, item] of itemByLine) ledgerAmounts.set(id, item.amountMinor);
    const groups = buildStatementGroups(
      matched.map((t) => ({ id: t.id, amountMinor: t.amount_minor })),
      links,
      ledgerAmounts,
    );
    const txnById = new Map(matched.map((t) => [t.id, t]));

    const { data: uncat, error: uErr } = await supabase
      .from("bank_transactions" as never)
      .select("id, txn_date, amount_minor, description" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("bank_account_id" as never, data.bankAccountId as never)
      .eq("status" as never, "uncategorised" as never)
      .lte("txn_date" as never, data.statementDate as never)
      .order("txn_date" as never, { ascending: false })
      .limit(50);
    if (uErr) throw new Error(uErr.message);
    const { count: uncatCount } = await supabase
      .from("bank_transactions" as never)
      .select("id" as never, { count: "exact", head: true })
      .eq("company_id" as never, data.companyId as never)
      .eq("bank_account_id" as never, data.bankAccountId as never)
      .eq("status" as never, "uncategorised" as never)
      .lte("txn_date" as never, data.statementDate as never);

    const lastCompleted = sessions.find((s) => s.status === "completed") ?? null;
    const proposal = proposeOpeningBalance(sessions);

    return {
      bankAccountName: account.name,
      currencyCode: account.currency_code,
      ledgerBalanceMinor: Number(ledgerBalance),
      openingProposalMinor: proposal === null ? null : Number(proposal),
      lastSession: lastCompleted
        ? {
            id: lastCompleted.id,
            statementDate: lastCompleted.statement_date,
            statementBalanceMinor: lastCompleted.statement_balance_minor,
          }
        : null,
      groups: groups.map((g) => ({
        key: g.key,
        inconsistent: g.inconsistent,
        statementTotalMinor: Number(g.statementTotal),
        ledgerTotalMinor: Number(g.ledgerTotal),
        transactions: g.bankTransactionIds.map((id) => {
          const t = txnById.get(id)!;
          return { id, date: t.txn_date, amountMinor: t.amount_minor, description: t.description };
        }),
        ledgerLines: g.journalLineIds.map((id) => itemByLine.get(id)).filter((x): x is LedgerItem => Boolean(x)),
      })),
      ledgerOnly: ledgerOnlyAll.slice(0, LEDGER_ITEM_CAP),
      ledgerOnlyTruncated: ledgerOnlyAll.length > LEDGER_ITEM_CAP,
      // Previous shape, kept for existing callers
      unmatchedLedgerTotalMinor: Number(ledgerOnlyTotal),
      unmatchedLedgerLines: [...ledgerOnlyAll].reverse().slice(0, 100),
      unmatchedLedgerCount: ledgerOnlyAll.length,
      uncategorised: (uncat ?? []) as unknown as Array<{
        id: string;
        txn_date: string;
        amount_minor: number;
        description: string | null;
      }>,
      uncategorisedCount: uncatCount ?? 0,
    };
  });

/**
 * Complete a reconciliation from ticked items. The database re-checks the arithmetic
 * (opening + ticked = statement closing, difference exactly 0) inside one transaction.
 */
export const completeReconciliation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      bankAccountId: string;
      statementDate: string;
      statementBalanceMinor: number;
      openingBalanceMinor: number;
      bankTransactionIds: string[];
      journalLineIds: string[];
      notes?: string;
    }) => {
      if (!isIsoDate(input.statementDate)) throw new Error("Statement date must be YYYY-MM-DD");
      const closing = Math.round(Number(input.statementBalanceMinor));
      const opening = Math.round(Number(input.openingBalanceMinor));
      if (!Number.isSafeInteger(closing) || !Number.isSafeInteger(opening)) {
        throw new Error("Balances must be valid amounts");
      }
      const txIds = [...new Set((input.bankTransactionIds ?? []).map((id) => assertUuid(id, "Transaction")))];
      const lineIds = [...new Set((input.journalLineIds ?? []).map((id) => assertUuid(id, "Journal line")))];
      if (txIds.length + lineIds.length === 0) throw new Error("Tick at least one item");
      if (txIds.length > 5000 || lineIds.length > 5000) throw new Error("Too many ticked items in one session");
      return {
        companyId: assertUuid(input.companyId),
        bankAccountId: assertUuid(input.bankAccountId),
        statementDate: input.statementDate,
        statementBalanceMinor: closing,
        openingBalanceMinor: opening,
        bankTransactionIds: txIds,
        journalLineIds: lineIds,
        notes: (input.notes ?? "").trim().slice(0, 500) || null,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyPermission(supabase, data.companyId, "banking.reconcile");
    const r = await callRpc<{ session_id: string; cleared_total_minor: number; ledger_balance_minor: number }>(
      supabase,
      "complete_reconciliation_session",
      {
        _company_id: data.companyId,
        _bank_account_id: data.bankAccountId,
        _statement_date: data.statementDate,
        _statement_balance_minor: data.statementBalanceMinor,
        _opening_balance_minor: data.openingBalanceMinor,
        _bank_transaction_ids: data.bankTransactionIds,
        _journal_line_ids: data.journalLineIds,
        _notes: data.notes,
      },
    );
    return {
      sessionId: r.session_id,
      clearedTotalMinor: Number(r.cleared_total_minor),
      ledgerBalanceMinor: Number(r.ledger_balance_minor),
    };
  });

/** Reopen (void) the latest completed reconciliation: ticked statement lines return to "matched". */
export const voidReconciliationSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; sessionId: string; reason?: string }) => ({
    companyId: assertUuid(input.companyId),
    sessionId: assertUuid(input.sessionId),
    reason: (input.reason ?? "").trim().slice(0, 500) || null,
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyPermission(supabase, data.companyId, "banking.reconcile");
    const r = await callRpc<{ statement_lines_reopened: number }>(supabase, "void_reconciliation_session", {
      _company_id: data.companyId,
      _session_id: data.sessionId,
      _reason: data.reason,
    });
    return { statementLinesReopened: r?.statement_lines_reopened ?? 0 };
  });

/**
 * Bank Reconciliation Report for a completed session: statement balance, outstanding items, book balance.
 * Outstanding = bank-ledger items on/before the statement date not cleared by this or an earlier completed session.
 */
export const getBankReconciliationReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; sessionId: string }) => ({
    companyId: assertUuid(input.companyId),
    sessionId: assertUuid(input.sessionId),
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyMember(supabase, data.companyId);

    const all = await selectSessions(supabase, data.companyId, null, 500);
    const session = all.find((s) => s.id === data.sessionId);
    if (!session) throw new Error("Reconciliation session not found");
    if (session.status !== "completed") {
      throw new Error("The report is available for completed reconciliations only");
    }
    const account = await loadBankAccount(supabase, data.companyId, session.bank_account_id);

    const upTo = all.filter(
      (s) =>
        s.bank_account_id === session.bank_account_id &&
        s.status === "completed" &&
        (s.statement_date < session.statement_date ||
          (s.statement_date === session.statement_date && s.created_at <= session.created_at)),
    );
    const { count: ownLines } = await supabase
      .from("reconciliation_session_lines" as never)
      .select("id" as never, { count: "exact", head: true })
      .eq("session_id" as never, session.id as never);
    const legacyNoLines = (ownLines ?? 0) === 0;

    const cleared = await clearedLineIds(supabase, data.companyId, upTo);
    const ledgerRows = await loadLedgerLines(
      supabase,
      data.companyId,
      account.gl_account_id,
      session.statement_date,
    );
    const outstanding = legacyNoLines
      ? []
      : ledgerRows
          .filter((r) => !cleared.has(r.id))
          .map(toItem)
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.journalNumber - b.journalNumber));
    const book = await ledgerBalanceAsOf(supabase, data.companyId, account.gl_account_id, session.statement_date);
    const report = bankReconciliationReport({
      statementBalanceMinor: session.statement_balance_minor,
      outstandingMinor: outstanding,
      bookBalanceMinor: book,
    });

    return {
      session: {
        id: session.id,
        statementDate: session.statement_date,
        statementBalanceMinor: session.statement_balance_minor,
        openingBalanceMinor: session.opening_balance_minor,
        clearedTotalMinor: session.cleared_total_minor,
        completedAt: session.completed_at,
        notes: session.notes,
      },
      bankAccount: { id: account.id, name: account.name, currencyCode: account.currency_code },
      legacyNoLines,
      outstanding: outstanding.filter((o) => o.amountMinor >= 0),
      outstandingPaymentsList: outstanding.filter((o) => o.amountMinor < 0),
      totals: {
        statementBalance: Number(report.statementBalance),
        outstandingReceipts: Number(report.outstandingReceipts),
        outstandingPayments: Number(report.outstandingPayments),
        expectedBookBalance: Number(report.expectedBookBalance),
        bookBalance: Number(report.bookBalance),
        unexplainedDifference: Number(report.unexplainedDifference),
      },
    };
  });
