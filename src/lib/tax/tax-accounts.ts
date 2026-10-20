import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAccountByCode, requireAccountInCompany } from "@/lib/purchases/accounts";

type AnyClient = SupabaseClient<any>;

/**
 * Resolve output (sales) / input (purchase) tax control accounts.
 * Prefer organisation mappings; fall back to CoA codes 2100 / 1200 when present.
 */
export async function resolveOutputTaxAccount(
  supabase: AnyClient,
  companyId: string,
): Promise<{ id: string; source: "mapping" | "fallback_code" }> {
  const { data: settings } = await supabase
    .from("company_tax_settings" as never)
    .select("output_tax_account_id" as never)
    .eq("company_id" as never, companyId as never)
    .maybeSingle();
  const mapped = (settings as { output_tax_account_id: string | null } | null)?.output_tax_account_id;
  if (mapped) {
    await requireAccountInCompany(supabase, companyId, mapped);
    return { id: mapped, source: "mapping" };
  }
  const acc = await requireAccountByCode(supabase, companyId, "2100");
  return { id: acc.id, source: "fallback_code" };
}

export async function resolveInputTaxAccount(
  supabase: AnyClient,
  companyId: string,
): Promise<{ id: string; source: "mapping" | "fallback_code" }> {
  const { data: settings } = await supabase
    .from("company_tax_settings" as never)
    .select("input_tax_account_id" as never)
    .eq("company_id" as never, companyId as never)
    .maybeSingle();
  const mapped = (settings as { input_tax_account_id: string | null } | null)?.input_tax_account_id;
  if (mapped) {
    await requireAccountInCompany(supabase, companyId, mapped);
    return { id: mapped, source: "mapping" };
  }
  const acc = await requireAccountByCode(supabase, companyId, "1200");
  return { id: acc.id, source: "fallback_code" };
}
