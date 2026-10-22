import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { previewOccurrences, nextOccurrenceAfter } from "@/lib/recurring/recurrence-engine";
import { legacyFrequencyToRrule } from "@/lib/recurring/legacy-frequency";
import type { LegacyRecurrenceFrequency } from "@/lib/recurring/legacy-frequency";

const companyIdOf = (input: { companyId: string }) => ({
  companyId: assertUuid(input.companyId),
});

export const listRecurringWorkspace = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      documentType?: "purchase_bill" | "sales_invoice";
      q?: string;
      page?: number;
      pageSize?: number;
    }) => ({
      companyId: assertUuid(input.companyId),
      documentType: input.documentType ?? "purchase_bill",
      q: (input.q ?? "").trim().slice(0, 100),
      page: Math.max(0, Math.floor(Number(input.page ?? 0))),
      pageSize: Math.min(100, Math.max(10, Math.floor(Number(input.pageSize ?? 25)))),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const from = data.page * data.pageSize;
    const to = from + data.pageSize - 1;

    let q = context.supabase
      .from("recurring_templates" as never)
      .select(
        "id, name, document_type, is_active, currency_code, contact_id, legacy_recurring_bill_id, legacy_sales_recurring_invoice_id, contacts(name), recurring_schedules(id, next_occurrence_date, mode, auto_authorise, is_paused, last_error, frequency_legacy)" as never,
        { count: "exact" },
      )
      .eq("company_id" as never, data.companyId as never)
      .eq("document_type" as never, data.documentType as never)
      .is("archived_at" as never, null)
      .order("name" as never)
      .range(from, to);

    if (data.q) {
      q = q.ilike("name" as never, `%${data.q}%` as never);
    }

    const { data: rows, error, count } = await q;
    if (error) throw new Error(error.message);

    return { rows: rows ?? [], total: count ?? 0, page: data.page, pageSize: data.pageSize };
  });

export const getRecurringBillWorkspaceDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; recurringBillId: string }) => ({
    companyId: assertUuid(input.companyId),
    recurringBillId: assertUuid(input.recurringBillId),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const { data: rb, error } = await context.supabase
      .from("recurring_bills" as never)
      .select("*, contacts(name)" as never)
      .eq("id" as never, data.recurringBillId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!rb) throw new Error("Not found");

    const { data: tpl } = await context.supabase
      .from("recurring_templates" as never)
      .select("id, recurring_schedules(*)" as never)
      .eq("legacy_recurring_bill_id" as never, data.recurringBillId as never)
      .maybeSingle();

    return { bill: rb, v2: tpl ?? null };
  });

export const updateRecurringBillWorkspace = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      recurringBillId: string;
      name?: string;
      nextDueDate?: string;
      frequency?: LegacyRecurrenceFrequency;
      autoAuthorise?: boolean;
      isActive?: boolean;
      mode?: "scheduled" | "reminder" | "on_demand";
    }) => ({
      companyId: assertUuid(input.companyId),
      recurringBillId: assertUuid(input.recurringBillId),
      name: input.name?.trim(),
      nextDueDate: input.nextDueDate,
      frequency: input.frequency,
      autoAuthorise: input.autoAuthorise,
      isActive: input.isActive,
      mode: input.mode,
    }),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyPermission(supabase, data.companyId, "purchases.draft");
    if (data.autoAuthorise === true) {
      await assertCompanyPermission(supabase, data.companyId, "recurring.auto_authorise");
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (data.name) patch.name = data.name;
    if (data.nextDueDate) patch.next_due_date = data.nextDueDate;
    if (data.frequency) patch.frequency = data.frequency;
    if (data.autoAuthorise !== undefined) patch.auto_authorise = data.autoAuthorise;
    if (data.isActive !== undefined) patch.is_active = data.isActive;

    const { error } = await supabase
      .from("recurring_bills" as never)
      .update(patch as never)
      .eq("id" as never, data.recurringBillId as never)
      .eq("company_id" as never, data.companyId as never);
    if (error) throw new Error(error.message);

    const { data: tpl } = await supabase
      .from("recurring_templates" as never)
      .select("id" as never)
      .eq("legacy_recurring_bill_id" as never, data.recurringBillId as never)
      .maybeSingle();
    if (tpl) {
      const schedPatch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (data.nextDueDate) schedPatch.next_occurrence_date = data.nextDueDate;
      if (data.frequency) {
        schedPatch.frequency_legacy = data.frequency;
        schedPatch.rrule = legacyFrequencyToRrule(data.frequency);
      }
      if (data.autoAuthorise !== undefined) schedPatch.auto_authorise = data.autoAuthorise;
      if (data.isActive !== undefined) schedPatch.is_paused = !data.isActive;
      if (data.mode) schedPatch.mode = data.mode;
      await supabase
        .from("recurring_schedules" as never)
        .update(schedPatch as never)
        .eq("template_id" as never, (tpl as { id: string }).id as never);
    }

    return { ok: true };
  });

export const previewRecurringSchedule = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; recurringBillId: string; count?: number }) => ({
    companyId: assertUuid(input.companyId),
    recurringBillId: assertUuid(input.recurringBillId),
    count: Math.min(24, Math.max(1, Math.floor(Number(input.count ?? 12)))),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const { data: rb } = await context.supabase
      .from("recurring_bills" as never)
      .select("next_due_date, frequency" as never)
      .eq("id" as never, data.recurringBillId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (!rb) throw new Error("Not found");
    const row = rb as { next_due_date: string; frequency: LegacyRecurrenceFrequency };
    const rrule = legacyFrequencyToRrule(row.frequency);
    const dates = previewOccurrences(
      { dtstart: row.next_due_date, rrule },
      row.next_due_date,
      data.count,
    );
    return { dates };
  });

export const listRecurringOccurrenceHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; recurringBillId: string }) => ({
    companyId: assertUuid(input.companyId),
    recurringBillId: assertUuid(input.recurringBillId),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const { data: tpl } = await context.supabase
      .from("recurring_templates" as never)
      .select("id, recurring_schedules(id)" as never)
      .eq("legacy_recurring_bill_id" as never, data.recurringBillId as never)
      .maybeSingle();
    const schedule = (tpl as { recurring_schedules?: { id: string } | { id: string }[] } | null)
      ?.recurring_schedules;
    const scheduleId = Array.isArray(schedule) ? schedule[0]?.id : schedule?.id;
    if (!scheduleId) return { rows: [] };

    const { data: rows, error } = await context.supabase
      .from("recurring_occurrences" as never)
      .select(
        "id, scheduled_date, status, purchase_bill_id, error_message, completed_at, created_at" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .eq("schedule_id" as never, scheduleId as never)
      .order("scheduled_date" as never, { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return { rows: rows ?? [] };
  });

export const skipNextRecurringBillOccurrence = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; recurringBillId: string }) => ({
    companyId: assertUuid(input.companyId),
    recurringBillId: assertUuid(input.recurringBillId),
  }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "purchases.draft");
    const { data: rb } = await supabase
      .from("recurring_bills" as never)
      .select("next_due_date, frequency" as never)
      .eq("id" as never, data.recurringBillId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (!rb) throw new Error("Not found");
    const row = rb as { next_due_date: string; frequency: LegacyRecurrenceFrequency };

    const { data: tpl } = await supabase
      .from("recurring_templates" as never)
      .select("id, recurring_schedules(id, dtstart, rrule)" as never)
      .eq("legacy_recurring_bill_id" as never, data.recurringBillId as never)
      .maybeSingle();
    const schedRaw = (tpl as { recurring_schedules?: { id: string; dtstart: string; rrule: string } | { id: string; dtstart: string; rrule: string }[] })?.recurring_schedules;
    const sched = Array.isArray(schedRaw) ? schedRaw[0] : schedRaw;
    if (!sched) throw new Error("Schedule not found");

    await supabase.from("recurring_schedule_exceptions" as never).insert({
      company_id: data.companyId,
      schedule_id: sched.id,
      exception_date: row.next_due_date,
      exception_type: "skip",
      created_by: userId,
      note: "Skip next occurrence",
    } as never);

    const next =
      nextOccurrenceAfter({ dtstart: sched.dtstart, rrule: sched.rrule }, row.next_due_date) ??
      row.next_due_date;

    await supabase
      .from("recurring_bills" as never)
      .update({ next_due_date: next, updated_at: new Date().toISOString() } as never)
      .eq("id" as never, data.recurringBillId as never);

    await supabase
      .from("recurring_schedules" as never)
      .update({ next_occurrence_date: next, updated_at: new Date().toISOString() } as never)
      .eq("id" as never, sched.id as never);

    return { nextDueDate: next };
  });

export const listRecurringExceptions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(companyIdOf)
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const { data: rows, error } = await context.supabase
      .from("recurring_occurrences" as never)
      .select(
        "id, schedule_id, scheduled_date, status, error_message, purchase_bill_id, sales_invoice_id, recurring_schedules(recurring_templates(name, document_type))" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .in("status" as never, ["failed", "needs_input"] as never)
      .order("scheduled_date" as never, { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return { rows: rows ?? [] };
  });

export const getRecurringForecast = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; days?: number }) => ({
    companyId: assertUuid(input.companyId),
    days: Math.min(365, Math.max(7, Math.floor(Number(input.days ?? 90)))),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const today = new Date().toISOString().slice(0, 10);
    const end = new Date(`${today}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + data.days);
    const endIso = end.toISOString().slice(0, 10);

    const { data: schedules, error } = await context.supabase
      .from("recurring_schedules" as never)
      .select(
        "id, next_occurrence_date, rrule, dtstart, recurring_templates(name, document_type, currency_code, is_active)" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .eq("is_paused" as never, false as never)
      .lte("next_occurrence_date" as never, endIso as never);
    if (error) throw new Error(error.message);

    const items: Array<{ date: string; name: string; documentType: string; scheduleId: string }> =
      [];
    for (const s of schedules ?? []) {
      const row = s as {
        id: string;
        next_occurrence_date: string;
        rrule: string;
        dtstart: string;
        recurring_templates: { name: string; document_type: string; is_active: boolean };
      };
      if (!row.recurring_templates?.is_active) continue;
      const dates = previewOccurrences(
        { dtstart: row.dtstart, rrule: row.rrule },
        row.next_occurrence_date,
        12,
      ).filter((d) => d >= today && d <= endIso);
      for (const d of dates) {
        items.push({
          date: d,
          name: row.recurring_templates.name,
          documentType: row.recurring_templates.document_type,
          scheduleId: row.id,
        });
      }
    }
    items.sort((a, b) => a.date.localeCompare(b.date));
    return { items, estimateDisclaimer: true };
  });

export const duplicateRecurringBill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; recurringBillId: string }) => ({
    companyId: assertUuid(input.companyId),
    recurringBillId: assertUuid(input.recurringBillId),
  }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "purchases.draft");
    const { data: src, error } = await supabase
      .from("recurring_bills" as never)
      .select("*" as never)
      .eq("id" as never, data.recurringBillId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!src) throw new Error("Not found");
    const s = src as {
      contact_id: string;
      name: string;
      frequency: LegacyRecurrenceFrequency;
      next_due_date: string;
      currency_code: string;
      auto_authorise: boolean;
      template: unknown;
    };

    const { data: inserted, error: insErr } = await supabase
      .from("recurring_bills" as never)
      .insert({
        company_id: data.companyId,
        contact_id: s.contact_id,
        name: `${s.name} (copy)`,
        frequency: s.frequency,
        next_due_date: s.next_due_date,
        currency_code: s.currency_code,
        auto_authorise: false,
        template: s.template,
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (insErr) throw new Error(insErr.message);
    const id = (inserted as { id: string }).id;
    const { ensureV2ForLegacyRecurringBill } = await import("@/lib/recurring/v2-sync");
    await ensureV2ForLegacyRecurringBill(supabase, id);
    return { id };
  });
