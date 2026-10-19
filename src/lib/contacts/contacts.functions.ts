import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { invoiceOutstanding } from "@/lib/sales/line-helpers";
import { billOutstanding } from "@/lib/purchases/line-math";

export const listContacts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; kind?: string; q?: string; includeInactive?: boolean }) => ({
      companyId: assertUuid(input.companyId),
      kind: (input.kind ?? "all").trim(),
      q: (input.q ?? "").trim().slice(0, 100),
      includeInactive: Boolean(input.includeInactive),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    let q = context.supabase
      .from("contacts" as never)
      .select(
        "id, name, email, phone, tax_number, payment_terms_days, is_active, kind, created_at" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("name" as never)
      .limit(200);
    if (!data.includeInactive) q = q.eq("is_active" as never, true as never);
    if (data.kind === "customers") q = q.in("kind" as never, ["customer", "both"] as never);
    else if (data.kind === "suppliers") q = q.in("kind" as never, ["supplier", "both"] as never);
    if (data.q) q = q.ilike("name" as never, `%${data.q}%` as never);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const getContact = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; contactId: string }) => ({
    companyId: assertUuid(input.companyId),
    contactId: assertUuid(input.contactId),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: row, error } = await context.supabase
      .from("contacts" as never)
      .select("*" as never)
      .eq("id" as never, data.contactId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Contact not found");
    return row;
  });

export const upsertContact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      id?: string;
      name: string;
      kind: string;
      email?: string;
      phone?: string;
      taxNumber?: string;
      paymentTermsDays?: number;
      notes?: string;
      isActive?: boolean;
    }) => {
      const name = (input.name ?? "").trim();
      if (!name) throw new Error("Contact name is required");
      if (!["supplier", "customer", "both", "employee"].includes(input.kind)) {
        throw new Error("Invalid contact kind");
      }
      return {
        companyId: assertUuid(input.companyId),
        id: input.id ? assertUuid(input.id) : undefined,
        name,
        kind: input.kind,
        email: (input.email ?? "").trim().slice(0, 200) || null,
        phone: (input.phone ?? "").trim().slice(0, 60) || null,
        taxNumber: (input.taxNumber ?? "").trim().slice(0, 60) || null,
        paymentTermsDays: Math.max(0, Number(input.paymentTermsDays ?? 30) || 0),
        notes: (input.notes ?? "").trim().slice(0, 2000) || null,
        isActive: input.isActive !== false,
      };
    },
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "contacts.manage");

    // Duplicate name check (active contacts)
    const { data: dup } = await context.supabase
      .from("contacts" as never)
      .select("id, name" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("is_active" as never, true as never)
      .ilike("name" as never, data.name as never);
    const conflict = ((dup ?? []) as Array<{ id: string; name: string }>).find(
      (c) => c.name.toLowerCase() === data.name.toLowerCase() && c.id !== data.id,
    );
    if (conflict) {
      throw new Error(`A contact named "${conflict.name}" already exists`);
    }

    if (data.id) {
      const { data: row, error } = await context.supabase
        .from("contacts" as never)
        .update({
          name: data.name,
          kind: data.kind,
          email: data.email,
          phone: data.phone,
          tax_number: data.taxNumber,
          payment_terms_days: data.paymentTermsDays,
          notes: data.notes,
          is_active: data.isActive,
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
      if (!row) throw new Error("Contact not found");
      return { id: data.id };
    }

    const { data: row, error } = await context.supabase
      .from("contacts" as never)
      .insert({
        company_id: data.companyId,
        kind: data.kind,
        name: data.name,
        email: data.email,
        phone: data.phone,
        tax_number: data.taxNumber,
        payment_terms_days: data.paymentTermsDays,
        notes: data.notes,
        is_active: data.isActive,
      } as never)
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") throw new Error("A contact with this name already exists");
      throw new Error(error.message);
    }
    return { id: (row as { id: string }).id };
  });

export const getContactBalances = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; contactId: string }) => ({
    companyId: assertUuid(input.companyId),
    contactId: assertUuid(input.contactId),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);

    const { data: invoices, error: iErr } = await context.supabase
      .from("sales_invoices" as never)
      .select("id, invoice_date, status, total_minor, amount_paid_minor, amount_credited_minor, invoice_number" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("contact_id" as never, data.contactId as never)
      .neq("status" as never, "void" as never)
      .order("invoice_date" as never, { ascending: false })
      .limit(50);
    if (iErr) throw new Error(iErr.message);

    const { data: bills, error: bErr } = await context.supabase
      .from("purchase_bills" as never)
      .select(
        "id, bill_date, status, total_minor, amount_paid_minor, amount_credited_minor, bill_number, supplier_invoice_number" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .eq("contact_id" as never, data.contactId as never)
      .neq("status" as never, "void" as never)
      .order("bill_date" as never, { ascending: false })
      .limit(50);
    if (bErr) throw new Error(bErr.message);

    const receivable = ((invoices ?? []) as Array<{
      status: string;
      total_minor: number;
      amount_paid_minor: number;
      amount_credited_minor: number;
    }>)
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

    const payable = ((bills ?? []) as Array<{
      status: string;
      total_minor: number;
      amount_paid_minor: number;
      amount_credited_minor: number;
    }>)
      .filter((b) => ["authorised", "partly_paid"].includes(b.status))
      .reduce(
        (s, b) =>
          s +
          Number(
            billOutstanding({
              total_minor: b.total_minor,
              amount_paid_minor: b.amount_paid_minor,
              amount_credited_minor: b.amount_credited_minor,
            }),
          ),
        0,
      );

    return {
      invoices: invoices ?? [],
      bills: bills ?? [],
      receivableMinor: receivable,
      payableMinor: payable,
    };
  });
