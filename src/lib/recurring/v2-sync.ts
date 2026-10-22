import type { SupabaseClient } from "@supabase/supabase-js";
import { legacyFrequencyToRrule, type LegacyRecurrenceFrequency } from "@/lib/recurring/legacy-frequency";

type RpcClient = {
  from: SupabaseClient["from"];
};

/** Ensure v2 template + schedule exist for a legacy recurring bill row (dual-write / repair). */
export async function ensureV2ForLegacyRecurringBill(
  supabase: RpcClient,
  recurringBillId: string,
): Promise<{ scheduleId: string; templateVersionId: string | null }> {
  const { data: existing } = await supabase
    .from("recurring_templates" as never)
    .select("id, current_version_id" as never)
    .eq("legacy_recurring_bill_id" as never, recurringBillId as never)
    .maybeSingle();

  const row = existing as { id: string; current_version_id: string | null } | null;

  if (row?.id) {
    const { data: sched } = await supabase
      .from("recurring_schedules" as never)
      .select("id" as never)
      .eq("template_id" as never, row.id as never)
      .maybeSingle();
    if (sched) {
      return {
        scheduleId: (sched as { id: string }).id,
        templateVersionId: row.current_version_id,
      };
    }
  }

  const { data: rb, error: rbErr } = await supabase
    .from("recurring_bills" as never)
    .select("*" as never)
    .eq("id" as never, recurringBillId as never)
    .maybeSingle();
  if (rbErr) throw new Error(rbErr.message);
  if (!rb) throw new Error("Recurring bill not found");

  const bill = rb as {
    company_id: string;
    contact_id: string;
    name: string;
    currency_code: string;
    created_by: string;
    is_active: boolean;
    frequency: LegacyRecurrenceFrequency;
    next_due_date: string;
    auto_authorise: boolean;
    last_generated_on: string | null;
    last_error: string | null;
    template: unknown;
    created_at: string;
    updated_at: string;
  };

  const { data: template, error: tErr } = await supabase
    .from("recurring_templates" as never)
    .insert({
      company_id: bill.company_id,
      document_type: "purchase_bill",
      name: bill.name,
      contact_id: bill.contact_id,
      currency_code: bill.currency_code,
      owner_user_id: bill.created_by,
      is_active: bill.is_active,
      legacy_recurring_bill_id: recurringBillId,
    } as never)
    .select("id")
    .single();
  if (tErr) throw new Error(tErr.message);
  const templateId = (template as { id: string }).id;

  const { data: version, error: vErr } = await supabase
    .from("recurring_template_versions" as never)
    .insert({
      company_id: bill.company_id,
      template_id: templateId,
      version_no: 1,
      payload: {
        source: "legacy_recurring_bill",
        legacy_id: recurringBillId,
        template: bill.template,
        auto_authorise: bill.auto_authorise,
      },
      created_by: bill.created_by,
    } as never)
    .select("id")
    .single();
  if (vErr) throw new Error(vErr.message);
  const versionId = (version as { id: string }).id;

  await supabase
    .from("recurring_templates" as never)
    .update({ current_version_id: versionId } as never)
    .eq("id" as never, templateId as never);

  const { data: schedule, error: sErr } = await supabase
    .from("recurring_schedules" as never)
    .insert({
      company_id: bill.company_id,
      template_id: templateId,
      mode: "scheduled",
      frequency_legacy: bill.frequency,
      rrule: legacyFrequencyToRrule(bill.frequency),
      dtstart: bill.next_due_date,
      next_occurrence_date: bill.next_due_date,
      auto_authorise: bill.auto_authorise,
      is_paused: !bill.is_active,
      last_generated_on: bill.last_generated_on,
      last_error: bill.last_error,
    } as never)
    .select("id")
    .single();
  if (sErr) throw new Error(sErr.message);

  return { scheduleId: (schedule as { id: string }).id, templateVersionId: versionId };
}
