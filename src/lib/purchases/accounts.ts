import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  isBankOrCashAccount,
  NOT_A_BANK_ACCOUNT_MESSAGE,
  type AccountCandidate,
} from "@/lib/purchases/bank-account-rules";

type Client = SupabaseClient<Database>;

export async function requireAccountByCode(
  supabase: Client,
  companyId: string,
  code: string,
): Promise<{ id: string; code: string }> {
  const { data, error } = await supabase
    .from("accounts" as never)
    .select("id, code" as never)
    .eq("company_id" as never, companyId as never)
    .eq("code" as never, code as never)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as { id: string; code: string } | null;
  if (!row) {
    throw new Error(
      `Required ledger account ${code} is missing. Open Accounting and ensure the chart of accounts is seeded.`,
    );
  }
  return row;
}

export async function requireAccountInCompany(
  supabase: Client,
  companyId: string,
  accountId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("accounts" as never)
    .select("id, is_active, is_postable, archived_at" as never)
    .eq("company_id" as never, companyId as never)
    .eq("id" as never, accountId as never)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as {
    id: string;
    is_active: boolean;
    is_postable: boolean;
    archived_at: string | null;
  } | null;
  if (!row) throw new Error("Account not found in this organisation");
  if (!row.is_active || row.archived_at) throw new Error("Account is inactive");
  if (!row.is_postable) throw new Error("Account is not postable");
}

/** GL account ids of the company's active Banking bank accounts. */
export async function loadBankGlAccountIds(
  supabase: Client,
  companyId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("bank_accounts" as never)
    .select("gl_account_id" as never)
    .eq("company_id" as never, companyId as never)
    .eq("is_active" as never, true as never);
  if (error) throw new Error(error.message);
  return new Set(
    ((data ?? []) as Array<{ gl_account_id: string | null }>)
      .map((r) => r.gl_account_id)
      .filter((id): id is string => Boolean(id)),
  );
}

/**
 * Like `requireAccountInCompany`, but the account must also be a bank / cash account
 * (see `isBankOrCashAccount`). Use for every "paid from" account.
 */
export async function requireBankAccount(
  supabase: Client,
  companyId: string,
  accountId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("accounts" as never)
    .select(
      "id, account_type, is_active, is_postable, archived_at, account_kind, subtype, is_payment_enabled" as never,
    )
    .eq("company_id" as never, companyId as never)
    .eq("id" as never, accountId as never)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as AccountCandidate | null;
  if (!row) throw new Error("Account not found in this organisation");
  if (!row.is_active || row.archived_at) throw new Error("Account is inactive");
  if (!row.is_postable) throw new Error("Account is not postable");
  const bankIds = await loadBankGlAccountIds(supabase, companyId);
  if (!isBankOrCashAccount(row, bankIds)) throw new Error(NOT_A_BANK_ACCOUNT_MESSAGE);
}

export type ApCandidate = {
  id: string;
  code: string;
  system_key: string | null;
  is_active: boolean;
  archived_at: string | null;
};

/** Role first (system_key "ap"), then the conventional code 2000. Inactive and archived accounts never win. */
export function pickApControlAccount(rows: ApCandidate[]): { id: string; code: string } | null {
  const usable = rows.filter((r) => r.is_active && !r.archived_at);
  const best = usable.find((r) => r.system_key === "ap") ?? usable.find((r) => r.code === "2000");
  return best ? { id: best.id, code: best.code } : null;
}

/** The accounts payable control account for a company (P-31: found by role, not only by code). */
export async function requireApControlAccount(
  supabase: Client,
  companyId: string,
): Promise<{ id: string; code: string }> {
  const { data, error } = await supabase
    .from("accounts" as never)
    .select("id, code, system_key, is_active, archived_at" as never)
    .eq("company_id" as never, companyId as never)
    .or("system_key.eq.ap,code.eq.2000" as never);
  if (error) throw new Error(error.message);
  const best = pickApControlAccount((data ?? []) as unknown as ApCandidate[]);
  if (!best) {
    throw new Error(
      "Accounts payable control account is missing. Open Accounting and ensure the chart of accounts is seeded.",
    );
  }
  return best;
}
