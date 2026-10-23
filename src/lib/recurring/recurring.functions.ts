import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runDuePurchaseBillSchedules } from "@/lib/recurring/scheduler";
import { generatePurchaseBillFromRecurring } from "@/lib/recurring/generate-purchase-bill";
import {
  authoriseBillInternal,
  validateBillLines,
} from "@/lib/purchases/purchases.functions";

/**
 * Cron entry: secured by LOVABLE_CRON_SECRET Bearer token.
 * Wire Vercel Cron or Supabase HTTP to POST this server function URL.
 */
export const runRecurringScheduler = createServerFn({ method: "POST" }).handler(async () => {
  const authFailure = await authenticateCronRequest(getRequest());
  if (authFailure) return authFailure;

  const admin = supabaseAdmin;
  const asOf = new Date().toISOString().slice(0, 10);

  const { data: runRow, error: runErr } = await admin
    .from("recurring_generation_runs" as never)
    .insert({ trigger_source: "cron", company_id: null } as never)
    .select("id")
    .single();
  if (runErr) throw new Error(runErr.message);
  const runId = (runRow as { id: string }).id;

  const stats = await runDuePurchaseBillSchedules(admin, asOf, async ({
    companyId,
    recurringBillId,
    userId,
  }) => {
    await generatePurchaseBillFromRecurring(
      admin,
      userId,
      companyId,
      recurringBillId,
      {
        validateBillLines,
        authoriseBill: authoriseBillInternal,
      },
      { automatic: true },
    );
  });

  // Recurring manual journals are processed in the database (acts as each template's creator).
  const journalRun = await admin.rpc(
    "process_all_due_recurring_journals" as never,
    { _as_of: asOf } as never,
  );
  const journals = journalRun.error
    ? { error: journalRun.error.message }
    : (journalRun.data as { posted: number; failed: number; skipped: number } | null);
  const journalsFailed = journalRun.error || (journals && "failed" in journals && journals.failed > 0);

  await admin
    .from("recurring_generation_runs" as never)
    .update({
      finished_at: new Date().toISOString(),
      outcome: stats.failed > 0 || journalsFailed ? "partial" : "ok",
      stats: { ...stats, journals },
    } as never)
    .eq("id" as never, runId as never);

  return { runId, asOf, stats, journals };
});
