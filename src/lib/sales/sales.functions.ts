import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { requireAccountInCompany } from "@/lib/purchases/accounts";
import {
  validateSalesLines,
  sumLines,
  deriveInvoiceStatus,
  invoiceOutstanding,
  nextDate,
  addDaysIso,
  type SalesLineInput,
} from "@/lib/sales/line-helpers";
import {
  postInvoiceAuthorisation,
  postCustomerReceipt,
  postSalesCreditAuthorisation,
  voidPostedDocument,
} from "@/lib/sales/posting";

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function parseSalesLineInputs(lines: SalesLineInput[]): SalesLineInput[] {
  if (!Array.isArray(lines) || !lines.length) throw new Error("At least one line is required");
  return lines.map((l, i) => {
    const description = (l.description ?? "").trim();
    if (!description) throw new Error(`Line ${i + 1}: description is required`);
    if (!l.accountId) throw new Error(`Line ${i + 1}: account is required`);
    const productId =
      l.productId && String(l.productId).trim()
        ? assertUuid(String(l.productId), `line ${i + 1} product`)
        : null;
    return {
      description,
      accountId: l.accountId,
      quantity: Number(l.quantity),
      unitPriceMinor: Math.round(Number(l.unitPriceMinor)),
      discountMinor: Math.round(Number(l.discountMinor ?? 0)),
      taxRateBps: Math.round(Number(l.taxRateBps ?? 0)),
      productId,
    };
  });
}

function lineInsertRows(
  companyId: string,
  parentKey: "invoice_id" | "quote_id" | "credit_note_id",
  parentId: string,
  lines: ReturnType<typeof validateSalesLines>,
  opts: { includeProductId?: boolean } = {},
) {
  return lines.map((l, i) => {
    const row: Record<string, unknown> = {
      company_id: companyId,
      [parentKey]: parentId,
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
    };
    if (opts.includeProductId) {
      row["product_id"] = l.productId ?? null;
    }
    return row;
  });
}

async function loadTaxTreatment(
  supabase: Parameters<typeof assertCompanyMember>[0],
  companyId: string,
): Promise<"exclusive" | "inclusive"> {
  const { data, error } = await supabase
    .from("company_tax_settings" as never)
    .select("prices_include_tax" as never)
    .eq("company_id" as never, companyId as never)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { prices_include_tax?: boolean } | null)?.prices_include_tax
    ? "inclusive"
    : "exclusive";
}

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
    if (data.q) q = q.ilike("name" as never, `%${data.q}%` as never);
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

// ---- Invoices ----

export const listInvoices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; status?: string; page?: number }) => ({
    companyId: assertUuid(input.companyId),
    status: (input.status ?? "").trim() || null,
    page: Math.max(0, Number(input.page ?? 0) || 0),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const pageSize = 50;
    let q = context.supabase
      .from("sales_invoices" as never)
      .select(
        "id, invoice_number, invoice_date, due_date, status, total_minor, amount_paid_minor, amount_credited_minor, currency_code, contact_id, contacts(name)" as never,
        { count: "exact" },
      )
      .eq("company_id" as never, data.companyId as never)
      .order("invoice_date" as never, { ascending: false })
      .range(data.page * pageSize, data.page * pageSize + pageSize - 1);
    if (data.status) q = q.eq("status" as never, data.status as never);
    const { data: rows, error, count } = await q;
    if (error) throw new Error(error.message);
    return { rows: rows ?? [], total: count ?? 0, page: data.page, pageSize };
  });

export const getInvoice = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; invoiceId: string }) => ({
    companyId: assertUuid(input.companyId),
    invoiceId: assertUuid(input.invoiceId, "invoice"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: row, error } = await context.supabase
      .from("sales_invoices" as never)
      .select("*, contacts(id, name, email), sales_invoice_lines(*)" as never)
      .eq("id" as never, data.invoiceId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Invoice not found");
    return row;
  });

export const saveInvoiceDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      invoiceId?: string;
      contactId: string;
      invoiceDate: string;
      dueDate: string;
      invoiceNumber?: string;
      memo?: string;
      currencyCode: string;
      lines: SalesLineInput[];
    }) => {
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
        currencyCode: (input.currencyCode ?? "").toUpperCase(),
        lines: parseSalesLineInputs(input.lines),
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "sales.draft");
    const treatment = await loadTaxTreatment(supabase, data.companyId);
    const lines = validateSalesLines(data.lines, { treatment });
    for (const line of lines) {
      await requireAccountInCompany(supabase, data.companyId, line.accountId);
    }
    const totals = sumLines(lines);

    if (data.invoiceId) {
      const { data: existing, error: exErr } = await supabase
        .from("sales_invoices" as never)
        .select("id, status" as never)
        .eq("id" as never, data.invoiceId as never)
        .eq("company_id" as never, data.companyId as never)
        .maybeSingle();
      if (exErr) throw new Error(exErr.message);
      if (!existing) throw new Error("Invoice not found");
      if ((existing as { status: string }).status !== "draft") {
        throw new Error("Only draft invoices can be edited");
      }
      const { error: upErr } = await supabase
        .from("sales_invoices" as never)
        .update({
          contact_id: data.contactId,
          invoice_date: data.invoiceDate,
          due_date: data.dueDate,
          invoice_number: data.invoiceNumber,
          memo: data.memo,
          currency_code: data.currencyCode,
          subtotal_minor: Number(totals.subtotal_minor),
          tax_minor: Number(totals.tax_minor),
          total_minor: Number(totals.total_minor),
          updated_at: new Date().toISOString(),
        } as never)
        .eq("id" as never, data.invoiceId as never);
      if (upErr) {
        if (upErr.code === "23505") throw new Error("An invoice with this number already exists");
        throw new Error(upErr.message);
      }
      await supabase
        .from("sales_invoice_lines" as never)
        .delete()
        .eq("invoice_id" as never, data.invoiceId as never);
      const { error: lineErr } = await supabase
        .from("sales_invoice_lines" as never)
        .insert(lineInsertRows(data.companyId, "invoice_id", data.invoiceId, lines, { includeProductId: true }) as never);
      if (lineErr) throw new Error(lineErr.message);
      return { id: data.invoiceId };
    }

    const { data: inserted, error } = await supabase
      .from("sales_invoices" as never)
      .insert({
        company_id: data.companyId,
        contact_id: data.contactId,
        invoice_date: data.invoiceDate,
        due_date: data.dueDate,
        invoice_number: data.invoiceNumber,
        memo: data.memo,
        currency_code: data.currencyCode,
        status: "draft",
        subtotal_minor: Number(totals.subtotal_minor),
        tax_minor: Number(totals.tax_minor),
        total_minor: Number(totals.total_minor),
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") throw new Error("An invoice with this number already exists");
      throw new Error(error.message);
    }
    const invoiceId = (inserted as { id: string }).id;
    const { error: lineErr } = await supabase
      .from("sales_invoice_lines" as never)
      .insert(lineInsertRows(data.companyId, "invoice_id", invoiceId, lines, { includeProductId: true }) as never);
    if (lineErr) throw new Error(lineErr.message);
    return { id: invoiceId };
  });

export const authoriseInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; invoiceId: string }) => ({
    companyId: assertUuid(input.companyId),
    invoiceId: assertUuid(input.invoiceId, "invoice"),
  }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "sales.authorise");
    const { data: inv, error } = await supabase
      .from("sales_invoices" as never)
      .select("*, sales_invoice_lines(*)" as never)
      .eq("id" as never, data.invoiceId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!inv) throw new Error("Invoice not found");
    const b = inv as {
      status: string;
      invoice_date: string;
      currency_code: string;
      memo: string | null;
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

    const journalId = await postInvoiceAuthorisation(supabase, {
      company_id: data.companyId,
      invoice_id: data.invoiceId,
      invoice_date: b.invoice_date,
      currency_code: b.currency_code,
      ...(b.memo ? { memo: b.memo } : {}),
      lines: b.sales_invoice_lines.map((l) => ({
        account_id: l.account_id,
        description: l.description,
        net_minor: l.net_minor,
        tax_minor: l.tax_minor,
      })),
    });

    const { error: upErr } = await supabase
      .from("sales_invoices" as never)
      .update({
        status: "authorised",
        posted_journal_id: journalId,
        authorised_at: new Date().toISOString(),
        authorised_by: userId,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, data.invoiceId as never);
    if (upErr) throw new Error(upErr.message);
    return { journalId };
  });

export const voidInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; invoiceId: string }) => ({
    companyId: assertUuid(input.companyId),
    invoiceId: assertUuid(input.invoiceId, "invoice"),
  }))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyPermission(supabase, data.companyId, "sales.void");
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
    if (b.status === "void" || b.status === "draft") {
      if (b.status === "draft") {
        const { error: upErr } = await supabase
          .from("sales_invoices" as never)
          .update({ status: "void", updated_at: new Date().toISOString() } as never)
          .eq("id" as never, data.invoiceId as never);
        if (upErr) throw new Error(upErr.message);
        return { journalId: null };
      }
      throw new Error("Invoice is already void");
    }
    if (b.amount_paid_minor > 0 || b.amount_credited_minor > 0) {
      throw new Error("Cannot void an invoice with payments or credits allocated");
    }
    if (!b.posted_journal_id) throw new Error("Invoice has no posted journal");
    const journalId = await voidPostedDocument(
      supabase,
      b.posted_journal_id,
      `sales_invoice:${data.invoiceId}:void`,
    );
    const { error: upErr } = await supabase
      .from("sales_invoices" as never)
      .update({
        status: "void",
        void_journal_id: journalId,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, data.invoiceId as never);
    if (upErr) throw new Error(upErr.message);
    return { journalId };
  });

// ---- Quotes ----

export const listQuotes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await context.supabase
      .from("sales_quotes" as never)
      .select(
        "id, quote_number, quote_date, expiry_date, status, total_minor, currency_code, contact_id, contacts(name), converted_invoice_id" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("quote_date" as never, { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return rows ?? [];
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
      lines: SalesLineInput[];
    }) => {
      if (!isIsoDate(input.quoteDate)) throw new Error("Quote date must be YYYY-MM-DD");
      const expiry = (input.expiryDate ?? "").trim();
      if (expiry && !isIsoDate(expiry)) throw new Error("Expiry date must be YYYY-MM-DD");
      return {
        companyId: assertUuid(input.companyId),
        quoteId: input.quoteId ? assertUuid(input.quoteId) : undefined,
        contactId: assertUuid(input.contactId, "customer"),
        quoteDate: input.quoteDate,
        expiryDate: expiry || null,
        quoteNumber: (input.quoteNumber ?? "").trim().slice(0, 40) || null,
        memo: (input.memo ?? "").trim().slice(0, 500) || null,
        currencyCode: (input.currencyCode ?? "").toUpperCase(),
        lines: parseSalesLineInputs(input.lines),
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "sales.draft");
    const treatment = await loadTaxTreatment(supabase, data.companyId);
    const lines = validateSalesLines(data.lines, { treatment });
    for (const line of lines) {
      await requireAccountInCompany(supabase, data.companyId, line.accountId);
    }
    const totals = sumLines(lines);

    if (data.quoteId) {
      const { data: existing, error: exErr } = await supabase
        .from("sales_quotes" as never)
        .select("id, status" as never)
        .eq("id" as never, data.quoteId as never)
        .eq("company_id" as never, data.companyId as never)
        .maybeSingle();
      if (exErr) throw new Error(exErr.message);
      if (!existing) throw new Error("Quote not found");
      const st = (existing as { status: string }).status;
      if (st === "converted" || st === "void") throw new Error("Converted or void quotes cannot be edited");
      await supabase
        .from("sales_quotes" as never)
        .update({
          contact_id: data.contactId,
          quote_date: data.quoteDate,
          expiry_date: data.expiryDate,
          quote_number: data.quoteNumber,
          memo: data.memo,
          currency_code: data.currencyCode,
          subtotal_minor: Number(totals.subtotal_minor),
          tax_minor: Number(totals.tax_minor),
          total_minor: Number(totals.total_minor),
          updated_at: new Date().toISOString(),
        } as never)
        .eq("id" as never, data.quoteId as never);
      await supabase.from("sales_quote_lines" as never).delete().eq("quote_id" as never, data.quoteId as never);
      await supabase
        .from("sales_quote_lines" as never)
        .insert(lineInsertRows(data.companyId, "quote_id", data.quoteId, lines, { includeProductId: true }) as never);
      return { id: data.quoteId };
    }

    const { data: inserted, error } = await supabase
      .from("sales_quotes" as never)
      .insert({
        company_id: data.companyId,
        contact_id: data.contactId,
        quote_date: data.quoteDate,
        expiry_date: data.expiryDate,
        quote_number: data.quoteNumber,
        memo: data.memo,
        currency_code: data.currencyCode,
        status: "draft",
        subtotal_minor: Number(totals.subtotal_minor),
        tax_minor: Number(totals.tax_minor),
        total_minor: Number(totals.total_minor),
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const quoteId = (inserted as { id: string }).id;
    await supabase
      .from("sales_quote_lines" as never)
      .insert(lineInsertRows(data.companyId, "quote_id", quoteId, lines, { includeProductId: true }) as never);
    return { id: quoteId };
  });

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
    return row;
  });

export const updateQuoteStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; quoteId: string; status: string }) => {
    const status = (input.status ?? "").trim();
    if (!["draft", "sent", "accepted", "declined", "expired", "void"].includes(status)) {
      throw new Error("Invalid quote status");
    }
    return {
      companyId: assertUuid(input.companyId),
      quoteId: assertUuid(input.quoteId, "quote"),
      status,
    };
  })
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "sales.draft");
    const { data: existing, error } = await context.supabase
      .from("sales_quotes" as never)
      .select("id, status, converted_invoice_id" as never)
      .eq("id" as never, data.quoteId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!existing) throw new Error("Quote not found");
    const q = existing as { status: string; converted_invoice_id: string | null };
    if (q.status === "converted" || q.converted_invoice_id) {
      throw new Error("Converted quotes cannot change status");
    }
    if (q.status === "void" && data.status !== "void") {
      throw new Error("Void quotes cannot be reopened");
    }
    const { error: upErr } = await context.supabase
      .from("sales_quotes" as never)
      .update({ status: data.status, updated_at: new Date().toISOString() } as never)
      .eq("id" as never, data.quoteId as never);
    if (upErr) throw new Error(upErr.message);
    return { id: data.quoteId, status: data.status };
  });

export const convertQuoteToInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; quoteId: string; dueDate?: string }) => ({
    companyId: assertUuid(input.companyId),
    quoteId: assertUuid(input.quoteId),
    dueDate: input.dueDate && isIsoDate(input.dueDate) ? input.dueDate : null,
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
    const q = quote as {
      status: string;
      contact_id: string;
      quote_date: string;
      currency_code: string;
      memo: string | null;
      converted_invoice_id: string | null;
      subtotal_minor: number;
      tax_minor: number;
      total_minor: number;
      sales_quote_lines: Array<{
        description: string;
        account_id: string;
        quantity: number;
        unit_price_minor: number;
        discount_minor: number;
        tax_rate_bps: number;
        net_minor: number;
        tax_minor: number;
        gross_minor: number;
        product_id: string | null;
      }>;
    };
    if (q.status === "converted" || q.converted_invoice_id) {
      throw new Error("Quote already converted");
    }
    if (q.status === "void" || q.status === "declined") {
      throw new Error("Cannot convert a void or declined quote");
    }
    const due = data.dueDate ?? addDaysIso(q.quote_date, 30);

    const { data: inserted, error: insErr } = await supabase
      .from("sales_invoices" as never)
      .insert({
        company_id: data.companyId,
        contact_id: q.contact_id,
        invoice_date: q.quote_date,
        due_date: due,
        memo: q.memo,
        currency_code: q.currency_code,
        status: "draft",
        subtotal_minor: q.subtotal_minor,
        tax_minor: q.tax_minor,
        total_minor: q.total_minor,
        quote_id: data.quoteId,
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (insErr) throw new Error(insErr.message);
    const invoiceId = (inserted as { id: string }).id;
    const { error: lineErr } = await supabase.from("sales_invoice_lines" as never).insert(
      q.sales_quote_lines.map((l, i) => ({
        company_id: data.companyId,
        invoice_id: invoiceId,
        line_order: i + 1,
        description: l.description,
        account_id: l.account_id,
        quantity: l.quantity,
        unit_price_minor: l.unit_price_minor,
        discount_minor: l.discount_minor,
        tax_rate_bps: l.tax_rate_bps,
        net_minor: l.net_minor,
        tax_minor: l.tax_minor,
        gross_minor: l.gross_minor,
        product_id: l.product_id ?? null,
      })) as never,
    );
    if (lineErr) throw new Error(lineErr.message);

    await supabase
      .from("sales_quotes" as never)
      .update({
        status: "converted",
        converted_invoice_id: invoiceId,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, data.quoteId as never);

    return { invoiceId };
  });

// ---- Receipts ----

export const listReceipts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await context.supabase
      .from("sales_receipts" as never)
      .select(
        "id, receipt_date, amount_minor, unallocated_minor, status, reference, currency_code, contact_id, contacts(name)" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("receipt_date" as never, { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const recordReceipt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      contactId: string;
      receiptDate: string;
      amountMinor: number;
      bankAccountId: string;
      currencyCode: string;
      reference?: string;
      memo?: string;
      allocations: Array<{ invoiceId: string; amountMinor: number }>;
    }) => {
      if (!isIsoDate(input.receiptDate)) throw new Error("Receipt date must be YYYY-MM-DD");
      const amount = Math.round(Number(input.amountMinor));
      if (!(amount > 0)) throw new Error("Receipt amount must be positive");
      const allocations = (input.allocations ?? []).map((a) => ({
        invoiceId: assertUuid(a.invoiceId, "invoice"),
        amountMinor: Math.round(Number(a.amountMinor)),
      }));
      for (const a of allocations) {
        if (!(a.amountMinor > 0)) throw new Error("Allocation amounts must be positive");
      }
      const allocSum = allocations.reduce((s, a) => s + a.amountMinor, 0);
      if (allocSum > amount) throw new Error("Allocations exceed receipt amount");
      return {
        companyId: assertUuid(input.companyId),
        contactId: assertUuid(input.contactId, "customer"),
        receiptDate: input.receiptDate,
        amountMinor: amount,
        bankAccountId: assertUuid(input.bankAccountId, "bank account"),
        currencyCode: (input.currencyCode ?? "").toUpperCase(),
        reference: (input.reference ?? "").trim().slice(0, 80) || null,
        memo: (input.memo ?? "").trim().slice(0, 500) || null,
        allocations,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "sales.payment");
    await requireAccountInCompany(supabase, data.companyId, data.bankAccountId);

    const unallocated = data.amountMinor - data.allocations.reduce((s, a) => s + a.amountMinor, 0);

    const { data: inserted, error } = await supabase
      .from("sales_receipts" as never)
      .insert({
        company_id: data.companyId,
        contact_id: data.contactId,
        receipt_date: data.receiptDate,
        currency_code: data.currencyCode,
        amount_minor: data.amountMinor,
        unallocated_minor: unallocated,
        bank_account_id: data.bankAccountId,
        reference: data.reference,
        memo: data.memo,
        status: "posted",
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const receiptId = (inserted as { id: string }).id;

    // Idempotent journal via receipt id
    const journalId = await postCustomerReceipt(supabase, {
      company_id: data.companyId,
      receipt_id: receiptId,
      receipt_date: data.receiptDate,
      currency_code: data.currencyCode,
      bank_account_id: data.bankAccountId,
      amount_minor: data.amountMinor,
      ...(data.memo ? { memo: data.memo } : {}),
    });

    await supabase
      .from("sales_receipts" as never)
      .update({ posted_journal_id: journalId } as never)
      .eq("id" as never, receiptId as never);

    for (const alloc of data.allocations) {
      const { data: inv, error: invErr } = await supabase
        .from("sales_invoices" as never)
        .select(
          "id, status, contact_id, total_minor, amount_paid_minor, amount_credited_minor, currency_code" as never,
        )
        .eq("id" as never, alloc.invoiceId as never)
        .eq("company_id" as never, data.companyId as never)
        .maybeSingle();
      if (invErr) throw new Error(invErr.message);
      if (!inv) throw new Error("Invoice not found for allocation");
      const invoice = inv as {
        status: string;
        contact_id: string;
        total_minor: number;
        amount_paid_minor: number;
        amount_credited_minor: number;
        currency_code: string;
      };
      if (invoice.contact_id !== data.contactId) {
        throw new Error("Invoice belongs to a different customer");
      }
      if (invoice.currency_code !== data.currencyCode) {
        throw new Error("Invoice currency does not match receipt");
      }
      if (!["authorised", "partly_paid"].includes(invoice.status)) {
        throw new Error("Can only allocate to authorised or partly paid invoices");
      }
      const outstanding = Number(
        invoiceOutstanding({
          total_minor: invoice.total_minor,
          amount_paid_minor: invoice.amount_paid_minor,
          amount_credited_minor: invoice.amount_credited_minor,
        }),
      );
      if (alloc.amountMinor > outstanding) {
        throw new Error("Allocation exceeds invoice outstanding balance");
      }

      const { error: aErr } = await supabase.from("sales_receipt_allocations" as never).insert({
        company_id: data.companyId,
        receipt_id: receiptId,
        invoice_id: alloc.invoiceId,
        amount_minor: alloc.amountMinor,
        created_by: userId,
      } as never);
      if (aErr) {
        if (aErr.code === "23505") throw new Error("This invoice is already allocated on this receipt");
        throw new Error(aErr.message);
      }

      const newPaid = invoice.amount_paid_minor + alloc.amountMinor;
      const newStatus = deriveInvoiceStatus({
        status: invoice.status,
        total_minor: invoice.total_minor,
        amount_paid_minor: newPaid,
        amount_credited_minor: invoice.amount_credited_minor,
      });
      await supabase
        .from("sales_invoices" as never)
        .update({
          amount_paid_minor: newPaid,
          status: newStatus,
          updated_at: new Date().toISOString(),
        } as never)
        .eq("id" as never, alloc.invoiceId as never);
    }

    return { id: receiptId, journalId, unallocatedMinor: unallocated };
  });

// ---- Credit notes ----

export const listCreditNotes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await context.supabase
      .from("sales_credit_notes" as never)
      .select(
        "id, credit_number, credit_date, status, total_minor, amount_allocated_minor, currency_code, contact_id, contacts(name)" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("credit_date" as never, { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const getCreditNote = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; creditNoteId: string }) => ({
    companyId: assertUuid(input.companyId),
    creditNoteId: assertUuid(input.creditNoteId, "credit note"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: row, error } = await context.supabase
      .from("sales_credit_notes" as never)
      .select(
        "*, contacts(id, name, email), sales_credit_note_lines(*), sales_credit_allocations(id, invoice_id, amount_minor, created_at)" as never,
      )
      .eq("id" as never, data.creditNoteId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Credit note not found");
    return row;
  });

export const saveCreditNoteDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      contactId: string;
      creditDate: string;
      creditNumber?: string;
      memo?: string;
      currencyCode: string;
      invoiceId?: string;
      lines: SalesLineInput[];
    }) => {
      if (!isIsoDate(input.creditDate)) throw new Error("Credit date must be YYYY-MM-DD");
      return {
        companyId: assertUuid(input.companyId),
        contactId: assertUuid(input.contactId, "customer"),
        creditDate: input.creditDate,
        creditNumber: (input.creditNumber ?? "").trim().slice(0, 40) || null,
        memo: (input.memo ?? "").trim().slice(0, 500) || null,
        currencyCode: (input.currencyCode ?? "").toUpperCase(),
        invoiceId: input.invoiceId ? assertUuid(input.invoiceId) : null,
        lines: parseSalesLineInputs(input.lines),
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "sales.draft");
    const treatment = await loadTaxTreatment(supabase, data.companyId);
    const lines = validateSalesLines(data.lines, { treatment });
    for (const line of lines) {
      await requireAccountInCompany(supabase, data.companyId, line.accountId);
    }
    const totals = sumLines(lines);
    const { data: inserted, error } = await supabase
      .from("sales_credit_notes" as never)
      .insert({
        company_id: data.companyId,
        contact_id: data.contactId,
        credit_date: data.creditDate,
        credit_number: data.creditNumber,
        memo: data.memo,
        currency_code: data.currencyCode,
        invoice_id: data.invoiceId,
        status: "draft",
        subtotal_minor: Number(totals.subtotal_minor),
        tax_minor: Number(totals.tax_minor),
        total_minor: Number(totals.total_minor),
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const creditId = (inserted as { id: string }).id;
    await supabase.from("sales_credit_note_lines" as never).insert(
      lines.map((l, i) => ({
        company_id: data.companyId,
        credit_note_id: creditId,
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
    return { id: creditId };
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
    const c = cn as {
      status: string;
      credit_date: string;
      currency_code: string;
      memo: string | null;
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

    const journalId = await postSalesCreditAuthorisation(supabase, {
      company_id: data.companyId,
      credit_note_id: data.creditNoteId,
      credit_date: c.credit_date,
      currency_code: c.currency_code,
      ...(c.memo ? { memo: c.memo } : {}),
      lines: c.sales_credit_note_lines.map((l) => ({
        account_id: l.account_id,
        description: l.description,
        net_minor: l.net_minor,
        tax_minor: l.tax_minor,
      })),
    });

    await supabase
      .from("sales_credit_notes" as never)
      .update({
        status: "authorised",
        posted_journal_id: journalId,
        authorised_at: new Date().toISOString(),
        authorised_by: userId,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, data.creditNoteId as never);

    return { journalId };
  });

export const allocateCreditNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      creditNoteId: string;
      allocations: Array<{ invoiceId: string; amountMinor: number }>;
    }) => ({
      companyId: assertUuid(input.companyId),
      creditNoteId: assertUuid(input.creditNoteId),
      allocations: (input.allocations ?? []).map((a) => ({
        invoiceId: assertUuid(a.invoiceId),
        amountMinor: Math.round(Number(a.amountMinor)),
      })),
    }),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "sales.payment");
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
    if (!["authorised", "partly_paid"].includes(credit.status)) {
      throw new Error("Credit note must be authorised before allocation");
    }
    const remaining = credit.total_minor - credit.amount_allocated_minor;
    const allocSum = data.allocations.reduce((s, a) => s + a.amountMinor, 0);
    if (allocSum <= 0) throw new Error("At least one allocation is required");
    if (allocSum > remaining) throw new Error("Allocations exceed unallocated credit");

    let allocated = credit.amount_allocated_minor;
    for (const alloc of data.allocations) {
      if (!(alloc.amountMinor > 0)) throw new Error("Allocation amounts must be positive");
      const { data: inv, error: invErr } = await supabase
        .from("sales_invoices" as never)
        .select(
          "id, status, contact_id, total_minor, amount_paid_minor, amount_credited_minor, currency_code" as never,
        )
        .eq("id" as never, alloc.invoiceId as never)
        .eq("company_id" as never, data.companyId as never)
        .maybeSingle();
      if (invErr) throw new Error(invErr.message);
      if (!inv) throw new Error("Invoice not found");
      const invoice = inv as {
        status: string;
        contact_id: string;
        total_minor: number;
        amount_paid_minor: number;
        amount_credited_minor: number;
        currency_code: string;
      };
      if (invoice.contact_id !== credit.contact_id) throw new Error("Invoice belongs to a different customer");
      if (invoice.currency_code !== credit.currency_code) throw new Error("Currency mismatch");
      const outstanding = Number(
        invoiceOutstanding({
          total_minor: invoice.total_minor,
          amount_paid_minor: invoice.amount_paid_minor,
          amount_credited_minor: invoice.amount_credited_minor,
        }),
      );
      if (alloc.amountMinor > outstanding) throw new Error("Allocation exceeds invoice outstanding");

      const { error: aErr } = await supabase.from("sales_credit_allocations" as never).insert({
        company_id: data.companyId,
        credit_note_id: data.creditNoteId,
        invoice_id: alloc.invoiceId,
        amount_minor: alloc.amountMinor,
        created_by: userId,
      } as never);
      if (aErr) {
        if (aErr.code === "23505") throw new Error("Already allocated to this invoice");
        throw new Error(aErr.message);
      }

      const newCredited = invoice.amount_credited_minor + alloc.amountMinor;
      const newStatus = deriveInvoiceStatus({
        status: invoice.status,
        total_minor: invoice.total_minor,
        amount_paid_minor: invoice.amount_paid_minor,
        amount_credited_minor: newCredited,
      });
      await supabase
        .from("sales_invoices" as never)
        .update({
          amount_credited_minor: newCredited,
          status: newStatus,
          updated_at: new Date().toISOString(),
        } as never)
        .eq("id" as never, alloc.invoiceId as never);
      allocated += alloc.amountMinor;
    }

    const cnStatus =
      allocated >= credit.total_minor ? "paid" : allocated > 0 ? "partly_paid" : credit.status;
    await supabase
      .from("sales_credit_notes" as never)
      .update({
        amount_allocated_minor: allocated,
        status: cnStatus,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, data.creditNoteId as never);

    return { allocatedMinor: allocated };
  });

// ---- Recurring ----

export const listRecurringInvoices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await context.supabase
      .from("sales_recurring_invoices" as never)
      .select(
        "id, name, frequency, next_due_date, is_active, auto_authorise, last_generated_on, last_error, contact_id, contacts(name)" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("next_due_date" as never)
      .limit(100);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const saveRecurringInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      contactId: string;
      name: string;
      frequency: string;
      nextDueDate: string;
      currencyCode: string;
      autoAuthorise?: boolean;
      memo?: string;
      lines: SalesLineInput[];
    }) => {
      const name = (input.name ?? "").trim();
      if (!name) throw new Error("Name is required");
      if (!["weekly", "monthly", "quarterly", "yearly"].includes(input.frequency)) {
        throw new Error("Invalid frequency");
      }
      if (!isIsoDate(input.nextDueDate)) throw new Error("Next due date must be YYYY-MM-DD");
      return {
        companyId: assertUuid(input.companyId),
        contactId: assertUuid(input.contactId),
        name,
        frequency: input.frequency,
        nextDueDate: input.nextDueDate,
        currencyCode: (input.currencyCode ?? "").toUpperCase(),
        autoAuthorise: Boolean(input.autoAuthorise),
        memo: (input.memo ?? "").trim().slice(0, 500) || null,
        lines: parseSalesLineInputs(input.lines),
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "sales.draft");
    for (const line of data.lines) {
      await requireAccountInCompany(supabase, data.companyId, line.accountId);
    }
    const { data: inserted, error } = await supabase
      .from("sales_recurring_invoices" as never)
      .insert({
        company_id: data.companyId,
        contact_id: data.contactId,
        name: data.name,
        frequency: data.frequency,
        next_due_date: data.nextDueDate,
        currency_code: data.currencyCode,
        auto_authorise: data.autoAuthorise,
        memo: data.memo,
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const id = (inserted as { id: string }).id;
    await supabase.from("sales_recurring_invoice_lines" as never).insert(
      data.lines.map((l, i) => ({
        company_id: data.companyId,
        recurring_id: id,
        line_order: i + 1,
        description: l.description,
        account_id: l.accountId,
        quantity: l.quantity,
        unit_price_minor: l.unitPriceMinor,
        discount_minor: l.discountMinor,
        tax_rate_bps: l.taxRateBps,
      })) as never,
    );
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
    const { data: rec, error } = await supabase
      .from("sales_recurring_invoices" as never)
      .select("*, sales_recurring_invoice_lines(*)" as never)
      .eq("id" as never, data.recurringId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!rec) throw new Error("Recurring invoice not found");
    const r = rec as {
      is_active: boolean;
      contact_id: string;
      next_due_date: string;
      currency_code: string;
      memo: string | null;
      frequency: string;
      auto_authorise: boolean;
      last_generated_on: string | null;
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
    if (r.last_generated_on === r.next_due_date) {
      throw new Error("Already generated for this due date (idempotent guard)");
    }

    const treatment = await loadTaxTreatment(supabase, data.companyId);
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
      const d = new Date(`${r.next_due_date}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 30);
      return d.toISOString().slice(0, 10);
    })();

    const { data: inserted, error: insErr } = await supabase
      .from("sales_invoices" as never)
      .insert({
        company_id: data.companyId,
        contact_id: r.contact_id,
        invoice_date: r.next_due_date,
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
        company_id: data.companyId,
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
    if (r.auto_authorise) {
      try {
        await assertCompanyPermission(supabase, data.companyId, "sales.authorise");
        journalId = await postInvoiceAuthorisation(supabase, {
          company_id: data.companyId,
          invoice_id: invoiceId,
          invoice_date: r.next_due_date,
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
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Authorise failed";
        await supabase
          .from("sales_recurring_invoices" as never)
          .update({ last_error: msg } as never)
          .eq("id" as never, data.recurringId as never);
        throw e;
      }
    }

    const next = nextDate(r.next_due_date, r.frequency);
    await supabase
      .from("sales_recurring_invoices" as never)
      .update({
        last_generated_on: r.next_due_date,
        last_invoice_id: invoiceId,
        next_due_date: next,
        last_error: null,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, data.recurringId as never);

    return { invoiceId, journalId, nextDueDate: next };
  });

export const setRecurringActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; recurringId: string; isActive: boolean }) => ({
    companyId: assertUuid(input.companyId),
    recurringId: assertUuid(input.recurringId),
    isActive: Boolean(input.isActive),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "sales.draft");
    const { data: row, error } = await context.supabase
      .from("sales_recurring_invoices" as never)
      .update({ is_active: data.isActive, updated_at: new Date().toISOString() } as never)
      .eq("id" as never, data.recurringId as never)
      .eq("company_id" as never, data.companyId as never)
      .select("id, is_active" as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Recurring invoice not found");
    return row as { id: string; is_active: boolean };
  });

// ---- Statements ----

export const getCustomerStatement = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; contactId: string; from?: string; to?: string }) => ({
    companyId: assertUuid(input.companyId),
    contactId: assertUuid(input.contactId),
    from: input.from && isIsoDate(input.from) ? input.from : null,
    to: input.to && isIsoDate(input.to) ? input.to : null,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    let invQ = context.supabase
      .from("sales_invoices" as never)
      .select(
        "id, invoice_date, due_date, status, total_minor, amount_paid_minor, amount_credited_minor, invoice_number, currency_code" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .eq("contact_id" as never, data.contactId as never)
      .neq("status" as never, "void" as never)
      .neq("status" as never, "draft" as never)
      .order("invoice_date" as never);
    if (data.from) invQ = invQ.gte("invoice_date" as never, data.from as never);
    if (data.to) invQ = invQ.lte("invoice_date" as never, data.to as never);
    const { data: invoices, error: iErr } = await invQ;
    if (iErr) throw new Error(iErr.message);

    let recQ = context.supabase
      .from("sales_receipts" as never)
      .select("id, receipt_date, amount_minor, unallocated_minor, reference, currency_code, status" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("contact_id" as never, data.contactId as never)
      .eq("status" as never, "posted" as never)
      .order("receipt_date" as never);
    if (data.from) recQ = recQ.gte("receipt_date" as never, data.from as never);
    if (data.to) recQ = recQ.lte("receipt_date" as never, data.to as never);
    const { data: receipts, error: rErr } = await recQ;
    if (rErr) throw new Error(rErr.message);

    let cnQ = context.supabase
      .from("sales_credit_notes" as never)
      .select(
        "id, credit_date, credit_number, status, total_minor, amount_allocated_minor, currency_code" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .eq("contact_id" as never, data.contactId as never)
      .neq("status" as never, "void" as never)
      .neq("status" as never, "draft" as never)
      .order("credit_date" as never);
    if (data.from) cnQ = cnQ.gte("credit_date" as never, data.from as never);
    if (data.to) cnQ = cnQ.lte("credit_date" as never, data.to as never);
    const { data: creditNotes, error: cErr } = await cnQ;
    if (cErr) throw new Error(cErr.message);

    type TimelineRow = {
      date: string;
      type: "invoice" | "receipt" | "credit_note";
      id: string;
      reference: string | null;
      debit_minor: number;
      credit_minor: number;
      due_date?: string | null;
      status: string;
    };

    const timeline: TimelineRow[] = [];
    for (const inv of (invoices ?? []) as Array<{
      id: string;
      invoice_date: string;
      due_date: string;
      status: string;
      total_minor: number;
      invoice_number: string | null;
    }>) {
      timeline.push({
        date: inv.invoice_date,
        type: "invoice",
        id: inv.id,
        reference: inv.invoice_number,
        debit_minor: inv.total_minor,
        credit_minor: 0,
        due_date: inv.due_date,
        status: inv.status,
      });
    }
    for (const r of (receipts ?? []) as Array<{
      id: string;
      receipt_date: string;
      amount_minor: number;
      reference: string | null;
      status: string;
    }>) {
      timeline.push({
        date: r.receipt_date,
        type: "receipt",
        id: r.id,
        reference: r.reference,
        debit_minor: 0,
        credit_minor: r.amount_minor,
        status: r.status,
      });
    }
    for (const cn of (creditNotes ?? []) as Array<{
      id: string;
      credit_date: string;
      credit_number: string | null;
      total_minor: number;
      status: string;
    }>) {
      timeline.push({
        date: cn.credit_date,
        type: "credit_note",
        id: cn.id,
        reference: cn.credit_number,
        debit_minor: 0,
        credit_minor: cn.total_minor,
        status: cn.status,
      });
    }
    timeline.sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));

    let running = 0;
    const lines = timeline.map((t) => {
      running += t.debit_minor - t.credit_minor;
      return { ...t, balance_minor: running };
    });

    const invRows = (invoices ?? []) as Array<{
      total_minor: number;
      amount_paid_minor: number;
      amount_credited_minor: number;
      status: string;
    }>;
    const outstanding = invRows
      .filter((i) => ["authorised", "partly_paid"].includes(i.status))
      .reduce(
        (s, i) =>
          s +
          Number(
            invoiceOutstanding({
              total_minor: i.total_minor,
              amount_paid_minor: i.amount_paid_minor,
              amount_credited_minor: i.amount_credited_minor,
            }),
          ),
        0,
      );

    const unappliedCredits = ((creditNotes ?? []) as Array<{
      total_minor: number;
      amount_allocated_minor: number;
      status: string;
    }>)
      .filter((c) => ["authorised", "partly_paid"].includes(c.status))
      .reduce((s, c) => s + (c.total_minor - c.amount_allocated_minor), 0);

    const unappliedReceipts = ((receipts ?? []) as Array<{ unallocated_minor: number }>).reduce(
      (s, r) => s + (r.unallocated_minor ?? 0),
      0,
    );

    return {
      invoices: invoices ?? [],
      receipts: receipts ?? [],
      creditNotes: creditNotes ?? [],
      lines,
      closingBalanceMinor: running,
      outstandingMinor: outstanding,
      unappliedCreditMinor: unappliedCredits,
      unappliedReceiptMinor: unappliedReceipts,
    };
  });

export const getSalesOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await context.supabase
      .from("sales_invoices" as never)
      .select("status, total_minor, amount_paid_minor, amount_credited_minor, due_date" as never)
      .eq("company_id" as never, data.companyId as never)
      .neq("status" as never, "void" as never);
    if (error) throw new Error(error.message);
    const today = new Date().toISOString().slice(0, 10);
    let draft = 0;
    let awaiting = 0;
    let overdue = 0;
    for (const r of (rows ?? []) as Array<{
      status: string;
      total_minor: number;
      amount_paid_minor: number;
      amount_credited_minor: number;
      due_date: string;
    }>) {
      if (r.status === "draft") {
        draft += 1;
        continue;
      }
      const out = Number(
        invoiceOutstanding({
          total_minor: r.total_minor,
          amount_paid_minor: r.amount_paid_minor,
          amount_credited_minor: r.amount_credited_minor,
        }),
      );
      if (out <= 0) continue;
      if (r.due_date < today) overdue += out;
      else awaiting += out;
    }
    return { draftCount: draft, awaitingMinor: awaiting, overdueMinor: overdue };
  });
