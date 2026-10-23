/** Allocate the next document number via concurrency-safe DB RPC. */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export async function allocateDocumentNumber(
  supabase: SupabaseClient<Database>,
  companyId: string,
  documentType: string,
): Promise<string> {
  const { data, error } = await supabase.rpc("allocate_document_number" as never, {
    _company_id: companyId,
    _document_type: documentType,
  } as never);
  if (error) throw new Error(error.message);
  const payload: unknown = data;
  const num = typeof payload === "string" ? payload.trim() : "";
  if (!num) throw new Error("Could not allocate document number");
  return num;
}
