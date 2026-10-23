import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import type { SalesLineInput } from "@/lib/sales/line-helpers";
import { callSalesRpc, requireRpc, type SalesClient } from "@/lib/sales/rpc";
import {
  isIsoDate,
  loadCompanyDefaults,
  normaliseCurrencyAndFx,
  optionalIsoDate,
  parseSalesLineInputs,
  prepareSalesLines,
  sortLines,
} from "@/lib/sales/sales-common";

const FREQUENCIES = ["weekly", "monthly", "quarterly", "yearly"] as const;

export type RecurringListRow = {
  id: string;
  name: string;
  frequency: string;
  next_due_date: string;
  is_active: boolean;
  auto_authorise: boolean;
  last_generated_on: string | null;
  last_error: string | null;
  end_date: string | null;
  max_occurrences: number | null;
  occurrences_generated: number | null;
  contact_id: string;
  contacts: { name: string } | null;
};

export const listRecurringInvoices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const cols =
      "id, name, frequency, next_due_date, is_active, auto_authorise, last_generated_on, last_error, contact_id, contacts(name)";
    let res = await context.supabase
      .from("sales_recurring_invoices" as never)
      .select(`${cols}, end_date, max_occurrences, occurrences_generated` as never)
      .eq("company_id" as never, data.companyId as never)
      .order("next_due_date" as never)
      .limit(200);
    if (res.error?.code === "42703") {
      res = await context.supabase
        .from("sales_recurring_invoices" as never)
        .select(cols as never)
        .eq("company_id" as never, data.companyId as never)
        .order("next_due_date" as never)
        .limit(200);
    }
    if (res.error) throw new Error(res.error.message);
    return ((res.data ?? []) as unknown as Array<Partial<RecurringListRow>>).map((r) => ({
      end_date: null,
      max_occurrences: null,
      occurrences_generated: 0,
      ...r,
    })) as RecurringListRow[];
  });

export type RecurringDetail = RecurringListRow & {
  currency_code: string;
  memo: string | null;
  payment_terms_days: number | null;
  sales_recurring_invoice_lines: Array<{
    id: string;
    line_order: number;
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

export const getRecurringInvoice = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; recurringId: string }) => ({
    companyId: assertUuid(input.companyId),
    recurringId: assertUuid(input.recurringId, "recurring invoice"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: row, error } = await context.supabase
      .from("sales_recurring_invoices" as never)
      .select("*, contacts(name), sales_recurring_invoice_lines(*)" as never)
      .eq("id" as never, data.recurringId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Recurring invoice not found");
    const r = row as unknown as RecurringDetail;
    return {
      ...r,
      end_date: r.end_date ?? null,
      max_occurrences: r.max_occurrences ?? null,
      occurrences_generated: r.occurrences_generated ?? 0,
      payment_terms_days: r.payment_terms_days ?? null,
      sales_recurring_invoice_lines: sortLines(r.sales_recurring_invoice_lines ?? []),
    } as RecurringDetail;
  });

async function assertCustomer(supabase: SalesClient, companyId: string, contactId: string) {
  const { data, error } = await supabase
    .from("contacts" as never)
    .select("id, kind, is_active" as never)
    .eq("id" as never, contactId as never)
    .eq("company_id" as never, companyId as never)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const c = data as { kind: string; is_active: boolean } | null;
  if (!c) throw new Error("Customer not found in this organisation");
  if (!["customer", "both"].includes(c.kind) || !c.is_active) {
    throw new Error("Contact is not an active customer");
  }
}

export const saveRecurringInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      recurringId?: string;
      contactId: string;
      name: string;
      frequency: string;
      nextDueDate: string;
      endDate?: string | null;
      maxOccurrences?: number | null;
      paymentTermsDays?: number | null;
      currencyCode: string;
      autoAuthorise?: boolean;
      memo?: string;
      lines: SalesLineInput[];
    }) => {
      const name = (input.name ?? "").trim();
      if (!name) throw new Error("Name is required");
      if (!(FREQUENCIES as readonly string[]).includes(input.frequency)) {
        throw new Error("Invalid frequency");
      }
      if (!isIsoDate(input.nextDueDate)) throw new Error("Next due date must be YYYY-MM-DD");
      const endDate = optionalIsoDate(input.endDate, "End date");
      if (endDate && endDate < input.nextDueDate) {
        throw new Error("End date cannot be before the next due date");
      }
      let max: number | null = null;
      if (input.maxOccurrences !== undefined && input.maxOccurrences !== null) {
        max = Math.round(Number(input.maxOccurrences));
        if (!(max >= 1) || max > 1000)
          throw new Error("Maximum invoices must be between 1 and 1000");
      }
      let terms: number | null = null;
      if (input.paymentTermsDays !== undefined && input.paymentTermsDays !== null) {
        terms = Math.round(Number(input.paymentTermsDays));
        if (!(terms >= 0) || terms > 365) throw new Error("Payment terms must be 0–365 days");
      }
      return {
        companyId: assertUuid(input.companyId),
        recurringId: input.recurringId
          ? assertUuid(input.recurringId, "recurring invoice")
          : undefined,
        contactId: assertUuid(input.contactId, "customer"),
        name: name.slice(0, 120),
        frequency: input.frequency,
        nextDueDate: input.nextDueDate,
        endDate,
        maxOccurrences: max,
        paymentTermsDays: terms,
        currencyCode: input.currencyCode ?? "",
        autoAuthorise: Boolean(input.autoAuthorise),
        memo: (input.memo ?? "").trim().slice(0, 500) || null,
        lines: parseSalesLineInputs(input.lines),
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "sales.draft");
    await assertCustomer(supabase, data.companyId, data.contactId);
    const defaults = await loadCompanyDefaults(supabase, data.companyId);
    const { currencyCode } = normaliseCurrencyAndFx(data.currencyCode, defaults.baseCurrency, 1);
    if (currencyCode !== defaults.baseCurrency) {
      throw new Error(
        `Recurring invoices must be in the base currency (${defaults.baseCurrency}) — exchange rates change on every run`,
      );
    }
    // Validate lines exactly as a normal invoice would be (tax codes, accounts, rounding).
    const lines = await prepareSalesLines(supabase, data.companyId, data.lines, data.nextDueDate);

    const header = {
      contact_id: data.contactId,
      name: data.name,
      frequency: data.frequency,
      next_due_date: data.nextDueDate,
      currency_code: currencyCode,
      auto_authorise: data.autoAuthorise,
      memo: data.memo,
      end_date: data.endDate,
      max_occurrences: data.maxOccurrences,
      payment_terms_days: data.paymentTermsDays,
    };
    const headerLegacy = {
      contact_id: data.contactId,
      name: data.name,
      frequency: data.frequency,
      next_due_date: data.nextDueDate,
      currency_code: currencyCode,
      auto_authorise: data.autoAuthorise,
      memo: data.memo,
    };
    const lineRows = (recurringId: string) =>
      lines.map((l, i) => ({
        company_id: data.companyId,
        recurring_id: recurringId,
        line_order: i + 1,
        description: l.description,
        account_id: l.accountId,
        quantity: l.quantity,
        unit_price_minor: l.unitPriceMinor,
        discount_minor: l.discountMinor ?? 0,
        tax_rate_bps: l.taxRateBps ?? 0,
        tax_code_id: l.taxCodeId ?? null,
        product_id: l.productId ?? null,
      }));
    const lineRowsLegacy = (recurringId: string) =>
      lineRows(recurringId).map(({ tax_code_id: _t, product_id: _p, ...rest }) => rest);

    const { syncV2FromLegacySalesRecurring, ensureV2ForLegacySalesRecurring } =
      await import("@/lib/recurring/v2-sync-sales");

    // ---- edit ----
    if (data.recurringId) {
      const id = data.recurringId;
      const { data: old, error: oErr } = await supabase
        .from("sales_recurring_invoices" as never)
        .select("*, sales_recurring_invoice_lines(*)" as never)
        .eq("id" as never, id as never)
        .eq("company_id" as never, data.companyId as never)
        .maybeSingle();
      if (oErr) throw new Error(oErr.message);
      if (!old) throw new Error("Recurring invoice not found");
      const prior = old as unknown as {
        sales_recurring_invoice_lines: Array<Record<string, unknown>>;
      };

      let up = await supabase
        .from("sales_recurring_invoices" as never)
        .update({ ...header, updated_at: new Date().toISOString() } as never)
        .eq("id" as never, id as never)
        .eq("company_id" as never, data.companyId as never);
      let legacyCols = false;
      if (up.error?.code === "42703") {
        legacyCols = true;
        up = await supabase
          .from("sales_recurring_invoices" as never)
          .update({ ...headerLegacy, updated_at: new Date().toISOString() } as never)
          .eq("id" as never, id as never)
          .eq("company_id" as never, data.companyId as never);
      }
      if (up.error) throw new Error(up.error.message);

      const { error: dErr } = await supabase
        .from("sales_recurring_invoice_lines" as never)
        .delete()
        .eq("recurring_id" as never, id as never);
      if (dErr) throw new Error(dErr.message);
      const { error: iErr } = await supabase
        .from("sales_recurring_invoice_lines" as never)
        .insert((legacyCols ? lineRowsLegacy(id) : lineRows(id)) as never);
      if (iErr) {
        if (prior.sales_recurring_invoice_lines.length) {
          await supabase
            .from("sales_recurring_invoice_lines" as never)
            .insert(prior.sales_recurring_invoice_lines as never);
        }
        throw new Error(`Could not save lines: ${iErr.message}`);
      }
      await syncV2FromLegacySalesRecurring(supabase, id);
      return { id };
    }

    // ---- create ----
    let ins = await supabase
      .from("sales_recurring_invoices" as never)
      .insert({ company_id: data.companyId, created_by: userId, ...header } as never)
      .select("id")
      .single();
    let legacyCols = false;
    if (ins.error?.code === "42703") {
      legacyCols = true;
      ins = await supabase
        .from("sales_recurring_invoices" as never)
        .insert({ company_id: data.companyId, created_by: userId, ...headerLegacy } as never)
        .select("id")
        .single();
    }
    if (ins.error) throw new Error(ins.error.message);
    const id = (ins.data as { id: string }).id;
    const { error: lErr } = await supabase
      .from("sales_recurring_invoice_lines" as never)
      .insert((legacyCols ? lineRowsLegacy(id) : lineRows(id)) as never);
    if (lErr) {
      // No DELETE policy on the header: retire the empty template so it can never run.
      await supabase
        .from("sales_recurring_invoices" as never)
        .update({ is_active: false, last_error: "Rolled back: lines could not be saved" } as never)
        .eq("id" as never, id as never);
      throw new Error(`Could not save lines: ${lErr.message}`);
    }
    await ensureV2ForLegacySalesRecurring(supabase, id);
    return { id };
  });

export const generateRecurringInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; recurringId: string }) => ({
    companyId: assertUuid(input.companyId),
    recurringId: assertUuid(input.recurringId),
  }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "sales.draft");
    const { generateSalesInvoiceFromRecurring } =
      await import("@/lib/recurring/generate-sales-invoice");
    return generateSalesInvoiceFromRecurring(supabase, userId, data.companyId, data.recurringId);
  });

export const setRecurringActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; recurringId: string; isActive: boolean }) => ({
    companyId: assertUuid(input.companyId),
    recurringId: assertUuid(input.recurringId),
    isActive: Boolean(input.isActive),
  }))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyPermission(supabase, data.companyId, "sales.draft");
    const { data: row, error } = await supabase
      .from("sales_recurring_invoices" as never)
      .update({ is_active: data.isActive, updated_at: new Date().toISOString() } as never)
      .eq("id" as never, data.recurringId as never)
      .eq("company_id" as never, data.companyId as never)
      .select("id, is_active" as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Recurring invoice not found");
    // Keep the v2 schedule in step so the scheduler does not run a deactivated template.
    const { syncV2FromLegacySalesRecurring } = await import("@/lib/recurring/v2-sync-sales");
    await syncV2FromLegacySalesRecurring(supabase, data.recurringId);
    return row as { id: string; is_active: boolean };
  });

/** Delete a template that has never generated an invoice; otherwise deactivate it instead. */
export const deleteRecurringInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; recurringId: string }) => ({
    companyId: assertUuid(input.companyId),
    recurringId: assertUuid(input.recurringId),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "sales.draft");
    const res = await callSalesRpc<{ deleted: boolean }>(
      context.supabase,
      "delete_sales_recurring_invoice",
      { company_id: data.companyId, recurring_id: data.recurringId },
    );
    requireRpc(res, "delete_sales_recurring_invoice", "20261024110500");
    return { ok: true };
  });
