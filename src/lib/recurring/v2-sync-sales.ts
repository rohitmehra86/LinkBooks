import type { SupabaseClient } from "@supabase/supabase-js";
import { legacyFrequencyToRrule, type LegacyRecurrenceFrequency } from "@/lib/recurring/legacy-frequency";

type RpcClient = { from: SupabaseClient["from"] };

export async function ensureV2ForLegacySalesRecurring(
  supabase: RpcClient,
  recurringInvoiceId: string,
): Promise<{ scheduleId: string; templateVersionId: string | null }> {
  const { data: existing } = await supabase
    .from("recurring_templates" as never)
    .select("id, current_version_id" as never)
    .eq("legacy_sales_recurring_invoice_id" as never, recurringInvoiceId as never)
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

  const { data: ri, error: riErr } = await supabase
    .from("sales_recurring_invoices" as never)
    .select("*" as never)
    .eq("id" as never, recurringInvoiceId as never)
    .maybeSingle();
  if (riErr) throw new Error(riErr.message);
  if (!ri) throw new Error("Recurring invoice not found");

  const inv = ri as {
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
    memo: string | null;
    created_at: string;
    updated_at: string;
  };

  const { data: lines } = await supabase
    .from("sales_recurring_invoice_lines" as never)
    .select("*" as never)
    .eq("recurring_id" as never, recurringInvoiceId as never);

  const { data: template, error: tErr } = await supabase
    .from("recurring_templates" as never)
    .insert({
      company_id: inv.company_id,
      document_type: "sales_invoice",
      name: inv.name,
      contact_id: inv.contact_id,
      currency_code: inv.currency_code,
      owner_user_id: inv.created_by,
      is_active: inv.is_active,
      legacy_sales_recurring_invoice_id: recurringInvoiceId,
    } as never)
    .select("id")
    .single();
  if (tErr) throw new Error(tErr.message);
  const templateId = (template as { id: string }).id;

  const { data: version, error: vErr } = await supabase
    .from("recurring_template_versions" as never)
    .insert({
      company_id: inv.company_id,
      template_id: templateId,
      version_no: 1,
      payload: {
        source: "legacy_sales_recurring_invoice",
        legacy_id: recurringInvoiceId,
        memo: inv.memo,
        auto_authorise: inv.auto_authorise,
        lines: lines ?? [],
      },
      created_by: inv.created_by,
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
      company_id: inv.company_id,
      template_id: templateId,
      mode: "scheduled",
      frequency_legacy: inv.frequency,
      rrule: legacyFrequencyToRrule(inv.frequency),
      dtstart: inv.next_due_date,
      next_occurrence_date: inv.next_due_date,
      auto_authorise: inv.auto_authorise,
      is_paused: !inv.is_active,
      last_generated_on: inv.last_generated_on,
      last_error: inv.last_error,
    } as never)
    .select("id")
    .single();
  if (sErr) throw new Error(sErr.message);

  return { scheduleId: (schedule as { id: string }).id, templateVersionId: versionId };
}
