import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { isIsoDate } from "@/lib/accounting/conversion-balances";
import { isPositiveRate } from "@/lib/accounting/fx-reval";

/**
 * Server functions for foreign-currency revaluation and auto-reversing journals. Posting is done by the
 * database functions, which build their journals through `post_journal`. Rates are manual: typed on the
 * screen or stored in `exchange_rates`; nothing here fetches rates from the internet.
 */

const MIGRATION_HINT =
  "FX revaluation and auto-reversals are not available yet: the database migration 20261025110000_fx_realised_unrealised has not been applied.";

function friendly(message: string): string {
  if (
    /preview_fx_revaluation|post_fx_revaluation|process_due_auto_reversals|cancel_auto_reversal|fx_revaluation_runs|journal_auto_reversals|fx_realised_postings/.test(
      message,
    ) &&
    /(does not exist|could not find|schema cache)/i.test(message)
  ) {
    return MIGRATION_HINT;
  }
  return message;
}

function parseRates(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== "object") return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const ccy = k.trim().toUpperCase();
    const rate = String(v ?? "").trim();
    if (!rate) continue;
    if (!/^[A-Z]{3}$/.test(ccy)) throw new Error(`Invalid currency code ${k}`);
    if (!isPositiveRate(rate))
      throw new Error(`The exchange rate for ${ccy} must be a positive number`);
    out[ccy] = rate;
  }
  return out;
}

const revalInput = (input: {
  companyId: string;
  asOfDate: string;
  rates?: Record<string, string>;
  note?: string;
}) => {
  if (!isIsoDate(input?.asOfDate)) throw new Error("Choose a valid revaluation date.");
  return {
    companyId: assertUuid(input?.companyId),
    asOfDate: input.asOfDate,
    rates: parseRates(input.rates),
    note: (input.note ?? "").trim().slice(0, 300),
  };
};

export type RevaluationPreviewLine = {
  account_id: string;
  account_code: string;
  account_name: string;
  currency_code: string;
  txn_net_minor: number;
  booked_base_minor: number;
  rate: number | null;
  rate_source: "manual" | "exchange_rates" | null;
  rate_date: string | null;
  closing_base_minor: number | null;
  adjustment_minor: number | null;
  stale: boolean;
};

export type RevaluationPreview = {
  base_currency: string;
  as_of_date: string;
  lines: RevaluationPreviewLine[];
  missing: string[];
};

export const previewFxRevaluation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(revalInput)
  .handler(async ({ data, context }): Promise<RevaluationPreview> => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: result, error } = await context.supabase.rpc(
      "preview_fx_revaluation" as never,
      {
        payload: { company_id: data.companyId, as_of_date: data.asOfDate, rates: data.rates },
      } as never,
    );
    if (error) throw new Error(friendly(error.message));
    return result as unknown as RevaluationPreview;
  });

export const postFxRevaluation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(revalInput)
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "accounting.post");
    const { data: result, error } = await context.supabase.rpc(
      "post_fx_revaluation" as never,
      {
        payload: {
          company_id: data.companyId,
          as_of_date: data.asOfDate,
          rates: data.rates,
          ...(data.note ? { note: data.note } : {}),
        },
      } as never,
    );
    if (error) throw new Error(friendly(error.message));
    return result as unknown as {
      posted: boolean;
      message?: string;
      run_id?: string;
      journal_ids: string[];
      total_gain_minor?: number;
      total_loss_minor?: number;
      reverse_on?: string;
    };
  });

export type AutoReversalRow = {
  id: string;
  journal_id: string;
  reverse_on: string;
  origin: "manual" | "fx_revaluation";
  status: "pending" | "done" | "failed" | "cancelled";
  reversal_journal_id: string | null;
  attempts: number;
  last_error: string | null;
  journal_number: number | null;
  journal_date: string | null;
  memo: string | null;
};

export type RealisedFxRow = {
  id: string;
  kind: "sales" | "purchases";
  currency_code: string;
  settled_minor: number;
  document_rate: number;
  settlement_rate: number;
  gain_loss_base_minor: number;
  journal_id: string | null;
  reversed_at: string | null;
  created_at: string;
};

export type RevaluationRunRow = {
  id: string;
  as_of_date: string;
  seq: number;
  rates: Record<string, string>;
  total_gain_minor: number;
  total_loss_minor: number;
  reverse_on: string;
  note: string | null;
  created_at: string;
};

export type FxOverview = {
  available: boolean;
  unavailableReason: string | null;
  canPost: boolean;
  autoReversals: AutoReversalRow[];
  realised: RealisedFxRow[];
  runs: RevaluationRunRow[];
};

export const getFxOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input?.companyId) }))
  .handler(async ({ data, context }): Promise<FxOverview> => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: canPost } = await context.supabase.rpc("has_company_permission", {
      _company_id: data.companyId,
      _permission: "accounting.post",
    });
    const empty: FxOverview = {
      available: false,
      unavailableReason: null,
      canPost: Boolean(canPost),
      autoReversals: [],
      realised: [],
      runs: [],
    };

    const { data: arRows, error: arErr } = await context.supabase
      .from("journal_auto_reversals" as never)
      .select(
        "id, journal_id, reverse_on, origin, status, reversal_journal_id, attempts, last_error" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("reverse_on" as never, { ascending: false })
      .limit(50);
    if (arErr) return { ...empty, unavailableReason: friendly(arErr.message) };

    const reversals = (arRows ?? []) as unknown as Array<
      Omit<AutoReversalRow, "journal_number" | "journal_date" | "memo">
    >;
    const ids = [...new Set(reversals.map((r) => r.journal_id))];
    const journalById = new Map<
      string,
      { journal_number: number; journal_date: string; memo: string | null }
    >();
    if (ids.length) {
      const { data: js } = await context.supabase
        .from("journals" as never)
        .select("id, journal_number, journal_date, memo" as never)
        .in("id" as never, ids as never);
      for (const j of (js ?? []) as unknown as Array<{
        id: string;
        journal_number: number;
        journal_date: string;
        memo: string | null;
      }>) {
        journalById.set(j.id, j);
      }
    }

    const { data: realised } = await context.supabase
      .from("fx_realised_postings" as never)
      .select(
        "id, kind, currency_code, settled_minor, document_rate, settlement_rate, gain_loss_base_minor, journal_id, reversed_at, created_at" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .neq("gain_loss_base_minor" as never, 0 as never)
      .order("created_at" as never, { ascending: false })
      .limit(50);
    const { data: runs } = await context.supabase
      .from("fx_revaluation_runs" as never)
      .select(
        "id, as_of_date, seq, rates, total_gain_minor, total_loss_minor, reverse_on, note, created_at" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("as_of_date" as never, { ascending: false })
      .limit(20);

    return {
      available: true,
      unavailableReason: null,
      canPost: Boolean(canPost),
      autoReversals: reversals.map((r) => {
        const j = journalById.get(r.journal_id);
        return {
          ...r,
          journal_number: j?.journal_number ?? null,
          journal_date: j?.journal_date ?? null,
          memo: j?.memo ?? null,
        };
      }),
      realised: ((realised ?? []) as unknown as RealisedFxRow[]).map((r) => ({
        ...r,
        settled_minor: Number(r.settled_minor),
        gain_loss_base_minor: Number(r.gain_loss_base_minor),
        document_rate: Number(r.document_rate),
        settlement_rate: Number(r.settlement_rate),
      })),
      runs: ((runs ?? []) as unknown as RevaluationRunRow[]).map((r) => ({
        ...r,
        total_gain_minor: Number(r.total_gain_minor),
        total_loss_minor: Number(r.total_loss_minor),
      })),
    };
  });

export const processDueAutoReversals = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; upToDate?: string }) => ({
    companyId: assertUuid(input?.companyId),
    upToDate: input?.upToDate && isIsoDate(input.upToDate) ? input.upToDate : undefined,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "accounting.post");
    const { data: result, error } = await context.supabase.rpc(
      "process_due_auto_reversals" as never,
      {
        payload: {
          company_id: data.companyId,
          ...(data.upToDate ? { up_to_date: data.upToDate } : {}),
        },
      } as never,
    );
    if (error) throw new Error(friendly(error.message));
    return result as unknown as {
      processed: number;
      failed: number;
      items: Array<{ journal_id: string; status: string; error?: string }>;
    };
  });

export const cancelAutoReversal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; journalId: string }) => ({
    companyId: assertUuid(input?.companyId),
    journalId: assertUuid(input?.journalId, "journal"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "accounting.post");
    const { error } = await context.supabase.rpc(
      "cancel_auto_reversal" as never,
      { payload: { company_id: data.companyId, journal_id: data.journalId } } as never,
    );
    if (error) throw new Error(friendly(error.message));
    return { ok: true as const };
  });
