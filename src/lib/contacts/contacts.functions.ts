import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { invoiceOutstanding } from "@/lib/sales/line-helpers";
import { billOutstanding } from "@/lib/purchases/line-math";
import {
  buildContactsCsv,
  contactImportTemplateCsv,
  duplicateScore,
  parseContactsCsv,
} from "@/lib/contacts/contact-helpers";

const CONTACT_SELECT =
  "id, name, email, phone, tax_number, payment_terms_days, is_active, kind, created_at, updated_at, account_number, legal_name, website, default_currency, credit_limit_minor, notes, billing_address_line1, billing_city, billing_country, archived_at";

export const listContacts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      kind?: string;
      q?: string;
      includeInactive?: boolean;
      view?: string;
      limit?: number;
      offset?: number;
    }) => ({
      companyId: assertUuid(input.companyId),
      kind: (input.kind ?? "all").trim(),
      q: (input.q ?? "").trim().slice(0, 100),
      includeInactive: Boolean(input.includeInactive),
      view: (input.view ?? "all").trim(),
      limit: Math.min(500, Math.max(1, Number(input.limit ?? 200) || 200)),
      offset: Math.max(0, Number(input.offset ?? 0) || 0),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    let q = context.supabase
      .from("contacts" as never)
      .select(CONTACT_SELECT as never)
      .eq("company_id" as never, data.companyId as never)
      .order("name" as never)
      .range(data.offset, data.offset + data.limit - 1);

    if (data.view === "archived") {
      q = q.not("archived_at" as never, "is" as never, null as never);
    } else if (!data.includeInactive && data.view !== "inactive") {
      q = q.eq("is_active" as never, true as never).is("archived_at" as never, null as never);
    } else if (data.view === "inactive") {
      q = q.eq("is_active" as never, false as never);
    }

    if (data.kind === "customers" || data.view === "customers") {
      q = q.in("kind" as never, ["customer", "both"] as never);
    } else if (data.kind === "suppliers" || data.view === "suppliers") {
      q = q.in("kind" as never, ["supplier", "both"] as never);
    } else if (data.view === "both") {
      q = q.eq("kind" as never, "both" as never);
    }

    if (data.view === "recent") {
      q = q.order("created_at" as never, { ascending: false });
    } else if (data.view === "updated") {
      q = q.order("updated_at" as never, { ascending: false });
    }

    if (data.q) {
      const term = `%${data.q}%`;
      q = q.or(
        `name.ilike.${term},email.ilike.${term},phone.ilike.${term},account_number.ilike.${term},tax_number.ilike.${term},legal_name.ilike.${term}` as never,
      );
    }

    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const getContactsDirectorySummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({
    companyId: assertUuid(input.companyId),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);

    const { count: activeCount } = await context.supabase
      .from("contacts" as never)
      .select("id" as never, { count: "exact", head: true })
      .eq("company_id" as never, data.companyId as never)
      .eq("is_active" as never, true as never)
      .is("archived_at" as never, null as never);

    const { data: invoices, error: iErr } = await context.supabase
      .from("sales_invoices" as never)
      .select("status, total_minor, amount_paid_minor, amount_credited_minor, due_date" as never)
      .eq("company_id" as never, data.companyId as never)
      .in("status" as never, ["authorised", "partly_paid"] as never)
      .limit(5000);
    if (iErr) throw new Error(iErr.message);

    const { data: bills, error: bErr } = await context.supabase
      .from("purchase_bills" as never)
      .select("status, total_minor, amount_paid_minor, amount_credited_minor, due_date" as never)
      .eq("company_id" as never, data.companyId as never)
      .in("status" as never, ["authorised", "partly_paid"] as never)
      .limit(5000);
    if (bErr) throw new Error(bErr.message);

    const today = new Date().toISOString().slice(0, 10);
    let receivable = 0;
    let overdueRecv = 0;
    for (const i of (invoices ?? []) as Array<{
      total_minor: number;
      amount_paid_minor: number;
      amount_credited_minor: number;
      due_date: string | null;
    }>) {
      const o = Number(
        invoiceOutstanding({
          total_minor: i.total_minor,
          amount_paid_minor: i.amount_paid_minor,
          amount_credited_minor: i.amount_credited_minor,
        }),
      );
      receivable += o;
      if (o > 0 && i.due_date && i.due_date < today) overdueRecv += o;
    }

    let payable = 0;
    let overduePay = 0;
    for (const b of (bills ?? []) as Array<{
      total_minor: number;
      amount_paid_minor: number;
      amount_credited_minor: number;
      due_date: string | null;
    }>) {
      const o = Number(
        billOutstanding({
          total_minor: b.total_minor,
          amount_paid_minor: b.amount_paid_minor,
          amount_credited_minor: b.amount_credited_minor,
        }),
      );
      payable += o;
      if (o > 0 && b.due_date && b.due_date < today) overduePay += o;
    }

    return {
      activeContactCount: activeCount ?? 0,
      receivableMinor: receivable,
      payableMinor: payable,
      overdueReceivableMinor: overdueRecv,
      overduePayableMinor: overduePay,
    };
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

    const [{ data: people }, { data: addresses }, { data: groupRows }, { data: tagRows }] =
      await Promise.all([
        context.supabase
          .from("contact_people" as never)
          .select("*" as never)
          .eq("contact_id" as never, data.contactId as never)
          .order("sort_order" as never),
        context.supabase
          .from("contact_addresses" as never)
          .select("*" as never)
          .eq("contact_id" as never, data.contactId as never),
        context.supabase
          .from("contact_group_members" as never)
          .select("group_id, contact_groups(id, name, color)" as never)
          .eq("contact_id" as never, data.contactId as never),
        context.supabase
          .from("contact_tag_assignments" as never)
          .select("tag_id, contact_tags(id, name)" as never)
          .eq("contact_id" as never, data.contactId as never),
      ]);

    return {
      contact: row,
      people: people ?? [],
      addresses: addresses ?? [],
      groups: groupRows ?? [],
      tags: tagRows ?? [],
    };
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
      accountNumber?: string;
      legalName?: string;
      website?: string;
      defaultCurrency?: string;
      creditLimitMinor?: number | null;
      billingAddressLine1?: string;
      billingCity?: string;
      billingRegion?: string;
      billingPostal?: string;
      billingCountry?: string;
      deliveryAddressLine1?: string;
      deliveryCity?: string;
      deliveryCountry?: string;
    }) => {
      const name = (input.name ?? "").trim();
      if (!name) throw new Error("Contact name is required");
      if (!["supplier", "customer", "both", "employee"].includes(input.kind)) {
        throw new Error("Invalid contact kind");
      }
      const notes = (input.notes ?? "").trim().slice(0, 4000);
      return {
        companyId: assertUuid(input.companyId),
        id: input.id ? assertUuid(input.id) : undefined,
        name,
        kind: input.kind,
        email: (input.email ?? "").trim().slice(0, 200) || null,
        phone: (input.phone ?? "").trim().slice(0, 60) || null,
        taxNumber: (input.taxNumber ?? "").trim().slice(0, 60) || null,
        paymentTermsDays: Math.max(0, Number(input.paymentTermsDays ?? 30) || 0),
        notes: notes || null,
        isActive: input.isActive !== false,
        accountNumber: (input.accountNumber ?? "").trim().slice(0, 40) || null,
        legalName: (input.legalName ?? "").trim().slice(0, 200) || null,
        website: (input.website ?? "").trim().slice(0, 200) || null,
        defaultCurrency: (input.defaultCurrency ?? "").trim().toUpperCase().slice(0, 3) || null,
        creditLimitMinor:
          input.creditLimitMinor == null ? null : Math.max(0, Math.floor(Number(input.creditLimitMinor) || 0)),
        billingAddressLine1: (input.billingAddressLine1 ?? "").trim().slice(0, 200) || null,
        billingCity: (input.billingCity ?? "").trim().slice(0, 100) || null,
        billingRegion: (input.billingRegion ?? "").trim().slice(0, 100) || null,
        billingPostal: (input.billingPostal ?? "").trim().slice(0, 40) || null,
        billingCountry: (input.billingCountry ?? "").trim().slice(0, 100) || null,
        deliveryAddressLine1: (input.deliveryAddressLine1 ?? "").trim().slice(0, 200) || null,
        deliveryCity: (input.deliveryCity ?? "").trim().slice(0, 100) || null,
        deliveryCountry: (input.deliveryCountry ?? "").trim().slice(0, 100) || null,
      };
    },
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "contacts.manage");

    const { data: dup } = await context.supabase
      .from("contacts" as never)
      .select("id, name" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("is_active" as never, true as never)
      .ilike("name" as never, data.name as never);
    const conflict = ((dup ?? []) as Array<{ id: string; name: string }>).find(
      (c) => c.name.toLowerCase() === data.name.toLowerCase() && c.id !== data.id,
    );
    if (conflict) throw new Error(`A contact named "${conflict.name}" already exists`);

    let accountNumber = data.accountNumber;
    if (!data.id && !accountNumber) {
      const { data: settings } = await context.supabase
        .from("company_contact_settings" as never)
        .select("account_number_prefix, next_account_number" as never)
        .eq("company_id" as never, data.companyId as never)
        .maybeSingle();
      const s = settings as { account_number_prefix?: string; next_account_number?: number } | null;
      if (s?.next_account_number) {
        accountNumber = `${s.account_number_prefix ?? "C"}${s.next_account_number}`;
        await context.supabase
          .from("company_contact_settings" as never)
          .update({
            next_account_number: (s.next_account_number ?? 1001) + 1,
            updated_at: new Date().toISOString(),
          } as never)
          .eq("company_id" as never, data.companyId as never);
      }
    }

    const payload = {
      name: data.name,
      kind: data.kind,
      email: data.email,
      phone: data.phone,
      tax_number: data.taxNumber,
      payment_terms_days: data.paymentTermsDays,
      notes: data.notes,
      is_active: data.isActive,
      account_number: accountNumber,
      legal_name: data.legalName,
      website: data.website,
      default_currency: data.defaultCurrency,
      credit_limit_minor: data.creditLimitMinor,
      billing_address_line1: data.billingAddressLine1,
      billing_city: data.billingCity,
      billing_region: data.billingRegion,
      billing_postal: data.billingPostal,
      billing_country: data.billingCountry,
      delivery_address_line1: data.deliveryAddressLine1,
      delivery_city: data.deliveryCity,
      delivery_country: data.deliveryCountry,
      updated_at: new Date().toISOString(),
    };

    if (data.id) {
      const { data: row, error } = await context.supabase
        .from("contacts" as never)
        .update(payload as never)
        .eq("id" as never, data.id as never)
        .eq("company_id" as never, data.companyId as never)
        .select("id")
        .maybeSingle();
      if (error) {
        if (error.code === "23505") throw new Error("Account number or name already exists");
        throw new Error(error.message);
      }
      if (!row) throw new Error("Contact not found");
      return { id: data.id };
    }

    const { data: row, error } = await context.supabase
      .from("contacts" as never)
      .insert({ company_id: data.companyId, ...payload } as never)
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") throw new Error("Account number or name already exists");
      throw new Error(error.message);
    }
    return { id: (row as { id: string }).id };
  });

export const archiveContact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; contactId: string; restore?: boolean }) => ({
    companyId: assertUuid(input.companyId),
    contactId: assertUuid(input.contactId),
    restore: Boolean(input.restore),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "contacts.manage");
    const { error } = await context.supabase
      .from("contacts" as never)
      .update({
        archived_at: data.restore ? null : new Date().toISOString(),
        is_active: data.restore,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, data.contactId as never)
      .eq("company_id" as never, data.companyId as never);
    if (error) throw new Error(error.message);
    return { ok: true };
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
      .select(
        "id, invoice_date, due_date, status, total_minor, amount_paid_minor, amount_credited_minor, invoice_number" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .eq("contact_id" as never, data.contactId as never)
      .neq("status" as never, "void" as never)
      .order("invoice_date" as never, { ascending: false })
      .limit(100);
    if (iErr) throw new Error(iErr.message);

    const { data: bills, error: bErr } = await context.supabase
      .from("purchase_bills" as never)
      .select(
        "id, bill_date, due_date, status, total_minor, amount_paid_minor, amount_credited_minor, bill_number, supplier_invoice_number" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .eq("contact_id" as never, data.contactId as never)
      .neq("status" as never, "void" as never)
      .order("bill_date" as never, { ascending: false })
      .limit(100);
    if (bErr) throw new Error(bErr.message);

    const today = new Date().toISOString().slice(0, 10);
    let receivable = 0;
    let overdueRecv = 0;
    for (const i of (invoices ?? []) as Array<{
      status: string;
      total_minor: number;
      amount_paid_minor: number;
      amount_credited_minor: number;
      due_date: string | null;
    }>) {
      if (!["authorised", "partly_paid"].includes(i.status)) continue;
      const o = Number(
        invoiceOutstanding({
          total_minor: i.total_minor,
          amount_paid_minor: i.amount_paid_minor,
          amount_credited_minor: i.amount_credited_minor,
        }),
      );
      receivable += o;
      if (o > 0 && i.due_date && i.due_date < today) overdueRecv += o;
    }

    let payable = 0;
    let overduePay = 0;
    for (const b of (bills ?? []) as Array<{
      status: string;
      total_minor: number;
      amount_paid_minor: number;
      amount_credited_minor: number;
      due_date: string | null;
    }>) {
      if (!["authorised", "partly_paid"].includes(b.status)) continue;
      const o = Number(
        billOutstanding({
          total_minor: b.total_minor,
          amount_paid_minor: b.amount_paid_minor,
          amount_credited_minor: b.amount_credited_minor,
        }),
      );
      payable += o;
      if (o > 0 && b.due_date && b.due_date < today) overduePay += o;
    }

    return {
      invoices: invoices ?? [],
      bills: bills ?? [],
      receivableMinor: receivable,
      payableMinor: payable,
      overdueReceivableMinor: overdueRecv,
      overduePayableMinor: overduePay,
    };
  });

/* ── People ── */
export const upsertContactPerson = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      contactId: string;
      id?: string;
      firstName: string;
      lastName?: string;
      email?: string;
      phone?: string;
      jobTitle?: string;
      isPrimary?: boolean;
      roleLabel?: string;
    }) => ({
      companyId: assertUuid(input.companyId),
      contactId: assertUuid(input.contactId),
      id: input.id ? assertUuid(input.id) : undefined,
      firstName: (input.firstName ?? "").trim().slice(0, 100),
      lastName: (input.lastName ?? "").trim().slice(0, 100),
      email: (input.email ?? "").trim().slice(0, 200) || null,
      phone: (input.phone ?? "").trim().slice(0, 60) || null,
      jobTitle: (input.jobTitle ?? "").trim().slice(0, 100) || null,
      isPrimary: Boolean(input.isPrimary),
      roleLabel: (input.roleLabel ?? "").trim().slice(0, 60) || null,
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "contacts.manage");
    if (!data.firstName && !data.email) throw new Error("Person needs a name or email");
    if (data.isPrimary) {
      await context.supabase
        .from("contact_people" as never)
        .update({ is_primary: false } as never)
        .eq("contact_id" as never, data.contactId as never)
        .eq("company_id" as never, data.companyId as never);
    }
    const payload = {
      company_id: data.companyId,
      contact_id: data.contactId,
      first_name: data.firstName,
      last_name: data.lastName,
      email: data.email,
      phone: data.phone,
      job_title: data.jobTitle,
      is_primary: data.isPrimary,
      role_label: data.roleLabel,
    };
    if (data.id) {
      const { error } = await context.supabase
        .from("contact_people" as never)
        .update(payload as never)
        .eq("id" as never, data.id as never)
        .eq("company_id" as never, data.companyId as never);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: row, error } = await context.supabase
      .from("contact_people" as never)
      .insert(payload as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: (row as { id: string }).id };
  });

export const deleteContactPerson = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; personId: string }) => ({
    companyId: assertUuid(input.companyId),
    personId: assertUuid(input.personId),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "contacts.manage");
    const { error } = await context.supabase
      .from("contact_people" as never)
      .delete()
      .eq("id" as never, data.personId as never)
      .eq("company_id" as never, data.companyId as never);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/* ── Groups & tags ── */
export const listContactGroups = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await context.supabase
      .from("contact_groups" as never)
      .select("id, name, description, color, is_active" as never)
      .eq("company_id" as never, data.companyId as never)
      .order("name" as never);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const upsertContactGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; id?: string; name: string; description?: string; color?: string; isActive?: boolean }) => {
      const name = (input.name ?? "").trim();
      if (!name) throw new Error("Group name required");
      return {
        companyId: assertUuid(input.companyId),
        id: input.id ? assertUuid(input.id) : undefined,
        name: name.slice(0, 80),
        description: (input.description ?? "").trim().slice(0, 400) || null,
        color: (input.color ?? "").trim().slice(0, 20) || null,
        isActive: input.isActive !== false,
      };
    },
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "contacts.manage");
    if (data.id) {
      const { error } = await context.supabase
        .from("contact_groups" as never)
        .update({
          name: data.name,
          description: data.description,
          color: data.color,
          is_active: data.isActive,
        } as never)
        .eq("id" as never, data.id as never)
        .eq("company_id" as never, data.companyId as never);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: row, error } = await context.supabase
      .from("contact_groups" as never)
      .insert({
        company_id: data.companyId,
        name: data.name,
        description: data.description,
        color: data.color,
        is_active: data.isActive,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: (row as { id: string }).id };
  });

export const setContactGroups = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; contactId: string; groupIds: string[] }) => ({
    companyId: assertUuid(input.companyId),
    contactId: assertUuid(input.contactId),
    groupIds: (input.groupIds ?? []).map((g) => assertUuid(g)).slice(0, 50),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "contacts.manage");
    await context.supabase
      .from("contact_group_members" as never)
      .delete()
      .eq("contact_id" as never, data.contactId as never)
      .eq("company_id" as never, data.companyId as never);
    if (data.groupIds.length) {
      const { error } = await context.supabase.from("contact_group_members" as never).insert(
        data.groupIds.map((group_id) => ({
          company_id: data.companyId,
          contact_id: data.contactId,
          group_id,
        })) as never,
      );
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });

export const listContactTags = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await context.supabase
      .from("contact_tags" as never)
      .select("id, name, is_active" as never)
      .eq("company_id" as never, data.companyId as never)
      .order("name" as never);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const upsertContactTag = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; id?: string; name: string; isActive?: boolean }) => {
    const name = (input.name ?? "").trim().toLowerCase();
    if (!name) throw new Error("Tag name required");
    return {
      companyId: assertUuid(input.companyId),
      id: input.id ? assertUuid(input.id) : undefined,
      name: name.slice(0, 60),
      isActive: input.isActive !== false,
    };
  })
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "contacts.manage");
    if (data.id) {
      const { error } = await context.supabase
        .from("contact_tags" as never)
        .update({ name: data.name, is_active: data.isActive } as never)
        .eq("id" as never, data.id as never)
        .eq("company_id" as never, data.companyId as never);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: row, error } = await context.supabase
      .from("contact_tags" as never)
      .insert({ company_id: data.companyId, name: data.name, is_active: data.isActive } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: (row as { id: string }).id };
  });

export const setContactTags = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; contactId: string; tagIds: string[] }) => ({
    companyId: assertUuid(input.companyId),
    contactId: assertUuid(input.contactId),
    tagIds: (input.tagIds ?? []).map((t) => assertUuid(t)).slice(0, 50),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "contacts.manage");
    await context.supabase
      .from("contact_tag_assignments" as never)
      .delete()
      .eq("contact_id" as never, data.contactId as never)
      .eq("company_id" as never, data.companyId as never);
    if (data.tagIds.length) {
      const { error } = await context.supabase.from("contact_tag_assignments" as never).insert(
        data.tagIds.map((tag_id) => ({
          company_id: data.companyId,
          contact_id: data.contactId,
          tag_id,
        })) as never,
      );
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });

/* ── Settings ── */
export const getContactSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: row } = await context.supabase
      .from("company_contact_settings" as never)
      .select("*" as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (row) return row;
    return {
      company_id: data.companyId,
      default_kind: "customer",
      account_number_prefix: "C",
      next_account_number: 1001,
      default_payment_terms_days: 30,
    };
  });

export const saveContactSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      defaultKind?: string;
      accountNumberPrefix?: string;
      nextAccountNumber?: number;
      defaultPaymentTermsDays?: number;
    }) => ({
      companyId: assertUuid(input.companyId),
      defaultKind: ["customer", "supplier", "both"].includes(input.defaultKind ?? "")
        ? input.defaultKind!
        : "customer",
      accountNumberPrefix: (input.accountNumberPrefix ?? "C").trim().slice(0, 10) || "C",
      nextAccountNumber: Math.max(1, Math.floor(Number(input.nextAccountNumber ?? 1001) || 1001)),
      defaultPaymentTermsDays: Math.max(0, Math.floor(Number(input.defaultPaymentTermsDays ?? 30) || 0)),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "contacts.manage");
    const { error } = await context.supabase.from("company_contact_settings" as never).upsert(
      {
        company_id: data.companyId,
        default_kind: data.defaultKind,
        account_number_prefix: data.accountNumberPrefix,
        next_account_number: data.nextAccountNumber,
        default_payment_terms_days: data.defaultPaymentTermsDays,
        updated_at: new Date().toISOString(),
      } as never,
      { onConflict: "company_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/* ── CSV export / import ── */
export const exportContactsCsv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; kind?: string; includeInactive?: boolean }) => ({
    companyId: assertUuid(input.companyId),
    kind: (input.kind ?? "all").trim(),
    includeInactive: Boolean(input.includeInactive),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    let q = context.supabase
      .from("contacts" as never)
      .select(
        "name, kind, email, phone, tax_number, payment_terms_days, account_number, legal_name, website, notes, is_active" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("name" as never)
      .limit(5000);
    if (!data.includeInactive) q = q.eq("is_active" as never, true as never);
    if (data.kind === "customers") q = q.in("kind" as never, ["customer", "both"] as never);
    else if (data.kind === "suppliers") q = q.in("kind" as never, ["supplier", "both"] as never);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    const columns = [
      "name",
      "kind",
      "email",
      "phone",
      "tax_number",
      "payment_terms_days",
      "account_number",
      "legal_name",
      "website",
      "notes",
      "is_active",
    ];
    const csv = buildContactsCsv(
      ((rows ?? []) as Array<Record<string, string | number | null>>).map((r) => ({
        ...r,
        is_active: r.is_active ? "true" : "false",
      })),
      columns,
    );
    return { csv, count: (rows ?? []).length };
  });

export const getContactImportTemplate = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => ({ csv: contactImportTemplateCsv() }));

export const importContactsCsv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; csvText: string; skipDuplicates?: boolean }) => ({
    companyId: assertUuid(input.companyId),
    csvText: String(input.csvText ?? "").slice(0, 2_000_000),
    skipDuplicates: input.skipDuplicates !== false,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "contacts.manage");
    const { headers, rows } = parseContactsCsv(data.csvText);
    if (!headers.includes("name")) throw new Error("CSV must include a name column");
    const idx = (h: string) => headers.indexOf(h);

    const { data: existing } = await context.supabase
      .from("contacts" as never)
      .select("id, name, email" as never)
      .eq("company_id" as never, data.companyId as never)
      .limit(5000);
    const byName = new Map(
      ((existing ?? []) as Array<{ id: string; name: string }>).map((c) => [
        c.name.toLowerCase(),
        c.id,
      ]),
    );

    let created = 0;
    let skipped = 0;
    let failed = 0;
    const errors: Array<{ row: number; message: string }> = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const name = (r[idx("name")] ?? "").trim();
      if (!name) {
        failed++;
        errors.push({ row: i + 2, message: "Missing name" });
        continue;
      }
      if (data.skipDuplicates && byName.has(name.toLowerCase())) {
        skipped++;
        continue;
      }
      let kind = (r[idx("kind")] ?? "customer").trim().toLowerCase();
      if (!["customer", "supplier", "both", "employee"].includes(kind)) kind = "customer";
      const { error } = await context.supabase.from("contacts" as never).insert({
        company_id: data.companyId,
        name,
        kind,
        email: (r[idx("email")] ?? "").trim().slice(0, 200) || null,
        phone: (r[idx("phone")] ?? "").trim().slice(0, 60) || null,
        tax_number: (r[idx("tax_number")] ?? "").trim().slice(0, 60) || null,
        payment_terms_days: Math.max(0, Number(r[idx("payment_terms_days")] ?? 30) || 30),
        account_number: (r[idx("account_number")] ?? "").trim().slice(0, 40) || null,
        notes: (r[idx("notes")] ?? "").trim().slice(0, 4000) || null,
        is_active: true,
      } as never);
      if (error) {
        failed++;
        errors.push({ row: i + 2, message: error.message });
      } else {
        created++;
        byName.set(name.toLowerCase(), "new");
      }
    }

    return { created, skipped, failed, errors: errors.slice(0, 100) };
  });

/* ── Duplicates & merge ── */
export const findPotentialDuplicates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await context.supabase
      .from("contacts" as never)
      .select("id, name, email, phone, tax_number, account_number, is_active" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("is_active" as never, true as never)
      .limit(2000);
    if (error) throw new Error(error.message);
    const list = (rows ?? []) as Array<{
      id: string;
      name: string;
      email: string | null;
      phone: string | null;
      tax_number: string | null;
      account_number: string | null;
    }>;
    const pairs: Array<{
      a: (typeof list)[0];
      b: (typeof list)[0];
      score: number;
      reasons: string[];
    }> = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const { score, reasons } = duplicateScore(list[i]!, list[j]!);
        if (score >= 40) pairs.push({ a: list[i]!, b: list[j]!, score, reasons });
      }
    }
    pairs.sort((x, y) => y.score - x.score);
    return pairs.slice(0, 50);
  });

export const mergeContacts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; survivorId: string; mergeId: string; confirm: boolean }) => {
      if (!input.confirm) throw new Error("Merge requires explicit confirmation");
      const survivorId = assertUuid(input.survivorId);
      const mergeId = assertUuid(input.mergeId);
      if (survivorId === mergeId) throw new Error("Cannot merge a contact into itself");
      return { companyId: assertUuid(input.companyId), survivorId, mergeId };
    },
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "contacts.manage");

    const load = async (id: string) => {
      const { data: row } = await context.supabase
        .from("contacts" as never)
        .select("id, company_id" as never)
        .eq("id" as never, id as never)
        .eq("company_id" as never, data.companyId as never)
        .maybeSingle();
      return row as { id: string; company_id: string } | null;
    };
    const survivor = await load(data.survivorId);
    const merge = await load(data.mergeId);
    if (!survivor || !merge) throw new Error("Both contacts must exist in this organisation");

    const tables = [
      "sales_invoices",
      "sales_quotes",
      "sales_credit_notes",
      "sales_receipts",
      "purchase_bills",
      "purchase_credit_notes",
      "purchase_payments",
    ] as const;

    for (const table of tables) {
      const { error } = await context.supabase
        .from(table as never)
        .update({ contact_id: data.survivorId } as never)
        .eq("company_id" as never, data.companyId as never)
        .eq("contact_id" as never, data.mergeId as never);
      if (error && !error.message.includes("does not exist") && error.code !== "42P01") {
        // Some tables may not exist in all envs — ignore missing-relation style
        if (error.code !== "PGRST205") throw new Error(`${table}: ${error.message}`);
      }
    }

    await context.supabase
      .from("contact_people" as never)
      .update({ contact_id: data.survivorId } as never)
      .eq("contact_id" as never, data.mergeId as never)
      .eq("company_id" as never, data.companyId as never);
    await context.supabase
      .from("contact_addresses" as never)
      .update({ contact_id: data.survivorId } as never)
      .eq("contact_id" as never, data.mergeId as never)
      .eq("company_id" as never, data.companyId as never);

    const { error: archErr } = await context.supabase
      .from("contacts" as never)
      .update({
        is_active: false,
        archived_at: new Date().toISOString(),
        notes: `Merged into ${data.survivorId}`,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, data.mergeId as never)
      .eq("company_id" as never, data.companyId as never);
    if (archErr) throw new Error(archErr.message);

    return { survivorId: data.survivorId, mergedId: data.mergeId };
  });
