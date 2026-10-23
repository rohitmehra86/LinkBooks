/**
 * Server-only: post the journal for one bank statement line (BK-06 / BK-14) through the posting engine.
 * Imported by `*.functions.ts` handlers only.
 */
import { postJournal } from "@/lib/accounting/posting-engine";
import { resolveInputTaxAccount, resolveOutputTaxAccount } from "@/lib/tax/tax-accounts";
import { isRateEffective, type TaxTreatment } from "@/lib/tax/tax-math";
import {
  CodingPlanError,
  planBankCoding,
  type CodingSplit,
  type CodingTaxCode,
} from "@/lib/banking/coding";
import { chunk } from "@/lib/banking/fetch-all";
import { isMissingSchema, recordAudit } from "@/lib/banking/rpc";
import {
  bumpCodingHistory,
  linkPostedJournalToBankTxn,
  loadBankAccount,
  loadBankTxn,
  nextCodingKey,
  type AnyClient,
} from "@/lib/banking/server-helpers";

export type CodeSplitInput = {
  accountId: string;
  amountMinor: number;
  description?: string | null;
  taxCodeId?: string | null;
};

export type CodeBankTxnArgs = {
  companyId: string;
  bankTransactionId: string;
  splits: readonly CodeSplitInput[];
  treatment: TaxTreatment;
  contactId?: string | null;
  reference?: string | null;
  memo?: string | null;
};

/** Accounts a bank line may be coded to: active, postable, not archived, NOT a control account, not the bank GL itself. */
export async function assertCodableAccounts(
  supabase: AnyClient,
  companyId: string,
  accountIds: readonly string[],
  bankGlAccountId: string,
): Promise<void> {
  const unique = [...new Set(accountIds)];
  for (const part of chunk(unique, 100)) {
    const { data, error } = await supabase
      .from("accounts" as never)
      .select("id, code, name, is_active, is_postable, is_control, archived_at" as never)
      .eq("company_id" as never, companyId as never)
      .in("id" as never, part as never);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as Array<{
      id: string;
      code: string;
      name: string;
      is_active: boolean;
      is_postable: boolean;
      is_control: boolean | null;
      archived_at: string | null;
    }>;
    for (const id of part) {
      const a = rows.find((r) => r.id === id);
      if (!a) throw new Error("Account not found in this organisation");
      const label = `${a.code} ${a.name}`;
      if (!a.is_active || a.archived_at) throw new Error(`Account ${label} is inactive`);
      if (!a.is_postable) throw new Error(`Account ${label} is not postable`);
      if (a.is_control) {
        throw new Error(
          `Account ${label} is a control account (receivables/payables/tax) and cannot be used for bank coding`,
        );
      }
      if (id === bankGlAccountId)
        throw new Error("Choose an account other than the bank account itself (use a transfer)");
    }
  }
}

type TaxCodeRow = {
  id: string;
  code: string;
  is_active: boolean;
  is_recoverable: boolean;
  applies_to: string;
  treatment: string | null;
  tax_account_id: string | null;
  tax_rates: {
    rate_bps: number;
    effective_from: string;
    effective_to: string | null;
    is_active: boolean;
    treatment: string | null;
  } | null;
};

export async function loadCodingTaxCodes(
  supabase: AnyClient,
  companyId: string,
  taxCodeIds: readonly string[],
  txnDate: string,
  direction: "in" | "out",
): Promise<Map<string, CodingTaxCode>> {
  const out = new Map<string, CodingTaxCode>();
  const unique = [...new Set(taxCodeIds)];
  if (unique.length === 0) return out;
  const { data, error } = await supabase
    .from("tax_codes" as never)
    .select(
      "id, code, is_active, is_recoverable, applies_to, treatment, tax_account_id, tax_rates!inner(rate_bps, effective_from, effective_to, is_active, treatment)" as never,
    )
    .eq("company_id" as never, companyId as never)
    .in("id" as never, unique as never);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as TaxCodeRow[];
  for (const id of unique) {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new Error("Tax code not found in this organisation");
    if (!row.is_active) throw new Error(`Tax code ${row.code} is inactive`);
    const allowed = direction === "in" ? ["sales", "both"] : ["purchases", "both"];
    if (!allowed.includes(row.applies_to)) {
      throw new Error(
        `Tax code ${row.code} applies to ${row.applies_to}, not to money ${direction === "in" ? "received" : "spent"}`,
      );
    }
    const rate = row.tax_rates;
    if (!rate || !isRateEffective(rate, txnDate)) {
      throw new Error(`Tax code ${row.code} has no effective rate on ${txnDate}`);
    }
    out.set(id, {
      id,
      code: row.code,
      rateBps: rate.rate_bps,
      treatment: row.treatment ?? rate.treatment ?? "standard",
      taxAccountId: row.tax_account_id,
      isRecoverable: row.is_recoverable,
    });
  }
  return out;
}

/** Post one balanced journal for the statement line and link it. Idempotent; safe to retry. */
export async function codeBankTransactionOnce(
  supabase: AnyClient,
  userId: string,
  args: CodeBankTxnArgs,
): Promise<{ journalId: string; taxMinor: number; grossMinor: number }> {
  const txn = await loadBankTxn(supabase, args.companyId, args.bankTransactionId);
  if (txn.status === "matched" || txn.status === "reconciled") {
    throw new Error("Transaction is already matched. Use Unmatch first to change it.");
  }
  if (txn.status === "excluded")
    throw new Error("Restore this excluded transaction before categorising");
  const account = await loadBankAccount(supabase, args.companyId, txn.bank_account_id);
  if (!account.is_active) throw new Error("This bank account is archived");
  const direction: "in" | "out" = txn.amount_minor > 0 ? "in" : "out";

  await assertCodableAccounts(
    supabase,
    args.companyId,
    args.splits.map((s) => s.accountId),
    account.gl_account_id,
  );
  const taxCodeIds = args.splits.map((s) => s.taxCodeId).filter((x): x is string => Boolean(x));
  const taxCodes = await loadCodingTaxCodes(
    supabase,
    args.companyId,
    taxCodeIds,
    txn.txn_date,
    direction,
  );

  let inputTaxAccountId: string | null = null;
  let outputTaxAccountId: string | null = null;
  const needsDefaultTaxAccount = [...taxCodes.values()].some(
    (c) => c.rateBps > 0 && !c.taxAccountId,
  );
  if (needsDefaultTaxAccount) {
    try {
      if (direction === "out")
        inputTaxAccountId = (await resolveInputTaxAccount(supabase, args.companyId)).id;
      else outputTaxAccountId = (await resolveOutputTaxAccount(supabase, args.companyId)).id;
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : "Tax account is not configured");
    }
  }

  const splits: CodingSplit[] = args.splits.map((s) => ({
    accountId: s.accountId,
    amountMinor: BigInt(s.amountMinor),
    description: s.description ?? null,
    taxCodeId: s.taxCodeId ?? null,
  }));
  const memoBase = (args.memo ?? txn.description ?? "").trim();
  const reference = (args.reference ?? "").trim();
  const memo =
    [memoBase, reference ? `Ref ${reference}` : ""].filter(Boolean).join(" · ").slice(0, 500) ||
    undefined;

  let plan;
  try {
    plan = planBankCoding({
      statementAmountMinor: BigInt(txn.amount_minor),
      bankGlAccountId: account.gl_account_id,
      splits,
      treatment: args.treatment,
      taxCodes,
      inputTaxAccountId,
      outputTaxAccountId,
      memo: memo ?? null,
    });
  } catch (e) {
    if (e instanceof CodingPlanError) throw new Error(e.message);
    throw e;
  }

  const key = await nextCodingKey(supabase, args.companyId, txn.id);
  const { journalId } = await postJournal(supabase as never, {
    company_id: args.companyId,
    journal_date: txn.txn_date,
    ...(memo ? { memo } : {}),
    source_type: "bank_transaction",
    source_id: txn.id,
    idempotency_key: key,
    lines: plan.lines,
  });

  await linkPostedJournalToBankTxn(supabase, {
    companyId: args.companyId,
    bankTransactionId: txn.id,
    journalId,
    bankGlAccountId: account.gl_account_id,
  });

  // Contact / reference are optional extras (columns may not exist before the database update).
  if (args.contactId) {
    const { error } = await supabase
      .from("bank_transactions" as never)
      .update({ contact_id: args.contactId } as never)
      .eq("id" as never, txn.id as never)
      .eq("company_id" as never, args.companyId as never);
    if (error && !isMissingSchema(error))
      console.error("bank contact update failed", error.message);
  }

  // Coding history for suggestions: credit the largest split's account.
  const largest = [...args.splits].sort((a, b) => b.amountMinor - a.amountMinor)[0]!;
  await bumpCodingHistory(supabase, {
    companyId: args.companyId,
    description: txn.description,
    amountMinor: txn.amount_minor,
    offsetAccountId: largest.accountId,
  }).catch((e: unknown) => console.error("coding history failed", e));

  await recordAudit(supabase, {
    companyId: args.companyId,
    action: "bank_transaction.coded",
    entityType: "bank_transaction",
    entityId: txn.id,
    details: { journal_id: journalId, split_count: args.splits.length, user_id: userId },
  });

  return {
    journalId,
    taxMinor: Number(plan.taxMinor),
    grossMinor: Number(plan.grossMinor),
  };
}
