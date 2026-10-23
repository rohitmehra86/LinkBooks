/**
 * Server-only helpers shared by the banking server functions (not exported as server functions).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllPages, chunk } from "@/lib/banking/fetch-all";
import { codingIdempotencyKey } from "@/lib/banking/coding";
import { isMissingRpc, tryRpc } from "@/lib/banking/rpc";
import { directionFromAmount, normalizePayee } from "@/lib/banking/suggestions";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyClient = SupabaseClient<any>;

export type BankTxnRow = {
  id: string;
  bank_account_id: string;
  txn_date: string;
  amount_minor: number;
  description: string | null;
  status: string;
};

export type BankAccountRow = {
  id: string;
  name: string;
  currency_code: string;
  gl_account_id: string;
  is_active: boolean;
};

export async function loadBankAccount(
  supabase: AnyClient,
  companyId: string,
  bankAccountId: string,
): Promise<BankAccountRow> {
  const { data, error } = await supabase
    .from("bank_accounts" as never)
    .select("id, name, currency_code, gl_account_id, is_active" as never)
    .eq("id" as never, bankAccountId as never)
    .eq("company_id" as never, companyId as never)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Bank account not found");
  return data as unknown as BankAccountRow;
}

export async function loadBankTxn(
  supabase: AnyClient,
  companyId: string,
  bankTransactionId: string,
): Promise<BankTxnRow> {
  const { data, error } = await supabase
    .from("bank_transactions" as never)
    .select("id, bank_account_id, txn_date, amount_minor, description, status" as never)
    .eq("id" as never, bankTransactionId as never)
    .eq("company_id" as never, companyId as never)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Transaction not found");
  return data as unknown as BankTxnRow;
}

/** Number of already-reversed bank-originated journals for a statement line → idempotency key generation. */
export async function reversedCodingCount(
  supabase: AnyClient,
  companyId: string,
  bankTransactionId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("journals" as never)
    .select("id" as never, { count: "exact", head: true })
    .eq("company_id" as never, companyId as never)
    .eq("source_type" as never, "bank_transaction" as never)
    .eq("source_id" as never, bankTransactionId as never)
    .not("reversed_by_journal_id" as never, "is" as never, null as never);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function nextCodingKey(
  supabase: AnyClient,
  companyId: string,
  bankTransactionId: string,
): Promise<string> {
  return codingIdempotencyKey(
    bankTransactionId,
    await reversedCodingCount(supabase, companyId, bankTransactionId),
  );
}

/**
 * Link the bank-GL line of a freshly posted journal to the statement line and mark it matched.
 * Idempotent: re-running after a partial failure (journal posted, link missing) completes the job.
 */
export async function linkPostedJournalToBankTxn(
  supabase: AnyClient,
  args: {
    companyId: string;
    bankTransactionId: string;
    journalId: string;
    bankGlAccountId: string;
    extraTxnUpdate?: Record<string, unknown>;
  },
): Promise<{ linkId: string | null }> {
  const { data: lines, error: lErr } = await supabase
    .from("journal_lines" as never)
    .select("id" as never)
    .eq("journal_id" as never, args.journalId as never)
    .eq("account_id" as never, args.bankGlAccountId as never);
  if (lErr) throw new Error(lErr.message);
  const bankLines = (lines ?? []) as unknown as Array<{ id: string }>;
  if (bankLines.length !== 1) throw new Error("Posted journal must have exactly one bank ledger line");
  const lineId = bankLines[0]!.id;

  const { data: existing } = await supabase
    .from("reconciliation_links" as never)
    .select("id" as never)
    .eq("bank_transaction_id" as never, args.bankTransactionId as never)
    .eq("journal_line_id" as never, lineId as never)
    .maybeSingle();
  let linkId = (existing as { id: string } | null)?.id ?? null;
  if (!linkId) {
    const { data: link, error } = await supabase
      .from("reconciliation_links" as never)
      .insert({
        company_id: args.companyId,
        bank_transaction_id: args.bankTransactionId,
        journal_line_id: lineId,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    linkId = (link as { id: string }).id;
  }

  const { error: uErr } = await supabase
    .from("bank_transactions" as never)
    .update({ status: "matched", ...(args.extraTxnUpdate ?? {}) } as never)
    .eq("id" as never, args.bankTransactionId as never)
    .eq("company_id" as never, args.companyId as never);
  if (uErr) throw new Error(uErr.message);
  return { linkId };
}

/** times_used + 1 (BK-15). Falls back to read-modify-write only when the RPC is not installed yet. */
export async function bumpCodingHistory(
  supabase: AnyClient,
  args: {
    companyId: string;
    description: string | null;
    amountMinor: number;
    offsetAccountId: string;
  },
): Promise<void> {
  const payee = normalizePayee(args.description);
  if (!payee) return;
  const direction = directionFromAmount(args.amountMinor);
  const res = await tryRpc<null>(supabase, "bump_bank_coding_history", {
    _company_id: args.companyId,
    _payee_normalized: payee,
    _description_sample: args.description,
    _offset_account_id: args.offsetAccountId,
    _direction: direction,
  });
  if (res.available) return;

  const { data: existing } = await supabase
    .from("bank_coding_history" as never)
    .select("id, times_used" as never)
    .eq("company_id" as never, args.companyId as never)
    .eq("payee_normalized" as never, payee as never)
    .eq("offset_account_id" as never, args.offsetAccountId as never)
    .eq("direction" as never, direction as never)
    .maybeSingle();
  if (existing) {
    await supabase
      .from("bank_coding_history" as never)
      .update({
        times_used: ((existing as unknown as { times_used: number }).times_used ?? 0) + 1,
        last_used_at: new Date().toISOString(),
        description_sample: args.description,
      } as never)
      .eq("id" as never, (existing as unknown as { id: string }).id as never);
  } else {
    await supabase.from("bank_coding_history" as never).insert({
      company_id: args.companyId,
      payee_normalized: payee,
      description_sample: args.description,
      offset_account_id: args.offsetAccountId,
      direction,
      times_used: 1,
    } as never);
  }
}

/** Ledger balance of an account as of a date: SQL SUM() RPC, with a paged fallback (BK-04). */
export async function ledgerBalanceAsOf(
  supabase: AnyClient,
  companyId: string,
  accountId: string,
  asOf: string,
): Promise<bigint> {
  const { data, error } = await supabase.rpc("account_balance_as_of" as never, {
    _company_id: companyId,
    _account_id: accountId,
    _as_of: asOf,
  } as never);
  if (!error && data !== null && data !== undefined) return BigInt(data as number | string);
  if (error && !isMissingRpc(error)) throw new Error(error.message);

  const rows = await fetchAllPages<{ debit_minor: number; credit_minor: number }>((from, to) =>
    supabase
      .from("journal_lines" as never)
      .select("id, debit_minor, credit_minor, journals!inner(journal_date, status)" as never)
      .eq("company_id" as never, companyId as never)
      .eq("account_id" as never, accountId as never)
      .eq("journals.status" as never, "posted" as never)
      .lte("journals.journal_date" as never, asOf as never)
      .order("id" as never)
      .range(from, to) as never,
  );
  let total = 0n;
  for (const r of rows) total += BigInt(r.debit_minor) - BigInt(r.credit_minor);
  return total;
}

/** Set of journal_line ids (from `ids`) that already have a reconciliation link. */
export async function linkedLineIds(
  supabase: AnyClient,
  companyId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunk(ids, 150)) {
    const { data, error } = await supabase
      .from("reconciliation_links" as never)
      .select("journal_line_id" as never)
      .eq("company_id" as never, companyId as never)
      .in("journal_line_id" as never, part as never);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as unknown as Array<{ journal_line_id: string }>) out.add(r.journal_line_id);
  }
  return out;
}
