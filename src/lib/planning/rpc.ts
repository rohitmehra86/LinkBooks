/**
 * Shared helpers for the budgets / fixed-assets / analysis server functions.
 * The generated Supabase types predate these tables and functions, so calls are untyped and the
 * result shapes are declared next to each call.
 */

import { isMissingRpc } from "@/lib/accounting/fetch-all";
import { assertUuid } from "@/lib/company-validation";

export type RpcLike = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
};

export function isMissingRelation(
  error: { code?: string | undefined; message?: string | undefined } | null | undefined,
): boolean {
  if (!error) return false;
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    (error.message ?? "").toLowerCase().includes("does not exist")
  );
}

/** Calls an RPC; a missing function becomes `missingMessage` so the UI can say which migration is due. */
export async function callRpc<T>(
  supabase: unknown,
  fn: string,
  args: Record<string, unknown>,
  missingMessage: string,
): Promise<T> {
  const { data, error } = await (supabase as RpcLike).rpc(fn, args);
  if (error) throw new Error(isMissingRpc(error) ? missingMessage : error.message);
  return data as T;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function isoDate(v: unknown, label: string): string {
  if (typeof v !== "string" || !ISO.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw new Error(`${label} must be a valid date (YYYY-MM-DD).`);
  }
  return v;
}

export function wholeMinor(v: unknown, label: string, opts: { min?: number } = {}): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) {
    throw new Error(`${label} must be a whole number of minor units.`);
  }
  if (opts.min !== undefined && v < opts.min)
    throw new Error(`${label} must be at least ${opts.min}.`);
  return v;
}

export function companyIdOf(input: { companyId: string }): string {
  return assertUuid(input?.companyId);
}

export function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v ?? 0);
}

export const BUDGET_MIGRATION =
  "Budgets are not available yet: the database update 20261025400100 has not been applied.";
export const ASSET_MIGRATION =
  "Fixed assets are not available yet: the database updates 20261025400200 and 20261025400300 have not been applied.";
export const REPORT_MIGRATION =
  "This report is not available yet: the database update 20261025400000 has not been applied.";
