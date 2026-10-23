import type { assertCompanyMember } from "@/lib/assert-company-access";

export type SalesClient = Parameters<typeof assertCompanyMember>[0];

type PgError = { code?: string; message?: string } | null;

/**
 * True when an RPC failed because the function is not deployed yet (PostgREST PGRST202 or
 * Postgres 42883 for THAT function). Errors raised inside a deployed function are never "missing".
 */
export function isMissingRpc(error: PgError, fn: string): boolean {
  if (!error) return false;
  const msg = error.message ?? "";
  if (error.code === "PGRST202") return msg.includes(fn) || msg === "";
  if (error.code === "42883") return msg.includes(fn);
  return /could not find the function/i.test(msg) && msg.includes(fn);
}

export type RpcResult<T> = { missing: false; data: T } | { missing: true };

/**
 * Call a SECURITY DEFINER RPC taking a single jsonb `payload`.
 * Returns `{ missing: true }` when the function is not deployed so callers can fall back;
 * any other database error is thrown with the database's own message.
 */
export async function callSalesRpc<T>(
  supabase: SalesClient,
  fn: string,
  payload: Record<string, unknown>,
): Promise<RpcResult<T>> {
  const { data, error } = await (
    supabase as unknown as {
      rpc: (name: string, args: unknown) => Promise<{ data: unknown; error: PgError }>;
    }
  ).rpc(fn, { payload });
  if (error) {
    if (isMissingRpc(error, fn)) return { missing: true };
    throw new Error(error.message ?? "Database error");
  }
  return { missing: false, data: data as T };
}

export function requireRpc<T>(result: RpcResult<T>, fn: string, migration: string): T {
  if (result.missing) {
    throw new Error(
      `This action needs a database update that has not been applied yet (function ${fn}, migration ${migration}). Ask an administrator to apply the latest migrations.`,
    );
  }
  return result.data;
}
