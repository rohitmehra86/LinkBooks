import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { Permission } from "@/lib/permissions";

type AuthedClient = SupabaseClient<Database>;

/**
 * Server-side authorisation helper. Prefer this in addition to RLS so failed
 * permission checks return a clear error instead of an empty update.
 */
export async function assertCompanyPermission(
  supabase: AuthedClient,
  companyId: string,
  permission: Permission,
): Promise<void> {
  const { data, error } = await supabase.rpc("has_company_permission", {
    _company_id: companyId,
    _permission: permission,
  });
  if (error) throw new Error(error.message);
  if (!data) {
    throw new Error("You do not have permission to perform this action for this organisation.");
  }
}

export async function assertCompanyMember(
  supabase: AuthedClient,
  companyId: string,
): Promise<void> {
  const { data, error } = await supabase.rpc("is_company_member", {
    _company_id: companyId,
  });
  if (error) throw new Error(error.message);
  if (!data) {
    throw new Error("You do not have access to that organisation.");
  }
}
