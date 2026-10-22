import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { deriveBillStatus, sumLines } from "@/lib/purchases/line-math";
import { describeBillEdits, type BillEditSnapshot } from "@/lib/purchases/bill-history";
import {
  computeBillLine,
  MAX_ATTACHMENT_BYTES,
  validateAttachmentFile,
  type TaxCalculationMode,
} from "@/lib/purchases/bill-form-helpers";
import { requireAccountInCompany } from "@/lib/purchases/accounts";
import {
  postBillAuthorisation,
  postCreditNoteAuthorisation,
  postDirectExpense,
  postSupplierPayment,
  voidPostedDocument,
} from "@/lib/purchases/posting";
import { parseScheduleOptions } from "@/lib/recurring/recurring-schedule-options";

async function recordBillAudit(
  supabase: unknown,
  companyId: string,
  action: string,
  billId: string | null,
  details: Record<string, unknown>,
) {
  const client = supabase as Parameters<typeof assertCompanyPermission>[0];
  let actorName = "";
  try {
    const { data: authData } = await client.auth.getUser();
    const id = authData.user?.id;
    if (id) {
      const names = await lookupActorNames(client, [id]);
      actorName = names.get(id) ?? authData.user?.email ?? "";
    }
  } catch {
    actorName = "";
  }
  await (
    supabase as { rpc: (fn: string, args: Record<string, unknown>) => Promise<unknown> }
  ).rpc("record_audit_event", {
    _company_id: companyId,
    _action: action,
    _entity_type: "purchase_bill",
    _entity_id: billId,
    _details: actorName ? { ...details, actor_name: actorName } : details,
  });
}

type AuditEventRow = {
  id: string;
  action: string;
  details: Record<string, unknown> | null;
  actor_user_id: string | null;
  created_at: string;
};

type AuditDetails = Record<string, string | number | boolean | null | string[]>;

function plainAuditDetails(
  details: Record<string, unknown> | null | undefined,
): AuditDetails {
  const out: AuditDetails = {};
  for (const [key, value] of Object.entries(details ?? {})) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      out[key] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      out[key] = value;
    }
  }
  return out;
}

async function lookupActorNames(
  supabase: Parameters<typeof assertCompanyPermission>[0],
  ids: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (!unique.length) return names;
  const { data } = await supabase.from("profiles").select("id, full_name, email").in("id", unique);
  for (const profile of data ?? []) {
    const name = profile.full_name.trim() || profile.email.trim();
    if (name) names.set(profile.id, name);
  }
  return names;
}

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
      .select(
        "id, name, email, phone, tax_number, payment_terms_days, is_active, kind, default_currency, billing_address_line1, billing_address_line2, billing_city, billing_region, billing_postal, billing_country" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .in("kind" as never, ["supplier", "both"] as never)
      .eq("is_active" as never, true as never)
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
      billingAddressLine1?: string;
      billingAddressLine2?: string;
      billingCity?: string;
      billingRegion?: string;
      billingPostal?: string;
      billingCountry?: string;
      defaultCurrency?: string;
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
        billingAddressLine1: (input.billingAddressLine1 ?? "").trim().slice(0, 200) || null,
        billingAddressLine2: (input.billingAddressLine2 ?? "").trim().slice(0, 200) || null,
        billingCity: (input.billingCity ?? "").trim().slice(0, 100) || null,
        billingRegion: (input.billingRegion ?? "").trim().slice(0, 100) || null,
        billingPostal: (input.billingPostal ?? "").trim().slice(0, 40) || null,
        billingCountry: (input.billingCountry ?? "").trim().slice(0, 100) || null,
        defaultCurrency: (input.defaultCurrency ?? "").trim().toUpperCase().slice(0, 3) || null,
      };
    },
  )
  .handler(async ({ data, context }) => {
    // Quick-add from bills may use purchases.draft; full contact edits use contacts.manage
    try {
      await assertCompanyPermission(context.supabase, data.companyId, "purchases.draft");
    } catch {
      await assertCompanyPermission(context.supabase, data.companyId, "contacts.manage");
    }

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

    const payload = {
      name: data.name,
      email: data.email,
      phone: data.phone,
      tax_number: data.taxNumber,
      payment_terms_days: data.paymentTermsDays,
      billing_address_line1: data.billingAddressLine1,
      billing_address_line2: data.billingAddressLine2,
      billing_city: data.billingCity,
      billing_region: data.billingRegion,
      billing_postal: data.billingPostal,
      billing_country: data.billingCountry,
      default_currency: data.defaultCurrency,
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
      if (error) throw new Error(error.message);
      if (!row) throw new Error("Supplier not found");
      return { id: data.id };
    }
    const { data: row, error } = await context.supabase
      .from("contacts" as never)
      .insert({
        company_id: data.companyId,
        kind: "supplier",
        ...payload,
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
  productId?: string | null;
  taxCodeId?: string | null;
  classOptionId?: string | null;
  locationOptionId?: string | null;
  projectOptionId?: string | null;
  customerContactId?: string | null;
  isBillable?: boolean;
};

export function validateBillLines(lines: BillLineIn[], taxCalculation: TaxCalculationMode = "exclusive") {
  if (!Array.isArray(lines) || lines.length < 1) throw new Error("Add at least one bill line");
  return lines.map((l, i) => {
    const description = (l.description ?? "").trim();
    if (!description) throw new Error(`Line ${i + 1}: description required`);
    if (!l.accountId) throw new Error(`Line ${i + 1}: expense/asset account required`);
    const qty = Number(l.quantity);
    if (!(qty > 0) || !Number.isFinite(qty)) throw new Error(`Line ${i + 1}: quantity must be positive`);
    const unitPriceMinor = Number(l.unitPriceMinor);
    if (!(unitPriceMinor >= 0) || !Number.isFinite(unitPriceMinor)) {
      throw new Error(`Line ${i + 1}: unit price cannot be negative`);
    }
    const discountMinor = Number(l.discountMinor ?? 0);
    if (!(discountMinor >= 0) || !Number.isFinite(discountMinor)) {
      throw new Error(`Line ${i + 1}: discount cannot be negative`);
    }
    const taxRateBps = Math.min(10000, Math.max(0, Math.floor(Number(l.taxRateBps ?? 0) || 0)));
    const computed = computeBillLine(
      { quantity: qty, unitPriceMinor, discountMinor, taxRateBps },
      taxCalculation,
    );
    return {
      description,
      accountId: assertUuid(l.accountId, "account"),
      quantity: qty,
      unitPriceMinor,
      discountMinor,
      taxRateBps: taxCalculation === "none" ? 0 : taxRateBps,
      productId: l.productId ? assertUuid(l.productId, "product") : null,
      taxCodeId: l.taxCodeId ? assertUuid(l.taxCodeId, "tax code") : null,
      classOptionId: l.classOptionId ? assertUuid(l.classOptionId, "class") : null,
      locationOptionId: l.locationOptionId ? assertUuid(l.locationOptionId, "location") : null,
      projectOptionId: l.projectOptionId ? assertUuid(l.projectOptionId, "project") : null,
      customerContactId: l.customerContactId
        ? assertUuid(l.customerContactId, "customer")
        : null,
      isBillable: Boolean(l.isBillable),
      ...computed,
    };
  });
}

export type BillsWorkspaceTab =
  | "all"
  | "drafts"
  | "for_approval"
  | "to_pay"
  | "paid"
  | "recurring";

function statusesForTab(tab: BillsWorkspaceTab | undefined): string[] | null {
  switch (tab) {
    case "drafts":
      return ["draft"];
    case "for_approval":
      return ["awaiting_approval"];
    case "to_pay":
      return ["authorised", "partly_paid"];
    case "paid":
      return ["paid"];
    case "all":
    default:
      return null;
  }
}

export const listBills = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      status?: string;
      tab?: BillsWorkspaceTab;
      q?: string;
      fromDate?: string;
      toDate?: string;
      dateField?: "bill_date" | "due_date";
      contactId?: string;
      includeVoid?: boolean;
      overdueOnly?: boolean;
      limit?: number;
      offset?: number;
      sortBy?: string;
      sortDir?: "asc" | "desc";
    }) => ({
      companyId: assertUuid(input.companyId),
      status: (input.status ?? "").trim() || undefined,
      tab: input.tab,
      q: (input.q ?? "").trim().slice(0, 100),
      fromDate: input.fromDate && /^\d{4}-\d{2}-\d{2}$/.test(input.fromDate) ? input.fromDate : undefined,
      toDate: input.toDate && /^\d{4}-\d{2}-\d{2}$/.test(input.toDate) ? input.toDate : undefined,
      dateField: input.dateField === "due_date" ? ("due_date" as const) : ("bill_date" as const),
      contactId: input.contactId ? assertUuid(input.contactId, "supplier") : undefined,
      includeVoid: Boolean(input.includeVoid),
      overdueOnly: Boolean(input.overdueOnly),
      limit: Math.min(Math.max(Number(input.limit ?? 50), 1), 200),
      offset: Math.max(Number(input.offset ?? 0), 0),
      sortBy: (input.sortBy ?? "bill_date").slice(0, 40),
      sortDir: input.sortDir === "asc" ? ("asc" as const) : ("desc" as const),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const today = new Date().toISOString().slice(0, 10);
    const sortCol = ["bill_date", "due_date", "total_minor", "status", "bill_number"].includes(
      data.sortBy,
    )
      ? data.sortBy
      : "bill_date";

    let q = context.supabase
      .from("purchase_bills" as never)
      .select(
        "id, bill_number, supplier_invoice_number, bill_date, due_date, status, total_minor, tax_minor, amount_paid_minor, amount_credited_minor, currency_code, contact_id, memo, posted_journal_id, fx_rate_to_base, created_at, updated_at, created_by, contacts(id, name, account_number)" as never,
        { count: "exact" },
      )
      .eq("company_id" as never, data.companyId as never)
      .order(sortCol as never, { ascending: data.sortDir === "asc" } as never)
      .range(data.offset, data.offset + data.limit - 1);

    const tabStatuses = statusesForTab(data.tab);
    if (data.status) {
      q = q.eq("status" as never, data.status as never);
    } else if (tabStatuses) {
      q = q.in("status" as never, tabStatuses as never);
    } else if (!data.includeVoid) {
      q = q.neq("status" as never, "void" as never);
    }

    if (data.contactId) q = q.eq("contact_id" as never, data.contactId as never);
    if (data.fromDate) q = q.gte(data.dateField as never, data.fromDate as never);
    if (data.toDate) q = q.lte(data.dateField as never, data.toDate as never);
    if (data.overdueOnly) {
      q = q
        .in("status" as never, ["authorised", "partly_paid"] as never)
        .lt("due_date" as never, today as never);
    }
    if (data.q) {
      const term = `%${data.q}%`;
      q = q.or(
        `bill_number.ilike.${term},supplier_invoice_number.ilike.${term},memo.ilike.${term}` as never,
      );
    }

    const { data: rows, error, count } = await q;
    if (error) throw new Error(error.message);

    const billIds = ((rows ?? []) as Array<{ id: string }>).map((r) => r.id);
    let attachmentCounts: Record<string, number> = {};
    if (billIds.length) {
      const { data: atts } = await context.supabase
        .from("document_attachments" as never)
        .select("entity_id" as never)
        .eq("company_id" as never, data.companyId as never)
        .eq("entity_type" as never, "purchase_bill" as never)
        .in("entity_id" as never, billIds as never);
      for (const a of (atts ?? []) as Array<{ entity_id: string }>) {
        attachmentCounts[a.entity_id] = (attachmentCounts[a.entity_id] ?? 0) + 1;
      }
    }

    type BillListRaw = {
      id: string;
      bill_number: string | null;
      supplier_invoice_number: string | null;
      bill_date: string;
      due_date: string;
      status: string;
      total_minor: number;
      tax_minor: number;
      amount_paid_minor: number;
      amount_credited_minor: number;
      currency_code: string | null;
      contact_id: string;
      memo: string | null;
      posted_journal_id: string | null;
      fx_rate_to_base: number | null;
      created_at: string;
      updated_at: string;
      created_by: string | null;
      contacts:
        | { id: string; name: string; account_number: string | null }
        | Array<{ id: string; name: string; account_number: string | null }>
        | null;
    };

    const mapped = ((rows ?? []) as BillListRaw[]).map((r) => {
      const contactRaw = r.contacts;
      const contact = Array.isArray(contactRaw) ? contactRaw[0] : contactRaw;
      const total = Number(r.total_minor ?? 0);
      const paid = Number(r.amount_paid_minor ?? 0);
      const credited = Number(r.amount_credited_minor ?? 0);
      const balance = Math.max(0, total - paid - credited);
      const status = String(r.status);
      const dueDate = String(r.due_date ?? "");
      const daysOverdue =
        ["authorised", "partly_paid"].includes(status) && dueDate && dueDate < today
          ? Math.floor((Date.parse(today) - Date.parse(dueDate)) / 86400000)
          : 0;
      return {
        id: r.id,
        bill_number: r.bill_number ?? null,
        supplier_invoice_number: r.supplier_invoice_number ?? null,
        bill_date: r.bill_date,
        due_date: dueDate,
        status,
        total_minor: total,
        tax_minor: Number(r.tax_minor ?? 0),
        amount_paid_minor: paid,
        amount_credited_minor: credited,
        balance_due_minor: status === "draft" || status === "awaiting_approval" ? 0 : balance,
        document_total_minor: total,
        currency_code: r.currency_code ?? "GBP",
        contact_id: r.contact_id,
        memo: r.memo ?? null,
        posted_journal_id: r.posted_journal_id ?? null,
        fx_rate_to_base: r.fx_rate_to_base ?? null,
        created_at: r.created_at,
        updated_at: r.updated_at,
        created_by: r.created_by ?? null,
        contacts: contact
          ? { id: contact.id, name: contact.name, account_number: contact.account_number }
          : null,
        attachment_count: attachmentCounts[r.id] ?? 0,
        days_overdue: daysOverdue,
        display_reference:
          r.supplier_invoice_number?.trim() || r.bill_number?.trim() || null,
      };
    });

    return { rows: mapped, totalCount: count ?? mapped.length };
  });

export const getBillsWorkspaceSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({
    companyId: assertUuid(input.companyId),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const today = new Date().toISOString().slice(0, 10);
    const { data: rows, error } = await context.supabase
      .from("purchase_bills" as never)
      .select(
        "id, status, total_minor, amount_paid_minor, amount_credited_minor, due_date" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .neq("status" as never, "void" as never);
    if (error) throw new Error(error.message);

    let drafts = 0;
    let forApproval = 0;
    let toPay = 0;
    let paid = 0;
    let all = 0;
    let outstandingMinor = 0;
    let overdueMinor = 0;

    for (const r of (rows ?? []) as Array<{
      status: string;
      total_minor: number;
      amount_paid_minor: number;
      amount_credited_minor: number;
      due_date: string;
    }>) {
      all += 1;
      if (r.status === "draft") drafts += 1;
      else if (r.status === "awaiting_approval") forApproval += 1;
      else if (r.status === "paid") paid += 1;
      else if (r.status === "authorised" || r.status === "partly_paid") {
        toPay += 1;
        const bal = Math.max(
          0,
          Number(r.total_minor) - Number(r.amount_paid_minor) - Number(r.amount_credited_minor),
        );
        outstandingMinor += bal;
        if (r.due_date < today) overdueMinor += bal;
      }
    }

    const { count: recurringCount } = await context.supabase
      .from("recurring_bills" as never)
      .select("id" as never, { count: "exact", head: true })
      .eq("company_id" as never, data.companyId as never)
      .eq("is_active" as never, true as never);

    return {
      counts: {
        all,
        drafts,
        for_approval: forApproval,
        to_pay: toPay,
        paid,
        recurring: recurringCount ?? 0,
      },
      outstandingMinor,
      overdueMinor,
      approvalQueue: forApproval,
    };
  });

export const submitBillForApproval = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; billId: string; comment?: string }) => ({
    companyId: assertUuid(input.companyId),
    billId: assertUuid(input.billId, "bill"),
    comment: (input.comment ?? "").trim().slice(0, 1000) || null,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.draft");
    const { data: bill, error } = await context.supabase
      .from("purchase_bills" as never)
      .select("id, status" as never)
      .eq("id" as never, data.billId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!bill) throw new Error("Bill not found");
    if ((bill as { status: string }).status !== "draft") {
      throw new Error("Only draft bills can be submitted for approval");
    }
    const { error: upErr } = await context.supabase
      .from("purchase_bills" as never)
      .update({
        status: "awaiting_approval",
        submitted_for_approval_at: new Date().toISOString(),
        submitted_for_approval_by: context.userId,
        approval_comment: data.comment,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, data.billId as never);
    if (upErr) throw new Error(upErr.message);
    await recordBillAudit(context.supabase, data.companyId, "bill.submit_approval", data.billId, {
      comment: data.comment,
    });
    return { ok: true };
  });

export const rejectBillApproval = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; billId: string; reason?: string }) => ({
    companyId: assertUuid(input.companyId),
    billId: assertUuid(input.billId, "bill"),
    reason: (input.reason ?? "").trim().slice(0, 1000) || null,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.authorise");
    const { data: bill, error } = await context.supabase
      .from("purchase_bills" as never)
      .select("id, status" as never)
      .eq("id" as never, data.billId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!bill) throw new Error("Bill not found");
    if ((bill as { status: string }).status !== "awaiting_approval") {
      throw new Error("Only bills awaiting approval can be rejected");
    }
    const { error: upErr } = await context.supabase
      .from("purchase_bills" as never)
      .update({
        status: "draft",
        rejected_at: new Date().toISOString(),
        rejected_by: context.userId,
        rejection_reason: data.reason,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, data.billId as never);
    if (upErr) throw new Error(upErr.message);
    await recordBillAudit(context.supabase, data.companyId, "bill.reject_approval", data.billId, {
      reason: data.reason,
    });
    return { ok: true };
  });

export const deleteDraftBill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; billId: string }) => ({
    companyId: assertUuid(input.companyId),
    billId: assertUuid(input.billId, "bill"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.draft");
    const { data: bill, error } = await context.supabase
      .from("purchase_bills" as never)
      .select("id, status, posted_journal_id" as never)
      .eq("id" as never, data.billId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!bill) throw new Error("Bill not found");
    const b = bill as { status: string; posted_journal_id: string | null };
    if (b.status !== "draft" && b.status !== "awaiting_approval") {
      throw new Error("Only unposted draft/awaiting-approval bills can be deleted");
    }
    if (b.posted_journal_id) throw new Error("Cannot delete a posted bill");
    await context.supabase
      .from("document_attachments" as never)
      .delete()
      .eq("company_id" as never, data.companyId as never)
      .eq("entity_type" as never, "purchase_bill" as never)
      .eq("entity_id" as never, data.billId as never);
    const { error: delErr } = await context.supabase
      .from("purchase_bills" as never)
      .delete()
      .eq("id" as never, data.billId as never)
      .eq("company_id" as never, data.companyId as never);
    if (delErr) throw new Error(delErr.message);
    await recordBillAudit(context.supabase, data.companyId, "bill.draft.delete", data.billId, {});
    return { ok: true };
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
      .select(
        "*, contacts(id, name, email, phone, account_number, tax_number, billing_address_line1, billing_city, billing_country), purchase_bill_lines(*)" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .eq("id" as never, data.billId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!bill) throw new Error("Bill not found");
    type ContactOut = {
      id: string;
      name: string;
      email: string | null;
      phone: string | null;
      account_number: string | null;
      tax_number: string | null;
      billing_address_line1: string | null;
      billing_city: string | null;
      billing_country: string | null;
    };
    const b = bill as {
      id: string;
      status: string;
      total_minor: number;
      tax_minor: number;
      subtotal_minor: number;
      amount_paid_minor: number;
      amount_credited_minor: number;
      supplier_invoice_number: string | null;
      bill_number: string | null;
      bill_date: string;
      due_date: string;
      memo: string | null;
      currency_code: string | null;
      fx_rate_to_base: number | null;
      payment_terms_days: number | null;
      posted_journal_id: string | null;
      contact_id: string;
      approval_comment: string | null;
      rejection_reason: string | null;
      submitted_for_approval_at: string | null;
      contacts: ContactOut | ContactOut[] | null;
      purchase_bill_lines: Array<{
        id: string;
        line_no?: number;
        description: string;
        quantity: number;
        unit_price_minor: number;
        discount_minor: number;
        net_minor: number;
        tax_minor: number;
        tax_rate_bps: number;
        account_id: string | null;
        class_id: string | null;
        location_id: string | null;
        project_id: string | null;
      }> | null;
    };
    const contactRaw = b.contacts;
    const contacts: ContactOut | null = Array.isArray(contactRaw)
      ? (contactRaw[0] ?? null)
      : contactRaw;
    const lines = Array.isArray(b.purchase_bill_lines)
      ? [...b.purchase_bill_lines].sort((a, c) => (a.line_no ?? 0) - (c.line_no ?? 0))
      : [];
    const { data: atts } = await context.supabase
      .from("document_attachments" as never)
      .select("id, file_name, content_type, size_bytes, created_at" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("entity_type" as never, "purchase_bill" as never)
      .eq("entity_id" as never, data.billId as never)
      .order("created_at" as never, { ascending: false } as never);

    const { data: allocations } = await context.supabase
      .from("supplier_payment_allocations" as never)
      .select(
        "id, amount_minor, payment_id, supplier_payments(id, payment_date, reference, memo, amount_minor, status, posted_journal_id, bank_account_id)" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .eq("bill_id" as never, data.billId as never)
      .order("id" as never, { ascending: true } as never);

    const status = String(b.status);
    const total = Number(b.total_minor ?? 0);
    const paid = Number(b.amount_paid_minor ?? 0);
    const credited = Number(b.amount_credited_minor ?? 0);
    const balance = Math.max(0, total - paid - credited);

    return {
      id: b.id,
      status: b.status,
      bill_date: b.bill_date,
      due_date: b.due_date,
      bill_number: b.bill_number,
      supplier_invoice_number: b.supplier_invoice_number,
      memo: b.memo,
      currency_code: b.currency_code,
      fx_rate_to_base: b.fx_rate_to_base,
      payment_terms_days: b.payment_terms_days,
      total_minor: total,
      tax_minor: Number(b.tax_minor ?? 0),
      subtotal_minor: Number(b.subtotal_minor ?? 0),
      amount_paid_minor: paid,
      amount_credited_minor: credited,
      posted_journal_id: b.posted_journal_id,
      contact_id: b.contact_id,
      approval_comment: b.approval_comment ?? null,
      rejection_reason: b.rejection_reason ?? null,
      submitted_for_approval_at: b.submitted_for_approval_at ?? null,
      contacts,
      purchase_bill_lines: lines,
      attachments: (atts ?? []) as Array<{
        id: string;
        file_name: string;
        content_type: string | null;
        size_bytes: number | null;
        created_at: string;
      }>,
      payment_allocations: (allocations ?? []) as Array<{
        id: string;
        amount_minor: number;
        payment_id: string;
        supplier_payments: {
          id: string;
          payment_date: string;
          reference: string | null;
          memo: string | null;
          amount_minor: number;
          status: string;
          posted_journal_id: string | null;
          bank_account_id: string;
        } | null;
      }>,
      balance_due_minor: status === "draft" || status === "awaiting_approval" ? 0 : balance,
      document_total_minor: total,
      display_reference:
        b.supplier_invoice_number?.trim() || b.bill_number?.trim() || null,
    };
  });

/** Previous / next bill ids for document workspace navigation (bill_date desc, id desc). */
export const getBillNeighbors = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; billId: string }) => ({
    companyId: assertUuid(input.companyId),
    billId: assertUuid(input.billId, "bill"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const { data: rows, error } = await context.supabase
      .from("purchase_bills" as never)
      .select("id, bill_date" as never)
      .eq("company_id" as never, data.companyId as never)
      .neq("status" as never, "void" as never)
      .order("bill_date" as never, { ascending: false } as never)
      .order("id" as never, { ascending: false } as never)
      .limit(500);
    if (error) throw new Error(error.message);
    const ids = ((rows ?? []) as Array<{ id: string }>).map((r) => r.id);
    const idx = ids.indexOf(data.billId);
    return {
      previousId: idx > 0 ? ids[idx - 1]! : null,
      nextId: idx >= 0 && idx < ids.length - 1 ? ids[idx + 1]! : null,
      position: idx >= 0 ? idx + 1 : null,
      total: ids.length,
    };
  });

export const checkDuplicateSupplierBill = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      contactId: string;
      supplierInvoiceNumber: string;
      excludeBillId?: string;
    }) => ({
      companyId: assertUuid(input.companyId),
      contactId: assertUuid(input.contactId, "supplier"),
      supplierInvoiceNumber: (input.supplierInvoiceNumber ?? "").trim().slice(0, 80),
      excludeBillId: input.excludeBillId ? assertUuid(input.excludeBillId, "bill") : undefined,
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    if (!data.supplierInvoiceNumber) return { duplicate: false as const };
    let q = context.supabase
      .from("purchase_bills" as never)
      .select("id, bill_number, status, bill_date, total_minor" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("contact_id" as never, data.contactId as never)
      .neq("status" as never, "void" as never)
      .ilike("supplier_invoice_number" as never, data.supplierInvoiceNumber as never)
      .limit(5);
    if (data.excludeBillId) q = q.neq("id" as never, data.excludeBillId as never);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    const matches = (rows ?? []) as Array<{
      id: string;
      bill_number: string | null;
      status: string;
      bill_date: string;
      total_minor: number;
    }>;
    if (!matches.length) return { duplicate: false as const };
    return { duplicate: true as const, matches };
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
      taxCalculation?: TaxCalculationMode;
      paymentTermId?: string | null;
      paymentTermsDays?: number | null;
      dueDateManualOverride?: boolean;
      acknowledgeDuplicate?: boolean;
      fxRateToBase?: number | null;
      supplierAddress?: {
        line1?: string;
        line2?: string;
        city?: string;
        region?: string;
        postal?: string;
        country?: string;
      };
      lines: BillLineIn[];
    }) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.billDate) || !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) {
        throw new Error("Bill and due dates are required (YYYY-MM-DD)");
      }
      const taxCalculation: TaxCalculationMode =
        input.taxCalculation === "inclusive" || input.taxCalculation === "none"
          ? input.taxCalculation
          : "exclusive";
      const currencyCode = (input.currencyCode ?? "").toUpperCase();
      if (!/^[A-Z]{3}$/.test(currencyCode)) throw new Error("Currency code required");
      return {
        companyId: assertUuid(input.companyId),
        billId: input.billId ? assertUuid(input.billId, "bill") : undefined,
        contactId: assertUuid(input.contactId, "supplier"),
        billDate: input.billDate,
        dueDate: input.dueDate,
        supplierInvoiceNumber: (input.supplierInvoiceNumber ?? "").trim().slice(0, 80) || null,
        memo: (input.memo ?? "").trim().slice(0, 500) || null,
        currencyCode,
        taxCalculation,
        paymentTermId: input.paymentTermId ? assertUuid(input.paymentTermId, "payment term") : null,
        paymentTermsDays:
          input.paymentTermsDays == null
            ? null
            : Math.max(0, Math.min(3650, Math.floor(Number(input.paymentTermsDays) || 0))),
        dueDateManualOverride: Boolean(input.dueDateManualOverride),
        acknowledgeDuplicate: Boolean(input.acknowledgeDuplicate),
        fxRateToBase:
          input.fxRateToBase == null || input.fxRateToBase === 1
            ? null
            : Number(input.fxRateToBase),
        supplierAddress: {
          line1: (input.supplierAddress?.line1 ?? "").trim().slice(0, 200) || null,
          line2: (input.supplierAddress?.line2 ?? "").trim().slice(0, 200) || null,
          city: (input.supplierAddress?.city ?? "").trim().slice(0, 100) || null,
          region: (input.supplierAddress?.region ?? "").trim().slice(0, 100) || null,
          postal: (input.supplierAddress?.postal ?? "").trim().slice(0, 40) || null,
          country: (input.supplierAddress?.country ?? "").trim().slice(0, 100) || null,
        },
        lines: validateBillLines(input.lines, taxCalculation),
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "purchases.draft");
    for (const line of data.lines) {
      await requireAccountInCompany(supabase, data.companyId, line.accountId);
    }
    if (data.fxRateToBase != null && (!(data.fxRateToBase > 0) || !Number.isFinite(data.fxRateToBase))) {
      throw new Error("Exchange rate must be a positive number");
    }
    const totals = sumLines(data.lines);

    const headerFields = {
      contact_id: data.contactId,
      bill_date: data.billDate,
      due_date: data.dueDate,
      supplier_invoice_number: data.supplierInvoiceNumber,
      memo: data.memo,
      currency_code: data.currencyCode,
      tax_calculation: data.taxCalculation,
      payment_term_id: data.paymentTermId,
      payment_terms_days: data.paymentTermsDays,
      due_date_manual_override: data.dueDateManualOverride,
      duplicate_override: data.acknowledgeDuplicate,
      fx_rate_to_base: data.fxRateToBase,
      supplier_address_line1: data.supplierAddress.line1,
      supplier_address_line2: data.supplierAddress.line2,
      supplier_address_city: data.supplierAddress.city,
      supplier_address_region: data.supplierAddress.region,
      supplier_address_postal: data.supplierAddress.postal,
      supplier_address_country: data.supplierAddress.country,
      subtotal_minor: Number(totals.subtotal_minor),
      tax_minor: Number(totals.tax_minor),
      total_minor: Number(totals.total_minor),
      updated_at: new Date().toISOString(),
    };

    const lineRows = (billId: string) =>
      data.lines.map((l, i) => ({
        company_id: data.companyId,
        bill_id: billId,
        line_no: i + 1,
        description: l.description,
        account_id: l.accountId,
        product_id: l.productId,
        tax_code_id: l.taxCodeId,
        quantity: l.quantity,
        unit_price_minor: l.unitPriceMinor,
        discount_minor: l.discountMinor,
        tax_rate_bps: l.taxRateBps,
        net_minor: Number(l.net_minor),
        tax_minor: Number(l.tax_minor),
        class_option_id: l.classOptionId,
        location_option_id: l.locationOptionId,
        project_option_id: l.projectOptionId,
        customer_contact_id: l.customerContactId,
        is_billable: l.isBillable,
      }));

    if (data.billId) {
      const { data: existing, error: exErr } = await supabase
        .from("purchase_bills" as never)
        .select(
          "id, status, contact_id, bill_date, due_date, supplier_invoice_number, memo, total_minor, tax_minor, currency_code" as never,
        )
        .eq("id" as never, data.billId as never)
        .eq("company_id" as never, data.companyId as never)
        .maybeSingle();
      if (exErr) throw new Error(exErr.message);
      if (!existing) throw new Error("Bill not found");
      const prior = existing as {
        status: string;
        contact_id: string;
        bill_date: string;
        due_date: string;
        supplier_invoice_number: string | null;
        memo: string | null;
        total_minor: number;
        tax_minor: number;
        currency_code: string;
      };
      if (prior.status !== "draft" && prior.status !== "awaiting_approval") {
        throw new Error("Only draft or awaiting-approval bills can be edited");
      }
      const { data: priorLines } = await supabase
        .from("purchase_bill_lines" as never)
        .select("description, quantity, unit_price_minor, net_minor" as never)
        .eq("bill_id" as never, data.billId as never);
      const contactIds = [...new Set([prior.contact_id, data.contactId])];
      const { data: contactRows } = await supabase
        .from("contacts" as never)
        .select("id, name" as never)
        .in("id" as never, contactIds as never);
      const contactNames = new Map(
        ((contactRows ?? []) as Array<{ id: string; name: string }>).map((row) => [row.id, row.name]),
      );
      const before: BillEditSnapshot = {
        totalMinor: Number(prior.total_minor),
        taxMinor: Number(prior.tax_minor),
        billDate: prior.bill_date,
        dueDate: prior.due_date,
        supplierInvoiceNumber: prior.supplier_invoice_number,
        memo: prior.memo,
        supplierName: contactNames.get(prior.contact_id) ?? null,
      };
      const after: BillEditSnapshot = {
        totalMinor: Number(totals.total_minor),
        taxMinor: Number(totals.tax_minor),
        billDate: data.billDate,
        dueDate: data.dueDate,
        supplierInvoiceNumber: data.supplierInvoiceNumber,
        memo: data.memo,
        supplierName: contactNames.get(data.contactId) ?? null,
      };
      const oldLineKey = ((priorLines ?? []) as Array<{
        description: string;
        quantity: number;
        unit_price_minor: number;
        net_minor: number;
      }>)
        .map((line) =>
          [line.description, line.quantity, line.unit_price_minor, line.net_minor].join("|"),
        )
        .sort()
        .join("\n");
      const newLineKey = data.lines
        .map((line) =>
          [line.description, line.quantity, line.unitPriceMinor, Number(line.net_minor)].join("|"),
        )
        .sort()
        .join("\n");
      const changes = describeBillEdits(before, after, data.currencyCode, oldLineKey !== newLineKey);
      const { error: upErr } = await supabase
        .from("purchase_bills" as never)
        .update(headerFields as never)
        .eq("id" as never, data.billId as never);
      if (upErr) {
        if (upErr.message.toLowerCase().includes("duplicate") || upErr.code === "23505") {
          throw new Error(
            "A bill with this supplier invoice number already exists. Acknowledge the duplicate to continue.",
          );
        }
        throw new Error(upErr.message);
      }
      await supabase
        .from("purchase_bill_lines" as never)
        .delete()
        .eq("bill_id" as never, data.billId as never);
      const { error: lineErr } = await supabase
        .from("purchase_bill_lines" as never)
        .insert(lineRows(data.billId) as never);
      if (lineErr) throw new Error(lineErr.message);
      await recordBillAudit(supabase, data.companyId, "bill.draft.update", data.billId, {
        total_minor: Number(totals.total_minor),
        previous_total_minor: before.totalMinor,
        line_count: data.lines.length,
        changes,
      });
      return { id: data.billId };
    }

    const { allocateDocumentNumber } = await import("@/lib/settings/document-numbering");
    const billNumber = await allocateDocumentNumber(
      supabase as never,
      data.companyId,
      "purchase_bill",
    );

    const { data: inserted, error } = await supabase
      .from("purchase_bills" as never)
      .insert({
        company_id: data.companyId,
        bill_number: billNumber,
        status: "draft",
        created_by: userId,
        ...headerFields,
      } as never)
      .select("id")
      .single();
    if (error) {
      if (error.message.toLowerCase().includes("duplicate") || error.code === "23505") {
        throw new Error(
          "A bill with this supplier invoice number already exists. Acknowledge the duplicate to continue.",
        );
      }
      throw new Error(error.message);
    }
    const billId = (inserted as { id: string }).id;
    const { error: lineErr } = await supabase
      .from("purchase_bill_lines" as never)
      .insert(lineRows(billId) as never);
    if (lineErr) throw new Error(lineErr.message);
    const { data: supplier } = await supabase
      .from("contacts" as never)
      .select("name" as never)
      .eq("id" as never, data.contactId as never)
      .maybeSingle();
    await recordBillAudit(supabase, data.companyId, "bill.draft.create", billId, {
      bill_number: billNumber,
      total_minor: Number(totals.total_minor),
      line_count: data.lines.length,
      supplier_name: (supplier as { name?: string } | null)?.name ?? "",
    });
    return { id: billId };
  });

export async function authoriseBillInternal(
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
  if (b.status !== "draft" && b.status !== "awaiting_approval") {
    throw new Error("Only draft or awaiting-approval bills can be authorised");
  }
  if (b.posted_journal_id) throw new Error("Bill already posted");

  const billFx = bill as { fx_rate_to_base?: number | string | null };
  const fxRate =
    billFx.fx_rate_to_base != null && Number(billFx.fx_rate_to_base) > 0
      ? Number(billFx.fx_rate_to_base)
      : undefined;

  const journalId = await postBillAuthorisation(supabase, {
    company_id: companyId,
    bill_id: billId,
    bill_date: b.bill_date,
    currency_code: b.currency_code,
    ...(b.memo ? { memo: b.memo } : {}),
    ...(fxRate != null ? { fx_rate_to_base: fxRate } : {}),
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
  await recordBillAudit(supabase, companyId, "bill.authorise", billId, { journal_id: journalId });
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
    await recordBillAudit(supabase, data.companyId, "bill.void", data.billId, {
      void_journal_id: voidJournalId,
    });
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

export const getSupplierPayment = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; paymentId: string }) => ({
    companyId: assertUuid(input.companyId),
    paymentId: assertUuid(input.paymentId, "payment"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const { data: payment, error } = await context.supabase
      .from("supplier_payments" as never)
      .select(
        "id, payment_date, amount_minor, unallocated_minor, status, reference, memo, currency_code, contact_id, bank_account_id, posted_journal_id, created_at, created_by" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .eq("id" as never, data.paymentId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!payment) throw new Error("Payment not found");
    const row = payment as {
      id: string;
      payment_date: string;
      amount_minor: number;
      unallocated_minor: number;
      status: string;
      reference: string | null;
      memo: string | null;
      currency_code: string;
      contact_id: string;
      bank_account_id: string;
      posted_journal_id: string | null;
      created_at: string;
      created_by: string | null;
    };
    const [{ data: contact }, { data: account }, { data: allocs, error: allocErr }] =
      await Promise.all([
        context.supabase
          .from("contacts" as never)
          .select("id, name, email" as never)
          .eq("company_id" as never, data.companyId as never)
          .eq("id" as never, row.contact_id as never)
          .maybeSingle(),
        context.supabase
          .from("accounts" as never)
          .select("id, code, name" as never)
          .eq("company_id" as never, data.companyId as never)
          .eq("id" as never, row.bank_account_id as never)
          .maybeSingle(),
        context.supabase
          .from("supplier_payment_allocations" as never)
          .select("id, amount_minor, bill_id" as never)
          .eq("company_id" as never, data.companyId as never)
          .eq("payment_id" as never, data.paymentId as never),
      ]);
    if (allocErr) throw new Error(allocErr.message);
    const allocationRows = (allocs ?? []) as Array<{
      id: string;
      amount_minor: number;
      bill_id: string;
    }>;
    const billIds = allocationRows.map((allocation) => allocation.bill_id);
    const { data: bills, error: billErr } = billIds.length
      ? await context.supabase
          .from("purchase_bills" as never)
          .select(
            "id, bill_number, supplier_invoice_number, bill_date, total_minor, status" as never,
          )
          .eq("company_id" as never, data.companyId as never)
          .in("id" as never, billIds as never)
      : { data: [] as unknown[], error: null };
    if (billErr) throw new Error(billErr.message);
    const billsById = new Map(
      (
        (bills ?? []) as Array<{
          id: string;
          bill_number: string | null;
          supplier_invoice_number: string | null;
          bill_date: string;
          total_minor: number;
          status: string;
        }>
      ).map((bill) => [bill.id, bill]),
    );
    const names = await lookupActorNames(context.supabase, [row.created_by]);
    const supplier = contact as { name: string; email: string | null } | null;
    const bank = account as { code: string; name: string } | null;
    return {
      ...row,
      supplier_name: supplier?.name ?? null,
      supplier_email: supplier?.email ?? null,
      bank_label: bank ? `${bank.code} — ${bank.name}` : null,
      recorded_by: row.created_by ? (names.get(row.created_by) ?? null) : null,
      allocations: allocationRows.map((allocation) => {
        const bill = billsById.get(allocation.bill_id);
        return {
          id: allocation.id,
          amount_minor: allocation.amount_minor,
          bill_id: allocation.bill_id,
          bill_number: bill?.bill_number ?? null,
          supplier_invoice_number: bill?.supplier_invoice_number ?? null,
          bill_date: bill?.bill_date ?? null,
          bill_total_minor: bill?.total_minor ?? null,
          bill_status: bill?.status ?? null,
        };
      }),
    };
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
      if (!["authorised", "partly_paid"].includes(b.status)) {
        throw new Error(
          "Can only pay authorised or partly paid bills (not draft, awaiting approval, paid, or void)",
        );
      }
      const outstanding =
        b.total_minor - b.amount_paid_minor - b.amount_credited_minor;
      if (outstanding <= 0) throw new Error("Bill has no outstanding balance");
      if (alloc.amountMinor > outstanding) {
        throw new Error("Allocation exceeds bill outstanding balance — overpayment blocked");
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

    const fullyPaidBillIds: string[] = [];
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
      if (nextStatus === "paid") fullyPaidBillIds.push(alloc.billId);
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

    const { data: supplier } = await supabase
      .from("contacts" as never)
      .select("name" as never)
      .eq("id" as never, data.contactId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();

    await recordBillAudit(supabase, data.companyId, "supplier_payment.post", null, {
      payment_id: paymentId,
      journal_id: journalId,
      amount_minor: data.amountMinor,
      payment_date: data.paymentDate,
      supplier_name: (supplier as { name?: string } | null)?.name ?? "",
      bill_ids: data.allocations.map((a) => a.billId),
      fully_paid_bill_ids: fullyPaidBillIds,
    });

    return { id: paymentId, journalId, unallocatedMinor: data.unallocatedMinor };
  });

/**
 * Reverse a posted supplier payment: reverse the journal, restore bill balances,
 * mark payment void. Does not delete history.
 */
export const reverseSupplierPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; paymentId: string; reason?: string }) => ({
    companyId: assertUuid(input.companyId),
    paymentId: assertUuid(input.paymentId, "payment"),
    reason: (input.reason ?? "").trim().slice(0, 500) || null,
  }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "purchases.payment");

    const { data: payment, error } = await supabase
      .from("supplier_payments" as never)
      .select(
        "id, status, posted_journal_id, amount_minor, contact_id, memo, reference" as never,
      )
      .eq("id" as never, data.paymentId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!payment) throw new Error("Payment not found");
    const p = payment as {
      id: string;
      status: string;
      posted_journal_id: string | null;
      amount_minor: number;
      contact_id: string;
      memo: string | null;
      reference: string | null;
    };
    if (p.status === "void") throw new Error("Payment is already voided");
    if (!p.posted_journal_id) throw new Error("Payment has no posted journal to reverse");

    const { data: allocs, error: aErr } = await supabase
      .from("supplier_payment_allocations" as never)
      .select("id, bill_id, amount_minor" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("payment_id" as never, data.paymentId as never);
    if (aErr) throw new Error(aErr.message);

    const voidJournalId = await voidPostedDocument(
      supabase,
      p.posted_journal_id,
      `supplier_payment:${data.paymentId}:void`,
    );

    for (const alloc of (allocs ?? []) as Array<{
      bill_id: string;
      amount_minor: number;
    }>) {
      const { data: bill, error: billErr } = await supabase
        .from("purchase_bills" as never)
        .select("total_minor, amount_paid_minor, amount_credited_minor, status" as never)
        .eq("id" as never, alloc.bill_id as never)
        .eq("company_id" as never, data.companyId as never)
        .maybeSingle();
      if (billErr) throw new Error(billErr.message);
      if (!bill) continue;
      const b = bill as {
        total_minor: number;
        amount_paid_minor: number;
        amount_credited_minor: number;
        status: string;
      };
      if (b.status === "void") continue;
      const amountPaid = Math.max(0, Number(b.amount_paid_minor) - Number(alloc.amount_minor));
      const nextStatus = deriveBillStatus({
        status: b.status === "paid" || b.status === "partly_paid" ? "authorised" : b.status,
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
        .eq("id" as never, alloc.bill_id as never);
    }

    const voidMemo = [
      p.memo,
      data.reason ? `Reversed: ${data.reason}` : "Reversed",
      `by ${userId.slice(0, 8)}`,
    ]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 500);

    await supabase
      .from("supplier_payments" as never)
      .update({
        status: "void",
        memo: voidMemo,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, data.paymentId as never);

    await recordBillAudit(supabase, data.companyId, "supplier_payment.reverse", null, {
      payment_id: data.paymentId,
      void_journal_id: voidJournalId,
      reason: data.reason,
      bill_ids: ((allocs ?? []) as Array<{ bill_id: string }>).map((a) => a.bill_id),
    });

    return { ok: true, voidJournalId };
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
      scheduleOptions?: Record<string, unknown>;
    }) => {
      const name = (input.name ?? "").trim();
      if (!name) throw new Error("Name is required");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.nextDueDate)) throw new Error("Next due date required");
      const scheduleOptions = parseScheduleOptions(input.scheduleOptions ?? {});
      if (
        scheduleOptions.endDate &&
        scheduleOptions.endDate < input.nextDueDate
      ) {
        throw new Error("End date must be on or after the first bill date");
      }
      return {
        companyId: assertUuid(input.companyId),
        contactId: assertUuid(input.contactId, "supplier"),
        name,
        frequency: input.frequency,
        nextDueDate: input.nextDueDate,
        currencyCode: input.currencyCode.toUpperCase(),
        autoAuthorise: Boolean(input.autoAuthorise),
        templateLines: validateBillLines(input.templateLines),
        scheduleOptions,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "purchases.draft");
    if (data.autoAuthorise) {
      await assertCompanyPermission(supabase, data.companyId, "recurring.auto_authorise");
    }
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
          scheduleOptions: data.scheduleOptions,
        },
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const id = (row as { id: string }).id;
    const { ensureV2ForLegacyRecurringBill, patchV2ScheduleFromRecurringBill } = await import(
      "@/lib/recurring/v2-sync"
    );
    await ensureV2ForLegacyRecurringBill(supabase, id);
    await patchV2ScheduleFromRecurringBill(supabase, id);
    return { id };
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
    const { generatePurchaseBillFromRecurring } = await import(
      "@/lib/recurring/generate-purchase-bill"
    );
    return generatePurchaseBillFromRecurring(supabase, userId, data.companyId, data.recurringId, {
      validateBillLines,
      authoriseBill: authoriseBillInternal,
    });
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

// ---- Payment terms ----

export const listPaymentTerms = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await context.supabase
      .from("company_payment_terms" as never)
      .select("id, name, days, calculation_method, is_active" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("is_active" as never, true as never)
      .order("days" as never);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const createPaymentTerm = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      name: string;
      days: number;
      calculationMethod?: string;
    }) => {
      const name = (input.name ?? "").trim();
      if (!name) throw new Error("Payment term name is required");
      const method = input.calculationMethod ?? "days_after_bill_date";
      if (!["days_after_bill_date", "due_on_receipt", "days_after_month_end"].includes(method)) {
        throw new Error("Invalid calculation method");
      }
      return {
        companyId: assertUuid(input.companyId),
        name: name.slice(0, 80),
        days: Math.max(0, Math.min(3650, Math.floor(Number(input.days) || 0))),
        calculationMethod: method,
      };
    },
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.draft");
    const { data: row, error } = await context.supabase
      .from("company_payment_terms" as never)
      .insert({
        company_id: data.companyId,
        name: data.name,
        days: data.days,
        calculation_method: data.calculationMethod,
      } as never)
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") throw new Error("A payment term with this name already exists");
      throw new Error(error.message);
    }
    return { id: (row as { id: string }).id };
  });

// ---- Bill attachments ----

export const listBillAttachments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; billId: string }) => ({
    companyId: assertUuid(input.companyId),
    billId: assertUuid(input.billId, "bill"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const { data: rows, error } = await context.supabase
      .from("document_attachments" as never)
      .select("id, file_name, content_type, size_bytes, created_at, uploaded_by, storage_path" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("entity_type" as never, "purchase_bill" as never)
      .eq("entity_id" as never, data.billId as never)
      .order("created_at" as never, { ascending: false } as never);
    if (error) throw new Error(error.message);
    return ((rows ?? []) as Array<{
      id: string;
      file_name: string;
      content_type: string | null;
      size_bytes: number | null;
      created_at: string;
      uploaded_by: string | null;
      storage_path: string;
    }>).map((r) => ({
      id: r.id,
      file_name: r.file_name,
      content_type: r.content_type,
      size_bytes: r.size_bytes,
      created_at: r.created_at,
      uploaded_by: r.uploaded_by,
      has_content: r.storage_path?.startsWith("inline:") ?? false,
    }));
  });

export const uploadBillAttachment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      billId: string;
      fileName: string;
      contentType?: string;
      contentBase64: string;
      sizeBytes: number;
    }) => {
      const fileName = (input.fileName ?? "").trim().slice(0, 255);
      const sizeBytes = Math.floor(Number(input.sizeBytes) || 0);
      const check = validateAttachmentFile({
        fileName,
        sizeBytes,
        contentType: input.contentType ?? null,
      });
      if (!check.ok) throw new Error(check.error);
      const contentBase64 = (input.contentBase64 ?? "").replace(/\s/g, "");
      if (!contentBase64) throw new Error("File content required");
      // Rough base64 size check
      const approxBytes = Math.floor((contentBase64.length * 3) / 4);
      if (approxBytes > MAX_ATTACHMENT_BYTES) throw new Error("Max file size: 20 MB");
      return {
        companyId: assertUuid(input.companyId),
        billId: assertUuid(input.billId, "bill"),
        fileName,
        contentType: (input.contentType ?? "").trim().slice(0, 120) || null,
        contentBase64,
        sizeBytes,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "purchases.draft");
    const { data: bill } = await supabase
      .from("purchase_bills" as never)
      .select("id" as never)
      .eq("id" as never, data.billId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (!bill) throw new Error("Bill not found");

    const { data: row, error } = await supabase
      .from("document_attachments" as never)
      .insert({
        company_id: data.companyId,
        entity_type: "purchase_bill",
        entity_id: data.billId,
        file_name: data.fileName,
        storage_path: `inline:${data.billId}`,
        content_type: data.contentType,
        size_bytes: data.sizeBytes,
        content_base64: data.contentBase64,
        uploaded_by: userId,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const id = (row as { id: string }).id;
    await supabase
      .from("document_attachments" as never)
      .update({ storage_path: `inline:${id}` } as never)
      .eq("id" as never, id as never);
    await recordBillAudit(supabase, data.companyId, "bill.attachment.upload", data.billId, {
      attachment_id: id,
      file_name: data.fileName,
      size_bytes: data.sizeBytes,
    });
    return { id };
  });

export const downloadBillAttachment = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; attachmentId: string }) => ({
    companyId: assertUuid(input.companyId),
    attachmentId: assertUuid(input.attachmentId),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const { data: row, error } = await context.supabase
      .from("document_attachments" as never)
      .select("id, file_name, content_type, size_bytes, content_base64, entity_type" as never)
      .eq("id" as never, data.attachmentId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Attachment not found");
    const r = row as {
      file_name: string;
      content_type: string | null;
      size_bytes: number | null;
      content_base64: string | null;
      entity_type: string;
    };
    if (r.entity_type !== "purchase_bill") throw new Error("Attachment not found");
    if (!r.content_base64) throw new Error("Attachment content unavailable");
    return {
      fileName: r.file_name,
      contentType: r.content_type,
      sizeBytes: r.size_bytes,
      contentBase64: r.content_base64,
    };
  });

export const deleteBillAttachment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; attachmentId: string }) => ({
    companyId: assertUuid(input.companyId),
    attachmentId: assertUuid(input.attachmentId),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.draft");
    const { data: row } = await context.supabase
      .from("document_attachments" as never)
      .select("id, entity_id, file_name, entity_type" as never)
      .eq("id" as never, data.attachmentId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (!row) throw new Error("Attachment not found");
    const r = row as { entity_id: string; file_name: string; entity_type: string };
    if (r.entity_type !== "purchase_bill") throw new Error("Attachment not found");
    const { error } = await context.supabase
      .from("document_attachments" as never)
      .delete()
      .eq("id" as never, data.attachmentId as never)
      .eq("company_id" as never, data.companyId as never);
    if (error) throw new Error(error.message);
    await recordBillAudit(context.supabase, data.companyId, "bill.attachment.delete", r.entity_id, {
      attachment_id: data.attachmentId,
      file_name: r.file_name,
    });
    return { ok: true };
  });

// ---- Internal notes + activity ----

export const listBillNotes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; billId: string }) => ({
    companyId: assertUuid(input.companyId),
    billId: assertUuid(input.billId, "bill"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const { data: rows, error } = await context.supabase
      .from("bill_internal_notes" as never)
      .select("id, body, created_by, created_at" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("bill_id" as never, data.billId as never)
      .order("created_at" as never, { ascending: false } as never);
    if (error) throw new Error(error.message);
    const notes = (rows ?? []) as Array<{
      id: string;
      body: string;
      created_by: string | null;
      created_at: string;
    }>;
    const names = await lookupActorNames(
      context.supabase,
      notes.map((note) => note.created_by),
    );
    return notes.map((note) => ({
      ...note,
      created_by_name: note.created_by ? (names.get(note.created_by) ?? null) : null,
    }));
  });

export const addBillNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; billId: string; body: string }) => {
    const body = (input.body ?? "").trim();
    if (!body) throw new Error("Note body is required");
    return {
      companyId: assertUuid(input.companyId),
      billId: assertUuid(input.billId, "bill"),
      body: body.slice(0, 4000),
    };
  })
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.draft");
    const { data: row, error } = await context.supabase
      .from("bill_internal_notes" as never)
      .insert({
        company_id: data.companyId,
        bill_id: data.billId,
        body: data.body,
        created_by: context.userId,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    await recordBillAudit(context.supabase, data.companyId, "bill.note.add", data.billId, {
      note_id: (row as { id: string }).id,
      body: data.body,
    });
    return { id: (row as { id: string }).id };
  });

export const listBillActivity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; billId: string }) => ({
    companyId: assertUuid(input.companyId),
    billId: assertUuid(input.billId, "bill"),
  }))
  .handler(async ({ data, context }): Promise<
    Array<{
      id: string;
      action: string;
      created_at: string;
      actor_user_id: string | null;
      actor_name: string | null;
      details: AuditDetails;
    }>
  > => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const eventSelect = "id, action, details, actor_user_id, created_at" as never;
    const { data: rows, error } = await context.supabase
      .from("audit_events" as never)
      .select(eventSelect)
      .eq("company_id" as never, data.companyId as never)
      .eq("entity_type" as never, "purchase_bill" as never)
      .eq("entity_id" as never, data.billId as never)
      .order("created_at" as never, { ascending: false } as never)
      .limit(100);
    if (error) throw new Error(error.message);

    // Payments are stored once, with the bill ids in details, so they still belong in this bill's history.
    const { data: paymentRows, error: paymentError } = await context.supabase
      .from("audit_events" as never)
      .select(eventSelect)
      .eq("company_id" as never, data.companyId as never)
      .eq("entity_type" as never, "purchase_bill" as never)
      .in("action" as never, ["supplier_payment.post", "supplier_payment.reverse"] as never)
      .contains("details" as never, { bill_ids: [data.billId] } as never)
      .order("created_at" as never, { ascending: false } as never)
      .limit(50);
    const linkedPayments = paymentError ? [] : ((paymentRows ?? []) as AuditEventRow[]);

    const { data: allocations, error: allocationError } = await context.supabase
      .from("supplier_payment_allocations" as never)
      .select(
        "payment_id, amount_minor, supplier_payments(id, payment_date, created_at, created_by, status, reference)" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .eq("bill_id" as never, data.billId as never);
    if (allocationError) throw new Error(allocationError.message);
    const allocationRows = (allocations ?? []) as Array<{
      payment_id: string;
      amount_minor: number;
      supplier_payments:
        | {
            payment_date: string;
            created_at: string;
            created_by: string | null;
            status: string;
            reference: string | null;
          }
        | Array<{
            payment_date: string;
            created_at: string;
            created_by: string | null;
            status: string;
            reference: string | null;
          }>
        | null;
    }>;
    const allocated = new Map(allocationRows.map((row) => [row.payment_id, row.amount_minor]));
    const paymentDates = new Map<string, string>();
    for (const allocation of allocationRows) {
      const payment = Array.isArray(allocation.supplier_payments)
        ? allocation.supplier_payments[0]
        : allocation.supplier_payments;
      if (payment?.payment_date) paymentDates.set(allocation.payment_id, payment.payment_date);
    }

    const merged = new Map<string, AuditEventRow>();
    for (const row of [...((rows ?? []) as AuditEventRow[]), ...linkedPayments]) {
      merged.set(row.id, row);
    }
    const events = [...merged.values()].map((row) => {
      const paymentId =
        typeof row.details?.["payment_id"] === "string" ? row.details["payment_id"] : "";
      const allocation = paymentId ? allocated.get(paymentId) : undefined;
      const paymentDate = paymentId ? paymentDates.get(paymentId) : undefined;
      const fullyPaidIds = Array.isArray(row.details?.["fully_paid_bill_ids"])
        ? row.details["fully_paid_bill_ids"].filter((id): id is string => typeof id === "string")
        : null;
      return {
        id: row.id,
        action: row.action,
        created_at: row.created_at,
        actor_user_id: row.actor_user_id,
        details: plainAuditDetails({
          ...(row.details ?? {}),
          ...(allocation == null ? {} : { allocation_minor: allocation }),
          ...(paymentDate ? { payment_date: paymentDate } : {}),
          ...(fullyPaidIds ? { fully_paid: fullyPaidIds.includes(data.billId) } : {}),
        }),
      };
    });
    const seenPaymentIds = new Set(
      events
        .map((event) =>
          typeof event.details["payment_id"] === "string" ? event.details["payment_id"] : "",
        )
        .filter(Boolean),
    );
    for (const allocation of allocationRows) {
      if (seenPaymentIds.has(allocation.payment_id)) continue;
      const payment = Array.isArray(allocation.supplier_payments)
        ? allocation.supplier_payments[0]
        : allocation.supplier_payments;
      if (!payment || payment.status === "draft") continue;
      seenPaymentIds.add(allocation.payment_id);
      events.push({
        id: `payment:${allocation.payment_id}`,
        action: payment.status === "void" ? "supplier_payment.reverse" : "supplier_payment.post",
        created_at: payment.created_at || `${payment.payment_date}T00:00:00.000Z`,
        actor_user_id: payment.created_by,
        details: {
          payment_id: allocation.payment_id,
          allocation_minor: allocation.amount_minor,
          ...(payment.payment_date ? { payment_date: payment.payment_date } : {}),
          ...(payment.reference ? { reference: payment.reference } : {}),
        },
      });
    }
    const names = await lookupActorNames(
      context.supabase,
      events.map((event) => event.actor_user_id),
    );
    return events
      .map((event) => {
        const storedName =
          typeof event.details["actor_name"] === "string" ? event.details["actor_name"].trim() : "";
        return {
          ...event,
          actor_name: (event.actor_user_id ? names.get(event.actor_user_id) : null) || storedName || null,
        };
      })
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  });

export const resolveFxRateForBill = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; currencyCode: string; onDate: string; baseCurrency: string }) => ({
      companyId: assertUuid(input.companyId),
      currencyCode: (input.currencyCode ?? "").toUpperCase().slice(0, 3),
      onDate: String(input.onDate ?? "").slice(0, 10),
      baseCurrency: (input.baseCurrency ?? "").toUpperCase().slice(0, 3),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    if (data.currencyCode === data.baseCurrency) {
      return { rate: 1, source: "base" as const, rateDate: data.onDate };
    }
    const { data: row, error } = await context.supabase
      .from("exchange_rates" as never)
      .select("rate, rate_date, from_currency, to_currency" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("from_currency" as never, data.currencyCode as never)
      .eq("to_currency" as never, data.baseCurrency as never)
      .is("voided_at" as never, null)
      .lte("rate_date" as never, data.onDate as never)
      .order("rate_date" as never, { ascending: false } as never)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) {
      return { rate: null, source: "missing" as const, rateDate: null };
    }
    const r = row as { rate: number; rate_date: string };
    return { rate: Number(r.rate), source: "exchange_rates" as const, rateDate: r.rate_date };
  });

/** Aggregated supplier intelligence for the New Bill right sidebar. */
export const getSupplierIntelligence = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; contactId: string }) => ({
    companyId: assertUuid(input.companyId),
    contactId: assertUuid(input.contactId, "supplier"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const today = new Date().toISOString().slice(0, 10);

    const { data: contact, error: cErr } = await context.supabase
      .from("contacts" as never)
      .select(
        "id, name, email, phone, account_number, default_currency, tax_number, payment_terms_days, billing_address_line1, billing_city, billing_country" as never,
      )
      .eq("id" as never, data.contactId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (cErr) throw new Error(cErr.message);
    if (!contact) throw new Error("Supplier not found");

    const { data: bills, error: bErr } = await context.supabase
      .from("purchase_bills" as never)
      .select(
        "id, bill_number, supplier_invoice_number, bill_date, due_date, status, total_minor, amount_paid_minor, amount_credited_minor, currency_code" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .eq("contact_id" as never, data.contactId as never)
      .neq("status" as never, "void" as never)
      .order("bill_date" as never, { ascending: false } as never)
      .limit(25);
    if (bErr) throw new Error(bErr.message);

    const billRows = (bills ?? []) as Array<{
      id: string;
      bill_number: string | null;
      supplier_invoice_number: string | null;
      bill_date: string;
      due_date: string;
      status: string;
      total_minor: number;
      amount_paid_minor: number;
      amount_credited_minor: number;
      currency_code: string;
    }>;

    let outstandingMinor = 0;
    let overdueMinor = 0;
    let openBillCount = 0;
    const openBills = [];
    for (const b of billRows) {
      if (!["authorised", "partly_paid"].includes(b.status)) continue;
      const o =
        Number(b.total_minor) - Number(b.amount_paid_minor) - Number(b.amount_credited_minor);
      if (o <= 0) continue;
      outstandingMinor += o;
      openBillCount += 1;
      if (b.due_date < today) overdueMinor += o;
      openBills.push({ ...b, outstanding_minor: o });
    }

    const { data: credits } = await context.supabase
      .from("purchase_credit_notes" as never)
      .select(
        "id, credit_number, credit_date, status, total_minor, amount_allocated_minor, currency_code" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .eq("contact_id" as never, data.contactId as never)
      .in("status" as never, ["authorised", "partly_paid"] as never)
      .order("credit_date" as never, { ascending: false } as never)
      .limit(20);

    const creditRows = ((credits ?? []) as Array<{
      id: string;
      credit_number: string | null;
      credit_date: string;
      status: string;
      total_minor: number;
      amount_allocated_minor: number;
      currency_code: string;
    }>).map((c) => ({
      ...c,
      available_minor: Math.max(0, Number(c.total_minor) - Number(c.amount_allocated_minor)),
    }));
    const availableCreditsMinor = creditRows.reduce((s, c) => s + c.available_minor, 0);

    const { data: payments } = await context.supabase
      .from("supplier_payments" as never)
      .select(
        "id, payment_date, amount_minor, unallocated_minor, reference, status, currency_code" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .eq("contact_id" as never, data.contactId as never)
      .order("payment_date" as never, { ascending: false } as never)
      .limit(20);

    const paymentRows = (payments ?? []) as Array<{
      id: string;
      payment_date: string;
      amount_minor: number;
      unallocated_minor: number;
      reference: string | null;
      status: string;
      currency_code?: string;
    }>;
    const unappliedPrepaymentsMinor = paymentRows
      .filter((p) => p.status === "paid" || p.status === "authorised")
      .reduce((s, p) => s + Math.max(0, Number(p.unallocated_minor) || 0), 0);

    const { data: orders } = await context.supabase
      .from("purchase_orders" as never)
      .select("id, order_number, order_date, status, total_minor, currency_code" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("contact_id" as never, data.contactId as never)
      .not("status" as never, "in" as never, "(cancelled,billed)" as never)
      .order("order_date" as never, { ascending: false } as never)
      .limit(10);

    return {
      contact,
      outstandingMinor,
      overdueMinor,
      openBillCount,
      availableCreditsMinor,
      unappliedPrepaymentsMinor,
      recentBills: billRows.slice(0, 12),
      openBills: openBills.slice(0, 12),
      credits: creditRows.filter((c) => c.available_minor > 0),
      payments: paymentRows,
      openOrders: orders ?? [],
    };
  });
