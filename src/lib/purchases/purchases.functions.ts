import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { computeLineAmounts, deriveBillStatus, sumLines } from "@/lib/purchases/line-math";
import { requireAccountInCompany } from "@/lib/purchases/accounts";
import {
  postBillAuthorisation,
  postCreditNoteAuthorisation,
  postDirectExpense,
  postSupplierPayment,
  voidPostedDocument,
} from "@/lib/purchases/posting";

function companyIdOf(input: { companyId: string }) {
  return { companyId: assertUuid(input.companyId) };
}

// ---- Contacts / suppliers ----

export const listSuppliers = createServerFn({ method: "GET" })
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
      .in("kind" as never, ["supplier", "both"] as never)
      .order("name" as never);
    if (data.q) q = q.ilike("name" as never, `%${data.q}%` as never);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const upsertSupplier = createServerFn({ method: "POST" })
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
      if (name.length < 1) throw new Error("Supplier name is required");
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
      if (error) throw new Error(error.message);
      if (!row) throw new Error("Supplier not found");
      return { id: data.id };
    }
    const { data: row, error } = await context.supabase
      .from("contacts" as never)
      .insert({
        company_id: data.companyId,
        kind: "supplier",
        name: data.name,
        email: data.email,
        phone: data.phone,
        tax_number: data.taxNumber,
        payment_terms_days: data.paymentTermsDays,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: (row as { id: string }).id };
  });

// ---- Bills ----

type BillLineIn = {
  description: string;
  accountId: string;
  quantity: number;
  unitPriceMinor: number;
  discountMinor?: number;
  taxRateBps?: number;
};

function validateBillLines(lines: BillLineIn[]) {
  if (!Array.isArray(lines) || lines.length < 1) throw new Error("Add at least one bill line");
  return lines.map((l, i) => {
    const description = (l.description ?? "").trim();
    if (!description) throw new Error(`Line ${i + 1}: description required`);
    const computed = computeLineAmounts({
      quantity: Number(l.quantity),
      unit_price_minor: l.unitPriceMinor,
      discount_minor: l.discountMinor ?? 0,
      tax_rate_bps: l.taxRateBps ?? 0,
    });
    return {
      description,
      accountId: assertUuid(l.accountId, "account"),
      quantity: Number(l.quantity),
      unitPriceMinor: Number(l.unitPriceMinor),
      discountMinor: Number(l.discountMinor ?? 0),
      taxRateBps: Number(l.taxRateBps ?? 0),
      ...computed,
    };
  });
}

export const listBills = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; status?: string; q?: string; limit?: number; offset?: number }) => ({
      companyId: assertUuid(input.companyId),
      status: input.status,
      q: (input.q ?? "").trim().slice(0, 100),
      limit: Math.min(Math.max(Number(input.limit ?? 50), 1), 100),
      offset: Math.max(Number(input.offset ?? 0), 0),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    let q = context.supabase
      .from("purchase_bills" as never)
      .select(
        "id, bill_number, supplier_invoice_number, bill_date, due_date, status, total_minor, amount_paid_minor, amount_credited_minor, currency_code, contact_id, contacts(name)" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("bill_date" as never, { ascending: false } as never)
      .range(data.offset, data.offset + data.limit - 1);
    if (data.status) q = q.eq("status" as never, data.status as never);
    if (data.q) {
      const term = `%${data.q}%`;
      q = q.or(
        `bill_number.ilike.${term},supplier_invoice_number.ilike.${term},memo.ilike.${term}` as never,
      );
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const getBill = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; billId: string }) => ({
    companyId: assertUuid(input.companyId),
    billId: assertUuid(input.billId, "bill"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const { data: bill, error } = await context.supabase
      .from("purchase_bills" as never)
      .select("*, contacts(id, name, email), purchase_bill_lines(*)" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("id" as never, data.billId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!bill) throw new Error("Bill not found");
    return bill;
  });

export const saveBillDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      billId?: string;
      contactId: string;
      billDate: string;
      dueDate: string;
      supplierInvoiceNumber?: string;
      memo?: string;
      currencyCode: string;
      lines: BillLineIn[];
    }) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.billDate) || !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) {
        throw new Error("Bill and due dates are required (YYYY-MM-DD)");
      }
      return {
        companyId: assertUuid(input.companyId),
        billId: input.billId ? assertUuid(input.billId, "bill") : undefined,
        contactId: assertUuid(input.contactId, "supplier"),
        billDate: input.billDate,
        dueDate: input.dueDate,
        supplierInvoiceNumber: (input.supplierInvoiceNumber ?? "").trim().slice(0, 80) || null,
        memo: (input.memo ?? "").trim().slice(0, 500) || null,
        currencyCode: (input.currencyCode ?? "").toUpperCase(),
        lines: validateBillLines(input.lines),
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "purchases.draft");
    for (const line of data.lines) {
      await requireAccountInCompany(supabase, data.companyId, line.accountId);
    }
    const totals = sumLines(data.lines);

    if (data.billId) {
      const { data: existing, error: exErr } = await supabase
        .from("purchase_bills" as never)
        .select("id, status" as never)
        .eq("id" as never, data.billId as never)
        .eq("company_id" as never, data.companyId as never)
        .maybeSingle();
      if (exErr) throw new Error(exErr.message);
      if (!existing) throw new Error("Bill not found");
      if ((existing as { status: string }).status !== "draft") {
        throw new Error("Only draft bills can be edited");
      }
      const { error: upErr } = await supabase
        .from("purchase_bills" as never)
        .update({
          contact_id: data.contactId,
          bill_date: data.billDate,
          due_date: data.dueDate,
          supplier_invoice_number: data.supplierInvoiceNumber,
          memo: data.memo,
          currency_code: data.currencyCode,
          subtotal_minor: Number(totals.subtotal_minor),
          tax_minor: Number(totals.tax_minor),
          total_minor: Number(totals.total_minor),
          updated_at: new Date().toISOString(),
        } as never)
        .eq("id" as never, data.billId as never);
      if (upErr) {
        if (upErr.message.toLowerCase().includes("duplicate") || upErr.code === "23505") {
          throw new Error("A bill with this supplier invoice number already exists");
        }
        throw new Error(upErr.message);
      }
      await supabase
        .from("purchase_bill_lines" as never)
        .delete()
        .eq("bill_id" as never, data.billId as never);
      const { error: lineErr } = await supabase.from("purchase_bill_lines" as never).insert(
        data.lines.map((l, i) => ({
          company_id: data.companyId,
          bill_id: data.billId,
          line_no: i + 1,
          description: l.description,
          account_id: l.accountId,
          quantity: l.quantity,
          unit_price_minor: l.unitPriceMinor,
          discount_minor: l.discountMinor,
          tax_rate_bps: l.taxRateBps,
          net_minor: Number(l.net_minor),
          tax_minor: Number(l.tax_minor),
        })) as never,
      );
      if (lineErr) throw new Error(lineErr.message);
      return { id: data.billId };
    }

    const { allocateDocumentNumber } = await import("@/lib/settings/document-numbering");
    const billNumber = await allocateDocumentNumber(supabase, data.companyId, "purchase_bill");

    const { data: inserted, error } = await supabase
      .from("purchase_bills" as never)
      .insert({
        company_id: data.companyId,
        contact_id: data.contactId,
        bill_date: data.billDate,
        due_date: data.dueDate,
        bill_number: billNumber,
        supplier_invoice_number: data.supplierInvoiceNumber,
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
      if (error.message.toLowerCase().includes("duplicate") || error.code === "23505") {
        throw new Error("A bill with this supplier invoice number already exists");
      }
      throw new Error(error.message);
    }
    const billId = (inserted as { id: string }).id;
    const { error: lineErr } = await supabase.from("purchase_bill_lines" as never).insert(
      data.lines.map((l, i) => ({
        company_id: data.companyId,
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
      })) as never,
    );
    if (lineErr) throw new Error(lineErr.message);
    return { id: billId };
  });

async function authoriseBillInternal(
  supabase: Parameters<typeof assertCompanyPermission>[0],
  userId: string,
  companyId: string,
  billId: string,
): Promise<{ journalId: string }> {
  await assertCompanyPermission(supabase, companyId, "purchases.authorise");
  const { data: bill, error } = await supabase
    .from("purchase_bills" as never)
    .select("*, purchase_bill_lines(*)" as never)
    .eq("id" as never, billId as never)
    .eq("company_id" as never, companyId as never)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!bill) throw new Error("Bill not found");
  const b = bill as {
    status: string;
    bill_date: string;
    currency_code: string;
    memo: string | null;
    posted_journal_id: string | null;
    purchase_bill_lines: Array<{
      account_id: string;
      description: string;
      net_minor: number;
      tax_minor: number;
    }>;
  };
  if (b.status !== "draft") throw new Error("Only draft bills can be authorised");
  if (b.posted_journal_id) throw new Error("Bill already posted");

  const journalId = await postBillAuthorisation(supabase, {
    company_id: companyId,
    bill_id: billId,
    bill_date: b.bill_date,
    currency_code: b.currency_code,
    ...(b.memo ? { memo: b.memo } : {}),
    lines: b.purchase_bill_lines.map((l) => ({
      account_id: l.account_id,
      description: l.description,
      net_minor: l.net_minor,
      tax_minor: l.tax_minor,
    })),
  });

  const { error: upErr } = await supabase
    .from("purchase_bills" as never)
    .update({
      status: "authorised",
      posted_journal_id: journalId,
      authorised_at: new Date().toISOString(),
      authorised_by: userId,
      updated_at: new Date().toISOString(),
    } as never)
    .eq("id" as never, billId as never);
  if (upErr) throw new Error(upErr.message);
  return { journalId };
}

export const authoriseBill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; billId: string }) => ({
    companyId: assertUuid(input.companyId),
    billId: assertUuid(input.billId, "bill"),
  }))
  .handler(async ({ data, context }) => {
    return authoriseBillInternal(context.supabase, context.userId, data.companyId, data.billId);
  });

export const voidBill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; billId: string }) => ({
    companyId: assertUuid(input.companyId),
    billId: assertUuid(input.billId, "bill"),
  }))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyPermission(supabase, data.companyId, "purchases.authorise");
    const { data: bill, error } = await supabase
      .from("purchase_bills" as never)
      .select("id, status, posted_journal_id, amount_paid_minor, amount_credited_minor" as never)
      .eq("id" as never, data.billId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!bill) throw new Error("Bill not found");
    const b = bill as {
      status: string;
      posted_journal_id: string | null;
      amount_paid_minor: number;
      amount_credited_minor: number;
    };
    if (b.status === "void") throw new Error("Bill already void");
    if (b.amount_paid_minor > 0 || b.amount_credited_minor > 0) {
      throw new Error("Cannot void a bill with payments or credits; reverse those first");
    }
    let voidJournalId: string | null = null;
    if (b.posted_journal_id) {
      voidJournalId = await voidPostedDocument(
        supabase,
        b.posted_journal_id,
        `purchase_bill:${data.billId}:void`,
      );
    }
    const { error: upErr } = await supabase
      .from("purchase_bills" as never)
      .update({
        status: "void",
        void_journal_id: voidJournalId,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, data.billId as never);
    if (upErr) throw new Error(upErr.message);
    return { voidJournalId };
  });

// ---- Direct expenses ----

export const listExpenses = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(companyIdOf)
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const { data: rows, error } = await context.supabase
      .from("purchase_expenses" as never)
      .select(
        "id, payee_name, expense_date, status, total_minor, currency_code, reference, memo" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("expense_date" as never, { ascending: false } as never)
      .limit(100);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const getExpense = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; expenseId: string }) => ({
    companyId: assertUuid(input.companyId),
    expenseId: assertUuid(input.expenseId, "expense"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const { data: row, error } = await context.supabase
      .from("purchase_expenses" as never)
      .select("*" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("id" as never, data.expenseId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Expense not found");
    return row;
  });

export const saveAndPostExpense = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      payeeName: string;
      expenseDate: string;
      expenseAccountId: string;
      paymentAccountId: string;
      currencyCode: string;
      netMinor: number;
      taxMinor?: number;
      reference?: string;
      memo?: string;
      post: boolean;
    }) => {
      const payeeName = (input.payeeName ?? "").trim();
      if (!payeeName) throw new Error("Payee is required");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expenseDate)) throw new Error("Expense date required");
      const net = Number(input.netMinor);
      const tax = Number(input.taxMinor ?? 0);
      if (!Number.isInteger(net) || net < 0) throw new Error("Net amount must be integer minor units");
      if (!Number.isInteger(tax) || tax < 0) throw new Error("Tax must be integer minor units");
      if (net + tax <= 0) throw new Error("Expense total must be greater than zero");
      return {
        companyId: assertUuid(input.companyId),
        payeeName,
        expenseDate: input.expenseDate,
        expenseAccountId: assertUuid(input.expenseAccountId, "expense account"),
        paymentAccountId: assertUuid(input.paymentAccountId, "payment account"),
        currencyCode: input.currencyCode.toUpperCase(),
        netMinor: net,
        taxMinor: tax,
        reference: (input.reference ?? "").trim().slice(0, 80) || null,
        memo: (input.memo ?? "").trim().slice(0, 500) || null,
        post: Boolean(input.post),
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "expenses.submit");
    await requireAccountInCompany(supabase, data.companyId, data.expenseAccountId);
    await requireAccountInCompany(supabase, data.companyId, data.paymentAccountId);

    const { data: inserted, error } = await supabase
      .from("purchase_expenses" as never)
      .insert({
        company_id: data.companyId,
        payee_name: data.payeeName,
        expense_date: data.expenseDate,
        expense_account_id: data.expenseAccountId,
        payment_account_id: data.paymentAccountId,
        currency_code: data.currencyCode,
        net_minor: data.netMinor,
        tax_minor: data.taxMinor,
        total_minor: data.netMinor + data.taxMinor,
        reference: data.reference,
        memo: data.memo,
        status: "draft",
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const expenseId = (inserted as { id: string }).id;

    if (!data.post) return { id: expenseId, journalId: null as string | null };

    await assertCompanyPermission(supabase, data.companyId, "purchases.authorise");
    const journalId = await postDirectExpense(supabase, {
      company_id: data.companyId,
      expense_id: expenseId,
      expense_date: data.expenseDate,
      currency_code: data.currencyCode,
      expense_account_id: data.expenseAccountId,
      payment_account_id: data.paymentAccountId,
      net_minor: data.netMinor,
      tax_minor: data.taxMinor,
      memo: data.memo ?? data.payeeName,
    });
    const { error: upErr } = await supabase
      .from("purchase_expenses" as never)
      .update({
        status: "paid",
        posted_journal_id: journalId,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, expenseId as never);
    if (upErr) throw new Error(upErr.message);
    return { id: expenseId, journalId };
  });

// ---- Supplier payments ----

export const listPayments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(companyIdOf)
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const { data: rows, error } = await context.supabase
      .from("supplier_payments" as never)
      .select(
        "id, payment_date, amount_minor, unallocated_minor, status, reference, currency_code, contact_id, contacts(name)" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("payment_date" as never, { ascending: false } as never)
      .limit(100);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const createAndPostPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      contactId: string;
      paymentDate: string;
      bankAccountId: string;
      currencyCode: string;
      amountMinor: number;
      reference?: string;
      memo?: string;
      allocations: Array<{ billId: string; amountMinor: number }>;
    }) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paymentDate)) throw new Error("Payment date required");
      const amountMinor = Number(input.amountMinor);
      if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
        throw new Error("Payment amount must be a positive integer (minor units)");
      }
      const allocations = (input.allocations ?? []).map((a) => ({
        billId: assertUuid(a.billId, "bill"),
        amountMinor: Number(a.amountMinor),
      }));
      const allocated = allocations.reduce((s, a) => s + a.amountMinor, 0);
      if (allocated > amountMinor) throw new Error("Allocations exceed payment amount");
      for (const a of allocations) {
        if (!Number.isInteger(a.amountMinor) || a.amountMinor <= 0) {
          throw new Error("Allocation amounts must be positive integers");
        }
      }
      return {
        companyId: assertUuid(input.companyId),
        contactId: assertUuid(input.contactId, "supplier"),
        paymentDate: input.paymentDate,
        bankAccountId: assertUuid(input.bankAccountId, "bank account"),
        currencyCode: input.currencyCode.toUpperCase(),
        amountMinor,
        reference: (input.reference ?? "").trim().slice(0, 80) || null,
        memo: (input.memo ?? "").trim().slice(0, 500) || null,
        allocations,
        unallocatedMinor: amountMinor - allocated,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "purchases.payment");
    await requireAccountInCompany(supabase, data.companyId, data.bankAccountId);

    // Validate bills outstanding
    for (const alloc of data.allocations) {
      const { data: bill, error } = await supabase
        .from("purchase_bills" as never)
        .select(
          "id, status, contact_id, total_minor, amount_paid_minor, amount_credited_minor" as never,
        )
        .eq("id" as never, alloc.billId as never)
        .eq("company_id" as never, data.companyId as never)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!bill) throw new Error("Bill not found for allocation");
      const b = bill as {
        status: string;
        contact_id: string;
        total_minor: number;
        amount_paid_minor: number;
        amount_credited_minor: number;
      };
      if (b.contact_id !== data.contactId) throw new Error("Bill belongs to a different supplier");
      if (b.status === "draft" || b.status === "void") {
        throw new Error("Can only allocate to authorised bills");
      }
      const outstanding =
        b.total_minor - b.amount_paid_minor - b.amount_credited_minor;
      if (alloc.amountMinor > outstanding) {
        throw new Error("Allocation exceeds bill outstanding balance");
      }
    }

    const { data: payment, error } = await supabase
      .from("supplier_payments" as never)
      .insert({
        company_id: data.companyId,
        contact_id: data.contactId,
        payment_date: data.paymentDate,
        bank_account_id: data.bankAccountId,
        currency_code: data.currencyCode,
        amount_minor: data.amountMinor,
        unallocated_minor: data.unallocatedMinor,
        reference: data.reference,
        memo: data.memo,
        status: "draft",
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const paymentId = (payment as { id: string }).id;

    if (data.allocations.length) {
      const { error: aErr } = await supabase.from("supplier_payment_allocations" as never).insert(
        data.allocations.map((a) => ({
          company_id: data.companyId,
          payment_id: paymentId,
          bill_id: a.billId,
          amount_minor: a.amountMinor,
        })) as never,
      );
      if (aErr) throw new Error(aErr.message);
    }

    const journalId = await postSupplierPayment(supabase, {
      company_id: data.companyId,
      payment_id: paymentId,
      payment_date: data.paymentDate,
      currency_code: data.currencyCode,
      bank_account_id: data.bankAccountId,
      amount_minor: data.amountMinor,
      ...(data.memo || data.reference
        ? { memo: (data.memo ?? data.reference) as string }
        : {}),
    });

    for (const alloc of data.allocations) {
      const { data: bill, error: billErr } = await supabase
        .from("purchase_bills" as never)
        .select("total_minor, amount_paid_minor, amount_credited_minor, status" as never)
        .eq("id" as never, alloc.billId as never)
        .maybeSingle();
      if (billErr) throw new Error(billErr.message);
      if (!bill) throw new Error("Bill not found while applying payment");
      const b = bill as unknown as {
        total_minor: number;
        amount_paid_minor: number;
        amount_credited_minor: number;
        status: string;
      };
      const amountPaid = b.amount_paid_minor + alloc.amountMinor;
      const nextStatus = deriveBillStatus({
        status: b.status,
        total_minor: b.total_minor,
        amount_paid_minor: amountPaid,
        amount_credited_minor: b.amount_credited_minor,
      });
      await supabase
        .from("purchase_bills" as never)
        .update({
          amount_paid_minor: amountPaid,
          status: nextStatus,
          updated_at: new Date().toISOString(),
        } as never)
        .eq("id" as never, alloc.billId as never);
    }

    await supabase
      .from("supplier_payments" as never)
      .update({
        status: "paid",
        posted_journal_id: journalId,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, paymentId as never);

    return { id: paymentId, journalId, unallocatedMinor: data.unallocatedMinor };
  });

// ---- Credit notes (core) ----

export const listCreditNotes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(companyIdOf)
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const { data: rows, error } = await context.supabase
      .from("purchase_credit_notes" as never)
      .select(
        "id, credit_number, credit_date, status, total_minor, amount_allocated_minor, currency_code, contact_id, contacts(name)" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("credit_date" as never, { ascending: false } as never)
      .limit(100);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const saveAndAuthoriseCreditNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      contactId: string;
      creditDate: string;
      currencyCode: string;
      memo?: string;
      lines: Array<{ description: string; accountId: string; netMinor: number; taxMinor?: number }>;
      allocations?: Array<{ billId: string; amountMinor: number }>;
      authorise: boolean;
    }) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.creditDate)) throw new Error("Credit date required");
      if (!input.lines?.length) throw new Error("Add at least one credit line");
      const lines = input.lines.map((l, i) => {
        const description = (l.description ?? "").trim();
        if (!description) throw new Error(`Line ${i + 1}: description required`);
        const net = Number(l.netMinor);
        const tax = Number(l.taxMinor ?? 0);
        if (!Number.isInteger(net) || net < 0) throw new Error("Invalid net amount");
        if (!Number.isInteger(tax) || tax < 0) throw new Error("Invalid tax amount");
        return {
          description,
          accountId: assertUuid(l.accountId, "account"),
          netMinor: net,
          taxMinor: tax,
        };
      });
      return {
        companyId: assertUuid(input.companyId),
        contactId: assertUuid(input.contactId, "supplier"),
        creditDate: input.creditDate,
        currencyCode: input.currencyCode.toUpperCase(),
        memo: (input.memo ?? "").trim().slice(0, 500) || null,
        lines,
        allocations: (input.allocations ?? []).map((a) => ({
          billId: assertUuid(a.billId, "bill"),
          amountMinor: Number(a.amountMinor),
        })),
        authorise: Boolean(input.authorise),
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "purchases.draft");
    const subtotal = data.lines.reduce((s, l) => s + l.netMinor, 0);
    const tax = data.lines.reduce((s, l) => s + l.taxMinor, 0);
    const total = subtotal + tax;
    if (total <= 0) throw new Error("Credit total must be greater than zero");

    const { data: cn, error } = await supabase
      .from("purchase_credit_notes" as never)
      .insert({
        company_id: data.companyId,
        contact_id: data.contactId,
        credit_date: data.creditDate,
        currency_code: data.currencyCode,
        memo: data.memo,
        subtotal_minor: subtotal,
        tax_minor: tax,
        total_minor: total,
        status: "draft",
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const creditId = (cn as { id: string }).id;
    const { error: lineErr } = await supabase.from("purchase_credit_note_lines" as never).insert(
      data.lines.map((l, i) => ({
        company_id: data.companyId,
        credit_note_id: creditId,
        line_no: i + 1,
        description: l.description,
        account_id: l.accountId,
        net_minor: l.netMinor,
        tax_minor: l.taxMinor,
      })) as never,
    );
    if (lineErr) throw new Error(lineErr.message);

    if (!data.authorise) return { id: creditId, journalId: null as string | null };

    await assertCompanyPermission(supabase, data.companyId, "purchases.authorise");
    const journalId = await postCreditNoteAuthorisation(supabase, {
      company_id: data.companyId,
      credit_note_id: creditId,
      credit_date: data.creditDate,
      currency_code: data.currencyCode,
      ...(data.memo ? { memo: data.memo } : {}),
      lines: data.lines.map((l) => ({
        account_id: l.accountId,
        description: l.description,
        net_minor: l.netMinor,
        tax_minor: l.taxMinor,
      })),
    });

    let allocated = 0;
    for (const alloc of data.allocations) {
      const { data: bill } = await supabase
        .from("purchase_bills" as never)
        .select("total_minor, amount_paid_minor, amount_credited_minor, status, contact_id" as never)
        .eq("id" as never, alloc.billId as never)
        .eq("company_id" as never, data.companyId as never)
        .maybeSingle();
      if (!bill) throw new Error("Bill not found for credit allocation");
      const b = bill as {
        contact_id: string;
        total_minor: number;
        amount_paid_minor: number;
        amount_credited_minor: number;
        status: string;
      };
      if (b.contact_id !== data.contactId) throw new Error("Credit allocation supplier mismatch");
      const outstanding = b.total_minor - b.amount_paid_minor - b.amount_credited_minor;
      if (alloc.amountMinor > outstanding) throw new Error("Credit allocation exceeds outstanding");
      allocated += alloc.amountMinor;
      if (allocated > total) throw new Error("Credit allocations exceed credit total");
      await supabase.from("purchase_credit_allocations" as never).insert({
        company_id: data.companyId,
        credit_note_id: creditId,
        bill_id: alloc.billId,
        amount_minor: alloc.amountMinor,
      } as never);
      const amountCredited = b.amount_credited_minor + alloc.amountMinor;
      const nextStatus = deriveBillStatus({
        status: b.status,
        total_minor: b.total_minor,
        amount_paid_minor: b.amount_paid_minor,
        amount_credited_minor: amountCredited,
      });
      await supabase
        .from("purchase_bills" as never)
        .update({
          amount_credited_minor: amountCredited,
          status: nextStatus,
          updated_at: new Date().toISOString(),
        } as never)
        .eq("id" as never, alloc.billId as never);
    }

    await supabase
      .from("purchase_credit_notes" as never)
      .update({
        status: "authorised",
        posted_journal_id: journalId,
        amount_allocated_minor: allocated,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, creditId as never);

    return { id: creditId, journalId };
  });

export const getCreditNote = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; creditNoteId: string }) => ({
    companyId: assertUuid(input.companyId),
    creditNoteId: assertUuid(input.creditNoteId, "credit note"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const { data: row, error } = await context.supabase
      .from("purchase_credit_notes" as never)
      .select(
        "*, contacts(id, name, email), purchase_credit_note_lines(*), purchase_credit_allocations(id, bill_id, amount_minor)" as never,
      )
      .eq("id" as never, data.creditNoteId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Credit note not found");
    return row;
  });

export const allocatePurchaseCreditNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      creditNoteId: string;
      allocations: Array<{ billId: string; amountMinor: number }>;
    }) => ({
      companyId: assertUuid(input.companyId),
      creditNoteId: assertUuid(input.creditNoteId, "credit note"),
      allocations: (input.allocations ?? []).map((a) => ({
        billId: assertUuid(a.billId, "bill"),
        amountMinor: Math.round(Number(a.amountMinor)),
      })),
    }),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyPermission(supabase, data.companyId, "purchases.payment");
    const { data: cn, error } = await supabase
      .from("purchase_credit_notes" as never)
      .select("id, status, contact_id, total_minor, amount_allocated_minor" as never)
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
      const { data: bill, error: bErr } = await supabase
        .from("purchase_bills" as never)
        .select(
          "id, status, contact_id, total_minor, amount_paid_minor, amount_credited_minor" as never,
        )
        .eq("id" as never, alloc.billId as never)
        .eq("company_id" as never, data.companyId as never)
        .maybeSingle();
      if (bErr) throw new Error(bErr.message);
      if (!bill) throw new Error("Bill not found");
      const b = bill as {
        status: string;
        contact_id: string;
        total_minor: number;
        amount_paid_minor: number;
        amount_credited_minor: number;
      };
      if (b.contact_id !== credit.contact_id) throw new Error("Bill belongs to a different supplier");
      const outstanding = b.total_minor - b.amount_paid_minor - b.amount_credited_minor;
      if (alloc.amountMinor > outstanding) throw new Error("Allocation exceeds bill outstanding");
      const { error: aErr } = await supabase.from("purchase_credit_allocations" as never).insert({
        company_id: data.companyId,
        credit_note_id: data.creditNoteId,
        bill_id: alloc.billId,
        amount_minor: alloc.amountMinor,
      } as never);
      if (aErr) {
        if (aErr.code === "23505") throw new Error("Already allocated to this bill");
        throw new Error(aErr.message);
      }
      const amountCredited = b.amount_credited_minor + alloc.amountMinor;
      const nextStatus = deriveBillStatus({
        status: b.status,
        total_minor: b.total_minor,
        amount_paid_minor: b.amount_paid_minor,
        amount_credited_minor: amountCredited,
      });
      await supabase
        .from("purchase_bills" as never)
        .update({
          amount_credited_minor: amountCredited,
          status: nextStatus,
          updated_at: new Date().toISOString(),
        } as never)
        .eq("id" as never, alloc.billId as never);
      allocated += alloc.amountMinor;
    }

    const cnStatus =
      allocated >= credit.total_minor ? "paid" : allocated > 0 ? "partly_paid" : credit.status;
    await supabase
      .from("purchase_credit_notes" as never)
      .update({
        amount_allocated_minor: allocated,
        status: cnStatus,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, data.creditNoteId as never);

    return { allocatedMinor: allocated };
  });

// ---- Purchase orders (no posting) ----

export const listPurchaseOrders = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(companyIdOf)
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const { data: rows, error } = await context.supabase
      .from("purchase_orders" as never)
      .select(
        "id, order_number, order_date, status, total_minor, currency_code, contact_id, contacts(name), billed_bill_id" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("order_date" as never, { ascending: false } as never)
      .limit(100);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const savePurchaseOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      contactId: string;
      orderDate: string;
      currencyCode: string;
      memo?: string;
      lines: BillLineIn[];
    }) => ({
      companyId: assertUuid(input.companyId),
      contactId: assertUuid(input.contactId, "supplier"),
      orderDate: input.orderDate,
      currencyCode: input.currencyCode.toUpperCase(),
      memo: (input.memo ?? "").trim().slice(0, 500) || null,
      lines: validateBillLines(input.lines),
    }),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "purchases.draft");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.orderDate)) throw new Error("Order date required");
    const totals = sumLines(data.lines);
    const { data: po, error } = await supabase
      .from("purchase_orders" as never)
      .insert({
        company_id: data.companyId,
        contact_id: data.contactId,
        order_date: data.orderDate,
        currency_code: data.currencyCode,
        memo: data.memo,
        status: "draft",
        subtotal_minor: Number(totals.subtotal_minor),
        tax_minor: Number(totals.tax_minor),
        total_minor: Number(totals.total_minor),
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const orderId = (po as { id: string }).id;
    const { error: lineErr } = await supabase.from("purchase_order_lines" as never).insert(
      data.lines.map((l, i) => ({
        company_id: data.companyId,
        order_id: orderId,
        line_no: i + 1,
        description: l.description,
        account_id: l.accountId,
        quantity: l.quantity,
        unit_price_minor: l.unitPriceMinor,
        tax_rate_bps: l.taxRateBps,
        net_minor: Number(l.net_minor),
        tax_minor: Number(l.tax_minor),
      })) as never,
    );
    if (lineErr) throw new Error(lineErr.message);
    return { id: orderId };
  });

export const convertPurchaseOrderToBill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; orderId: string }) => ({
    companyId: assertUuid(input.companyId),
    orderId: assertUuid(input.orderId, "order"),
  }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "purchases.draft");
    const { data: po, error } = await supabase
      .from("purchase_orders" as never)
      .select("*, purchase_order_lines(*)" as never)
      .eq("id" as never, data.orderId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!po) throw new Error("Purchase order not found");
    const order = po as {
      status: string;
      billed_bill_id: string | null;
      contact_id: string;
      order_date: string;
      currency_code: string;
      memo: string | null;
      subtotal_minor: number;
      tax_minor: number;
      total_minor: number;
      purchase_order_lines: Array<{
        description: string;
        account_id: string;
        quantity: number;
        unit_price_minor: number;
        tax_rate_bps: number;
        net_minor: number;
        tax_minor: number;
      }>;
    };
    if (order.billed_bill_id) throw new Error("Purchase order already converted to a bill");
    if (order.status === "cancelled") throw new Error("Cancelled orders cannot be billed");

    const due = new Date(order.order_date);
    due.setDate(due.getDate() + 30);
    const dueDate = due.toISOString().slice(0, 10);

    const { data: bill, error: bErr } = await supabase
      .from("purchase_bills" as never)
      .insert({
        company_id: data.companyId,
        contact_id: order.contact_id,
        bill_date: order.order_date,
        due_date: dueDate,
        currency_code: order.currency_code,
        memo: order.memo,
        status: "draft",
        subtotal_minor: order.subtotal_minor,
        tax_minor: order.tax_minor,
        total_minor: order.total_minor,
        purchase_order_id: data.orderId,
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (bErr) throw new Error(bErr.message);
    const billId = (bill as { id: string }).id;
    await supabase.from("purchase_bill_lines" as never).insert(
      order.purchase_order_lines.map((l, i) => ({
        company_id: data.companyId,
        bill_id: billId,
        line_no: i + 1,
        description: l.description,
        account_id: l.account_id,
        quantity: l.quantity,
        unit_price_minor: l.unit_price_minor,
        tax_rate_bps: l.tax_rate_bps,
        net_minor: l.net_minor,
        tax_minor: l.tax_minor,
      })) as never,
    );
    await supabase
      .from("purchase_orders" as never)
      .update({
        status: "billed",
        billed_bill_id: billId,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, data.orderId as never);
    // No ledger posting — draft bill only
    return { billId };
  });

// ---- Recurring bills ----

export const listRecurringBills = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(companyIdOf)
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const { data: rows, error } = await context.supabase
      .from("recurring_bills" as never)
      .select(
        "id, name, frequency, next_due_date, is_active, auto_authorise, last_generated_on, last_error, contact_id, contacts(name)" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("next_due_date" as never)
      .limit(100);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const saveRecurringBill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      contactId: string;
      name: string;
      frequency: "weekly" | "monthly" | "quarterly" | "yearly";
      nextDueDate: string;
      currencyCode: string;
      autoAuthorise?: boolean;
      templateLines: BillLineIn[];
    }) => {
      const name = (input.name ?? "").trim();
      if (!name) throw new Error("Name is required");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.nextDueDate)) throw new Error("Next due date required");
      return {
        companyId: assertUuid(input.companyId),
        contactId: assertUuid(input.contactId, "supplier"),
        name,
        frequency: input.frequency,
        nextDueDate: input.nextDueDate,
        currencyCode: input.currencyCode.toUpperCase(),
        autoAuthorise: Boolean(input.autoAuthorise),
        templateLines: validateBillLines(input.templateLines),
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "purchases.draft");
    const totals = sumLines(data.templateLines);
    const { data: row, error } = await supabase
      .from("recurring_bills" as never)
      .insert({
        company_id: data.companyId,
        contact_id: data.contactId,
        name: data.name,
        frequency: data.frequency,
        next_due_date: data.nextDueDate,
        currency_code: data.currencyCode,
        auto_authorise: data.autoAuthorise,
        template: {
          lines: data.templateLines.map((l) => ({
            description: l.description,
            accountId: l.accountId,
            quantity: l.quantity,
            unitPriceMinor: l.unitPriceMinor,
            discountMinor: l.discountMinor,
            taxRateBps: l.taxRateBps,
          })),
          subtotal_minor: Number(totals.subtotal_minor),
          tax_minor: Number(totals.tax_minor),
          total_minor: Number(totals.total_minor),
        },
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: (row as { id: string }).id };
  });

export const generateRecurringBill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; recurringId: string }) => ({
    companyId: assertUuid(input.companyId),
    recurringId: assertUuid(input.recurringId, "recurring"),
  }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "purchases.draft");
    const { data: rb, error } = await supabase
      .from("recurring_bills" as never)
      .select("*" as never)
      .eq("id" as never, data.recurringId as never)
      .eq("company_id" as never, data.companyId as never)
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
      frequency: string;
      template: {
        lines: BillLineIn[];
        subtotal_minor: number;
        tax_minor: number;
        total_minor: number;
      };
    };
    if (!r.is_active) throw new Error("Recurring bill is inactive");
    if (r.last_generated_on === r.next_due_date) {
      throw new Error("A bill was already generated for this due date");
    }

    try {
      const lines = validateBillLines(r.template.lines);
      const totals = sumLines(lines);
      const due = r.next_due_date;
      const { data: bill, error: bErr } = await supabase
        .from("purchase_bills" as never)
        .insert({
          company_id: data.companyId,
          contact_id: r.contact_id,
          bill_date: due,
          due_date: due,
          currency_code: r.currency_code,
          status: "draft",
          subtotal_minor: Number(totals.subtotal_minor),
          tax_minor: Number(totals.tax_minor),
          total_minor: Number(totals.total_minor),
          memo: `Generated from recurring bill`,
          created_by: userId,
        } as never)
        .select("id")
        .single();
      if (bErr) throw new Error(bErr.message);
      const billId = (bill as { id: string }).id;
      await supabase.from("purchase_bill_lines" as never).insert(
        lines.map((l, i) => ({
          company_id: data.companyId,
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
        })) as never,
      );

      // Default policy: do NOT auto-post unless auto_authorise explicitly true
      if (r.auto_authorise) {
        await authoriseBillInternal(supabase, userId, data.companyId, billId);
      }

      const next = new Date(due + "T00:00:00Z");
      if (r.frequency === "weekly") next.setUTCDate(next.getUTCDate() + 7);
      else if (r.frequency === "monthly") next.setUTCMonth(next.getUTCMonth() + 1);
      else if (r.frequency === "quarterly") next.setUTCMonth(next.getUTCMonth() + 3);
      else next.setUTCFullYear(next.getUTCFullYear() + 1);

      await supabase
        .from("recurring_bills" as never)
        .update({
          last_generated_on: due,
          next_due_date: next.toISOString().slice(0, 10),
          last_error: null,
          updated_at: new Date().toISOString(),
        } as never)
        .eq("id" as never, data.recurringId as never);

      return { billId, authorised: r.auto_authorise };
    } catch (e) {
      const message = e instanceof Error ? e.message : "Generation failed";
      await supabase
        .from("recurring_bills" as never)
        .update({ last_error: message, updated_at: new Date().toISOString() } as never)
        .eq("id" as never, data.recurringId as never);
      throw new Error(message);
    }
  });

// ---- Employee expenses ----

export const listEmployeeClaims = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(companyIdOf)
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const { data: rows, error } = await context.supabase
      .from("employee_expense_claims" as never)
      .select(
        "id, claim_date, description, amount_minor, tax_minor, status, currency_code, claimant_user_id" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("claim_date" as never, { ascending: false } as never)
      .limit(100);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const submitEmployeeClaim = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      claimDate: string;
      description: string;
      expenseAccountId: string;
      currencyCode: string;
      amountMinor: number;
      taxMinor?: number;
    }) => {
      const description = (input.description ?? "").trim();
      if (!description) throw new Error("Description required");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.claimDate)) throw new Error("Claim date required");
      const amountMinor = Number(input.amountMinor);
      if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new Error("Invalid amount");
      return {
        companyId: assertUuid(input.companyId),
        claimDate: input.claimDate,
        description,
        expenseAccountId: assertUuid(input.expenseAccountId, "account"),
        currencyCode: input.currencyCode.toUpperCase(),
        amountMinor,
        taxMinor: Number(input.taxMinor ?? 0),
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "expenses.submit");
    const { data: row, error } = await supabase
      .from("employee_expense_claims" as never)
      .insert({
        company_id: data.companyId,
        claimant_user_id: userId,
        claim_date: data.claimDate,
        description: data.description,
        expense_account_id: data.expenseAccountId,
        currency_code: data.currencyCode,
        amount_minor: data.amountMinor,
        tax_minor: data.taxMinor,
        status: "submitted",
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: (row as { id: string }).id };
  });

export const approveAndReimburseClaim = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; claimId: string; paymentAccountId: string }) => ({
      companyId: assertUuid(input.companyId),
      claimId: assertUuid(input.claimId, "claim"),
      paymentAccountId: assertUuid(input.paymentAccountId, "payment account"),
    }),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "expenses.approve");
    const { data: claim, error } = await supabase
      .from("employee_expense_claims" as never)
      .select("*" as never)
      .eq("id" as never, data.claimId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!claim) throw new Error("Claim not found");
    const c = claim as {
      status: string;
      claim_date: string;
      currency_code: string;
      expense_account_id: string;
      amount_minor: number;
      tax_minor: number;
      description: string;
      posted_journal_id: string | null;
    };
    if (c.status !== "submitted") throw new Error("Only submitted claims can be approved");
    if (c.posted_journal_id) throw new Error("Claim already posted");

    // Reimburse = direct expense style posting (DR expense, CR bank)
    const journalId = await postDirectExpense(supabase, {
      company_id: data.companyId,
      expense_id: data.claimId,
      expense_date: c.claim_date,
      currency_code: c.currency_code,
      expense_account_id: c.expense_account_id,
      payment_account_id: data.paymentAccountId,
      net_minor: c.amount_minor,
      tax_minor: c.tax_minor,
      memo: c.description,
    });

    await supabase
      .from("employee_expense_claims" as never)
      .update({
        status: "reimbursed",
        posted_journal_id: journalId,
        reviewed_by: userId,
        reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, data.claimId as never);

    return { journalId };
  });

// ---- Supplier statement / AP aging ----

export const setRecurringBillActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; recurringId: string; isActive: boolean }) => ({
    companyId: assertUuid(input.companyId),
    recurringId: assertUuid(input.recurringId),
    isActive: Boolean(input.isActive),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.draft");
    const { data: row, error } = await context.supabase
      .from("recurring_bills" as never)
      .update({ is_active: data.isActive, updated_at: new Date().toISOString() } as never)
      .eq("id" as never, data.recurringId as never)
      .eq("company_id" as never, data.companyId as never)
      .select("id, is_active" as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Recurring bill not found");
    return row as { id: string; is_active: boolean };
  });

export const rejectEmployeeClaim = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; claimId: string }) => ({
    companyId: assertUuid(input.companyId),
    claimId: assertUuid(input.claimId),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.authorise");
    const { data: claim, error } = await context.supabase
      .from("employee_expense_claims" as never)
      .select("id, status" as never)
      .eq("id" as never, data.claimId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!claim) throw new Error("Claim not found");
    if ((claim as { status: string }).status !== "submitted") {
      throw new Error("Only submitted claims can be rejected");
    }
    const { error: upErr } = await context.supabase
      .from("employee_expense_claims" as never)
      .update({
        status: "rejected",
        reviewed_by: context.userId,
        reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, data.claimId as never);
    if (upErr) throw new Error(upErr.message);
    return { id: data.claimId, status: "rejected" };
  });

export const getSupplierStatement = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; contactId: string; from?: string; to?: string; asOf?: string }) => ({
    companyId: assertUuid(input.companyId),
    contactId: assertUuid(input.contactId, "supplier"),
    from: input.from && /^\d{4}-\d{2}-\d{2}$/.test(input.from) ? input.from : null,
    to: input.to && /^\d{4}-\d{2}-\d{2}$/.test(input.to) ? input.to : null,
    asOf: input.asOf && /^\d{4}-\d{2}-\d{2}$/.test(input.asOf)
      ? input.asOf
      : new Date().toISOString().slice(0, 10),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    let billQ = context.supabase
      .from("purchase_bills" as never)
      .select(
        "id, bill_date, due_date, status, total_minor, amount_paid_minor, amount_credited_minor, supplier_invoice_number, bill_number, currency_code" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .eq("contact_id" as never, data.contactId as never)
      .neq("status" as never, "void" as never)
      .neq("status" as never, "draft" as never)
      .lte("bill_date" as never, data.asOf as never)
      .order("bill_date" as never);
    if (data.from) billQ = billQ.gte("bill_date" as never, data.from as never);
    if (data.to) billQ = billQ.lte("bill_date" as never, data.to as never);
    const { data: bills, error } = await billQ;
    if (error) throw new Error(error.message);

    let payQ = context.supabase
      .from("supplier_payments" as never)
      .select("id, payment_date, amount_minor, unallocated_minor, reference, status" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("contact_id" as never, data.contactId as never)
      .eq("status" as never, "paid" as never)
      .lte("payment_date" as never, data.asOf as never)
      .order("payment_date" as never);
    if (data.from) payQ = payQ.gte("payment_date" as never, data.from as never);
    if (data.to) payQ = payQ.lte("payment_date" as never, data.to as never);
    const { data: payments, error: pErr } = await payQ;
    if (pErr) throw new Error(pErr.message);

    let cnQ = context.supabase
      .from("purchase_credit_notes" as never)
      .select(
        "id, credit_date, credit_number, status, total_minor, amount_allocated_minor" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .eq("contact_id" as never, data.contactId as never)
      .neq("status" as never, "void" as never)
      .neq("status" as never, "draft" as never)
      .lte("credit_date" as never, data.asOf as never)
      .order("credit_date" as never);
    if (data.from) cnQ = cnQ.gte("credit_date" as never, data.from as never);
    if (data.to) cnQ = cnQ.lte("credit_date" as never, data.to as never);
    const { data: creditNotes, error: cErr } = await cnQ;
    if (cErr) throw new Error(cErr.message);

    type TimelineRow = {
      date: string;
      type: "bill" | "payment" | "credit_note";
      id: string;
      reference: string | null;
      debit_minor: number;
      credit_minor: number;
      status: string;
    };
    const timeline: TimelineRow[] = [];
    for (const b of (bills ?? []) as Array<{
      id: string;
      bill_date: string;
      total_minor: number;
      supplier_invoice_number: string | null;
      bill_number: string | null;
      status: string;
    }>) {
      timeline.push({
        date: b.bill_date,
        type: "bill",
        id: b.id,
        reference: b.supplier_invoice_number ?? b.bill_number,
        debit_minor: b.total_minor,
        credit_minor: 0,
        status: b.status,
      });
    }
    for (const p of (payments ?? []) as Array<{
      id: string;
      payment_date: string;
      amount_minor: number;
      reference: string | null;
      status: string;
    }>) {
      timeline.push({
        date: p.payment_date,
        type: "payment",
        id: p.id,
        reference: p.reference,
        debit_minor: 0,
        credit_minor: p.amount_minor,
        status: p.status,
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

    const rows = ((bills ?? []) as Array<{
      id: string;
      bill_date: string;
      due_date: string;
      status: string;
      total_minor: number;
      amount_paid_minor: number;
      amount_credited_minor: number;
      supplier_invoice_number: string | null;
      currency_code: string;
    }>).map((b) => ({
      ...b,
      outstanding_minor: b.total_minor - b.amount_paid_minor - b.amount_credited_minor,
    }));
    const open = rows.filter((r) => r.outstanding_minor > 0 && r.status !== "draft");
    const unappliedCredits = ((creditNotes ?? []) as Array<{
      total_minor: number;
      amount_allocated_minor: number;
      status: string;
    }>)
      .filter((c) => ["authorised", "partly_paid"].includes(c.status))
      .reduce((s, c) => s + (c.total_minor - c.amount_allocated_minor), 0);
    const unappliedPayments = ((payments ?? []) as Array<{ unallocated_minor: number }>).reduce(
      (s, p) => s + (p.unallocated_minor ?? 0),
      0,
    );

    return {
      asOf: data.asOf,
      bills: rows,
      payments: payments ?? [],
      creditNotes: creditNotes ?? [],
      lines,
      closingBalanceMinor: running,
      openBalanceMinor: open.reduce((s, r) => s + r.outstanding_minor, 0),
      unappliedCreditMinor: unappliedCredits,
      unappliedPaymentMinor: unappliedPayments,
    };
  });
