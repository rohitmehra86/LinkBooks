import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * New banking RPCs / columns ship in migration FILES that are applied separately.
 * Until then the UI must say so clearly instead of showing a raw Postgres error.
 */
export const DB_UPDATE_MESSAGE = "Unavailable until database update is applied";

type DbError = { code?: string | null; message?: string | null } | null | undefined;

/** PGRST202 = function not found in schema cache; 42883 = undefined_function. */
export function isMissingRpc(error: DbError): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  if (code === "PGRST202" || code === "42883") return true;
  const msg = (error.message ?? "").toLowerCase();
  return msg.includes("could not find the function") || /function .* does not exist/.test(msg);
}

/** Missing column (42703 / PGRST204) or table (42P01 / PGRST205). */
export function isMissingSchema(error: DbError): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  if (["42703", "PGRST204", "42P01", "PGRST205"].includes(code)) return true;
  const msg = (error.message ?? "").toLowerCase();
  return (
    msg.includes("schema cache") ||
    /column .* does not exist/.test(msg) ||
    /relation .* does not exist/.test(msg)
  );
}

export class DatabaseUpdateRequiredError extends Error {
  constructor(what: string) {
    super(`${DB_UPDATE_MESSAGE} (${what}).`);
    this.name = "DatabaseUpdateRequiredError";
  }
}

/** Call an RPC; translate "function missing" into DatabaseUpdateRequiredError. */
export async function callRpc<T>(
  supabase: SupabaseClient<any>,
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabase.rpc(fn as never, args as never);
  if (error) {
    if (isMissingRpc(error)) throw new DatabaseUpdateRequiredError(fn);
    throw new Error(error.message);
  }
  return data as T;
}

/** Like callRpc but returns null when the function is not installed (caller supplies a fallback). */
export async function tryRpc<T>(
  supabase: SupabaseClient<any>,
  fn: string,
  args: Record<string, unknown>,
): Promise<{ available: true; data: T } | { available: false }> {
  const { data, error } = await supabase.rpc(fn as never, args as never);
  if (error) {
    if (isMissingRpc(error)) return { available: false };
    throw new Error(error.message);
  }
  return { available: true, data: data as T };
}

/**
 * Audit trail via the SECURITY DEFINER helper `record_audit_event` (audit_events has no client INSERT policy,
 * so direct inserts silently failed — BK-13). Failures are logged, not thrown.
 */
export async function recordAudit(
  supabase: SupabaseClient<any>,
  args: {
    companyId: string;
    action: string;
    entityType: string;
    entityId?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await supabase.rpc("record_audit_event" as never, {
    _company_id: args.companyId,
    _action: args.action,
    _entity_type: args.entityType,
    _entity_id: args.entityId ?? null,
    _details: args.details ?? {},
  } as never);
  // The business action has already succeeded; never turn a logging failure into a failed action.
  if (error && !isMissingRpc(error)) {
    console.error(`[banking] audit event ${args.action} failed: ${error.message}`);
  }
}
