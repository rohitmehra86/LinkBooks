import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";

/**
 * AC-02 server functions. Posting itself is done by the `post_conversion_balances` database function,
 * which builds the opening journals through `post_journal` (single posting engine). These functions
 * only load screen data and forward the validated payload.
 */

const MIGRATION_HINT =
  "Conversion balances are not available yet: the database migration 20261025100000_conversion_balances has not been applied.";

function friendly(message: string): string {
  if (
    /post_conversion_balances|reverse_conversion_balances|conversion_balance_batches/.test(
      message,
    ) &&
    /(does not exist|could not find|schema cache)/i.test(message)
  ) {
    return MIGRATION_HINT;
  }
  return message;
}

export type ConversionBatch = {
  id: string;
  conversion_date: string;
  opening_date: string;
  status: "posted" | "reversed";
  journal_ids: string[];
  total_debit_minor: number;
  total_credit_minor: number;
  plug_to_opening_equity_minor: number;
  invoice_count: number;
  bill_count: number;
  note: string | null;
  created_at: string;
  reversed_at: string | null;
  reverse_reason: string | null;
};

export type ConversionOverview = {
  available: boolean;
  unavailableReason: string | null;
  conversionDate: string | null;
  canManage: boolean;
  batches: ConversionBatch[];
  active: ConversionBatch | null;
};

export const getConversionOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({
    companyId: assertUuid(input?.companyId),
  }))
  .handler(async ({ data, context }): Promise<ConversionOverview> => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: canManage } = await context.supabase.rpc("has_company_permission", {
      _company_id: data.companyId,
      _permission: "accounting.conversion.manage",
    });
    const { data: policy } = await context.supabase
      .from("organisation_lock_policy" as never)
      .select("conversion_date" as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    const conversionDate =
      (policy as { conversion_date: string | null } | null)?.conversion_date ?? null;

    const { data: rows, error } = await context.supabase
      .from("conversion_balance_batches" as never)
      .select(
        "id, conversion_date, opening_date, status, journal_ids, total_debit_minor, total_credit_minor, plug_to_opening_equity_minor, invoice_count, bill_count, note, created_at, reversed_at, reverse_reason" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("created_at" as never, { ascending: false });
    if (error) {
      return {
        available: false,
        unavailableReason: friendly(error.message),
        conversionDate,
        canManage: Boolean(canManage),
        batches: [],
        active: null,
      };
    }
    const batches = ((rows ?? []) as unknown as ConversionBatch[]).map((b) => ({
      ...b,
      total_debit_minor: Number(b.total_debit_minor),
      total_credit_minor: Number(b.total_credit_minor),
      plug_to_opening_equity_minor: Number(b.plug_to_opening_equity_minor),
    }));
    return {
      available: true,
      unavailableReason: null,
      conversionDate,
      canManage: Boolean(canManage),
      batches,
      active: batches.find((b) => b.status === "posted") ?? null,
    };
  });

export type ConversionAccount = {
  id: string;
  code: string;
  name: string;
  account_type: string;
  account_kind: string | null;
  system_key: string | null;
  normal_balance: string;
};

export type ConversionContact = { id: string; name: string; kind: string };

export const getConversionSetup = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({
    companyId: assertUuid(input?.companyId),
  }))
  .handler(
    async ({
      data,
      context,
    }): Promise<{
      accounts: ConversionAccount[];
      customers: ConversionContact[];
      suppliers: ConversionContact[];
    }> => {
      await assertCompanyMember(context.supabase, data.companyId);
      const { data: accts, error } = await context.supabase
        .from("accounts" as never)
        .select("id, code, name, account_type, account_kind, system_key, normal_balance" as never)
        .eq("company_id" as never, data.companyId as never)
        .eq("is_active" as never, true as never)
        .eq("is_postable" as never, true as never)
        .order("code" as never);
      if (error) throw new Error(error.message);
      const { data: contacts, error: cErr } = await context.supabase
        .from("contacts" as never)
        .select("id, name, kind" as never)
        .eq("company_id" as never, data.companyId as never)
        .eq("is_active" as never, true as never)
        .order("name" as never);
      if (cErr) throw new Error(cErr.message);
      const all = (contacts ?? []) as unknown as ConversionContact[];
      return {
        accounts: (accts ?? []) as unknown as ConversionAccount[],
        customers: all.filter((c) => c.kind === "customer" || c.kind === "both"),
        suppliers: all.filter((c) => c.kind === "supplier" || c.kind === "both"),
      };
    },
  );

type PostPayload = Record<string, unknown> & { company_id: string };

export const postConversionBalances = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { payload: PostPayload }) => {
    if (!input?.payload || typeof input.payload !== "object") throw new Error("Missing payload");
    return {
      payload: { ...input.payload, company_id: assertUuid(input.payload.company_id) },
    };
  })
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(
      context.supabase,
      data.payload.company_id,
      "accounting.conversion.manage",
    );
    const { data: result, error } = await context.supabase.rpc(
      "post_conversion_balances" as never,
      { payload: data.payload } as never,
    );
    if (error) throw new Error(friendly(error.message));
    return result as unknown as {
      batch_id: string;
      journal_ids: string[];
      opening_date: string;
      total_debit_minor: number;
      total_credit_minor: number;
      plug_minor: number;
      invoice_count: number;
      bill_count: number;
    };
  });

export const reverseConversionBalances = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; reason: string }) => {
    const reason = String(input?.reason ?? "").trim();
    if (!reason) throw new Error("A reason is required");
    return { companyId: assertUuid(input?.companyId), reason };
  })
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "accounting.conversion.manage");
    const { data: result, error } = await context.supabase.rpc(
      "reverse_conversion_balances" as never,
      { payload: { company_id: data.companyId, reason: data.reason } } as never,
    );
    if (error) throw new Error(friendly(error.message));
    return {
      ok: true as const,
      result: (result ?? null) as Record<string, string | number> | null,
    };
  });
