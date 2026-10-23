import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { assertLinesBalance, type JournalLineDraft } from "@/lib/accounting/money";

type AuthedClient = SupabaseClient<Database>;

/** Must match the Postgres enum `journal_source_type`. A value outside this list fails at post time. */
export const JOURNAL_SOURCE_TYPES = [
  "manual",
  "opening_balance",
  "sales_invoice",
  "sales_credit_note",
  "customer_payment",
  "purchase_bill",
  "purchase_credit_note",
  "supplier_payment",
  "expense",
  "bank_transaction",
  "bank_transfer",
  "tax_adjustment",
  "reversal",
  "other",
  "fx_revaluation",
] as const;
export type JournalSourceType = (typeof JOURNAL_SOURCE_TYPES)[number];

export type PostJournalInput = {
  company_id: string;
  journal_date: string; // YYYY-MM-DD
  memo?: string;
  currency_code?: string;
  fx_rate_to_base?: number;
  source_type?: JournalSourceType;
  source_id?: string;
  idempotency_key?: string;
  reverses_journal_id?: string;
  lines: JournalLineDraft[];
};

/**
 * Single reusable posting service for all modules.
 * Validates locally then posts via atomic Postgres RPC `post_journal`
 * (balance, period lock, permissions, idempotency enforced in DB).
 */
export async function postJournal(
  supabase: AuthedClient,
  input: PostJournalInput,
): Promise<{ journalId: string }> {
  if (!input.company_id) throw new Error("company_id is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.journal_date)) {
    throw new Error("journal_date must be YYYY-MM-DD");
  }
  assertLinesBalance(input.lines);

  const payload = {
    company_id: input.company_id,
    journal_date: input.journal_date,
    memo: input.memo ?? null,
    currency_code: input.currency_code ?? null,
    fx_rate_to_base: input.fx_rate_to_base ?? 1,
    source_type: input.source_type ?? "manual",
    source_id: input.source_id ?? null,
    idempotency_key: input.idempotency_key ?? null,
    reverses_journal_id: input.reverses_journal_id ?? null,
    lines: input.lines.map((l) => ({
      account_id: l.account_id,
      description: l.description ?? null,
      debit_minor: Number(typeof l.debit_minor === "bigint" ? l.debit_minor : BigInt(l.debit_minor)),
      credit_minor: Number(
        typeof l.credit_minor === "bigint" ? l.credit_minor : BigInt(l.credit_minor),
      ),
    })),
  };

  // JSON numbers are fine for minor units within Number.MAX_SAFE_INTEGER (≈ 90 trillion currency units).
  for (const line of payload.lines) {
    if (!Number.isSafeInteger(line.debit_minor) || !Number.isSafeInteger(line.credit_minor)) {
      throw new Error("Amount exceeds safe integer range for JSON transport");
    }
  }

  const { data, error } = await supabase.rpc("post_journal" as never, {
    payload,
  } as never);
  if (error) throw new Error(error.message);
  if (!data || typeof data !== "string") throw new Error("Posting failed: no journal id returned");
  return { journalId: data };
}

export async function reverseJournal(
  supabase: AuthedClient,
  journalId: string,
  idempotencyKey?: string,
): Promise<{ journalId: string }> {
  const { data, error } = await supabase.rpc("reverse_journal" as never, {
    _journal_id: journalId,
    _idempotency_key: idempotencyKey ?? null,
  } as never);
  if (error) throw new Error(error.message);
  if (!data || typeof data !== "string") throw new Error("Reversal failed: no journal id returned");
  return { journalId: data };
}

/**
 * Categorise a bank transaction by posting one balanced journal and linking
 * the bank-side journal line — does not create a second financial movement.
 */
export async function categoriseBankTransaction(
  supabase: AuthedClient,
  args: {
    company_id: string;
    bank_transaction_id: string;
    bank_gl_account_id: string;
    offset_account_id: string;
    journal_date: string;
    amount_minor: bigint | number;
    description?: string;
    idempotency_key: string;
  },
): Promise<{ journalId: string; linkId: string }> {
  const amount =
    typeof args.amount_minor === "number" ? BigInt(args.amount_minor) : args.amount_minor;
  if (amount === 0n) throw new Error("Bank amount cannot be zero");

  // Positive amount = money in (DR bank, CR offset); negative = money out (DR offset, CR bank)
  const abs = amount < 0n ? -amount : amount;
  const bankIsDebit = amount > 0n;

  const { journalId } = await postJournal(supabase, {
    company_id: args.company_id,
    journal_date: args.journal_date,
    memo: args.description ?? "Bank categorisation",
    source_type: "bank_transaction",
    source_id: args.bank_transaction_id,
    idempotency_key: args.idempotency_key,
    lines: bankIsDebit
      ? [
          {
            account_id: args.bank_gl_account_id,
            debit_minor: abs,
            credit_minor: 0n,
            ...(args.description ? { description: args.description } : {}),
          },
          {
            account_id: args.offset_account_id,
            debit_minor: 0n,
            credit_minor: abs,
            ...(args.description ? { description: args.description } : {}),
          },
        ]
      : [
          {
            account_id: args.offset_account_id,
            debit_minor: abs,
            credit_minor: 0n,
            ...(args.description ? { description: args.description } : {}),
          },
          {
            account_id: args.bank_gl_account_id,
            debit_minor: 0n,
            credit_minor: abs,
            ...(args.description ? { description: args.description } : {}),
          },
        ],
  });

  const { data: bankLine, error: lineErr } = await supabase
    .from("journal_lines" as never)
    .select("id")
    .eq("journal_id" as never, journalId as never)
    .eq("account_id" as never, args.bank_gl_account_id as never)
    .maybeSingle();
  if (lineErr) throw new Error(lineErr.message);
  const journalLineId = (bankLine as { id?: string } | null)?.id;
  if (!journalLineId) throw new Error("Posted journal missing bank GL line");

  const { data: link, error: linkErr } = await supabase
    .from("reconciliation_links" as never)
    .insert({
      company_id: args.company_id,
      bank_transaction_id: args.bank_transaction_id,
      journal_line_id: journalLineId,
    } as never)
    .select("id")
    .single();
  if (linkErr) throw new Error(linkErr.message);

  await supabase
    .from("bank_transactions" as never)
    .update({ status: "matched" } as never)
    .eq("id" as never, args.bank_transaction_id as never);

  return { journalId, linkId: (link as { id: string }).id };
}
