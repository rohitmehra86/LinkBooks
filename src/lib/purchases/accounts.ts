import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

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
