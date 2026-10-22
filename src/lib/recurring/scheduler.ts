import type { SupabaseClient } from "@supabase/supabase-js";

const BATCH_LIMIT = 50;

export type SchedulerRunStats = {
  examined: number;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  errors: Array<{ scheduleId: string; message: string }>;
};

/** Process due purchase-bill schedules (server-side; use service role or cron). */
export async function runDuePurchaseBillSchedules(
  supabase: SupabaseClient,
  asOfDate: string,
  generate: (args: {
    companyId: string;
    recurringBillId: string;
    userId: string;
  }) => Promise<unknown>,
): Promise<SchedulerRunStats> {
  const stats: SchedulerRunStats = {
    examined: 0,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  const { data: dueRows, error } = await supabase
    .from("recurring_schedules" as never)
    .select("id, company_id, template_id, next_occurrence_date" as never)
    .eq("mode" as never, "scheduled" as never)
    .eq("is_paused" as never, false as never)
    .lte("next_occurrence_date" as never, asOfDate as never)
    .limit(BATCH_LIMIT);

  if (error) throw new Error(error.message);

  for (const row of dueRows ?? []) {
    stats.examined += 1;
    const sched = row as { id: string; company_id: string; template_id: string };
    const { data: tpl, error: tErr } = await supabase
      .from("recurring_templates" as never)
      .select(
        "legacy_recurring_bill_id, owner_user_id, document_type, is_active" as never,
      )
      .eq("id" as never, sched.template_id as never)
      .maybeSingle();
    if (tErr) throw new Error(tErr.message);
    const meta = tpl as {
      legacy_recurring_bill_id: string | null;
      owner_user_id: string;
      document_type: string;
      is_active: boolean;
    } | null;
    if (
      !meta?.is_active ||
      meta.document_type !== "purchase_bill" ||
      !meta.legacy_recurring_bill_id
    ) {
      stats.skipped += 1;
      continue;
    }
    stats.attempted += 1;
    try {
      await generate({
        companyId: sched.company_id,
        recurringBillId: meta.legacy_recurring_bill_id,
        userId: meta.owner_user_id,
      });
      stats.succeeded += 1;
    } catch (e) {
      stats.failed += 1;
      stats.errors.push({
        scheduleId: sched.id,
        message: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  return stats;
}
