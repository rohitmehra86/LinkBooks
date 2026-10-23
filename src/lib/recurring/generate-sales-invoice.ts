import type { SupabaseClient } from "@supabase/supabase-js";
import { nextOccurrenceAfter } from "@/lib/recurring/recurrence-engine";
import { buildOccurrenceIdempotencyKey } from "@/lib/recurring/occurrence-key";
import type { LegacyRecurrenceFrequency } from "@/lib/recurring/legacy-frequency";
import { addDaysIso } from "@/lib/sales/line-helpers";
import { prepareSalesLines, loadCompanyDefaults } from "@/lib/sales/sales-common";
import { saveSalesDocument, deleteDraftDocument } from "@/lib/sales/doc-save";
import { postInvoiceAuthorisation } from "@/lib/sales/posting";
import { assertRecurringRunnable, recurringFinished } from "@/lib/sales/recurring-end";
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
    end_date: string | null;
    max_occurrences: number | null;
    occurrences_generated: number | null;
    payment_terms_days: number | null;
    sales_recurring_invoice_lines: Array<{
      line_order: number | null;
      description: string;
      account_id: string;
      quantity: number;
      unit_price_minor: number;
      discount_minor: number;
      tax_rate_bps: number;
      tax_code_id: string | null;
      product_id: string | null;
    }>;
  };
  if (!r.is_active) throw new Error("Recurring invoice is inactive");
  assertRecurringRunnable({
    scheduledDate: r.next_due_date,
    endDate: r.end_date ?? null,
    maxOccurrences: r.max_occurrences ?? null,
    occurrencesGenerated: r.occurrences_generated ?? 0,
  });

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
  const idempotencyKey = buildOccurrenceIdempotencyKey("sales_invoice", scheduleId, scheduledDate);

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

  let invoiceId: string | null = null;
  let journalId: string | null = null;
  try {
    const defaults = await loadCompanyDefaults(supabase, companyId);
    const lines = await prepareSalesLines(
      supabase,
      companyId,
      [...r.sales_recurring_invoice_lines]
        .sort((a, b) => (a.line_order ?? 0) - (b.line_order ?? 0))
        .map((l) => ({
          description: l.description,
          accountId: l.account_id,
          quantity: Number(l.quantity),
          unitPriceMinor: l.unit_price_minor,
          discountMinor: l.discount_minor,
          taxRateBps: l.tax_rate_bps,
          taxCodeId: l.tax_code_id ?? null,
          productId: l.product_id ?? null,
        })),
      scheduledDate,
    );

    // Payment terms: the template's own, else the customer's, else 30 days (AR-15).
    let terms = r.payment_terms_days;
    if (terms === null || terms === undefined) {
      const { data: contact } = await supabase
        .from("contacts" as never)
        .select("payment_terms_days" as never)
        .eq("id" as never, r.contact_id as never)
        .eq("company_id" as never, companyId as never)
        .maybeSingle();
      terms = Number(
        (contact as { payment_terms_days: number | null } | null)?.payment_terms_days ?? 30,
      );
    }
    const currencyIsBase = r.currency_code.toUpperCase() === defaults.baseCurrency;
    if (!currencyIsBase) {
      throw new Error(
        `Recurring invoices in ${r.currency_code} need an exchange rate and are not supported yet — use the base currency (${defaults.baseCurrency})`,
      );
    }

    // Header + lines + document number in one transaction (RPC) or compensated (fallback).
    const saved = await saveSalesDocument(supabase as never, {
      kind: "invoice",
      companyId,
      userId,
      contactId: r.contact_id,
      docDate: scheduledDate,
      dueDate: addDaysIso(scheduledDate, terms),
      memo: r.memo,
      currencyCode: r.currency_code,
      fxRateToBase: 1,
      lines,
    });
    invoiceId = saved.id;

    const autoAuthorise = schedule.auto_authorise ?? r.auto_authorise;
    if (autoAuthorise) {
      await assertCompanyPermission(supabase, companyId, "recurring.auto_authorise");
      await assertCompanyPermission(supabase, companyId, "sales.authorise");
      journalId = await postInvoiceAuthorisation(supabase as never, {
        company_id: companyId,
        invoice_id: saved.id,
        invoice_date: scheduledDate,
        currency_code: r.currency_code,
        ...(r.memo ? { memo: r.memo } : {}),
        lines: lines.map((l) => ({
          account_id: l.accountId,
          description: l.description,
          net_minor: l.net_minor,
          tax_minor: l.tax_minor,
        })),
      });
      const nowIso = new Date().toISOString();
      const { data: claimed, error: authErr } = await supabase
        .from("sales_invoices" as never)
        .update({
          status: "authorised",
          posted_journal_id: journalId,
          authorised_at: nowIso,
          authorised_by: userId,
          updated_at: nowIso,
        } as never)
        .eq("id" as never, saved.id as never)
        .eq("status" as never, "draft" as never)
        .select("id");
      if (authErr) throw new Error(authErr.message);
      if (!claimed || (claimed as unknown[]).length === 0) {
        throw new Error("Generated invoice could not be authorised");
      }
    }

    const computedNext = nextOccurrenceAfter(
      { dtstart: schedule.dtstart, rrule: schedule.rrule },
      scheduledDate,
    );
    const generatedCount = (r.occurrences_generated ?? 0) + 1;
    const end = recurringFinished({
      endDate: r.end_date ?? null,
      maxOccurrences: r.max_occurrences ?? null,
      occurrencesGenerated: generatedCount,
      nextDate: computedNext,
    });
    const nextDate = computedNext ?? scheduledDate;

    // The legacy row is updated first: a failure here still leaves the occurrence retryable.
    const { error: legacyErr } = await supabase
      .from("sales_recurring_invoices" as never)
      .update({
        last_generated_on: scheduledDate,
        last_invoice_id: saved.id,
        next_due_date: nextDate,
        occurrences_generated: generatedCount,
        is_active: !end.finished,
        last_error: end.finished ? end.reason : null,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, recurringId as never);
    if (legacyErr) {
      // Older databases without the new columns: fall back to the original column set.
      if (legacyErr.code !== "42703") throw new Error(legacyErr.message);
      const { error: oldErr } = await supabase
        .from("sales_recurring_invoices" as never)
        .update({
          last_generated_on: scheduledDate,
          last_invoice_id: saved.id,
          next_due_date: nextDate,
          last_error: null,
        } as never)
        .eq("id" as never, recurringId as never);
      if (oldErr) throw new Error(oldErr.message);
    }

    const { error: schedErr } = await supabase
      .from("recurring_schedules" as never)
      .update({
        last_generated_on: scheduledDate,
        next_occurrence_date: nextDate,
        is_paused: end.finished,
        last_error: null,
      } as never)
      .eq("id" as never, scheduleId as never);
    if (schedErr) throw new Error(schedErr.message);

    const { error: completeErr } = await supabase.rpc(
      "recurring_complete_occurrence" as never,
      {
        _occurrence_id: occurrenceId,
        _sales_invoice_id: saved.id,
      } as never,
    );
    if (completeErr) throw new Error(completeErr.message);

    return {
      invoiceId: saved.id,
      journalId,
      nextDueDate: end.finished ? null : nextDate,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Generation failed";
    // Do not leave an orphan draft behind: a retry of the same occurrence would create a duplicate.
    if (invoiceId && !journalId) {
      try {
        await deleteDraftDocument(supabase as never, companyId, "invoice", invoiceId);
      } catch {
        /* best effort — the draft stays visible in the invoice list */
      }
    }
    await supabase.rpc(
      "recurring_complete_occurrence" as never,
      {
        _occurrence_id: occurrenceId,
        _failed_message: message,
      } as never,
    );
    await supabase
      .from("sales_recurring_invoices" as never)
      .update({ last_error: message } as never)
      .eq("id" as never, recurringId as never);
    throw new Error(message);
  }
}
