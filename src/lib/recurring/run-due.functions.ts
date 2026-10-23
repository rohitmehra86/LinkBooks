import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { selectDueSchedules, type RunDueSummary } from "@/lib/recurring/due";

type DueRow = { id: string; next_due_date: string; is_active: boolean };

async function loadDue(
  supabase: Parameters<typeof assertCompanyPermission>[0],
  table: "sales_recurring_invoices" | "recurring_bills",
  companyId: string,
  today: string,
): Promise<DueRow[]> {
  const { data, error } = await supabase
    .from(table as never)
    .select("id, next_due_date, is_active" as never)
    .eq("company_id" as never, companyId as never)
    .eq("is_active" as never, true as never)
    .lte("next_due_date" as never, today as never)
    .order("next_due_date" as never, { ascending: true } as never)
    .limit(100);
  if (error) throw new Error(error.message);
  return selectDueSchedules((data ?? []) as unknown as DueRow[], today);
}

/**
 * User-triggered "Run due now" for recurring invoices: generates every due schedule as the signed-in
 * user (their permissions apply). Each occurrence is idempotent, so pressing it twice is safe.
 */
export const runDueRecurringInvoices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }): Promise<RunDueSummary> => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "sales.draft");
    const { generateSalesInvoiceFromRecurring } =
      await import("@/lib/recurring/generate-sales-invoice");
    const today = new Date().toISOString().slice(0, 10);
    const due = await loadDue(supabase, "sales_recurring_invoices", data.companyId, today);
    const summary: RunDueSummary = { generated: 0, failed: [] };
    for (const row of due) {
      try {
        await generateSalesInvoiceFromRecurring(supabase, userId, data.companyId, row.id);
        summary.generated += 1;
      } catch (e) {
        summary.failed.push({ id: row.id, message: e instanceof Error ? e.message : "Failed" });
      }
    }
    return summary;
  });

export const runDueRecurringBills = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }): Promise<RunDueSummary> => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "purchases.draft");
    const { generatePurchaseBillFromRecurring } =
      await import("@/lib/recurring/generate-purchase-bill");
    const { validateBillLines, authoriseBillInternal } =
      await import("@/lib/purchases/purchases.functions");
    const today = new Date().toISOString().slice(0, 10);
    const due = await loadDue(supabase, "recurring_bills", data.companyId, today);
    const summary: RunDueSummary = { generated: 0, failed: [] };
    for (const row of due) {
      try {
        await generatePurchaseBillFromRecurring(supabase, userId, data.companyId, row.id, {
          validateBillLines,
          authoriseBill: authoriseBillInternal,
        });
        summary.generated += 1;
      } catch (e) {
        summary.failed.push({ id: row.id, message: e instanceof Error ? e.message : "Failed" });
      }
    }
    return summary;
  });
