import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import type { SalesLineInput } from "@/lib/sales/line-helpers";
import { postSalesCreditAuthorisation } from "@/lib/sales/posting";
import { callSalesRpc, requireRpc, type SalesClient } from "@/lib/sales/rpc";
import { deleteDraftDocument, saveSalesDocument } from "@/lib/sales/doc-save";
import {
  validateCreditAllocations,
  deriveSalesInvoiceStatus,
  deriveCreditNoteStatus,
  type AllocatableInvoice,
} from "@/lib/sales/allocation-rules";
import {
  type ListQuery,
  assertReason,
  isIsoDate,
  sortLines,
  loadCompanyDefaults,
  normaliseCurrencyAndFx,
  optionalIsoDate,
  prepareSalesLines,
  searchContactIds,
} from "@/lib/sales/sales-common";
import {
  buildSearchOr,
  clampPage,
  clampPageSize,
  hasNextPage,
  isIsoDateString,
  pickSort,
} from "@/lib/sales/list-filters";
import { fetchAllPages } from "@/lib/sales/fetch-all";
import { minorToDecimalString, toCsv } from "@/lib/sales/csv";

const CN_SORTS = ["credit_date", "credit_number", "total_minor", "status"] as const;
const CN_STATUSES = ["draft", "authorised", "partly_paid", "paid", "void"] as const;
const CORRECTION_MIGRATION = "20261024110300";

type CnListInput = {
  companyId: string;
  status?: string;
  contactId?: string;
  q?: string;
  from?: string;
  to?: string;
  sort?: string;
  dir?: string;
  page?: number;
  pageSize?: number;
};

function parseCnListInput(input: CnListInput) {
  const status = (input.status ?? "").trim();
  return {
    companyId: assertUuid(input.companyId),
    status: (CN_STATUSES as readonly string[]).includes(status) ? status : null,
    contactId: input.contactId ? assertUuid(input.contactId, "customer") : null,
    q: (input.q ?? "").trim().slice(0, 100),
    from: isIsoDateString(input.from) ? input.from : null,
    to: isIsoDateString(input.to) ? input.to : null,
    sort: pickSort(input.sort, CN_SORTS, "credit_date"),
    ascending: input.dir === "asc",
    page: clampPage(input.page),
    pageSize: clampPageSize(input.pageSize),
  };
}

const CN_LIST_COLUMNS =
  "id, credit_number, credit_date, status, total_minor, amount_allocated_minor, currency_code, contact_id, contacts(name)";

function applyCnFilters(
  q: ListQuery,
  f: ReturnType<typeof parseCnListInput>,
  or: string | null,
): ListQuery {
  let out = q.eq("company_id" as never, f.companyId as never);
  if (f.status) out = out.eq("status" as never, f.status as never);
  if (f.contactId) out = out.eq("contact_id" as never, f.contactId as never);
  if (f.from) out = out.gte("credit_date" as never, f.from as never);
  if (f.to) out = out.lte("credit_date" as never, f.to as never);
  if (or) out = out.or(or as never);
  return out;
}

async function cnSearchOr(supabase: SalesClient, f: ReturnType<typeof parseCnListInput>) {
  const ids = f.q ? await searchContactIds(supabase, f.companyId, f.q) : [];
  return buildSearchOr(f.q, ["credit_number", "memo"], ids);
}

export const listCreditNotes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(parseCnListInput)
  .handler(async ({ data: f, context }) => {
    await assertCompanyMember(context.supabase, f.companyId);
    const or = await cnSearchOr(context.supabase, f);
    const base = context.supabase
      .from("sales_credit_notes" as never)
      .select(CN_LIST_COLUMNS as never, { count: "exact" });
    const {
      data: rows,
      error,
      count,
    } = await applyCnFilters(base as unknown as ListQuery, f, or)
      .order(f.sort as never, { ascending: f.ascending } as never)
      .order("id" as never, { ascending: true } as never)
      .range(f.page * f.pageSize, f.page * f.pageSize + f.pageSize - 1);
    if (error) throw new Error((error as { message: string }).message);
    const total = count ?? 0;
    return {
      rows: (rows ?? []) as unknown as Array<{
        id: string;
        credit_number: string | null;
        credit_date: string;
        status: string;
        total_minor: number;
        amount_allocated_minor: number;
        currency_code: string;
        contact_id: string;
        contacts: { name: string } | null;
      }>,
      total,
      page: f.page,
      pageSize: f.pageSize,
      hasNext: hasNextPage(total, f.page, f.pageSize),
    };
  });

export const exportCreditNotesCsv = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(parseCnListInput)
  .handler(async ({ data: f, context }) => {
    await assertCompanyMember(context.supabase, f.companyId);
    const or = await cnSearchOr(context.supabase, f);
    const defaults = await loadCompanyDefaults(context.supabase, f.companyId);
    const rows = await fetchAllPages<Record<string, unknown>>(
      (from, to) =>
        applyCnFilters(
          context.supabase
            .from("sales_credit_notes" as never)
            .select(CN_LIST_COLUMNS as never) as unknown as ListQuery,
          f,
          or,
        )
          .order(f.sort as never, { ascending: f.ascending } as never)
          .order("id" as never, { ascending: true } as never)
          .range(from, to) as never,
    );
    const csv = toCsv(
      ["Number", "Date", "Customer", "Status", "Currency", "Total", "Applied", "Remaining credit"],
      rows.map((r) => {
        const total = Number(r["total_minor"]);
        const applied = Number(r["amount_allocated_minor"]);
        const live = ["authorised", "partly_paid"].includes(String(r["status"]));
        return [
          r["credit_number"],
          r["credit_date"],
          (r["contacts"] as { name?: string } | null)?.name ?? "",
          r["status"],
          r["currency_code"],
          minorToDecimalString(total),
          minorToDecimalString(applied),
          minorToDecimalString(live ? total - applied : 0),
        ];
      }),
    );
    return { filename: `credit-notes-${defaults.today}.csv`, csv, rowCount: rows.length };
  });

export const getCreditNote = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; creditNoteId: string }) => ({
    companyId: assertUuid(input.companyId),
    creditNoteId: assertUuid(input.creditNoteId, "credit note"),
  }))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyMember(supabase, data.companyId);
    const { data: row, error } = await supabase
      .from("sales_credit_notes" as never)
      .select(
        "*, contacts(id, name, email), sales_credit_note_lines(*), source_invoice:invoice_id(id, invoice_number)" as never,
      )
      .eq("id" as never, data.creditNoteId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Credit note not found");

    const rich =
      "id, invoice_id, amount_minor, allocated_on, reversed_on, reverse_reason, created_at, sales_invoices(id, invoice_number)";
    const basic = "id, invoice_id, amount_minor, created_at, sales_invoices(id, invoice_number)";
    let al = await supabase
      .from("sales_credit_allocations" as never)
      .select(rich as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("credit_note_id" as never, data.creditNoteId as never);
    if (al.error?.code === "42703") {
      al = await supabase
        .from("sales_credit_allocations" as never)
        .select(basic as never)
        .eq("company_id" as never, data.companyId as never)
        .eq("credit_note_id" as never, data.creditNoteId as never);
    }
    if (al.error) throw new Error(al.error.message);
    type Alloc = {
      id: string;
      invoice_id: string;
      amount_minor: number;
      allocated_on: string | null;
      reversed_on: string | null;
      reverse_reason: string | null;
      created_at: string;
      sales_invoices: { id: string; invoice_number: string | null } | null;
    };
    const allocs = (al.data ?? []) as unknown as Alloc[];
    return {
      ...(row as unknown as Record<string, unknown>),
      sales_credit_note_lines: sortLines(
        (row as unknown as { sales_credit_note_lines: Array<{ line_order: number; id: string }> })
          .sales_credit_note_lines ?? [],
      ),
      allocations: allocs.filter((a) => !a.reversed_on),
      reversedAllocations: allocs.filter((a) => Boolean(a.reversed_on)),
    } as {
      id: string;
      credit_number: string | null;
      credit_date: string;
      status: string;
      memo: string | null;
      currency_code: string;
      contact_id: string;
      invoice_id: string | null;
      subtotal_minor: number;
      tax_minor: number;
      total_minor: number;
      amount_allocated_minor: number;
      posted_journal_id: string | null;
      void_journal_id: string | null;
      void_reason: string | null;
      contacts: { id: string; name: string; email: string | null } | null;
      source_invoice: { id: string; invoice_number: string | null } | null;
      sales_credit_note_lines: Array<{
        id: string;
        line_order: number;
        description: string;
        account_id: string;
        quantity: number;
        unit_price_minor: number;
        discount_minor: number;
        tax_rate_bps: number;
        tax_code_id: string | null;
        net_minor: number;
        tax_minor: number;
        gross_minor: number;
      }>;
      allocations: Alloc[];
      reversedAllocations: Alloc[];
    };
  });

export const saveCreditNoteDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      creditNoteId?: string;
      contactId: string;
      creditDate: string;
      creditNumber?: string;
      memo?: string;
      currencyCode: string;
      fxRateToBase?: number;
      invoiceId?: string;
      lines: SalesLineInput[];
    }) => {
      if (!isIsoDate(input.creditDate)) throw new Error("Credit date must be YYYY-MM-DD");
      return {
        companyId: assertUuid(input.companyId),
        creditNoteId: input.creditNoteId
          ? assertUuid(input.creditNoteId, "credit note")
          : undefined,
        contactId: assertUuid(input.contactId, "customer"),
        creditDate: input.creditDate,
        creditNumber: (input.creditNumber ?? "").trim().slice(0, 40) || null,
        memo: (input.memo ?? "").trim().slice(0, 500) || null,
        currencyCode: input.currencyCode ?? "",
        fxRateToBase: input.fxRateToBase,
        invoiceId: input.invoiceId ? assertUuid(input.invoiceId, "invoice") : null,
        lines: input.lines,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "sales.draft");
    const defaults = await loadCompanyDefaults(supabase, data.companyId);
    const { currencyCode, fxRateToBase } = normaliseCurrencyAndFx(
      data.currencyCode,
      defaults.baseCurrency,
      data.fxRateToBase,
    );
    const lines = await prepareSalesLines(supabase, data.companyId, data.lines, data.creditDate);
    const saved = await saveSalesDocument(supabase, {
      kind: "credit_note",
      companyId: data.companyId,
      userId,
      id: data.creditNoteId,
      contactId: data.contactId,
      docDate: data.creditDate,
      number: data.creditNumber,
      memo: data.memo,
      currencyCode,
      fxRateToBase,
      sourceInvoiceId: data.invoiceId,
      lines,
    });
    return { id: saved.id, creditNumber: saved.number };
  });

export const deleteDraftCreditNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; creditNoteId: string }) => ({
    companyId: assertUuid(input.companyId),
    creditNoteId: assertUuid(input.creditNoteId, "credit note"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "sales.draft");
    await deleteDraftDocument(context.supabase, data.companyId, "credit_note", data.creditNoteId);
    return { ok: true };
  });

export const authoriseCreditNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; creditNoteId: string }) => ({
    companyId: assertUuid(input.companyId),
    creditNoteId: assertUuid(input.creditNoteId),
  }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "sales.authorise");
    const { data: cn, error } = await supabase
      .from("sales_credit_notes" as never)
      .select("*, sales_credit_note_lines(*)" as never)
      .eq("id" as never, data.creditNoteId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!cn) throw new Error("Credit note not found");
    const c = cn as unknown as {
      status: string;
      credit_date: string;
      credit_number: string | null;
      currency_code: string;
      fx_rate_to_base?: number | null;
      memo: string | null;
      subtotal_minor: number;
      tax_minor: number;
      total_minor: number;
      posted_journal_id: string | null;
      sales_credit_note_lines: Array<{
        account_id: string;
        description: string;
        net_minor: number;
        tax_minor: number;
      }>;
    };
    if (c.status !== "draft") throw new Error("Only draft credit notes can be authorised");
    if (c.posted_journal_id) throw new Error("Credit note already posted");
    if (!c.sales_credit_note_lines.length) throw new Error("Credit note has no lines");
    const net = c.sales_credit_note_lines.reduce((s, l) => s + Number(l.net_minor), 0);
    const tax = c.sales_credit_note_lines.reduce((s, l) => s + Number(l.tax_minor), 0);
    if (net !== Number(c.subtotal_minor) || tax !== Number(c.tax_minor)) {
      throw new Error("Credit note totals do not match its lines — re-save the draft first");
    }
    if (!(Number(c.total_minor) > 0))
      throw new Error("Credit note total must be greater than zero");

    let number = c.credit_number;
    if (!number) {
      const { allocateDocumentNumber } = await import("@/lib/settings/document-numbering");
      number = await allocateDocumentNumber(supabase as never, data.companyId, "sales_credit_note");
    }

    const journalId = await postSalesCreditAuthorisation(supabase as never, {
      company_id: data.companyId,
      credit_note_id: data.creditNoteId,
      credit_date: c.credit_date,
      currency_code: c.currency_code,
      fx_rate_to_base: Number(c.fx_rate_to_base ?? 1),
      ...(c.memo ? { memo: c.memo } : {}),
      lines: c.sales_credit_note_lines.map((l) => ({
        account_id: l.account_id,
        description: l.description,
        net_minor: l.net_minor,
        tax_minor: l.tax_minor,
      })),
    });

    const nowIso = new Date().toISOString();
    const { error: upErr } = await supabase
      .from("sales_credit_notes" as never)
      .update({
        status: "authorised",
        credit_number: number,
        posted_journal_id: journalId,
        authorised_at: nowIso,
        authorised_by: userId,
        updated_at: nowIso,
      } as never)
      .eq("id" as never, data.creditNoteId as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("status" as never, "draft" as never);
    if (upErr) {
      throw new Error(
        `The journal was posted but the credit note could not be marked authorised (${upErr.message}). Retry authorise — it is safe to repeat.`,
      );
    }
    return { journalId };
  });

// ---- allocation ----

export const allocateCreditNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      creditNoteId: string;
      allocationDate?: string;
      allocations: Array<{ invoiceId: string; amountMinor: number }>;
    }) => {
      const allocations = (input.allocations ?? []).map((a) => ({
        invoiceId: assertUuid(a.invoiceId, "invoice"),
        amountMinor: Math.round(Number(a.amountMinor)),
      }));
      for (const a of allocations) {
        if (!(a.amountMinor > 0)) throw new Error("Allocation amounts must be positive");
      }
      if (!allocations.length) throw new Error("At least one allocation is required");
      return {
        companyId: assertUuid(input.companyId),
        creditNoteId: assertUuid(input.creditNoteId, "credit note"),
        allocationDate: optionalIsoDate(input.allocationDate, "Allocation date"),
        allocations,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "sales.payment");
    const rpc = await callSalesRpc<{
      credit_note_id: string;
      allocated_minor: number;
      remaining_minor: number;
    }>(supabase, "allocate_sales_credit_note", {
      company_id: data.companyId,
      credit_note_id: data.creditNoteId,
      allocation_date: data.allocationDate,
      allocations: data.allocations.map((a) => ({
        invoice_id: a.invoiceId,
        amount_minor: a.amountMinor,
      })),
    });
    if (!rpc.missing) {
      return {
        allocatedMinor: Number(rpc.data.allocated_minor),
        remainingMinor: Number(rpc.data.remaining_minor),
      };
    }

    // ---- fallback: validate everything first, apply with optimistic guards + compensation ----
    const { data: cn, error } = await supabase
      .from("sales_credit_notes" as never)
      .select("id, status, contact_id, total_minor, amount_allocated_minor, currency_code" as never)
      .eq("id" as never, data.creditNoteId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!cn) throw new Error("Credit note not found");
    const credit = cn as {
      status: string;
      contact_id: string;
      total_minor: number;
      amount_allocated_minor: number;
      currency_code: string;
    };
    const invoices = await loadAllocatableInvoices(
      supabase,
      data.companyId,
      data.allocations.map((a) => a.invoiceId),
    );
    const { allocatedMinor } = validateCreditAllocations({
      credit: {
        contactId: credit.contact_id,
        currencyCode: credit.currency_code,
        status: credit.status,
        totalMinor: Number(credit.total_minor),
        amountAllocatedMinor: Number(credit.amount_allocated_minor),
      },
      allocations: data.allocations,
      invoices,
    });

    const undo: Array<() => Promise<unknown>> = [];
    try {
      for (const alloc of data.allocations) {
        const inv = invoices.get(alloc.invoiceId)!;
        const { error: aErr } = await supabase.from("sales_credit_allocations" as never).insert({
          company_id: data.companyId,
          credit_note_id: data.creditNoteId,
          invoice_id: alloc.invoiceId,
          amount_minor: alloc.amountMinor,
          created_by: userId,
        } as never);
        if (aErr) {
          throw new Error(
            aErr.code === "23505" ? "Already allocated to this invoice" : aErr.message,
          );
        }
        undo.push(async () =>
          supabase
            .from("sales_credit_allocations" as never)
            .delete()
            .eq("credit_note_id" as never, data.creditNoteId as never)
            .eq("invoice_id" as never, alloc.invoiceId as never),
        );
        const newCredited = inv.amountCreditedMinor + alloc.amountMinor;
        const status = deriveSalesInvoiceStatus({
          totalMinor: inv.totalMinor,
          amountPaidMinor: inv.amountPaidMinor,
          amountCreditedMinor: newCredited,
        });
        const { data: bumped, error: bErr } = await supabase
          .from("sales_invoices" as never)
          .update({
            amount_credited_minor: newCredited,
            status,
            updated_at: new Date().toISOString(),
          } as never)
          .eq("id" as never, alloc.invoiceId as never)
          .eq("amount_paid_minor" as never, inv.amountPaidMinor as never)
          .eq("amount_credited_minor" as never, inv.amountCreditedMinor as never)
          .select("id");
        if (bErr) throw new Error(bErr.message);
        if (!bumped || (bumped as unknown[]).length === 0) {
          throw new Error("An invoice changed while the credit was being applied — please retry");
        }
        undo.push(async () =>
          supabase
            .from("sales_invoices" as never)
            .update({ amount_credited_minor: inv.amountCreditedMinor, status: inv.status } as never)
            .eq("id" as never, alloc.invoiceId as never),
        );
      }
      const total = Number(credit.amount_allocated_minor) + allocatedMinor;
      const { error: cErr } = await supabase
        .from("sales_credit_notes" as never)
        .update({
          amount_allocated_minor: total,
          status: deriveCreditNoteStatus({
            totalMinor: Number(credit.total_minor),
            amountAllocatedMinor: total,
          }),
          updated_at: new Date().toISOString(),
        } as never)
        .eq("id" as never, data.creditNoteId as never)
        .eq("amount_allocated_minor" as never, Number(credit.amount_allocated_minor) as never);
      if (cErr) throw new Error(cErr.message);
      return { allocatedMinor: total, remainingMinor: Number(credit.total_minor) - total };
    } catch (e) {
      for (const fn of undo.reverse()) {
        try {
          await fn();
        } catch {
          /* best effort */
        }
      }
      throw e instanceof Error ? e : new Error("Allocation failed");
    }
  });

async function loadAllocatableInvoices(
  supabase: SalesClient,
  companyId: string,
  ids: string[],
): Promise<Map<string, AllocatableInvoice>> {
  const map = new Map<string, AllocatableInvoice>();
  if (!ids.length) return map;
  const { data, error } = await supabase
    .from("sales_invoices" as never)
    .select(
      "id, invoice_number, status, contact_id, total_minor, amount_paid_minor, amount_credited_minor, currency_code" as never,
    )
    .eq("company_id" as never, companyId as never)
    .in("id" as never, ids as never);
  if (error) throw new Error(error.message);
  for (const r of (data ?? []) as Array<{
    id: string;
    invoice_number: string | null;
    status: string;
    contact_id: string;
    total_minor: number;
    amount_paid_minor: number;
    amount_credited_minor: number;
    currency_code: string;
  }>) {
    map.set(r.id, {
      id: r.id,
      number: r.invoice_number,
      contactId: r.contact_id,
      currencyCode: r.currency_code,
      status: r.status,
      totalMinor: Number(r.total_minor),
      amountPaidMinor: Number(r.amount_paid_minor),
      amountCreditedMinor: Number(r.amount_credited_minor),
    });
  }
  return map;
}

// ---- corrections ----

export const voidCreditNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; creditNoteId: string; reason: string; voidDate?: string }) => ({
      companyId: assertUuid(input.companyId),
      creditNoteId: assertUuid(input.creditNoteId, "credit note"),
      reason: assertReason(input.reason, "A void reason"),
      voidDate: optionalIsoDate(input.voidDate, "Void date"),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "sales.void");
    const res = await callSalesRpc<{ void_journal_id: string }>(
      context.supabase,
      "void_sales_credit_note",
      {
        company_id: data.companyId,
        credit_note_id: data.creditNoteId,
        reason: data.reason,
        void_date: data.voidDate,
      },
    );
    const out = requireRpc(res, "void_sales_credit_note", CORRECTION_MIGRATION);
    return { journalId: out.void_journal_id };
  });

export const removeCreditAllocation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      allocationId: string;
      reason: string;
      reversalDate?: string;
    }) => ({
      companyId: assertUuid(input.companyId),
      allocationId: assertUuid(input.allocationId, "allocation"),
      reason: assertReason(input.reason, "A reason"),
      reversalDate: optionalIsoDate(input.reversalDate, "Date"),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "sales.payment");
    const res = await callSalesRpc<{ allocated_minor: number }>(
      context.supabase,
      "remove_sales_credit_allocation",
      {
        company_id: data.companyId,
        allocation_id: data.allocationId,
        reason: data.reason,
        reversal_date: data.reversalDate,
      },
    );
    const out = requireRpc(res, "remove_sales_credit_allocation", CORRECTION_MIGRATION);
    return { allocatedMinor: Number(out.allocated_minor) };
  });
