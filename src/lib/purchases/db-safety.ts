/**
 * Safe multi-step write helpers for AP workflows (P-08).
 *
 * PostgREST has no transaction across calls, so each helper (a) checks every error,
 * (b) prefers an atomic Postgres RPC when the migration has been applied, and
 * (c) otherwise falls back to a checked multi-step write that restores the previous
 * state if a later step fails. Ledger rows are never touched here - journals only move
 * through postJournal / reverseJournal.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Client = SupabaseClient<Database>;

type PgError = { code?: string | null; message?: string | null } | null | undefined;

/** PostgREST / Postgres signal that an RPC has not been created yet. */
export function isMissingFunctionError(error: PgError): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  if (code === "PGRST202" || code === "42883") return true;
  return /could not find the function|function .* does not exist/i.test(error.message ?? "");
}

export type BillLineRow = Record<string, unknown>;

/**
 * Replace all lines of a bill atomically.
 * - Uses `replace_purchase_bill_lines` when installed (single transaction).
 * - Otherwise deletes then inserts with every error checked; if the insert fails the
 *   previous lines are put back so the bill is never left without lines.
 */
export async function replaceBillLines(
  supabase: Client,
  companyId: string,
  billId: string,
  rows: BillLineRow[],
  priorRows: BillLineRow[] | null,
): Promise<void> {
  const rpc = await supabase.rpc(
    "replace_purchase_bill_lines" as never,
    {
      _company_id: companyId,
      _bill_id: billId,
      _lines: rows,
    } as never,
  );
  if (!rpc.error) return;
  if (!isMissingFunctionError(rpc.error)) throw new Error(rpc.error.message);

  const { error: delErr } = await supabase
    .from("purchase_bill_lines" as never)
    .delete()
    .eq("company_id" as never, companyId as never)
    .eq("bill_id" as never, billId as never);
  if (delErr) throw new Error(`Could not replace bill lines: ${delErr.message}`);

  const { error: insErr } = await supabase
    .from("purchase_bill_lines" as never)
    .insert(rows as never);
  if (insErr) {
    if (priorRows && priorRows.length) {
      const { error: restoreErr } = await supabase
        .from("purchase_bill_lines" as never)
        .insert(priorRows as never);
      if (restoreErr) {
        throw new Error(
          `Could not save bill lines (${insErr.message}) and the previous lines could not be restored (${restoreErr.message}). Re-open the bill and re-enter the lines.`,
        );
      }
    }
    throw new Error(`Could not save bill lines: ${insErr.message}`);
  }
}

/** Insert the lines of a brand-new bill; if that fails, remove the empty draft header. */
export async function insertNewBillLines(
  supabase: Client,
  companyId: string,
  billId: string,
  rows: BillLineRow[],
): Promise<void> {
  const { error } = await supabase.from("purchase_bill_lines" as never).insert(rows as never);
  if (!error) return;
  await supabase
    .from("purchase_bills" as never)
    .delete()
    .eq("company_id" as never, companyId as never)
    .eq("id" as never, billId as never)
    .eq("status" as never, "draft" as never)
    .is("posted_journal_id" as never, null as never);
  throw new Error(`Could not save bill lines: ${error.message}`);
}

export type BillSettlement = {
  paid: number;
  credited: number;
  status: string;
};

/**
 * Add `delta` (negative to reverse) to a bill's paid / credited amounts and re-derive its
 * status. Compare-and-set on the amounts we read, so two people settling the same bill at
 * once cannot both succeed against a stale balance. Returns the previous state so the caller
 * can undo it if a later step fails.
 */
export async function adjustBillSettlement(
  supabase: Client,
  companyId: string,
  billId: string,
  delta: { paid?: number; credited?: number },
  nextStatus: (b: {
    status: string;
    total_minor: number;
    amount_paid_minor: number;
    amount_credited_minor: number;
  }) => string,
): Promise<BillSettlement> {
  const { data, error } = await supabase
    .from("purchase_bills" as never)
    .select("status, total_minor, amount_paid_minor, amount_credited_minor" as never)
    .eq("company_id" as never, companyId as never)
    .eq("id" as never, billId as never)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Bill not found while applying settlement");
  const b = data as unknown as {
    status: string;
    total_minor: number;
    amount_paid_minor: number;
    amount_credited_minor: number;
  };
  const prev: BillSettlement = {
    paid: Number(b.amount_paid_minor),
    credited: Number(b.amount_credited_minor),
    status: b.status,
  };
  const paid = prev.paid + (delta.paid ?? 0);
  const credited = prev.credited + (delta.credited ?? 0);
  if (paid < 0 || credited < 0) throw new Error("Settlement would make the bill balance negative");
  if (paid + credited > Number(b.total_minor)) {
    throw new Error("Settlement would exceed the bill total");
  }
  const status = nextStatus({
    status: b.status,
    total_minor: Number(b.total_minor),
    amount_paid_minor: paid,
    amount_credited_minor: credited,
  });
  const { data: updated, error: upErr } = await supabase
    .from("purchase_bills" as never)
    .update({
      amount_paid_minor: paid,
      amount_credited_minor: credited,
      status,
      updated_at: new Date().toISOString(),
    } as never)
    .eq("company_id" as never, companyId as never)
    .eq("id" as never, billId as never)
    .eq("amount_paid_minor" as never, prev.paid as never)
    .eq("amount_credited_minor" as never, prev.credited as never)
    .select("id");
  if (upErr) throw new Error(upErr.message);
  if (!updated || (updated as unknown[]).length === 0) {
    throw new Error("A bill balance changed while saving. Reload and try again.");
  }
  return prev;
}

/** Best-effort undo of `adjustBillSettlement`; never throws. */
export async function restoreBillSettlement(
  supabase: Client,
  companyId: string,
  billId: string,
  prev: BillSettlement,
): Promise<void> {
  try {
    await supabase
      .from("purchase_bills" as never)
      .update({
        amount_paid_minor: prev.paid,
        amount_credited_minor: prev.credited,
        status: prev.status,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("company_id" as never, companyId as never)
      .eq("id" as never, billId as never);
  } catch {
    // The caller already has the original error to report.
  }
}
