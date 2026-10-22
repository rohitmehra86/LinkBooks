import type { SupabaseClient } from "@supabase/supabase-js";
import { nextOccurrenceAfter } from "@/lib/recurring/recurrence-engine";
import { buildOccurrenceIdempotencyKey } from "@/lib/recurring/occurrence-key";
import { ensureV2ForLegacyRecurringBill } from "@/lib/recurring/v2-sync";
import { sumLines } from "@/lib/purchases/line-math";
import type { LegacyRecurrenceFrequency } from "@/lib/recurring/legacy-frequency";
import { assertCompanyPermission } from "@/lib/assert-company-access";
import { addCalendarDays, parseScheduleOptions } from "@/lib/recurring/recurring-schedule-options";
import { generatedDraftHeader, type RecurringTemplateDocument } from "@/lib/purchases/recurring-template";

export type BillLineIn = {
  description: string;
  accountId: string;
  quantity: number;
  unitPriceMinor: number;
  discountMinor?: number;
  taxRateBps?: number;
};

export async function generatePurchaseBillFromRecurring(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  recurringId: string,
  deps: {
    validateBillLines: (lines: BillLineIn[]) => Array<BillLineIn & { net_minor: bigint; tax_minor: bigint }>;
    authoriseBill: (
      sb: SupabaseClient,
      uid: string,
      cid: string,
      billId: string,
    ) => Promise<void>;
  },
): Promise<{ billId: string; authorised: boolean; occurrenceId?: string }> {
  const { data: rb, error } = await supabase
    .from("recurring_bills" as never)
    .select("*" as never)
    .eq("id" as never, recurringId as never)
    .eq("company_id" as never, companyId as never)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!rb) throw new Error("Recurring bill not found");

  const r = rb as {
    is_active: boolean;
    next_due_date: string;
    last_generated_on: string | null;
    contact_id: string;
    currency_code: string;
    auto_authorise: boolean;
    frequency: LegacyRecurrenceFrequency;
    template: {
      lines: BillLineIn[];
      scheduleOptions?: unknown;
      document?: RecurringTemplateDocument | null;
    };
  };

  if (!r.is_active) throw new Error("Recurring bill is inactive");

  const { scheduleId, templateVersionId } = await ensureV2ForLegacyRecurringBill(
    supabase,
    recurringId,
  );

  const { data: scheduleRow } = await supabase
    .from("recurring_schedules" as never)
    .select("id, rrule, dtstart, auto_authorise, is_paused" as never)
    .eq("id" as never, scheduleId as never)
    .maybeSingle();
  if (!scheduleRow) throw new Error("Recurring schedule not found");
  const schedule = scheduleRow as {
    rrule: string;
    dtstart: string;
    auto_authorise: boolean;
    is_paused: boolean;
  };
  if (schedule.is_paused) throw new Error("Recurring bill is inactive");

  const scheduledDate = r.next_due_date;
  const idempotencyKey = buildOccurrenceIdempotencyKey(
    "purchase_bill",
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
    purchase_bill_id?: string;
  };

  if (claim.action === "already_completed" && claim.purchase_bill_id) {
    return { billId: claim.purchase_bill_id, authorised: false, occurrenceId: claim.occurrence_id };
  }
  if (claim.action === "in_progress") {
    throw new Error("Generation already in progress for this occurrence");
  }

  const occurrenceId = claim.occurrence_id;
  if (!occurrenceId) throw new Error("Failed to claim occurrence");

  try {
    const lines = deps.validateBillLines(r.template.lines);
    const totals = sumLines(lines);
    const scheduleOpts = parseScheduleOptions(r.template.scheduleOptions ?? {});
    const doc = r.template.document ?? null;
    const header = generatedDraftHeader({
      contactId: r.contact_id,
      currencyCode: r.currency_code,
      nextDueDate: scheduledDate,
      document: doc,
    });
    const dueDate = doc?.dueDateManualOverride && doc.dueDate
      ? doc.dueDate
      : addCalendarDays(scheduledDate, scheduleOpts.dueDaysAfterBillDate || 0);
    const memo = doc?.memo?.trim() || scheduleOpts.memo?.trim() || "Generated from recurring bill";
    const { data: bill, error: bErr } = await supabase
      .from("purchase_bills" as never)
      .insert({
        company_id: companyId,
        ...header,
        bill_date: scheduledDate,
        due_date: dueDate,
        status: "draft",
        memo,
        subtotal_minor: Number(totals.subtotal_minor),
        tax_minor: Number(totals.tax_minor),
        total_minor: Number(totals.total_minor),
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (bErr) throw new Error(bErr.message);
    const billId = (bill as { id: string }).id;

    await supabase.from("purchase_bill_lines" as never).insert(
      lines.map((l, i) => ({
        company_id: companyId,
        bill_id: billId,
        line_no: i + 1,
        description: l.description,
        account_id: l.accountId,
        quantity: l.quantity,
        unit_price_minor: l.unitPriceMinor,
        discount_minor: l.discountMinor,
        tax_rate_bps: l.taxRateBps,
        net_minor: Number(l.net_minor),
        tax_minor: Number(l.tax_minor),
        product_id: "productId" in l ? (l as { productId?: string | null }).productId ?? null : null,
        tax_code_id: "taxCodeId" in l ? (l as { taxCodeId?: string | null }).taxCodeId ?? null : null,
        class_option_id: "classOptionId" in l ? (l as { classOptionId?: string | null }).classOptionId ?? null : null,
        location_option_id: "locationOptionId" in l ? (l as { locationOptionId?: string | null }).locationOptionId ?? null : null,
        project_option_id: "projectOptionId" in l ? (l as { projectOptionId?: string | null }).projectOptionId ?? null : null,
        customer_contact_id: "customerContactId" in l ? (l as { customerContactId?: string | null }).customerContactId ?? null : null,
        is_billable: "isBillable" in l ? Boolean((l as { isBillable?: boolean }).isBillable) : false,
      })) as never,
    );
    const notes = doc?.notes ?? [];
    if (notes.length) {
      await supabase.from("bill_internal_notes" as never).insert(
        notes.map((body) => ({
          company_id: companyId,
          bill_id: billId,
          body,
          created_by: userId,
        })) as never,
      );
    }

    const autoAuthorise = schedule.auto_authorise ?? r.auto_authorise;
    let authorised = false;
    if (autoAuthorise) {
      await assertCompanyPermission(supabase, companyId, "recurring.auto_authorise");
      await deps.authoriseBill(supabase, userId, companyId, billId);
      authorised = true;
    }

    const nextDate =
      nextOccurrenceAfter({ dtstart: schedule.dtstart, rrule: schedule.rrule }, scheduledDate) ??
      scheduledDate;

    await supabase.rpc("recurring_complete_occurrence" as never, {
      _occurrence_id: occurrenceId,
      _purchase_bill_id: billId,
    } as never);

    await supabase
      .from("recurring_bills" as never)
      .update({
        last_generated_on: scheduledDate,
        next_due_date: nextDate,
        last_error: null,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, recurringId as never);

    const { data: schedNow } = await supabase
      .from("recurring_schedules" as never)
      .select("occurrence_count" as never)
      .eq("id" as never, scheduleId as never)
      .single();
    const count = Number((schedNow as { occurrence_count: number } | null)?.occurrence_count ?? 0);

    await supabase
      .from("recurring_schedules" as never)
      .update({
        last_generated_on: scheduledDate,
        next_occurrence_date: nextDate,
        last_error: null,
        occurrence_count: count + 1,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, scheduleId as never);

    return { billId, authorised, occurrenceId };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Generation failed";
    await supabase.rpc("recurring_complete_occurrence" as never, {
      _occurrence_id: occurrenceId,
      _failed_message: message,
    } as never);
    await supabase
      .from("recurring_bills" as never)
      .update({ last_error: message, updated_at: new Date().toISOString() } as never)
      .eq("id" as never, recurringId as never);
    await supabase
      .from("recurring_schedules" as never)
      .update({ last_error: message, updated_at: new Date().toISOString() } as never)
      .eq("id" as never, scheduleId as never);
    throw new Error(message);
  }
}
