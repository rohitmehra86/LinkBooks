import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Client = SupabaseClient<Database>;

async function countEq(
  supabase: Client,
  table: string,
  companyId: string,
  column: string,
  value: string,
): Promise<number> {
  const { count, error } = await supabase
    .from(table as never)
    .select("id" as never, { count: "exact", head: true })
    .eq("company_id" as never, companyId as never)
    .eq(column as never, value as never);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function countNeq(
  supabase: Client,
  table: string,
  companyId: string,
  column: string,
  value: string,
): Promise<number> {
  const { count, error } = await supabase
    .from(table as never)
    .select("id" as never, { count: "exact", head: true })
    .eq("company_id" as never, companyId as never)
    .neq(column as never, value as never);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export const getAccountantChecklist = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const supabase = context.supabase;
    const cid = data.companyId;

    const [
      unlockedPeriods,
      draftInvoices,
      draftBills,
      uncategorisedBank,
      matchedBank,
      openRecon,
    ] = await Promise.all([
      countNeq(supabase, "accounting_periods", cid, "status", "locked"),
      countEq(supabase, "sales_invoices", cid, "status", "draft"),
      countEq(supabase, "purchase_bills", cid, "status", "draft"),
      countEq(supabase, "bank_transactions", cid, "status", "uncategorised"),
      countEq(supabase, "bank_transactions", cid, "status", "matched"),
      countEq(supabase, "reconciliation_sessions", cid, "status", "open"),
    ]);

    const { data: recentJournals, error: jErr } = await supabase
      .from("journals" as never)
      .select("id, journal_number, journal_date, status, source_type, memo" as never)
      .eq("company_id" as never, cid as never)
      .order("created_at" as never, { ascending: false })
      .limit(15);
    if (jErr) throw new Error(jErr.message);

    return {
      unlockedPeriods,
      draftInvoices,
      draftBills,
      uncategorisedBank,
      matchedAwaitingReconcile: matchedBank,
      openReconciliationSessions: openRecon,
      recentJournals: recentJournals ?? [],
      links: {
        periods: "/accounting",
        invoices: "/sales/invoices",
        bills: "/purchases/bills",
        banking: "/banking/transactions",
        reconcile: "/banking/reconcile",
        journals: "/accounting",
        reports: "/reports",
      },
    };
  });
