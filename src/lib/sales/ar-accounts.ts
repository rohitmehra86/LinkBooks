/**
 * Accounts-receivable control account and bank/cash deposit account lookups for sales.
 * The rules mirror public.sales_ar_control_account / public.sales_is_deposit_account so the
 * TypeScript fallback path and the RPC agree on which accounts are valid.
 */
import type { SalesClient } from "@/lib/sales/rpc";

export type AccountRow = {
  id: string;
  code: string;
  name: string;
  account_type: string;
  account_kind: string | null;
  subtype: string | null;
  system_key: string | null;
  is_control: boolean;
  is_postable: boolean;
  is_active: boolean;
  archived_at: string | null;
  is_payment_enabled: boolean | null;
};

const ACCOUNT_COLUMNS =
  "id, code, name, account_type, account_kind, subtype, system_key, is_control, is_postable, is_active, archived_at, is_payment_enabled";

/** Bank / cash account suitable for a customer deposit (never a control account such as AR). */
export function isDepositAccount(a: AccountRow, bankGlAccountIds: ReadonlySet<string>): boolean {
  if (!a.is_active || a.archived_at || !a.is_postable || a.is_control) return false;
  if (a.account_type !== "asset") return false;
  return (
    a.account_kind === "bank" ||
    a.account_kind === "cash" ||
    a.subtype === "bank" ||
    a.subtype === "cash" ||
    a.system_key === "bank" ||
    a.system_key === "cash" ||
    Boolean(a.is_payment_enabled) ||
    bankGlAccountIds.has(a.id) ||
    /bank|cash/i.test(a.name)
  );
}

export async function listDepositAccountRows(
  supabase: SalesClient,
  companyId: string,
): Promise<AccountRow[]> {
  const { data: accounts, error } = await supabase
    .from("accounts" as never)
    .select(ACCOUNT_COLUMNS as never)
    .eq("company_id" as never, companyId as never)
    .eq("account_type" as never, "asset" as never)
    .eq("is_active" as never, true as never)
    .order("code" as never);
  if (error) throw new Error(error.message);
  const { data: banks, error: bErr } = await supabase
    .from("bank_accounts" as never)
    .select("gl_account_id, is_active" as never)
    .eq("company_id" as never, companyId as never);
  if (bErr) throw new Error(bErr.message);
  const bankIds = new Set(
    ((banks ?? []) as Array<{ gl_account_id: string; is_active: boolean }>)
      .filter((b) => b.is_active)
      .map((b) => b.gl_account_id),
  );
  return ((accounts ?? []) as unknown as AccountRow[]).filter((a) => isDepositAccount(a, bankIds));
}

export async function assertDepositAccount(
  supabase: SalesClient,
  companyId: string,
  accountId: string,
): Promise<void> {
  const rows = await listDepositAccountRows(supabase, companyId);
  if (!rows.some((r) => r.id === accountId)) {
    throw new Error("Deposit account must be an active bank or cash account of this organisation");
  }
}

/** AR control account: accounts.system_key = 'ar' first, then code 1100. */
export async function resolveArAccount(
  supabase: SalesClient,
  companyId: string,
): Promise<{ id: string; code: string }> {
  const { data, error } = await supabase
    .from("accounts" as never)
    .select("id, code, system_key, is_active, archived_at" as never)
    .eq("company_id" as never, companyId as never)
    .or("system_key.eq.ar,code.eq.1100" as never);
  if (error) throw new Error(error.message);
  const rows = (
    (data ?? []) as Array<{
      id: string;
      code: string;
      system_key: string | null;
      is_active: boolean;
      archived_at: string | null;
    }>
  ).filter((r) => r.is_active && !r.archived_at);
  const best = rows.find((r) => r.system_key === "ar") ?? rows.find((r) => r.code === "1100");
  if (!best) {
    throw new Error(
      "Accounts receivable control account is missing. Open Accounting and ensure the chart of accounts is seeded.",
    );
  }
  return { id: best.id, code: best.code };
}
