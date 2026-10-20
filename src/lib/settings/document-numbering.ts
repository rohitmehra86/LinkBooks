/** Allocate the next document number via concurrency-safe DB RPC. */

type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

export async function allocateDocumentNumber(
  supabase: RpcClient,
  companyId: string,
  documentType: string,
): Promise<string> {
  const { data, error } = await supabase.rpc("allocate_document_number", {
    _company_id: companyId,
    _document_type: documentType,
  });
  if (error) throw new Error(error.message);
  const num = typeof data === "string" ? data.trim() : "";
  if (!num) throw new Error("Could not allocate document number");
  return num;
}
