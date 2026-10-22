import type { SupabaseClient } from "@supabase/supabase-js";
import { nextOccurrenceAfter } from "@/lib/recurring/recurrence-engine";
import { buildOccurrenceIdempotencyKey } from "@/lib/recurring/occurrence-key";
import type { LegacyRecurrenceFrequency } from "@/lib/recurring/legacy-frequency";
import { validateSalesLines, sumLines } from "@/lib/sales/line-helpers";
import { loadTaxTreatment } from "@/lib/sales/sales.functions";
import { postInvoiceAuthorisation } from "@/lib/sales/posting";
import { assertCompanyPermission } from "@/lib/assert-company-access";

import { ensureV2ForLegacySalesRecurring } from "@/lib/recurring/v2-sync-sales";

export async function generateSalesInvoiceFromRecurring(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  recurringId: string,
): Promise<{ invoiceId: string; journalId: string | null; nextDueDate: string | null }> {
  await assertCompanyPermission(supabase, companyId, "sales.draft");
  const { data: rec, error } = await supabase
    .from("sales_recurring_invoices" as never)
    .select("*, sales_recurring_invoice_lines(*)" as never)
    .eq("id" as never, recurringId as never)
    .eq("company_id" as never, companyId as never)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!rec) throw new Error("Recurring invoice not found");

  const r = rec as unknown as {
    is_active: boolean;
    contact_id: string;
    next_due_date: string;
    currency_code: string;
    memo: string | null;
    frequency: LegacyRecurrenceFrequency;
    auto_authorise: boolean;
    sales_recurring_invoice_lines: Array<{
      description: string;
      account_id: string;
      quantity: number;
      unit_price_minor: number;
      discount_minor: number;
      tax_rate_bps: number;
    }>;
  };
  if (!r.is_active) throw new Error("Recurring invoice is inactive");

  const { scheduleId, templateVersionId } = await ensureV2ForLegacySalesRecurring(
    supabase,
    recurringId,
  );
  const { data: scheduleRow } = await supabase
    .from("recurring_schedules" as never)
    .select("rrule, dtstart, auto_authorise, is_paused" as never)
    .eq("id" as never, scheduleId as never)
    .maybeSingle();
  if (!scheduleRow) throw new Error("Schedule not found");
  const schedule = scheduleRow as unknown as {
    rrule: string;
    dtstart: string;
    auto_authorise: boolean;
    is_paused: boolean;
  };
  if (schedule.is_paused) throw new Error("Recurring invoice is inactive");

  const scheduledDate = r.next_due_date;
  const idempotencyKey = buildOccurrenceIdempotencyKey(
    "sales_invoice",
    scheduleId,
    scheduledDate,
  );

  const { data: claimRaw, error: claimErr } = await supabase.rpc(
    "recurring_claim_occurrence" as never,
    {
      _company_id: companyId,
      _schedule_id: scheduleId,
      _scheduled_date: scheduledDate,
      _document_date: scheduledDate,
      _template_version_id: templateVersionId,
      _idempotency_key: idempotencyKey,
    } as never,
  );
  if (claimErr) throw new Error(claimErr.message);
  const claim = claimRaw as {
    action: string;
    occurrence_id?: string;
    sales_invoice_id?: string;
  };
  if (claim.action === "already_completed" && claim.sales_invoice_id) {
    return { invoiceId: claim.sales_invoice_id, journalId: null, nextDueDate: null };
  }
  if (claim.action === "in_progress") {
    throw new Error("Generation already in progress for this occurrence");
  }
  const occurrenceId = claim.occurrence_id;
  if (!occurrenceId) throw new Error("Failed to claim occurrence");

  try {
    const treatment = await loadTaxTreatment(supabase, companyId);
    const validated = validateSalesLines(
      r.sales_recurring_invoice_lines.map((l) => ({
        description: l.description,
        accountId: l.account_id,
        quantity: Number(l.quantity),
        unitPriceMinor: l.unit_price_minor,
        discountMinor: l.discount_minor,
        taxRateBps: l.tax_rate_bps,
      })),
      { treatment },
    );
    const totals = sumLines(validated);
    const due = (() => {
      const d = new Date(`${scheduledDate}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 30);
      return d.toISOString().slice(0, 10);
    })();

    const { data: inserted, error: insErr } = await supabase
      .from("sales_invoices" as never)
      .insert({
        company_id: companyId,
        contact_id: r.contact_id,
        invoice_date: scheduledDate,
        due_date: due,
        memo: r.memo,
        currency_code: r.currency_code,
        status: "draft",
        subtotal_minor: Number(totals.subtotal_minor),
        tax_minor: Number(totals.tax_minor),
        total_minor: Number(totals.total_minor),
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (insErr) throw new Error(insErr.message);
    const invoiceId = (inserted as { id: string }).id;

    await supabase.from("sales_invoice_lines" as never).insert(
      validated.map((l, i) => ({
        company_id: companyId,
        invoice_id: invoiceId,
        line_order: i + 1,
        description: l.description,
        account_id: l.accountId,
        quantity: l.quantity,
        unit_price_minor: l.unitPriceMinor,
        discount_minor: l.discountMinor,
        tax_rate_bps: l.taxRateBps,
        net_minor: Number(l.net_minor),
        tax_minor: Number(l.tax_minor),
        gross_minor: Number(l.gross_minor),
      })) as never,
    );

    let journalId: string | null = null;
    const autoAuthorise = schedule.auto_authorise ?? r.auto_authorise;
    if (autoAuthorise) {
      await assertCompanyPermission(supabase, companyId, "recurring.auto_authorise");
      await assertCompanyPermission(supabase, companyId, "sales.authorise");
      journalId = await postInvoiceAuthorisation(supabase, {
        company_id: companyId,
        invoice_id: invoiceId,
        invoice_date: scheduledDate,
        currency_code: r.currency_code,
        ...(r.memo ? { memo: r.memo } : {}),
        lines: validated.map((l) => ({
          account_id: l.accountId,
          description: l.description,
          net_minor: l.net_minor,
          tax_minor: l.tax_minor,
        })),
      });
      await supabase
        .from("sales_invoices" as never)
        .update({
          status: "authorised",
          posted_journal_id: journalId,
          authorised_at: new Date().toISOString(),
          authorised_by: userId,
        } as never)
        .eq("id" as never, invoiceId as never);
    }

    const nextDate =
      nextOccurrenceAfter({ dtstart: schedule.dtstart, rrule: schedule.rrule }, scheduledDate) ??
      scheduledDate;

    await supabase.rpc("recurring_complete_occurrence" as never, {
      _occurrence_id: occurrenceId,
      _sales_invoice_id: invoiceId,
    } as never);

    await supabase
      .from("sales_recurring_invoices" as never)
      .update({
        last_generated_on: scheduledDate,
        last_invoice_id: invoiceId,
        next_due_date: nextDate,
        last_error: null,
      } as never)
      .eq("id" as never, recurringId as never);

    await supabase
      .from("recurring_schedules" as never)
      .update({
        last_generated_on: scheduledDate,
        next_occurrence_date: nextDate,
        last_error: null,
      } as never)
      .eq("id" as never, scheduleId as never);

    return { invoiceId, journalId, nextDueDate: nextDate };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Generation failed";
    await supabase.rpc("recurring_complete_occurrence" as never, {
      _occurrence_id: occurrenceId,
      _failed_message: message,
    } as never);
    await supabase
      .from("sales_recurring_invoices" as never)
      .update({ last_error: message } as never)
      .eq("id" as never, recurringId as never);
    throw new Error(message);
  }
}
