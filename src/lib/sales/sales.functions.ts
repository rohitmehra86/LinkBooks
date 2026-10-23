import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { addDaysIso, type SalesLineInput } from "@/lib/sales/line-helpers";
import { postInvoiceAuthorisation, voidPostedDocument } from "@/lib/sales/posting";
import { callSalesRpc, type SalesClient } from "@/lib/sales/rpc";
import { deleteDraftDocument, saveSalesDocument } from "@/lib/sales/doc-save";
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
  escapeLikeLiteral,
  hasNextPage,
  isIsoDateString,
  pickSort,
} from "@/lib/sales/list-filters";
import { fetchAllPages } from "@/lib/sales/fetch-all";
import { minorToDecimalString, toCsv } from "@/lib/sales/csv";
import {
  assertQuoteTransition,
  isQuoteConvertible,
  isQuoteStatus,
  quoteTimestampColumns,
} from "@/lib/sales/quote-status";

// Re-exported for the recurring generator and other modules that import it from here.
export { loadTaxTreatment } from "@/lib/sales/sales-common";

// ---- Customers ----

export const listCustomers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; q?: string }) => ({
    companyId: assertUuid(input.companyId),
    q: (input.q ?? "").trim().slice(0, 100),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    let q = context.supabase
      .from("contacts" as never)
      .select("id, name, email, phone, tax_number, payment_terms_days, is_active, kind" as never)
      .eq("company_id" as never, data.companyId as never)
      .in("kind" as never, ["customer", "both"] as never)
      .order("name" as never);
    if (data.q) q = q.ilike("name" as never, `%${escapeLikeLiteral(data.q)}%` as never);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const upsertCustomer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      id?: string;
      name: string;
      email?: string;
      phone?: string;
      taxNumber?: string;
      paymentTermsDays?: number;
    }) => {
      const name = (input.name ?? "").trim();
      if (name.length < 1) throw new Error("Customer name is required");
      return {
        companyId: assertUuid(input.companyId),
        id: input.id ? assertUuid(input.id) : undefined,
        name,
        email: (input.email ?? "").trim().slice(0, 200) || null,
        phone: (input.phone ?? "").trim().slice(0, 60) || null,
        taxNumber: (input.taxNumber ?? "").trim().slice(0, 60) || null,
        paymentTermsDays: Math.max(0, Number(input.paymentTermsDays ?? 30) || 0),
      };
    },
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "contacts.manage");
    if (data.id) {
      const { data: row, error } = await context.supabase
        .from("contacts" as never)
        .update({
          name: data.name,
          email: data.email,
          phone: data.phone,
          tax_number: data.taxNumber,
          payment_terms_days: data.paymentTermsDays,
          updated_at: new Date().toISOString(),
        } as never)
        .eq("id" as never, data.id as never)
        .eq("company_id" as never, data.companyId as never)
        .select("id")
        .maybeSingle();
      if (error) {
        if (error.code === "23505") throw new Error("A contact with this name already exists");
        throw new Error(error.message);
      }
      if (!row) throw new Error("Customer not found");
      return { id: data.id };
    }
    const { data: row, error } = await context.supabase
      .from("contacts" as never)
      .insert({
        company_id: data.companyId,
        kind: "customer",
        name: data.name,
        email: data.email,
        phone: data.phone,
        tax_number: data.taxNumber,
        payment_terms_days: data.paymentTermsDays,
      } as never)
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") throw new Error("A contact with this name already exists");
      throw new Error(error.message);
    }
    return { id: (row as { id: string }).id };
  });

async function customerTerms(
  supabase: SalesClient,
  companyId: string,
  contactId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("contacts" as never)
    .select("payment_terms_days" as never)
    .eq("id" as never, contactId as never)
    .eq("company_id" as never, companyId as never)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Customer not found in this organisation");
  return Math.max(
    0,
    Number((data as { payment_terms_days: number | null }).payment_terms_days ?? 30),
  );
}

// ---- Invoice list (search / filters / sort / pagination / CSV) ----

const INVOICE_STATUSES = ["draft", "authorised", "partly_paid", "paid", "void"] as const;
const INVOICE_SORTS = [
  "invoice_date",
  "due_date",
  "invoice_number",
  "total_minor",
  "status",
] as const;

type InvoiceListInput = {
  companyId: string;
  status?: string;
  /** Pseudo filter: authorised/partly-paid invoices past their due date. */
  overdue?: boolean;
  contactId?: string;
  q?: string;
  from?: string;
  to?: string;
  sort?: string;
  dir?: string;
  page?: number;
  pageSize?: number;
};

function parseInvoiceListInput(input: InvoiceListInput) {
  const status = (input.status ?? "").trim();
  return {
    companyId: assertUuid(input.companyId),
    status: (INVOICE_STATUSES as readonly string[]).includes(status) ? status : null,
    overdue: Boolean(input.overdue),
    contactId: input.contactId ? assertUuid(input.contactId, "customer") : null,
    q: (input.q ?? "").trim().slice(0, 100),
    from: isIsoDateString(input.from) ? input.from : null,
    to: isIsoDateString(input.to) ? input.to : null,
    sort: pickSort(input.sort, INVOICE_SORTS, "invoice_date"),
    ascending: input.dir === "asc",
    page: clampPage(input.page),
    pageSize: clampPageSize(input.pageSize),
  };
}

const INVOICE_LIST_COLUMNS =
  "id, invoice_number, invoice_date, due_date, status, total_minor, amount_paid_minor, amount_credited_minor, currency_code, contact_id, sent_at, contacts(name)";

async function invoiceListQueryParts(
  supabase: SalesClient,
  f: ReturnType<typeof parseInvoiceListInput>,
) {
  const defaults = await loadCompanyDefaults(supabase, f.companyId);
  const ids = f.q ? await searchContactIds(supabase, f.companyId, f.q) : [];
  const or = buildSearchOr(f.q, ["invoice_number", "memo"], ids);
  return { today: defaults.today, or };
}

function applyInvoiceFilters(
  q: ListQuery,
  f: ReturnType<typeof parseInvoiceListInput>,
  parts: { today: string; or: string | null },
): ListQuery {
  let out = q.eq("company_id" as never, f.companyId as never);
  if (f.status) out = out.eq("status" as never, f.status as never);
  if (f.overdue) {
    out = out
      .in("status" as never, ["authorised", "partly_paid"] as never)
      .lt("due_date" as never, parts.today as never);
  }
  if (f.contactId) out = out.eq("contact_id" as never, f.contactId as never);
  if (f.from) out = out.gte("invoice_date" as never, f.from as never);
  if (f.to) out = out.lte("invoice_date" as never, f.to as never);
  if (parts.or) out = out.or(parts.or as never);
  return out;
}

export type InvoiceListRow = {
  id: string;
  invoice_number: string | null;
  invoice_date: string;
  due_date: string;
  status: string;
  total_minor: number;
  amount_paid_minor: number;
  amount_credited_minor: number;
  currency_code: string;
  contact_id: string;
  sent_at: string | null;
  contacts: { name: string } | null;
};

export const listInvoices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(parseInvoiceListInput)
  .handler(async ({ data: f, context }) => {
    await assertCompanyMember(context.supabase, f.companyId);
    const parts = await invoiceListQueryParts(context.supabase, f);
    const base = context.supabase
      .from("sales_invoices" as never)
      .select(INVOICE_LIST_COLUMNS as never, { count: "exact" });
    const {
      data: rows,
      error,
      count,
    } = await applyInvoiceFilters(base as never, f, parts)
      .order(f.sort as never, { ascending: f.ascending } as never)
      .order("id" as never, { ascending: true } as never)
      .range(f.page * f.pageSize, f.page * f.pageSize + f.pageSize - 1);
    if (error) throw new Error((error as { message: string }).message);
    const total = count ?? 0;
    return {
      rows: (rows ?? []) as unknown as InvoiceListRow[],
      total,
      page: f.page,
      pageSize: f.pageSize,
      hasNext: hasNextPage(total, f.page, f.pageSize),
      today: parts.today,
    };
  });

export const exportInvoicesCsv = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(parseInvoiceListInput)
  .handler(async ({ data: f, context }) => {
    await assertCompanyMember(context.supabase, f.companyId);
    const parts = await invoiceListQueryParts(context.supabase, f);
    const rows = await fetchAllPages<Record<string, unknown>>(
      (from, to) =>
        applyInvoiceFilters(
          context.supabase
            .from("sales_invoices" as never)
            .select(INVOICE_LIST_COLUMNS as never) as unknown as ListQuery,
          f,
          parts,
        )
          .order(f.sort as never, { ascending: f.ascending } as never)
          .order("id" as never, { ascending: true } as never)
          .range(from, to) as never,
    );
    const csv = toCsv(
      [
        "Number",
        "Date",
        "Due",
        "Customer",
        "Status",
        "Currency",
        "Total",
        "Paid",
        "Credited",
        "Outstanding",
      ],
      rows.map((r) => {
        const total = Number(r["total_minor"]);
        const paid = Number(r["amount_paid_minor"]);
        const cred = Number(r["amount_credited_minor"]);
        const draftOrVoid = r["status"] === "draft" || r["status"] === "void";
        return [
          r["invoice_number"],
          r["invoice_date"],
          r["due_date"],
          (r["contacts"] as { name?: string } | null)?.name ?? "",
          r["status"],
          r["currency_code"],
          minorToDecimalString(total),
          minorToDecimalString(paid),
          minorToDecimalString(cred),
          minorToDecimalString(draftOrVoid ? 0 : total - paid - cred),
        ];
      }),
    );
    return { filename: `invoices-${parts.today}.csv`, csv, rowCount: rows.length };
  });

// ---- Invoice detail ----

export type InvoiceDetail = {
  id: string;
  status: string;
  invoice_number: string | null;
  invoice_date: string;
  due_date: string;
  memo: string | null;
  currency_code: string;
  contact_id: string;
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  amount_paid_minor: number;
  amount_credited_minor: number;
  posted_journal_id: string | null;
  void_journal_id: string | null;
  quote_id: string | null;
  sent_at: string | null;
  void_reason: string | null;
  contacts: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    tax_number: string | null;
  } | null;
  sales_invoice_lines: Array<{
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
    net_minor: number;
    tax_minor: number;
    gross_minor: number;
  }>;
  payments: Array<{
    id: string;
    amount_minor: number;
    allocated_on: string | null;
    receipt_id: string;
    sales_receipts: {
      id: string;
      receipt_date: string;
      reference: string | null;
      status: string;
    } | null;
  }>;
  reversed_payments: Array<{
    id: string;
    amount_minor: number;
    reversed_on: string | null;
    reverse_reason: string | null;
    receipt_id: string;
    sales_receipts: { id: string; receipt_date: string; reference: string | null } | null;
  }>;
  credit_applications: Array<{
    id: string;
    amount_minor: number;
    allocated_on: string | null;
    credit_note_id: string;
    sales_credit_notes: { id: string; credit_number: string | null; credit_date: string } | null;
  }>;
  reversed_credit_applications: Array<{
    id: string;
    amount_minor: number;
    reversed_on: string | null;
    reverse_reason: string | null;
    credit_note_id: string;
    sales_credit_notes: { id: string; credit_number: string | null; credit_date: string } | null;
  }>;
  company: {
    name: string;
    legal_name: string | null;
    country_code: string | null;
    invoice_footer: string | null;
    base_currency: string;
  } | null;
  branding: {
    trading_name: string | null;
    letterhead_line: string | null;
    invoice_email: string | null;
    invoice_phone: string | null;
    logo_url: string | null;
  } | null;
};

export const getInvoice = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; invoiceId: string }) => ({
    companyId: assertUuid(input.companyId),
    invoiceId: assertUuid(input.invoiceId, "invoice"),
  }))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyMember(supabase, data.companyId);
    const { data: row, error } = await supabase
      .from("sales_invoices" as never)
      .select("*, contacts(id, name, email, phone, tax_number), sales_invoice_lines(*)" as never)
      .eq("id" as never, data.invoiceId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Invoice not found");

    // Payment + credit history. Active rows only; reversed rows are listed separately so an
    // accountant can see what was undone and why.
    const richPay =
      "id, amount_minor, allocated_on, reversed_on, reverse_reason, receipt_id, sales_receipts(id, receipt_date, reference, status)";
    const basicPay =
      "id, amount_minor, receipt_id, sales_receipts(id, receipt_date, reference, status)";
    let payRes = await supabase
      .from("sales_receipt_allocations" as never)
      .select(richPay as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("invoice_id" as never, data.invoiceId as never);
    if (payRes.error?.code === "42703") {
      payRes = await supabase
        .from("sales_receipt_allocations" as never)
        .select(basicPay as never)
        .eq("company_id" as never, data.companyId as never)
        .eq("invoice_id" as never, data.invoiceId as never);
    }
    if (payRes.error) throw new Error(payRes.error.message);

    const richCr =
      "id, amount_minor, allocated_on, reversed_on, reverse_reason, credit_note_id, sales_credit_notes(id, credit_number, credit_date, status)";
    const basicCr =
      "id, amount_minor, credit_note_id, sales_credit_notes(id, credit_number, credit_date, status)";
    let crRes = await supabase
      .from("sales_credit_allocations" as never)
      .select(richCr as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("invoice_id" as never, data.invoiceId as never);
    if (crRes.error?.code === "42703") {
      crRes = await supabase
        .from("sales_credit_allocations" as never)
        .select(basicCr as never)
        .eq("company_id" as never, data.companyId as never)
        .eq("invoice_id" as never, data.invoiceId as never);
    }
    if (crRes.error) throw new Error(crRes.error.message);

    const { data: company } = await supabase
      .from("companies" as never)
      .select("name, legal_name, country_code, invoice_footer, base_currency" as never)
      .eq("id" as never, data.companyId as never)
      .maybeSingle();
    const { data: branding } = await supabase
      .from("company_branding" as never)
      .select("trading_name, letterhead_line, invoice_email, invoice_phone, logo_url" as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();

    const split = <T extends { reversed_on?: string | null }>(rows: T[]) => ({
      active: rows.filter((r) => !r.reversed_on),
      reversed: rows.filter((r) => Boolean(r.reversed_on)),
    });
    const pay = split((payRes.data ?? []) as unknown as Array<{ reversed_on?: string | null }>);
    const cr = split((crRes.data ?? []) as unknown as Array<{ reversed_on?: string | null }>);
    const invoiceRow = row as unknown as {
      sales_invoice_lines: Array<{ line_order: number; id: string }>;
    };
    return {
      ...(row as unknown as Record<string, unknown>),
      sales_invoice_lines: sortLines(invoiceRow.sales_invoice_lines ?? []),
      payments: pay.active,
      reversed_payments: pay.reversed,
      credit_applications: cr.active,
      reversed_credit_applications: cr.reversed,
      company: company ?? null,
      branding: branding ?? null,
    } as unknown as InvoiceDetail;
  });

// ---- Invoice save / authorise ----

type InvoiceDraftInput = {
  companyId: string;
  invoiceId?: string;
  contactId: string;
  invoiceDate: string;
  dueDate: string;
  invoiceNumber?: string;
  memo?: string;
  currencyCode: string;
  fxRateToBase?: number;
  lines: SalesLineInput[];
};

function parseInvoiceDraftInput(input: InvoiceDraftInput) {
  if (!isIsoDate(input.invoiceDate) || !isIsoDate(input.dueDate)) {
    throw new Error("Invoice and due dates must be YYYY-MM-DD");
  }
  if (input.dueDate < input.invoiceDate) throw new Error("Due date cannot be before invoice date");
  return {
    companyId: assertUuid(input.companyId),
    invoiceId: input.invoiceId ? assertUuid(input.invoiceId, "invoice") : undefined,
    contactId: assertUuid(input.contactId, "customer"),
    invoiceDate: input.invoiceDate,
    dueDate: input.dueDate,
    invoiceNumber: (input.invoiceNumber ?? "").trim().slice(0, 40) || null,
    memo: (input.memo ?? "").trim().slice(0, 500) || null,
    currencyCode: input.currencyCode ?? "",
    fxRateToBase: input.fxRateToBase,
    lines: input.lines,
  };
}

type ServerCtx = { supabase: SalesClient; userId: string };

async function saveInvoiceDraftCore(
  { supabase, userId }: ServerCtx,
  data: ReturnType<typeof parseInvoiceDraftInput>,
) {
  await assertCompanyPermission(supabase, data.companyId, "sales.draft");
  const defaults = await loadCompanyDefaults(supabase, data.companyId);
  const { currencyCode, fxRateToBase } = normaliseCurrencyAndFx(
    data.currencyCode,
    defaults.baseCurrency,
    data.fxRateToBase,
  );
  const lines = await prepareSalesLines(supabase, data.companyId, data.lines, data.invoiceDate);
  const saved = await saveSalesDocument(supabase, {
    kind: "invoice",
    companyId: data.companyId,
    userId,
    id: data.invoiceId,
    contactId: data.contactId,
    docDate: data.invoiceDate,
    dueDate: data.dueDate,
    number: data.invoiceNumber,
    memo: data.memo,
    currencyCode,
    fxRateToBase,
    lines,
  });
  return { id: saved.id, invoiceNumber: saved.number };
}

export const saveInvoiceDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(parseInvoiceDraftInput)
  .handler(async ({ data, context }) => saveInvoiceDraftCore(context, data));

async function authoriseInvoiceCore(
  { supabase, userId }: ServerCtx,
  companyId: string,
  invoiceId: string,
) {
  await assertCompanyPermission(supabase, companyId, "sales.authorise");
  const { data: inv, error } = await supabase
    .from("sales_invoices" as never)
    .select("*, sales_invoice_lines(*)" as never)
    .eq("id" as never, invoiceId as never)
    .eq("company_id" as never, companyId as never)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!inv) throw new Error("Invoice not found");
  const b = inv as unknown as {
    status: string;
    invoice_date: string;
    invoice_number: string | null;
    currency_code: string;
    fx_rate_to_base?: number | null;
    memo: string | null;
    total_minor: number;
    subtotal_minor: number;
    tax_minor: number;
    posted_journal_id: string | null;
    sales_invoice_lines: Array<{
      account_id: string;
      description: string;
      net_minor: number;
      tax_minor: number;
    }>;
  };
  if (b.status !== "draft") throw new Error("Only draft invoices can be authorised");
  if (b.posted_journal_id) throw new Error("Invoice already posted");
  if (!b.sales_invoice_lines.length) throw new Error("Invoice has no lines");
  const lineNet = b.sales_invoice_lines.reduce((s, l) => s + Number(l.net_minor), 0);
  const lineTax = b.sales_invoice_lines.reduce((s, l) => s + Number(l.tax_minor), 0);
  if (lineNet !== Number(b.subtotal_minor) || lineTax !== Number(b.tax_minor)) {
    throw new Error("Invoice totals do not match its lines — re-save the draft before authorising");
  }
  if (!(Number(b.total_minor) > 0)) throw new Error("Invoice total must be greater than zero");

  let number = b.invoice_number;
  if (!number) {
    const { allocateDocumentNumber } = await import("@/lib/settings/document-numbering");
    number = await allocateDocumentNumber(supabase as never, companyId, "sales_invoice");
  }

  // Idempotent on invoice id: a retry after a partial failure returns the same journal.
  const journalId = await postInvoiceAuthorisation(supabase as never, {
    company_id: companyId,
    invoice_id: invoiceId,
    invoice_date: b.invoice_date,
    currency_code: b.currency_code,
    fx_rate_to_base: Number(b.fx_rate_to_base ?? 1),
    ...(b.memo ? { memo: b.memo } : {}),
    lines: b.sales_invoice_lines.map((l) => ({
      account_id: l.account_id,
      description: l.description,
      net_minor: l.net_minor,
      tax_minor: l.tax_minor,
    })),
  });

  const nowIso = new Date().toISOString();
  const { data: claimed, error: upErr } = await supabase
    .from("sales_invoices" as never)
    .update({
      status: "authorised",
      invoice_number: number,
      posted_journal_id: journalId,
      authorised_at: nowIso,
      authorised_by: userId,
      updated_at: nowIso,
    } as never)
    .eq("id" as never, invoiceId as never)
    .eq("company_id" as never, companyId as never)
    .eq("status" as never, "draft" as never)
    .select("id");
  if (upErr) {
    throw new Error(
      `The journal was posted but the invoice could not be marked authorised (${upErr.message}). Retry authorise — it is safe to repeat.`,
    );
  }
  if (!claimed || (claimed as unknown[]).length === 0) {
    // Someone else authorised it between our read and write; the idempotent journal is the same one.
    return { journalId, invoiceNumber: number, alreadyAuthorised: true };
  }
  return { journalId, invoiceNumber: number, alreadyAuthorised: false };
}

export const authoriseInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; invoiceId: string }) => ({
    companyId: assertUuid(input.companyId),
    invoiceId: assertUuid(input.invoiceId, "invoice"),
  }))
  .handler(async ({ data, context }) =>
    authoriseInvoiceCore(context, data.companyId, data.invoiceId),
  );

/**
 * "Save and authorise" in ONE call (AR-11). The draft is saved first; if authorising then fails the
 * draft id is returned with the error so the browser opens that draft instead of creating a second
 * one on the next click.
 */
export const saveAndAuthoriseInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(parseInvoiceDraftInput)
  .handler(async ({ data, context }) => {
    const saved = await saveInvoiceDraftCore(context, data);
    try {
      const res = await authoriseInvoiceCore(context, data.companyId, saved.id);
      return { id: saved.id, journalId: res.journalId, authoriseError: null as string | null };
    } catch (e) {
      return {
        id: saved.id,
        journalId: null as string | null,
        authoriseError: e instanceof Error ? e.message : "Could not authorise the invoice",
      };
    }
  });

// ---- Invoice corrections / conveniences ----

export const voidInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; invoiceId: string; reason: string; voidDate?: string }) => ({
      companyId: assertUuid(input.companyId),
      invoiceId: assertUuid(input.invoiceId, "invoice"),
      reason: assertReason(input.reason, "A void reason"),
      voidDate: optionalIsoDate(input.voidDate, "Void date"),
    }),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyPermission(supabase, data.companyId, "sales.void");
    const rpc = await callSalesRpc<{ invoice_id: string; void_journal_id: string }>(
      supabase,
      "void_sales_invoice",
      {
        company_id: data.companyId,
        invoice_id: data.invoiceId,
        reason: data.reason,
        void_date: data.voidDate,
      },
    );
    if (!rpc.missing) return { journalId: rpc.data.void_journal_id };

    // ---- fallback until the migration is applied ----
    const { data: inv, error } = await supabase
      .from("sales_invoices" as never)
      .select("id, status, posted_journal_id, amount_paid_minor, amount_credited_minor" as never)
      .eq("id" as never, data.invoiceId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!inv) throw new Error("Invoice not found");
    const b = inv as {
      status: string;
      posted_journal_id: string | null;
      amount_paid_minor: number;
      amount_credited_minor: number;
    };
    if (b.status === "draft") throw new Error("Delete a draft invoice instead of voiding it");
    if (b.status === "void") throw new Error("Invoice is already void");
    if (b.status !== "authorised") {
      throw new Error("Only authorised invoices with no payments or credits can be voided");
    }
    if (b.amount_paid_minor > 0 || b.amount_credited_minor > 0) {
      throw new Error("Remove payments and credit allocations before voiding this invoice");
    }
    if (!b.posted_journal_id) throw new Error("Invoice has no posted journal");
    const journalId = await voidPostedDocument(
      supabase as never,
      b.posted_journal_id,
      `sales_invoice:${data.invoiceId}:void`,
      data.voidDate ?? undefined,
    );
    const { data: done, error: upErr } = await supabase
      .from("sales_invoices" as never)
      .update({
        status: "void",
        void_journal_id: journalId,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, data.invoiceId as never)
      .eq("status" as never, "authorised" as never)
      .select("id");
    if (upErr) throw new Error(upErr.message);
    if (!done || (done as unknown[]).length === 0)
      throw new Error("Invoice changed — reload and retry");
    return { journalId };
  });

export const deleteDraftInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; invoiceId: string }) => ({
    companyId: assertUuid(input.companyId),
    invoiceId: assertUuid(input.invoiceId, "invoice"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "sales.draft");
    await deleteDraftDocument(context.supabase, data.companyId, "invoice", data.invoiceId);
    return { ok: true };
  });

export const markInvoiceSent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; invoiceId: string }) => ({
    companyId: assertUuid(input.companyId),
    invoiceId: assertUuid(input.invoiceId, "invoice"),
  }))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyPermission(supabase, data.companyId, "sales.draft");
    const nowIso = new Date().toISOString();
    const { data: row, error } = await supabase
      .from("sales_invoices" as never)
      .update({ sent_at: nowIso } as never)
      .eq("id" as never, data.invoiceId as never)
      .eq("company_id" as never, data.companyId as never)
      .in("status" as never, ["authorised", "partly_paid", "paid"] as never)
      .select("id");
    if (error) {
      if (error.code === "42703") {
        throw new Error("Marking as sent needs a database update that has not been applied yet");
      }
      throw new Error(error.message);
    }
    if (!row || (row as unknown[]).length === 0) {
      throw new Error("Only authorised invoices can be marked as sent");
    }
    return { sentAt: nowIso };
  });

/** Copy an invoice into a NEW draft dated today (company timezone) with the customer's terms. */
export const copyInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; invoiceId: string }) => ({
    companyId: assertUuid(input.companyId),
    invoiceId: assertUuid(input.invoiceId, "invoice"),
  }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "sales.draft");
    const { data: inv, error } = await supabase
      .from("sales_invoices" as never)
      .select("contact_id, memo, currency_code, fx_rate_to_base, sales_invoice_lines(*)" as never)
      .eq("id" as never, data.invoiceId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!inv) throw new Error("Invoice not found");
    const src = inv as unknown as {
      contact_id: string;
      memo: string | null;
      currency_code: string;
      fx_rate_to_base?: number | null;
      sales_invoice_lines: Array<{
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
    const defaults = await loadCompanyDefaults(supabase, data.companyId);
    const terms = await customerTerms(supabase, data.companyId, src.contact_id);
    const today = defaults.today;
    const { currencyCode, fxRateToBase } = normaliseCurrencyAndFx(
      src.currency_code,
      defaults.baseCurrency,
      src.fx_rate_to_base ?? 1,
    );
    const { loadSalesTaxCodes } = await import("@/lib/sales/tax-codes");
    const available = new Set(
      (await loadSalesTaxCodes(supabase, data.companyId, today)).map((c) => c.id),
    );
    const lines = await prepareSalesLines(
      supabase,
      data.companyId,
      sortLines(src.sales_invoice_lines).map((l) => ({
        description: l.description,
        accountId: l.account_id,
        quantity: Number(l.quantity),
        unitPriceMinor: Number(l.unit_price_minor),
        discountMinor: Number(l.discount_minor),
        taxRateBps: Number(l.tax_rate_bps),
        taxCodeId: l.tax_code_id && available.has(l.tax_code_id) ? l.tax_code_id : null,
        productId: l.product_id ?? null,
      })),
      today,
    );
    const saved = await saveSalesDocument(supabase, {
      kind: "invoice",
      companyId: data.companyId,
      userId,
      contactId: src.contact_id,
      docDate: today,
      dueDate: addDaysIso(today, terms),
      memo: src.memo,
      currencyCode,
      fxRateToBase,
      lines,
    });
    return { id: saved.id };
  });

// ---- Quotes ----

const QUOTE_SORTS = ["quote_date", "expiry_date", "quote_number", "total_minor", "status"] as const;

type QuoteListInput = {
  companyId: string;
  status?: string;
  q?: string;
  from?: string;
  to?: string;
  sort?: string;
  dir?: string;
  page?: number;
  pageSize?: number;
};

function parseQuoteListInput(input: QuoteListInput) {
  const status = (input.status ?? "").trim();
  return {
    companyId: assertUuid(input.companyId),
    status: isQuoteStatus(status) ? status : null,
    q: (input.q ?? "").trim().slice(0, 100),
    from: isIsoDateString(input.from) ? input.from : null,
    to: isIsoDateString(input.to) ? input.to : null,
    sort: pickSort(input.sort, QUOTE_SORTS, "quote_date"),
    ascending: input.dir === "asc",
    page: clampPage(input.page),
    pageSize: clampPageSize(input.pageSize),
  };
}

const QUOTE_LIST_COLUMNS =
  "id, quote_number, quote_date, expiry_date, status, total_minor, currency_code, contact_id, contacts(name), converted_invoice_id";

function applyQuoteFilters(
  q: ListQuery,
  f: ReturnType<typeof parseQuoteListInput>,
  or: string | null,
): ListQuery {
  let out = q.eq("company_id" as never, f.companyId as never);
  if (f.status) out = out.eq("status" as never, f.status as never);
  if (f.from) out = out.gte("quote_date" as never, f.from as never);
  if (f.to) out = out.lte("quote_date" as never, f.to as never);
  if (or) out = out.or(or as never);
  return out;
}

async function quoteSearchOr(
  supabase: SalesClient,
  f: ReturnType<typeof parseQuoteListInput>,
): Promise<string | null> {
  const ids = f.q ? await searchContactIds(supabase, f.companyId, f.q) : [];
  return buildSearchOr(f.q, ["quote_number", "memo"], ids);
}

export const listQuotes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(parseQuoteListInput)
  .handler(async ({ data: f, context }) => {
    await assertCompanyMember(context.supabase, f.companyId);
    const or = await quoteSearchOr(context.supabase, f);
    const base = context.supabase
      .from("sales_quotes" as never)
      .select(QUOTE_LIST_COLUMNS as never, { count: "exact" });
    const {
      data: rows,
      error,
      count,
    } = await applyQuoteFilters(base as unknown as ListQuery, f, or)
      .order(f.sort as never, { ascending: f.ascending } as never)
      .order("id" as never, { ascending: true } as never)
      .range(f.page * f.pageSize, f.page * f.pageSize + f.pageSize - 1);
    if (error) throw new Error((error as { message: string }).message);
    const total = count ?? 0;
    const defaults = await loadCompanyDefaults(context.supabase, f.companyId);
    return {
      rows: (rows ?? []) as unknown as Array<{
        id: string;
        quote_number: string | null;
        quote_date: string;
        expiry_date: string | null;
        status: string;
        total_minor: number;
        currency_code: string;
        contact_id: string;
        contacts: { name: string } | null;
        converted_invoice_id: string | null;
      }>,
      total,
      page: f.page,
      pageSize: f.pageSize,
      hasNext: hasNextPage(total, f.page, f.pageSize),
      today: defaults.today,
    };
  });

export const exportQuotesCsv = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(parseQuoteListInput)
  .handler(async ({ data: f, context }) => {
    await assertCompanyMember(context.supabase, f.companyId);
    const or = await quoteSearchOr(context.supabase, f);
    const defaults = await loadCompanyDefaults(context.supabase, f.companyId);
    const rows = await fetchAllPages<Record<string, unknown>>(
      (from, to) =>
        applyQuoteFilters(
          context.supabase
            .from("sales_quotes" as never)
            .select(QUOTE_LIST_COLUMNS as never) as unknown as ListQuery,
          f,
          or,
        )
          .order(f.sort as never, { ascending: f.ascending } as never)
          .order("id" as never, { ascending: true } as never)
          .range(from, to) as never,
    );
    const csv = toCsv(
      ["Number", "Date", "Expiry", "Customer", "Status", "Currency", "Total"],
      rows.map((r) => [
        r["quote_number"],
        r["quote_date"],
        r["expiry_date"],
        (r["contacts"] as { name?: string } | null)?.name ?? "",
        r["status"],
        r["currency_code"],
        minorToDecimalString(Number(r["total_minor"])),
      ]),
    );
    return { filename: `quotes-${defaults.today}.csv`, csv, rowCount: rows.length };
  });

export const saveQuoteDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      quoteId?: string;
      contactId: string;
      quoteDate: string;
      expiryDate?: string;
      quoteNumber?: string;
      memo?: string;
      currencyCode: string;
      fxRateToBase?: number;
      lines: SalesLineInput[];
    }) => {
      if (!isIsoDate(input.quoteDate)) throw new Error("Quote date must be YYYY-MM-DD");
      const expiry = (input.expiryDate ?? "").trim();
      if (expiry && !isIsoDate(expiry)) throw new Error("Expiry date must be YYYY-MM-DD");
      if (expiry && expiry < input.quoteDate)
        throw new Error("Expiry date cannot be before the quote date");
      return {
        companyId: assertUuid(input.companyId),
        quoteId: input.quoteId ? assertUuid(input.quoteId) : undefined,
        contactId: assertUuid(input.contactId, "customer"),
        quoteDate: input.quoteDate,
        expiryDate: expiry || null,
        quoteNumber: (input.quoteNumber ?? "").trim().slice(0, 40) || null,
        memo: (input.memo ?? "").trim().slice(0, 500) || null,
        currencyCode: input.currencyCode ?? "",
        fxRateToBase: input.fxRateToBase,
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
    const lines = await prepareSalesLines(supabase, data.companyId, data.lines, data.quoteDate);
    const saved = await saveSalesDocument(supabase, {
      kind: "quote",
      companyId: data.companyId,
      userId,
      id: data.quoteId,
      contactId: data.contactId,
      docDate: data.quoteDate,
      expiryDate: data.expiryDate,
      number: data.quoteNumber,
      memo: data.memo,
      currencyCode,
      fxRateToBase,
      lines,
    });
    return { id: saved.id, quoteNumber: saved.number };
  });

export type QuoteDetail = {
  id: string;
  quote_number: string | null;
  quote_date: string;
  expiry_date: string | null;
  status: string;
  memo: string | null;
  currency_code: string;
  contact_id: string;
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  converted_invoice_id: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  contacts: { id: string; name: string; email: string | null } | null;
  sales_quote_lines: Array<{
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
    net_minor: number;
    tax_minor: number;
    gross_minor: number;
  }>;
};

export const getQuote = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; quoteId: string }) => ({
    companyId: assertUuid(input.companyId),
    quoteId: assertUuid(input.quoteId, "quote"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: row, error } = await context.supabase
      .from("sales_quotes" as never)
      .select("*, contacts(id, name, email), sales_quote_lines(*)" as never)
      .eq("id" as never, data.quoteId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Quote not found");
    const qr = row as unknown as { sales_quote_lines: Array<{ line_order: number; id: string }> };
    return {
      ...(row as unknown as Record<string, unknown>),
      sales_quote_lines: sortLines(qr.sales_quote_lines ?? []),
    } as unknown as QuoteDetail;
  });

export const updateQuoteStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; quoteId: string; status: string }) => {
    const status = (input.status ?? "").trim();
    if (!isQuoteStatus(status)) throw new Error("Invalid quote status");
    return {
      companyId: assertUuid(input.companyId),
      quoteId: assertUuid(input.quoteId, "quote"),
      status,
    };
  })
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyPermission(supabase, data.companyId, "sales.draft");
    const { data: existing, error } = await supabase
      .from("sales_quotes" as never)
      .select("id, status, converted_invoice_id" as never)
      .eq("id" as never, data.quoteId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!existing) throw new Error("Quote not found");
    const q = existing as { status: string; converted_invoice_id: string | null };
    if (q.converted_invoice_id) throw new Error("Converted quotes cannot change status");
    assertQuoteTransition(q.status, data.status);

    const nowIso = new Date().toISOString();
    const run = (extra: Record<string, string>) =>
      supabase
        .from("sales_quotes" as never)
        .update({ status: data.status, updated_at: nowIso, ...extra } as never)
        .eq("id" as never, data.quoteId as never)
        .eq("company_id" as never, data.companyId as never)
        .eq("status" as never, q.status as never) // lost-update guard
        .select("id");
    let res = await run(quoteTimestampColumns(data.status, nowIso));
    if (res.error?.code === "42703") res = await run({}); // timestamp columns not migrated yet
    if (res.error) throw new Error(res.error.message);
    if (!res.data || (res.data as unknown[]).length === 0) {
      throw new Error("Quote changed in the meantime — reload and retry");
    }
    return { id: data.quoteId, status: data.status };
  });

export const deleteDraftQuote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; quoteId: string }) => ({
    companyId: assertUuid(input.companyId),
    quoteId: assertUuid(input.quoteId, "quote"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "sales.draft");
    await deleteDraftDocument(context.supabase, data.companyId, "quote", data.quoteId);
    return { ok: true };
  });

export const convertQuoteToInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; quoteId: string; dueDate?: string }) => ({
    companyId: assertUuid(input.companyId),
    quoteId: assertUuid(input.quoteId),
    dueDate: optionalIsoDate(input.dueDate, "Due date"),
  }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "sales.draft");
    const { data: quote, error } = await supabase
      .from("sales_quotes" as never)
      .select("*, sales_quote_lines(*)" as never)
      .eq("id" as never, data.quoteId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!quote) throw new Error("Quote not found");
    const q = quote as unknown as {
      status: string;
      contact_id: string;
      expiry_date: string | null;
      currency_code: string;
      fx_rate_to_base?: number | null;
      memo: string | null;
      converted_invoice_id: string | null;
      sales_quote_lines: Array<{
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
    const defaults = await loadCompanyDefaults(supabase, data.companyId);
    const today = defaults.today;
    const ok = isQuoteConvertible(q, today);
    if (!ok.ok) throw new Error(ok.reason);

    const terms = await customerTerms(supabase, data.companyId, q.contact_id);
    const due = data.dueDate ?? addDaysIso(today, terms);
    if (due < today) throw new Error("Due date cannot be before the invoice date");
    const { currencyCode, fxRateToBase } = normaliseCurrencyAndFx(
      q.currency_code,
      defaults.baseCurrency,
      q.fx_rate_to_base ?? 1,
    );
    const { loadSalesTaxCodes } = await import("@/lib/sales/tax-codes");
    const available = new Set(
      (await loadSalesTaxCodes(supabase, data.companyId, today)).map((c) => c.id),
    );
    // Totals are recalculated from the quote lines under the CURRENT tax treatment.
    const lines = await prepareSalesLines(
      supabase,
      data.companyId,
      sortLines(q.sales_quote_lines).map((l) => ({
        description: l.description,
        accountId: l.account_id,
        quantity: Number(l.quantity),
        unitPriceMinor: Number(l.unit_price_minor),
        discountMinor: Number(l.discount_minor),
        taxRateBps: Number(l.tax_rate_bps),
        taxCodeId: l.tax_code_id && available.has(l.tax_code_id) ? l.tax_code_id : null,
        productId: l.product_id ?? null,
      })),
      today,
    );
    // The quote is claimed inside the same transaction as the invoice insert.
    const saved = await saveSalesDocument(supabase, {
      kind: "invoice",
      companyId: data.companyId,
      userId,
      contactId: q.contact_id,
      docDate: today,
      dueDate: due,
      memo: q.memo,
      currencyCode,
      fxRateToBase,
      quoteId: data.quoteId,
      lines,
    });
    return { invoiceId: saved.id };
  });
