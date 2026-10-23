import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { deriveBillStatus, sumLines } from "@/lib/purchases/line-math";
import { assertAllocationsAllowed, type AllocatableBill } from "@/lib/purchases/allocation";
import {
  creditRemainingMinor,
  deriveCreditNoteStatus,
  nextBillStatus,
} from "@/lib/purchases/status";
import { buildIlikeOr, escapeLikeTerm, ilikePattern } from "@/lib/purchases/search-terms";
import { isBankOrCashAccount, type AccountCandidate } from "@/lib/purchases/bank-account-rules";
import { dueDateFromBillDate, impliedDiscountMinor } from "@/lib/purchases/po-convert";
import { describeBillEdits, type BillEditSnapshot } from "@/lib/purchases/bill-history";
import { type RecurringTemplateDocument } from "@/lib/purchases/recurring-template";
import {
  computeBillLine,
  MAX_ATTACHMENT_BYTES,
  validateAttachmentFile,
  type TaxCalculationMode,
} from "@/lib/purchases/bill-form-helpers";
import {
  requireAccountInCompany,
  requireBankAccount,
  loadBankGlAccountIds,
} from "@/lib/purchases/accounts";
import {
  insertNewBillLines,
  replaceBillLines,
  isMissingFunctionError,
  adjustBillSettlement,
  restoreBillSettlement,
  type BillLineRow,
  type BillSettlement,
} from "@/lib/purchases/db-safety";
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
  entityType = "purchase_bill",
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
  await (supabase as { rpc: (fn: string, args: Record<string, unknown>) => Promise<unknown> }).rpc(
    "record_audit_event",
    {
      _company_id: companyId,
      _action: action,
      _entity_type: entityType,
      _entity_id: billId,
      _details: actorName ? { ...details, actor_name: actorName } : details,
    },
  );
}

type AuditEventRow = {
  id: string;
  action: string;
  details: Record<string, unknown> | null;
  actor_user_id: string | null;
  created_at: string;
};

type AuditDetails = Record<string, string | number | boolean | null | string[]>;

function plainAuditDetails(details: Record<string, unknown> | null | undefined): AuditDetails {
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
  .inputValidator((input: { companyId: string; q?: string; includeInactive?: boolean }) => ({
    companyId: assertUuid(input.companyId),
    q: (input.q ?? "").trim().slice(0, 100),
    includeInactive: Boolean(input.includeInactive),
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
      .order("name" as never);
    // Settlement screens include inactive suppliers so their open bills can still be paid.
    if (!data.includeInactive) q = q.eq("is_active" as never, true as never);
    if (data.q) q = q.ilike("name" as never, ilikePattern(data.q) as never);
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

export function validateBillLines(
  lines: BillLineIn[],
  taxCalculation: TaxCalculationMode = "exclusive",
) {
  if (!Array.isArray(lines) || lines.length < 1) throw new Error("Add at least one bill line");
  return lines.map((l, i) => {
    const description = (l.description ?? "").trim();
    if (!description) throw new Error(`Line ${i + 1}: description required`);
    if (!l.accountId) throw new Error(`Line ${i + 1}: expense/asset account required`);
    const qty = Number(l.quantity);
    if (!(qty > 0) || !Number.isFinite(qty))
      throw new Error(`Line ${i + 1}: quantity must be positive`);
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
      customerContactId: l.customerContactId ? assertUuid(l.customerContactId, "customer") : null,
      isBillable: Boolean(l.isBillable),
      ...computed,
    };
  });
}

export type BillsWorkspaceTab = "all" | "drafts" | "for_approval" | "to_pay" | "paid" | "recurring";

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

export type ListBillsInput = {
  companyId: string;
  status?: string;
  tab?: BillsWorkspaceTab;
  q?: string;
  fromDate?: string;
  toDate?: string;
  dateField?: "bill_date" | "due_date";
  contactId?: string;
  currencyCode?: string;
  includeVoid?: boolean;
  overdueOnly?: boolean;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
};

function parseListBillsInput(input: ListBillsInput) {
  return {
    companyId: assertUuid(input.companyId),
    status: (input.status ?? "").trim() || undefined,
    tab: input.tab,
    q: (input.q ?? "").trim().slice(0, 100),
    fromDate:
      input.fromDate && /^\d{4}-\d{2}-\d{2}$/.test(input.fromDate) ? input.fromDate : undefined,
    toDate: input.toDate && /^\d{4}-\d{2}-\d{2}$/.test(input.toDate) ? input.toDate : undefined,
    dateField: input.dateField === "due_date" ? ("due_date" as const) : ("bill_date" as const),
    contactId: input.contactId ? assertUuid(input.contactId, "supplier") : undefined,
    currencyCode: /^[A-Za-z]{3}$/.test(input.currencyCode ?? "")
      ? (input.currencyCode as string).toUpperCase()
      : undefined,
    includeVoid: Boolean(input.includeVoid),
    overdueOnly: Boolean(input.overdueOnly),
    limit: Math.min(Math.max(Number(input.limit ?? 50), 1), 200),
    offset: Math.max(Number(input.offset ?? 0), 0),
    sortBy: (input.sortBy ?? "bill_date").slice(0, 40),
    sortDir: input.sortDir === "asc" ? ("asc" as const) : ("desc" as const),
  };
}

async function runListBills(
  supabase: Parameters<typeof assertCompanyPermission>[0],
  data: ReturnType<typeof parseListBillsInput>,
) {
  const today = new Date().toISOString().slice(0, 10);
  const sortCol = ["bill_date", "due_date", "total_minor", "status", "bill_number"].includes(
    data.sortBy,
  )
    ? data.sortBy
    : "bill_date";

  let q = supabase
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
  if (data.currencyCode) q = q.eq("currency_code" as never, data.currencyCode as never);
  if (data.q) {
    // Match bill #, supplier invoice #, memo AND the supplier's name (P-19). The term is
    // quoted/escaped so commas and parentheses cannot break the filter.
    const clauses: string[] = [];
    const textOr = buildIlikeOr(["bill_number", "supplier_invoice_number", "memo"], data.q);
    if (textOr) clauses.push(textOr);
    const { data: supplierMatches, error: supplierErr } = await supabase
      .from("contacts" as never)
      .select("id" as never)
      .eq("company_id" as never, data.companyId as never)
      .ilike("name" as never, ilikePattern(data.q) as never)
      .limit(200);
    if (supplierErr) throw new Error(supplierErr.message);
    const supplierIds = ((supplierMatches ?? []) as Array<{ id: string }>).map((c) => c.id);
    if (supplierIds.length) clauses.push(`contact_id.in.(${supplierIds.join(",")})`);
    if (clauses.length) q = q.or(clauses.join(",") as never);
  }

  const { data: rows, error, count } = await q;
  if (error) throw new Error(error.message);

  const billIds = ((rows ?? []) as Array<{ id: string }>).map((r) => r.id);
  const attachmentCounts: Record<string, number> = {};
  if (billIds.length) {
    const { data: atts } = await supabase
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
      display_reference: r.supplier_invoice_number?.trim() || r.bill_number?.trim() || null,
    };
  });

  return { rows: mapped, totalCount: count ?? mapped.length };
}

export const listBills = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: ListBillsInput) => parseListBillsInput(input))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    return runListBills(context.supabase, data);
  });

const BILLS_CSV_COLUMNS = [
  "Supplier",
  "Reference",
  "Bill date",
  "Due date",
  "Bill number",
  "Supplier invoice number",
  "Status",
  "Currency",
  "Total",
  "Paid",
  "Credited",
  "Balance due",
  "Days overdue",
] as const;

/** Server-side CSV of EVERY bill matching the filters, not just the visible page (P-23). */
export const exportBillsCsv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: ListBillsInput) => parseListBillsInput(input))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const { csvEscape } = await import("@/lib/contacts/contact-helpers");
    const { fromMinorUnits } = await import("@/lib/accounting/money");
    const PAGE = 200;
    const MAX_ROWS = 20000;
    const lines: string[] = [BILLS_CSV_COLUMNS.map(csvEscape).join(",")];
    let offset = 0;
    let total = 0;
    for (;;) {
      const page = await runListBills(context.supabase, { ...data, limit: PAGE, offset });
      total = page.totalCount;
      for (const b of page.rows) {
        const cur = b.currency_code;
        const money = (v: number) => fromMinorUnits(BigInt(v), cur);
        lines.push(
          [
            b.contacts?.name ?? "",
            b.display_reference ?? "",
            b.bill_date,
            b.due_date,
            b.bill_number ?? "",
            b.supplier_invoice_number ?? "",
            b.status,
            cur,
            money(b.total_minor),
            money(b.amount_paid_minor),
            money(b.amount_credited_minor),
            money(b.balance_due_minor),
            b.days_overdue,
          ]
            .map(csvEscape)
            .join(","),
        );
      }
      offset += PAGE;
      if (page.rows.length < PAGE || offset >= total || offset >= MAX_ROWS) break;
    }
    return {
      csv: `${lines.join("\n")}\n`,
      rowCount: lines.length - 1,
      totalCount: total,
      truncated: total > MAX_ROWS,
    };
  });

export type CurrencyTotal = {
  currency: string;
  outstandingMinor: number;
  overdueMinor: number;
  billCount: number;
};

export const getBillsWorkspaceSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({
    companyId: assertUuid(input.companyId),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const today = new Date().toISOString().slice(0, 10);

    const { data: company } = await context.supabase
      .from("companies")
      .select("base_currency")
      .eq("id", data.companyId)
      .maybeSingle();
    const baseCurrency = (company?.base_currency ?? "GBP").toUpperCase();

    // Page through every bill: a single un-ranged select is silently capped by the API row limit.
    type SummaryRow = {
      status: string;
      total_minor: number;
      amount_paid_minor: number;
      amount_credited_minor: number;
      due_date: string;
      currency_code: string | null;
    };
    const rows: SummaryRow[] = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data: page, error } = await context.supabase
        .from("purchase_bills" as never)
        .select(
          "status, total_minor, amount_paid_minor, amount_credited_minor, due_date, currency_code" as never,
        )
        .eq("company_id" as never, data.companyId as never)
        .neq("status" as never, "void" as never)
        .order("id" as never)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const chunk = (page ?? []) as unknown as SummaryRow[];
      rows.push(...chunk);
      if (chunk.length < PAGE) break;
    }

    let drafts = 0;
    let forApproval = 0;
    let toPay = 0;
    let paid = 0;
    let all = 0;
    const byCurrency = new Map<string, CurrencyTotal>();

    for (const r of rows) {
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
        const currency = (r.currency_code ?? baseCurrency).toUpperCase();
        const entry = byCurrency.get(currency) ?? {
          currency,
          outstandingMinor: 0,
          overdueMinor: 0,
          billCount: 0,
        };
        entry.outstandingMinor += bal;
        entry.billCount += 1;
        if (r.due_date < today) entry.overdueMinor += bal;
        byCurrency.set(currency, entry);
      }
    }

    const { count: recurringCount } = await context.supabase
      .from("recurring_bills" as never)
      .select("id" as never, { count: "exact", head: true })
      .eq("company_id" as never, data.companyId as never)
      .eq("is_active" as never, true as never);

    // Never add different currencies together (P-21). The legacy single figures are base-currency only.
    const totalsByCurrency = [...byCurrency.values()].sort((x, y) =>
      x.currency === baseCurrency
        ? -1
        : y.currency === baseCurrency
          ? 1
          : x.currency.localeCompare(y.currency),
    );
    const base = byCurrency.get(baseCurrency);

    return {
      counts: {
        all,
        drafts,
        for_approval: forApproval,
        to_pay: toPay,
        paid,
        recurring: recurringCount ?? 0,
      },
      baseCurrency,
      outstandingMinor: base?.outstandingMinor ?? 0,
      overdueMinor: base?.overdueMinor ?? 0,
      totalsByCurrency,
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
      payment_term_id: string | null;
      due_date_manual_override: boolean | null;
      tax_calculation: string | null;
      duplicate_override: boolean | null;
      supplier_address_line1: string | null;
      supplier_address_line2: string | null;
      supplier_address_city: string | null;
      supplier_address_region: string | null;
      supplier_address_postal: string | null;
      supplier_address_country: string | null;
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
        product_id: string | null;
        tax_code_id: string | null;
        class_option_id: string | null;
        location_option_id: string | null;
        project_option_id: string | null;
        customer_contact_id: string | null;
        is_billable: boolean | null;
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
      payment_term_id: b.payment_term_id ?? null,
      due_date_manual_override: Boolean(b.due_date_manual_override),
      tax_calculation: b.tax_calculation ?? "exclusive",
      duplicate_override: Boolean(b.duplicate_override),
      supplier_address_line1: b.supplier_address_line1 ?? null,
      supplier_address_line2: b.supplier_address_line2 ?? null,
      supplier_address_city: b.supplier_address_city ?? null,
      supplier_address_region: b.supplier_address_region ?? null,
      supplier_address_postal: b.supplier_address_postal ?? null,
      supplier_address_country: b.supplier_address_country ?? null,
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
      display_reference: b.supplier_invoice_number?.trim() || b.bill_number?.trim() || null,
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
      .ilike(
        "supplier_invoice_number" as never,
        escapeLikeTerm(data.supplierInvoiceNumber) as never,
      )
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
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(input.billDate) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)
      ) {
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
        rawLines: input.lines,
        /**
         * Which optional header fields the caller actually sent. When editing an existing
         * bill, anything not sent is left exactly as stored instead of being reset to a
         * default (P-01 / P-02 defence in depth - a partial caller can no longer wipe the
         * tax mode, FX rate, terms, address or duplicate acknowledgement).
         */
        provided: {
          taxCalculation: input.taxCalculation !== undefined,
          paymentTermId: input.paymentTermId !== undefined,
          paymentTermsDays: input.paymentTermsDays !== undefined,
          dueDateManualOverride: input.dueDateManualOverride !== undefined,
          acknowledgeDuplicate: input.acknowledgeDuplicate !== undefined,
          fxRateToBase: input.fxRateToBase !== undefined,
          supplierAddress: input.supplierAddress !== undefined,
        },
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "purchases.draft");
    if (
      data.fxRateToBase != null &&
      (!(data.fxRateToBase > 0) || !Number.isFinite(data.fxRateToBase))
    ) {
      throw new Error("Exchange rate must be a positive number");
    }

    // Validate everything that can be validated BEFORE any write.
    for (const accountId of new Set(data.lines.map((l) => l.accountId))) {
      await requireAccountInCompany(supabase, data.companyId, accountId);
    }
    const { data: supplierRow, error: supplierErr } = await supabase
      .from("contacts" as never)
      .select("id, name" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("id" as never, data.contactId as never)
      .maybeSingle();
    if (supplierErr) throw new Error(supplierErr.message);
    if (!supplierRow) throw new Error("Supplier not found in this organisation");

    type ExistingBill = {
      id: string;
      status: string;
      contact_id: string;
      bill_date: string;
      due_date: string;
      supplier_invoice_number: string | null;
      memo: string | null;
      total_minor: number;
      tax_minor: number;
      currency_code: string;
      tax_calculation: string | null;
    };
    let existing: ExistingBill | null = null;
    let priorHeader: Record<string, unknown> | null = null;
    if (data.billId) {
      const { data: row, error: exErr } = await supabase
        .from("purchase_bills" as never)
        .select("*" as never)
        .eq("id" as never, data.billId as never)
        .eq("company_id" as never, data.companyId as never)
        .maybeSingle();
      if (exErr) throw new Error(exErr.message);
      if (!row) throw new Error("Bill not found");
      priorHeader = row as Record<string, unknown>;
      existing = row as unknown as ExistingBill;
      if (existing.status !== "draft" && existing.status !== "awaiting_approval") {
        throw new Error("Only draft or awaiting-approval bills can be edited");
      }
    }

    // When editing, a caller that did not send the tax mode keeps the stored one.
    const effectiveTaxCalculation: TaxCalculationMode =
      existing && !data.provided.taxCalculation
        ? existing.tax_calculation === "inclusive" || existing.tax_calculation === "none"
          ? existing.tax_calculation
          : "exclusive"
        : data.taxCalculation;
    const lines =
      effectiveTaxCalculation === data.taxCalculation
        ? data.lines
        : validateBillLines(data.rawLines, effectiveTaxCalculation);
    const totals = sumLines(lines);

    const isEdit = Boolean(existing);
    const sends = (key: keyof typeof data.provided) => !isEdit || data.provided[key];
    const headerFields: Record<string, unknown> = {
      contact_id: data.contactId,
      bill_date: data.billDate,
      due_date: data.dueDate,
      supplier_invoice_number: data.supplierInvoiceNumber,
      memo: data.memo,
      currency_code: data.currencyCode,
      tax_calculation: effectiveTaxCalculation,
      subtotal_minor: Number(totals.subtotal_minor),
      tax_minor: Number(totals.tax_minor),
      total_minor: Number(totals.total_minor),
      updated_at: new Date().toISOString(),
    };
    if (sends("paymentTermId")) headerFields["payment_term_id"] = data.paymentTermId;
    if (sends("paymentTermsDays")) headerFields["payment_terms_days"] = data.paymentTermsDays;
    if (sends("dueDateManualOverride")) {
      headerFields["due_date_manual_override"] = data.dueDateManualOverride;
    }
    if (sends("acknowledgeDuplicate"))
      headerFields["duplicate_override"] = data.acknowledgeDuplicate;
    if (sends("fxRateToBase")) headerFields["fx_rate_to_base"] = data.fxRateToBase;
    if (sends("supplierAddress")) {
      headerFields["supplier_address_line1"] = data.supplierAddress.line1;
      headerFields["supplier_address_line2"] = data.supplierAddress.line2;
      headerFields["supplier_address_city"] = data.supplierAddress.city;
      headerFields["supplier_address_region"] = data.supplierAddress.region;
      headerFields["supplier_address_postal"] = data.supplierAddress.postal;
      headerFields["supplier_address_country"] = data.supplierAddress.country;
    }

    const lineRows = (billId: string) =>
      lines.map((l, i) => ({
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

    const duplicateMessage =
      "A bill with this supplier invoice number already exists. Acknowledge the duplicate to continue.";

    if (data.billId && existing && priorHeader) {
      const { data: priorLineRows, error: priorLinesErr } = await supabase
        .from("purchase_bill_lines" as never)
        .select("*" as never)
        .eq("company_id" as never, data.companyId as never)
        .eq("bill_id" as never, data.billId as never)
        .order("line_no" as never);
      if (priorLinesErr) throw new Error(priorLinesErr.message);
      const priorLines = (priorLineRows ?? []) as unknown as Array<{
        description: string;
        quantity: number;
        unit_price_minor: number;
        net_minor: number;
      }>;

      const contactIds = [...new Set([existing.contact_id, data.contactId])];
      const { data: contactRows } = await supabase
        .from("contacts" as never)
        .select("id, name" as never)
        .in("id" as never, contactIds as never);
      const contactNames = new Map(
        ((contactRows ?? []) as Array<{ id: string; name: string }>).map((row) => [
          row.id,
          row.name,
        ]),
      );
      const before: BillEditSnapshot = {
        totalMinor: Number(existing.total_minor),
        taxMinor: Number(existing.tax_minor),
        billDate: existing.bill_date,
        dueDate: existing.due_date,
        supplierInvoiceNumber: existing.supplier_invoice_number,
        memo: existing.memo,
        supplierName: contactNames.get(existing.contact_id) ?? null,
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
      const oldLineKey = priorLines
        .map((line) =>
          [line.description, line.quantity, line.unit_price_minor, line.net_minor].join("|"),
        )
        .sort()
        .join("\n");
      const newLineKey = lines
        .map((line) =>
          [line.description, line.quantity, line.unitPriceMinor, Number(line.net_minor)].join("|"),
        )
        .sort()
        .join("\n");
      const changes = describeBillEdits(
        before,
        after,
        data.currencyCode,
        oldLineKey !== newLineKey,
      );

      const { error: upErr } = await supabase
        .from("purchase_bills" as never)
        .update(headerFields as never)
        .eq("id" as never, data.billId as never)
        .eq("company_id" as never, data.companyId as never);
      if (upErr) {
        if (upErr.message.toLowerCase().includes("duplicate") || upErr.code === "23505") {
          throw new Error(duplicateMessage);
        }
        throw new Error(upErr.message);
      }

      try {
        await replaceBillLines(
          supabase,
          data.companyId,
          data.billId,
          lineRows(data.billId),
          priorLineRows as unknown as BillLineRow[],
        );
      } catch (lineError) {
        // Put the header back so header totals and lines still agree.
        const restore: Record<string, unknown> = {};
        for (const key of Object.keys(headerFields)) restore[key] = priorHeader[key] ?? null;
        await supabase
          .from("purchase_bills" as never)
          .update(restore as never)
          .eq("id" as never, data.billId as never)
          .eq("company_id" as never, data.companyId as never);
        throw lineError;
      }

      await recordBillAudit(supabase, data.companyId, "bill.draft.update", data.billId, {
        total_minor: Number(totals.total_minor),
        previous_total_minor: before.totalMinor,
        line_count: lines.length,
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
        throw new Error(duplicateMessage);
      }
      throw new Error(error.message);
    }
    const billId = (inserted as { id: string }).id;
    await insertNewBillLines(supabase as never, data.companyId, billId, lineRows(billId));
    await recordBillAudit(supabase, data.companyId, "bill.draft.create", billId, {
      bill_number: billNumber,
      total_minor: Number(totals.total_minor),
      line_count: lines.length,
      supplier_name: (supplierRow as { name?: string } | null)?.name ?? "",
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

  // The journal is already posted (idempotent on `purchase_bill:<id>:authorise`). If the status
  // update fails, retry once; if it still fails, say so plainly - clicking Authorise again is safe
  // because the same journal is returned, never a second one.
  let linkError: { message: string } | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: updated, error: upErr } = await supabase
      .from("purchase_bills" as never)
      .update({
        status: "authorised",
        posted_journal_id: journalId,
        authorised_at: new Date().toISOString(),
        authorised_by: userId,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, billId as never)
      .eq("company_id" as never, companyId as never)
      .in("status" as never, ["draft", "awaiting_approval"] as never)
      .select("id");
    linkError = upErr;
    if (!upErr && updated && (updated as unknown[]).length > 0) {
      linkError = null;
      break;
    }
    if (!upErr) linkError = { message: "The bill changed while it was being authorised" };
  }
  if (linkError) {
    throw new Error(
      `The journal was posted but the bill could not be marked authorised (${linkError.message}). Open the bill and click Authorise again - it will not post twice.`,
    );
  }
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
      if (!Number.isInteger(net) || net < 0)
        throw new Error("Net amount must be integer minor units");
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
    // Check every permission BEFORE inserting so staff never leave an orphan draft behind (P-18).
    await assertCompanyPermission(supabase, data.companyId, "expenses.submit");
    if (data.post) await assertCompanyPermission(supabase, data.companyId, "purchases.authorise");
    if (data.expenseAccountId === data.paymentAccountId) {
      throw new Error("The expense account and the paid-from account must be different");
    }
    await requireAccountInCompany(supabase, data.companyId, data.expenseAccountId);
    await requireBankAccount(supabase, data.companyId, data.paymentAccountId);

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
    try {
      const journalId = await postExpenseRecord(supabase, data.companyId, expenseId);
      return { id: expenseId, journalId };
    } catch (postError) {
      throw new Error(
        `The expense was saved as a draft but could not be posted: ${(postError as Error).message}`,
      );
    }
  });

/** Post an existing draft expense. Idempotent per expense (journal key), status update is checked. */
async function postExpenseRecord(
  supabase: Parameters<typeof assertCompanyPermission>[0],
  companyId: string,
  expenseId: string,
): Promise<string> {
  const { data: row, error } = await supabase
    .from("purchase_expenses" as never)
    .select(
      "id, status, expense_date, currency_code, expense_account_id, payment_account_id, net_minor, tax_minor, memo, payee_name" as never,
    )
    .eq("company_id" as never, companyId as never)
    .eq("id" as never, expenseId as never)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw new Error("Expense not found");
  const e = row as unknown as {
    status: string;
    expense_date: string;
    currency_code: string;
    expense_account_id: string;
    payment_account_id: string;
    net_minor: number;
    tax_minor: number;
    memo: string | null;
    payee_name: string;
  };
  if (e.status !== "draft") throw new Error("Only draft expenses can be posted");
  await requireBankAccount(supabase, companyId, e.payment_account_id);
  const journalId = await postDirectExpense(supabase as never, {
    company_id: companyId,
    expense_id: expenseId,
    expense_date: e.expense_date,
    currency_code: e.currency_code,
    expense_account_id: e.expense_account_id,
    payment_account_id: e.payment_account_id,
    net_minor: e.net_minor,
    tax_minor: e.tax_minor,
    memo: e.memo ?? e.payee_name,
  });
  const { data: marked, error: upErr } = await supabase
    .from("purchase_expenses" as never)
    .update({
      status: "paid",
      posted_journal_id: journalId,
      updated_at: new Date().toISOString(),
    } as never)
    .eq("company_id" as never, companyId as never)
    .eq("id" as never, expenseId as never)
    .eq("status" as never, "draft" as never)
    .select("id");
  if (upErr || !marked || (marked as unknown[]).length === 0) {
    throw new Error(
      `The journal was posted but the expense could not be marked paid (${upErr?.message ?? "it changed while saving"}). Open it and click Post again - it will not post twice.`,
    );
  }
  return journalId;
}

export const postDraftExpense = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; expenseId: string }) => ({
    companyId: assertUuid(input.companyId),
    expenseId: assertUuid(input.expenseId, "expense"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.authorise");
    const journalId = await postExpenseRecord(context.supabase, data.companyId, data.expenseId);
    return { journalId };
  });

export const deleteDraftExpense = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; expenseId: string }) => ({
    companyId: assertUuid(input.companyId),
    expenseId: assertUuid(input.expenseId, "expense"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "expenses.submit");
    const { data: removed, error } = await context.supabase
      .from("purchase_expenses" as never)
      .delete()
      .eq("company_id" as never, data.companyId as never)
      .eq("id" as never, data.expenseId as never)
      .eq("status" as never, "draft" as never)
      .is("posted_journal_id" as never, null as never)
      .select("id");
    if (error) throw new Error(error.message);
    if (!removed || (removed as unknown[]).length === 0) {
      throw new Error("Only unposted draft expenses can be deleted");
    }
    return { ok: true };
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
    await requireBankAccount(supabase, data.companyId, data.bankAccountId);

    // 1. Validate everything before writing anything.
    const { data: supplier, error: supplierErr } = await supabase
      .from("contacts" as never)
      .select("id, name" as never)
      .eq("id" as never, data.contactId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (supplierErr) throw new Error(supplierErr.message);
    if (!supplier) throw new Error("Supplier not found in this organisation");

    const billIds = [...new Set(data.allocations.map((a) => a.billId))];
    let billRows: AllocatableBill[] = [];
    if (billIds.length) {
      const { data: rows, error } = await supabase
        .from("purchase_bills" as never)
        .select(
          "id, status, contact_id, currency_code, total_minor, amount_paid_minor, amount_credited_minor" as never,
        )
        .eq("company_id" as never, data.companyId as never)
        .in("id" as never, billIds as never);
      if (error) throw new Error(error.message);
      billRows = (rows ?? []) as unknown as AllocatableBill[];
    }
    assertAllocationsAllowed(billRows, data.allocations, {
      contactId: data.contactId,
      currencyCode: data.currencyCode,
      kind: "payment",
    });

    // 2. Draft payment, then allocations. Every step is checked and undone on failure.
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

    const discardDraftPayment = async () => {
      await supabase
        .from("supplier_payment_allocations" as never)
        .delete()
        .eq("company_id" as never, data.companyId as never)
        .eq("payment_id" as never, paymentId as never);
      await supabase
        .from("supplier_payments" as never)
        .delete()
        .eq("company_id" as never, data.companyId as never)
        .eq("id" as never, paymentId as never)
        .is("posted_journal_id" as never, null as never);
    };

    if (data.allocations.length) {
      const { error: aErr } = await supabase.from("supplier_payment_allocations" as never).insert(
        data.allocations.map((a) => ({
          company_id: data.companyId,
          payment_id: paymentId,
          bill_id: a.billId,
          amount_minor: a.amountMinor,
        })) as never,
      );
      if (aErr) {
        await discardDraftPayment();
        throw new Error(aErr.message);
      }
    }

    // 3. Post the journal (idempotent per payment).
    let journalId: string;
    try {
      journalId = await postSupplierPayment(supabase, {
        company_id: data.companyId,
        payment_id: paymentId,
        payment_date: data.paymentDate,
        currency_code: data.currencyCode,
        bank_account_id: data.bankAccountId,
        amount_minor: data.amountMinor,
        ...(data.memo || data.reference ? { memo: (data.memo ?? data.reference) as string } : {}),
      });
    } catch (postError) {
      await discardDraftPayment();
      throw postError;
    }

    // 4. Apply to the bills with compare-and-set; undo everything (including the journal) on failure.
    const applied: Array<{ billId: string; prev: BillSettlement }> = [];
    const fullyPaidBillIds: string[] = [];
    try {
      for (const alloc of data.allocations) {
        const prev = await adjustBillSettlement(
          supabase,
          data.companyId,
          alloc.billId,
          { paid: alloc.amountMinor },
          nextBillStatus,
        );
        applied.push({ billId: alloc.billId, prev });
      }
      const { data: marked, error: markErr } = await supabase
        .from("supplier_payments" as never)
        .update({
          status: "paid",
          posted_journal_id: journalId,
          updated_at: new Date().toISOString(),
        } as never)
        .eq("company_id" as never, data.companyId as never)
        .eq("id" as never, paymentId as never)
        .select("id");
      if (markErr) throw new Error(markErr.message);
      if (!marked || (marked as unknown[]).length === 0) {
        throw new Error("The payment record could not be marked as posted");
      }
    } catch (applyError) {
      for (const done of applied.reverse()) {
        await restoreBillSettlement(supabase, data.companyId, done.billId, done.prev);
      }
      await voidPostedDocument(supabase, journalId, `supplier_payment:${paymentId}:rollback`).catch(
        () => undefined,
      );
      await supabase
        .from("supplier_payment_allocations" as never)
        .delete()
        .eq("company_id" as never, data.companyId as never)
        .eq("payment_id" as never, paymentId as never);
      await supabase
        .from("supplier_payments" as never)
        .update({
          status: "void",
          posted_journal_id: journalId,
          memo: `Auto-reversed: ${(applyError as Error).message}`.slice(0, 500),
          updated_at: new Date().toISOString(),
        } as never)
        .eq("company_id" as never, data.companyId as never)
        .eq("id" as never, paymentId as never);
      throw new Error(
        `The payment could not be completed and was reversed (${(applyError as Error).message}). Nothing was paid - please try again.`,
      );
    }
    for (const done of applied) {
      const alloc = data.allocations.find((a) => a.billId === done.billId);
      if (!alloc) continue;
      const after = nextBillStatus({
        status: done.prev.status,
        total_minor: billRows.find((b) => b.id === done.billId)?.total_minor ?? 0,
        amount_paid_minor: done.prev.paid + alloc.amountMinor,
        amount_credited_minor: done.prev.credited,
      });
      if (after === "paid") fullyPaidBillIds.push(done.billId);
    }

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
      .select("id, status, posted_journal_id, amount_minor, contact_id, memo, reference" as never)
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

    const allocRows = (allocs ?? []) as Array<{ bill_id: string; amount_minor: number }>;

    // Reverse the bill balances first (compare-and-set). If any bill cannot be restored, undo the
    // ones already done and stop - the ledger has not been touched yet.
    const restoredBills: Array<{ billId: string; prev: BillSettlement }> = [];
    try {
      for (const alloc of allocRows) {
        const { data: billRow, error: billErr } = await supabase
          .from("purchase_bills" as never)
          .select("status" as never)
          .eq("id" as never, alloc.bill_id as never)
          .eq("company_id" as never, data.companyId as never)
          .maybeSingle();
        if (billErr) throw new Error(billErr.message);
        if (!billRow || (billRow as { status: string }).status === "void") continue;
        const prev = await adjustBillSettlement(
          supabase,
          data.companyId,
          alloc.bill_id,
          { paid: -Number(alloc.amount_minor) },
          nextBillStatus,
        );
        restoredBills.push({ billId: alloc.bill_id, prev });
      }
    } catch (restoreError) {
      for (const done of restoredBills.reverse()) {
        await restoreBillSettlement(supabase, data.companyId, done.billId, done.prev);
      }
      throw restoreError;
    }

    let voidJournalId: string;
    try {
      voidJournalId = await voidPostedDocument(
        supabase,
        p.posted_journal_id,
        `supplier_payment:${data.paymentId}:void`,
      );
    } catch (reverseError) {
      for (const done of restoredBills.reverse()) {
        await restoreBillSettlement(supabase, data.companyId, done.billId, done.prev);
      }
      throw reverseError;
    }

    const names = await lookupActorNames(supabase, [userId]);
    const voidMemo = [
      p.memo,
      data.reason ? `Reversed: ${data.reason}` : "Reversed",
      `by ${names.get(userId) ?? "a team member"}`,
    ]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 500);

    const { error: voidErr } = await supabase
      .from("supplier_payments" as never)
      .update({
        status: "void",
        memo: voidMemo,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("id" as never, data.paymentId as never);
    if (voidErr) {
      throw new Error(
        `The payment was reversed in the ledger but its record could not be marked void (${voidErr.message}). Reload and try Reverse again - it will not post twice.`,
      );
    }

    await recordBillAudit(supabase, data.companyId, "supplier_payment.reverse", null, {
      payment_id: data.paymentId,
      void_journal_id: voidJournalId,
      reason: data.reason,
      bill_ids: allocRows.map((a) => a.bill_id),
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

type CreditLineIn = {
  description: string;
  accountId: string;
  netMinor: number;
  taxMinor?: number;
};

function normaliseCreditLines(lines: CreditLineIn[] | undefined) {
  if (!lines?.length) throw new Error("Add at least one credit line");
  return lines.map((l, i) => {
    const description = (l.description ?? "").trim();
    if (!description) throw new Error(`Line ${i + 1}: description required`);
    const net = Number(l.netMinor);
    const tax = Number(l.taxMinor ?? 0);
    if (!Number.isInteger(net) || net < 0) throw new Error(`Line ${i + 1}: invalid net amount`);
    if (!Number.isInteger(tax) || tax < 0) throw new Error(`Line ${i + 1}: invalid tax amount`);
    return {
      description,
      accountId: assertUuid(l.accountId, "account"),
      netMinor: net,
      taxMinor: tax,
    };
  });
}

type SupabaseDb = Parameters<typeof assertCompanyPermission>[0];

async function loadBillsForAllocation(
  supabase: SupabaseDb,
  companyId: string,
  billIds: string[],
): Promise<AllocatableBill[]> {
  if (!billIds.length) return [];
  const { data: rows, error } = await supabase
    .from("purchase_bills" as never)
    .select(
      "id, status, contact_id, currency_code, total_minor, amount_paid_minor, amount_credited_minor" as never,
    )
    .eq("company_id" as never, companyId as never)
    .in("id" as never, [...new Set(billIds)] as never);
  if (error) throw new Error(error.message);
  return (rows ?? []) as unknown as AllocatableBill[];
}

/**
 * Apply part of an authorised credit note to bills. Every step is checked; if any bill cannot be
 * updated, the bills and allocation rows already written are put back and the error is thrown.
 * The credit's own `amount_allocated_minor` / status are updated last.
 */
async function applyCreditAllocations(
  supabase: SupabaseDb,
  companyId: string,
  credit: {
    id: string;
    contact_id: string;
    currency_code: string;
    status: string;
    total_minor: number;
    amount_allocated_minor: number;
  },
  allocations: Array<{ billId: string; amountMinor: number }>,
): Promise<{ allocatedMinor: number; status: string }> {
  if (!["authorised", "partly_paid"].includes(credit.status)) {
    throw new Error("Credit note must be authorised before allocation");
  }
  if (!allocations.length) throw new Error("At least one allocation is required");
  const requested = allocations.reduce((s, a) => s + a.amountMinor, 0);
  const remaining = Number(creditRemainingMinor(credit));
  if (requested > remaining) throw new Error("Allocations exceed the unallocated credit");

  const bills = await loadBillsForAllocation(
    supabase,
    companyId,
    allocations.map((a) => a.billId),
  );
  assertAllocationsAllowed(bills, allocations, {
    contactId: credit.contact_id,
    currencyCode: credit.currency_code,
    kind: "credit",
  });

  const done: Array<{ billId: string; prev: BillSettlement; allocationId: string | null }> = [];
  try {
    for (const alloc of allocations) {
      const { data: row, error: aErr } = await supabase
        .from("purchase_credit_allocations" as never)
        .insert({
          company_id: companyId,
          credit_note_id: credit.id,
          bill_id: alloc.billId,
          amount_minor: alloc.amountMinor,
        } as never)
        .select("id")
        .single();
      if (aErr) {
        if (aErr.code === "23505") throw new Error("Already allocated to this bill");
        throw new Error(aErr.message);
      }
      const allocationId = (row as { id: string }).id;
      const prev = await adjustBillSettlement(
        supabase,
        companyId,
        alloc.billId,
        { credited: alloc.amountMinor },
        nextBillStatus,
      );
      done.push({ billId: alloc.billId, prev, allocationId });
    }
    const allocatedMinor = credit.amount_allocated_minor + requested;
    const status = deriveCreditNoteStatus({
      status: credit.status,
      total_minor: credit.total_minor,
      amount_allocated_minor: allocatedMinor,
    });
    const { data: updated, error: cnErr } = await supabase
      .from("purchase_credit_notes" as never)
      .update({
        amount_allocated_minor: allocatedMinor,
        status,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("company_id" as never, companyId as never)
      .eq("id" as never, credit.id as never)
      .eq("amount_allocated_minor" as never, credit.amount_allocated_minor as never)
      .select("id");
    if (cnErr) throw new Error(cnErr.message);
    if (!updated || (updated as unknown[]).length === 0) {
      throw new Error("The credit note changed while saving. Reload and try again.");
    }
    return { allocatedMinor, status };
  } catch (error) {
    for (const item of done.reverse()) {
      await restoreBillSettlement(supabase, companyId, item.billId, item.prev);
      if (item.allocationId) {
        await supabase
          .from("purchase_credit_allocations" as never)
          .delete()
          .eq("company_id" as never, companyId as never)
          .eq("id" as never, item.allocationId as never);
      }
    }
    // The failed insert (if any) may have created a row that never got a bill update.
    throw error;
  }
}

async function loadCreditNote(supabase: SupabaseDb, companyId: string, creditNoteId: string) {
  const { data, error } = await supabase
    .from("purchase_credit_notes" as never)
    .select(
      "id, status, contact_id, currency_code, credit_date, credit_number, memo, total_minor, amount_allocated_minor, posted_journal_id, purchase_credit_note_lines(*)" as never,
    )
    .eq("id" as never, creditNoteId as never)
    .eq("company_id" as never, companyId as never)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Credit note not found");
  return data as unknown as {
    id: string;
    status: string;
    contact_id: string;
    currency_code: string;
    credit_date: string;
    credit_number: string | null;
    memo: string | null;
    total_minor: number;
    amount_allocated_minor: number;
    posted_journal_id: string | null;
    purchase_credit_note_lines: Array<{
      description: string;
      account_id: string;
      net_minor: number;
      tax_minor: number;
      line_no: number;
    }>;
  };
}

/** Post a draft credit note and (optionally) apply it. Safe to retry: posting is idempotent. */
async function authoriseCreditNoteInternal(
  supabase: SupabaseDb,
  companyId: string,
  creditNoteId: string,
  allocations: Array<{ billId: string; amountMinor: number }>,
): Promise<{ journalId: string; allocatedMinor: number; allocationError: string | null }> {
  await assertCompanyPermission(supabase, companyId, "purchases.authorise");
  const credit = await loadCreditNote(supabase, companyId, creditNoteId);
  if (credit.status !== "draft") throw new Error("Only draft credit notes can be authorised");

  // Validate the allocations BEFORE posting so a bad request never leaves a half-done credit.
  if (allocations.length) {
    const requested = allocations.reduce((s, a) => s + a.amountMinor, 0);
    if (requested > credit.total_minor) throw new Error("Credit allocations exceed credit total");
    const bills = await loadBillsForAllocation(
      supabase,
      companyId,
      allocations.map((a) => a.billId),
    );
    assertAllocationsAllowed(bills, allocations, {
      contactId: credit.contact_id,
      currencyCode: credit.currency_code,
      kind: "credit",
    });
  }

  const journalId = await postCreditNoteAuthorisation(supabase as never, {
    company_id: companyId,
    credit_note_id: creditNoteId,
    credit_date: credit.credit_date,
    currency_code: credit.currency_code,
    ...(credit.memo ? { memo: credit.memo } : {}),
    lines: [...credit.purchase_credit_note_lines]
      .sort((a, b) => a.line_no - b.line_no)
      .map((l) => ({
        account_id: l.account_id,
        description: l.description,
        net_minor: l.net_minor,
        tax_minor: l.tax_minor,
      })),
  });

  const { data: marked, error: markErr } = await supabase
    .from("purchase_credit_notes" as never)
    .update({
      status: "authorised",
      posted_journal_id: journalId,
      updated_at: new Date().toISOString(),
    } as never)
    .eq("company_id" as never, companyId as never)
    .eq("id" as never, creditNoteId as never)
    .eq("status" as never, "draft" as never)
    .select("id");
  if (markErr || !marked || (marked as unknown[]).length === 0) {
    throw new Error(
      `The journal was posted but the credit note could not be marked authorised (${markErr?.message ?? "it changed while saving"}). Open it and click Authorise again - it will not post twice.`,
    );
  }

  let allocatedMinor = 0;
  let allocationError: string | null = null;
  if (allocations.length) {
    try {
      const result = await applyCreditAllocations(
        supabase,
        companyId,
        { ...credit, status: "authorised", amount_allocated_minor: 0 },
        allocations,
      );
      allocatedMinor = result.allocatedMinor;
    } catch (error) {
      // The credit itself is valid and posted; only the application to bills failed.
      allocationError = (error as Error).message;
    }
  }
  await recordBillAudit(
    supabase,
    companyId,
    "credit_note.authorise",
    creditNoteId,
    { journal_id: journalId, allocated_minor: allocatedMinor },
    "purchase_credit_note",
  );
  return { journalId, allocatedMinor, allocationError };
}

export const saveAndAuthoriseCreditNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      contactId: string;
      creditDate: string;
      currencyCode: string;
      memo?: string;
      lines: CreditLineIn[];
      allocations?: Array<{ billId: string; amountMinor: number }>;
      authorise: boolean;
    }) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.creditDate)) throw new Error("Credit date required");
      const lines = normaliseCreditLines(input.lines);
      return {
        companyId: assertUuid(input.companyId),
        contactId: assertUuid(input.contactId, "supplier"),
        creditDate: input.creditDate,
        currencyCode: (input.currencyCode ?? "").toUpperCase(),
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
    if (data.authorise) {
      // Fail before inserting anything if the user may not authorise.
      await assertCompanyPermission(supabase, data.companyId, "purchases.authorise");
    }
    if (!/^[A-Z]{3}$/.test(data.currencyCode)) throw new Error("Currency code required");
    for (const accountId of new Set(data.lines.map((l) => l.accountId))) {
      await requireAccountInCompany(supabase, data.companyId, accountId);
    }
    const subtotal = data.lines.reduce((s, l) => s + l.netMinor, 0);
    const tax = data.lines.reduce((s, l) => s + l.taxMinor, 0);
    const total = subtotal + tax;
    if (total <= 0) throw new Error("Credit total must be greater than zero");
    if (data.allocations.length && !data.authorise) {
      throw new Error("A credit note must be authorised before it can be applied to bills");
    }

    const { data: supplier, error: supplierErr } = await supabase
      .from("contacts" as never)
      .select("id" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("id" as never, data.contactId as never)
      .maybeSingle();
    if (supplierErr) throw new Error(supplierErr.message);
    if (!supplier) throw new Error("Supplier not found in this organisation");

    const { allocateDocumentNumber } = await import("@/lib/settings/document-numbering");
    const creditNumber = await allocateDocumentNumber(
      supabase as never,
      data.companyId,
      "purchase_credit_note",
    );

    const { data: cn, error } = await supabase
      .from("purchase_credit_notes" as never)
      .insert({
        company_id: data.companyId,
        contact_id: data.contactId,
        credit_number: creditNumber,
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
    if (lineErr) {
      await supabase
        .from("purchase_credit_notes" as never)
        .delete()
        .eq("company_id" as never, data.companyId as never)
        .eq("id" as never, creditId as never)
        .eq("status" as never, "draft" as never);
      throw new Error(`Could not save credit note lines: ${lineErr.message}`);
    }

    if (!data.authorise)
      return {
        id: creditId,
        journalId: null as string | null,
        allocationError: null as string | null,
      };

    try {
      const result = await authoriseCreditNoteInternal(
        supabase,
        data.companyId,
        creditId,
        data.allocations,
      );
      return { id: creditId, journalId: result.journalId, allocationError: result.allocationError };
    } catch (authoriseError) {
      throw new Error(
        `The credit note was saved as draft ${creditNumber} but could not be authorised: ${(authoriseError as Error).message}`,
      );
    }
  });

export const authoriseCreditNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      creditNoteId: string;
      allocations?: Array<{ billId: string; amountMinor: number }>;
    }) => ({
      companyId: assertUuid(input.companyId),
      creditNoteId: assertUuid(input.creditNoteId, "credit note"),
      allocations: (input.allocations ?? []).map((a) => ({
        billId: assertUuid(a.billId, "bill"),
        amountMinor: Number(a.amountMinor),
      })),
    }),
  )
  .handler(async ({ data, context }) =>
    authoriseCreditNoteInternal(
      context.supabase,
      data.companyId,
      data.creditNoteId,
      data.allocations,
    ),
  );

export const updateCreditNoteDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      creditNoteId: string;
      contactId: string;
      creditDate: string;
      memo?: string;
      lines: CreditLineIn[];
    }) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.creditDate)) throw new Error("Credit date required");
      return {
        companyId: assertUuid(input.companyId),
        creditNoteId: assertUuid(input.creditNoteId, "credit note"),
        contactId: assertUuid(input.contactId, "supplier"),
        creditDate: input.creditDate,
        memo: (input.memo ?? "").trim().slice(0, 500) || null,
        lines: normaliseCreditLines(input.lines),
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyPermission(supabase, data.companyId, "purchases.draft");
    const credit = await loadCreditNote(supabase, data.companyId, data.creditNoteId);
    if (credit.status !== "draft") throw new Error("Only draft credit notes can be edited");
    for (const accountId of new Set(data.lines.map((l) => l.accountId))) {
      await requireAccountInCompany(supabase, data.companyId, accountId);
    }
    const subtotal = data.lines.reduce((s, l) => s + l.netMinor, 0);
    const tax = data.lines.reduce((s, l) => s + l.taxMinor, 0);
    if (subtotal + tax <= 0) throw new Error("Credit total must be greater than zero");

    const priorLines = credit.purchase_credit_note_lines.map((l) => ({
      company_id: data.companyId,
      credit_note_id: credit.id,
      ...l,
    }));
    const newLines = data.lines.map((l, i) => ({
      company_id: data.companyId,
      credit_note_id: data.creditNoteId,
      line_no: i + 1,
      description: l.description,
      account_id: l.accountId,
      net_minor: l.netMinor,
      tax_minor: l.taxMinor,
    }));
    const { error: delErr } = await supabase
      .from("purchase_credit_note_lines" as never)
      .delete()
      .eq("company_id" as never, data.companyId as never)
      .eq("credit_note_id" as never, data.creditNoteId as never);
    if (delErr) throw new Error(delErr.message);
    const { error: insErr } = await supabase
      .from("purchase_credit_note_lines" as never)
      .insert(newLines as never);
    if (insErr) {
      await supabase.from("purchase_credit_note_lines" as never).insert(priorLines as never);
      throw new Error(`Could not save credit note lines: ${insErr.message}`);
    }
    const { error: upErr } = await supabase
      .from("purchase_credit_notes" as never)
      .update({
        contact_id: data.contactId,
        credit_date: data.creditDate,
        memo: data.memo,
        subtotal_minor: subtotal,
        tax_minor: tax,
        total_minor: subtotal + tax,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("id" as never, data.creditNoteId as never)
      .eq("status" as never, "draft" as never);
    if (upErr) throw new Error(upErr.message);
    return { id: data.creditNoteId };
  });

export const deleteCreditNoteDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; creditNoteId: string }) => ({
    companyId: assertUuid(input.companyId),
    creditNoteId: assertUuid(input.creditNoteId, "credit note"),
  }))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyPermission(supabase, data.companyId, "purchases.draft");
    const credit = await loadCreditNote(supabase, data.companyId, data.creditNoteId);
    if (credit.status !== "draft" || credit.posted_journal_id) {
      throw new Error(
        "Only unposted draft credit notes can be deleted. Void posted credit notes instead.",
      );
    }
    const { error: lineErr } = await supabase
      .from("purchase_credit_note_lines" as never)
      .delete()
      .eq("company_id" as never, data.companyId as never)
      .eq("credit_note_id" as never, data.creditNoteId as never);
    if (lineErr) throw new Error(lineErr.message);
    const { error } = await supabase
      .from("purchase_credit_notes" as never)
      .delete()
      .eq("company_id" as never, data.companyId as never)
      .eq("id" as never, data.creditNoteId as never)
      .eq("status" as never, "draft" as never);
    if (error) throw new Error(error.message);
    await recordBillAudit(
      supabase,
      data.companyId,
      "credit_note.draft.delete",
      data.creditNoteId,
      { credit_number: credit.credit_number },
      "purchase_credit_note",
    );
    return { ok: true };
  });

export type CreditNoteDetail = {
  id: string;
  status: string;
  contact_id: string;
  credit_number: string | null;
  credit_date: string;
  currency_code: string;
  memo: string | null;
  total_minor: number;
  subtotal_minor: number;
  tax_minor: number;
  amount_allocated_minor: number;
  posted_journal_id: string | null;
  contacts: { id: string; name: string; email: string | null } | null;
  purchase_credit_note_lines: Array<{
    id: string;
    description: string;
    account_id: string;
    net_minor: number;
    tax_minor: number;
    line_no: number;
  }>;
  purchase_credit_allocations: Array<{
    id: string;
    bill_id: string;
    amount_minor: number;
    bill_number?: string | null;
    supplier_invoice_number?: string | null;
    bill_status?: string | null;
  }>;
};

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
    const credit = row as unknown as CreditNoteDetail;
    const allocations = credit.purchase_credit_allocations ?? [];
    const billIds = allocations.map((a) => a.bill_id);
    const billLabels = new Map<
      string,
      { bill_number: string | null; supplier_invoice_number: string | null; status: string }
    >();
    if (billIds.length) {
      const { data: bills } = await context.supabase
        .from("purchase_bills" as never)
        .select("id, bill_number, supplier_invoice_number, status" as never)
        .eq("company_id" as never, data.companyId as never)
        .in("id" as never, billIds as never);
      for (const b of (bills ?? []) as Array<{
        id: string;
        bill_number: string | null;
        supplier_invoice_number: string | null;
        status: string;
      }>) {
        billLabels.set(b.id, b);
      }
    }
    const detail: CreditNoteDetail = {
      ...credit,
      purchase_credit_allocations: allocations.map((a) => ({
        ...a,
        bill_number: billLabels.get(a.bill_id)?.bill_number ?? null,
        supplier_invoice_number: billLabels.get(a.bill_id)?.supplier_invoice_number ?? null,
        bill_status: billLabels.get(a.bill_id)?.status ?? null,
      })),
    };
    return detail;
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
    const credit = await loadCreditNote(supabase, data.companyId, data.creditNoteId);
    const result = await applyCreditAllocations(supabase, data.companyId, credit, data.allocations);
    return { allocatedMinor: result.allocatedMinor, status: result.status };
  });

/**
 * Remove credit applied to bills (P-11). With `billId`, only that bill's allocation is removed;
 * otherwise all of them. Bills go back to authorised / partly paid and the credit becomes usable again.
 */
async function unallocateCreditInternal(
  supabase: SupabaseDb,
  companyId: string,
  creditNoteId: string,
  billId: string | null,
): Promise<{ removedMinor: number }> {
  const credit = await loadCreditNote(supabase, companyId, creditNoteId);
  let q = supabase
    .from("purchase_credit_allocations" as never)
    .select("id, bill_id, amount_minor" as never)
    .eq("company_id" as never, companyId as never)
    .eq("credit_note_id" as never, creditNoteId as never);
  if (billId) q = q.eq("bill_id" as never, billId as never);
  const { data: rows, error } = await q;
  if (error) throw new Error(error.message);
  const allocs = (rows ?? []) as Array<{ id: string; bill_id: string; amount_minor: number }>;
  if (!allocs.length) throw new Error("This credit note has no allocations to remove");

  const restored: Array<{ billId: string; prev: BillSettlement }> = [];
  try {
    for (const a of allocs) {
      const prev = await adjustBillSettlement(
        supabase,
        companyId,
        a.bill_id,
        { credited: -Number(a.amount_minor) },
        nextBillStatus,
      );
      restored.push({ billId: a.bill_id, prev });
    }
    const { error: delErr } = await supabase
      .from("purchase_credit_allocations" as never)
      .delete()
      .eq("company_id" as never, companyId as never)
      .in("id" as never, allocs.map((a) => a.id) as never);
    if (delErr) throw new Error(delErr.message);
    const removed = allocs.reduce((s, a) => s + Number(a.amount_minor), 0);
    const nextAllocated = Math.max(0, credit.amount_allocated_minor - removed);
    const { error: cnErr } = await supabase
      .from("purchase_credit_notes" as never)
      .update({
        amount_allocated_minor: nextAllocated,
        status: deriveCreditNoteStatus({
          status: credit.status,
          total_minor: credit.total_minor,
          amount_allocated_minor: nextAllocated,
        }),
        updated_at: new Date().toISOString(),
      } as never)
      .eq("company_id" as never, companyId as never)
      .eq("id" as never, creditNoteId as never);
    if (cnErr) throw new Error(cnErr.message);
    return { removedMinor: removed };
  } catch (error) {
    for (const item of restored.reverse()) {
      await restoreBillSettlement(supabase, companyId, item.billId, item.prev);
    }
    throw error;
  }
}

export const unallocatePurchaseCredit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; creditNoteId: string; billId?: string }) => ({
    companyId: assertUuid(input.companyId),
    creditNoteId: assertUuid(input.creditNoteId, "credit note"),
    billId: input.billId ? assertUuid(input.billId, "bill") : null,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.payment");
    const result = await unallocateCreditInternal(
      context.supabase,
      data.companyId,
      data.creditNoteId,
      data.billId,
    );
    await recordBillAudit(
      context.supabase,
      data.companyId,
      "credit_note.unallocate",
      data.creditNoteId,
      { bill_id: data.billId, removed_minor: result.removedMinor },
      "purchase_credit_note",
    );
    return result;
  });

export const voidPurchaseCreditNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; creditNoteId: string; reason?: string }) => ({
    companyId: assertUuid(input.companyId),
    creditNoteId: assertUuid(input.creditNoteId, "credit note"),
    reason: (input.reason ?? "").trim().slice(0, 500) || null,
  }))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyPermission(supabase, data.companyId, "purchases.authorise");
    const credit = await loadCreditNote(supabase, data.companyId, data.creditNoteId);
    if (credit.status === "void") throw new Error("Credit note is already void");
    if (credit.status === "draft" || !credit.posted_journal_id) {
      throw new Error("Draft credit notes have no ledger entry - delete the draft instead");
    }
    const { data: allocRows, error: allocErr } = await supabase
      .from("purchase_credit_allocations" as never)
      .select("amount_minor" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("credit_note_id" as never, data.creditNoteId as never);
    if (allocErr) throw new Error(allocErr.message);
    const onBills = ((allocRows ?? []) as Array<{ amount_minor: number }>).reduce(
      (s, r) => s + Number(r.amount_minor),
      0,
    );
    if (credit.amount_allocated_minor - onBills > 0) {
      throw new Error(
        "Part of this credit was used by a supplier refund. Void that refund first, then void the credit note.",
      );
    }
    if (onBills > 0) {
      await unallocateCreditInternal(supabase, data.companyId, data.creditNoteId, null);
    }
    const voidJournalId = await voidPostedDocument(
      supabase as never,
      credit.posted_journal_id,
      `purchase_credit_note:${data.creditNoteId}:void`,
    );
    const { error: upErr } = await supabase
      .from("purchase_credit_notes" as never)
      .update({
        status: "void",
        amount_allocated_minor: 0,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("id" as never, data.creditNoteId as never);
    if (upErr) {
      throw new Error(
        `The credit note was reversed in the ledger but could not be marked void (${upErr.message}). Reload and click Void again - it will not post twice.`,
      );
    }
    await recordBillAudit(
      supabase,
      data.companyId,
      "credit_note.void",
      data.creditNoteId,
      { void_journal_id: voidJournalId, reason: data.reason, unallocated_minor: onBills },
      "purchase_credit_note",
    );
    return { voidJournalId };
  });

/**
 * Apply the unallocated part of an on-account / over-payment to bills (P-09).
 * The ledger is unchanged (the payment already debited AP); only the subledger moves.
 */
export const allocateSupplierPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      paymentId: string;
      allocations: Array<{ billId: string; amountMinor: number }>;
    }) => ({
      companyId: assertUuid(input.companyId),
      paymentId: assertUuid(input.paymentId, "payment"),
      allocations: (input.allocations ?? []).map((a) => ({
        billId: assertUuid(a.billId, "bill"),
        amountMinor: Math.round(Number(a.amountMinor)),
      })),
    }),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyPermission(supabase, data.companyId, "purchases.payment");
    if (!data.allocations.length) throw new Error("At least one allocation is required");
    const { data: pay, error } = await supabase
      .from("supplier_payments" as never)
      .select("id, status, contact_id, currency_code, unallocated_minor" as never)
      .eq("id" as never, data.paymentId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!pay) throw new Error("Payment not found");
    const payment = pay as unknown as {
      status: string;
      contact_id: string;
      currency_code: string;
      unallocated_minor: number;
    };
    if (payment.status !== "paid") throw new Error("Only posted payments can be allocated");
    const requested = data.allocations.reduce((s, a) => s + a.amountMinor, 0);
    if (requested > Number(payment.unallocated_minor)) {
      throw new Error("Allocations exceed the unallocated amount on this payment");
    }
    const bills = await loadBillsForAllocation(
      supabase,
      data.companyId,
      data.allocations.map((a) => a.billId),
    );
    assertAllocationsAllowed(bills, data.allocations, {
      contactId: payment.contact_id,
      currencyCode: payment.currency_code,
      kind: "payment",
    });

    const done: Array<{ billId: string; prev: BillSettlement; allocationId: string }> = [];
    try {
      for (const alloc of data.allocations) {
        const { data: row, error: aErr } = await supabase
          .from("supplier_payment_allocations" as never)
          .insert({
            company_id: data.companyId,
            payment_id: data.paymentId,
            bill_id: alloc.billId,
            amount_minor: alloc.amountMinor,
          } as never)
          .select("id")
          .single();
        if (aErr) throw new Error(aErr.message);
        const prev = await adjustBillSettlement(
          supabase,
          data.companyId,
          alloc.billId,
          { paid: alloc.amountMinor },
          nextBillStatus,
        );
        done.push({ billId: alloc.billId, prev, allocationId: (row as { id: string }).id });
      }
      const { data: updated, error: upErr } = await supabase
        .from("supplier_payments" as never)
        .update({
          unallocated_minor: Number(payment.unallocated_minor) - requested,
          updated_at: new Date().toISOString(),
        } as never)
        .eq("company_id" as never, data.companyId as never)
        .eq("id" as never, data.paymentId as never)
        .eq("unallocated_minor" as never, Number(payment.unallocated_minor) as never)
        .select("id");
      if (upErr) throw new Error(upErr.message);
      if (!updated || (updated as unknown[]).length === 0) {
        throw new Error("The payment changed while saving. Reload and try again.");
      }
    } catch (allocError) {
      for (const item of done.reverse()) {
        await restoreBillSettlement(supabase, data.companyId, item.billId, item.prev);
        await supabase
          .from("supplier_payment_allocations" as never)
          .delete()
          .eq("company_id" as never, data.companyId as never)
          .eq("id" as never, item.allocationId as never);
      }
      throw allocError;
    }
    await recordBillAudit(supabase, data.companyId, "supplier_payment.allocate", null, {
      payment_id: data.paymentId,
      allocated_minor: requested,
      bill_ids: data.allocations.map((a) => a.billId),
    });
    return {
      allocatedMinor: requested,
      remainingMinor: Number(payment.unallocated_minor) - requested,
    };
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
    for (const accountId of new Set(data.lines.map((l) => l.accountId))) {
      await requireAccountInCompany(supabase, data.companyId, accountId);
    }
    const { data: supplier, error: supplierErr } = await supabase
      .from("contacts" as never)
      .select("id" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("id" as never, data.contactId as never)
      .maybeSingle();
    if (supplierErr) throw new Error(supplierErr.message);
    if (!supplier) throw new Error("Supplier not found in this organisation");

    const totals = sumLines(data.lines);
    const { allocateDocumentNumber } = await import("@/lib/settings/document-numbering");
    const orderNumber = await allocateDocumentNumber(
      supabase as never,
      data.companyId,
      "purchase_order",
    );
    const { data: po, error } = await supabase
      .from("purchase_orders" as never)
      .insert({
        company_id: data.companyId,
        contact_id: data.contactId,
        order_number: orderNumber,
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
    if (lineErr) {
      await supabase
        .from("purchase_orders" as never)
        .delete()
        .eq("company_id" as never, data.companyId as never)
        .eq("id" as never, orderId as never)
        .eq("status" as never, "draft" as never);
      throw new Error(`Could not save purchase order lines: ${lineErr.message}`);
    }
    return { id: orderId, orderNumber };
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
    const order = po as unknown as {
      status: string;
      order_number: string | null;
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
        line_no?: number;
      }>;
    };
    if (order.billed_bill_id) throw new Error("Purchase order already converted to a bill");
    if (order.status === "cancelled") throw new Error("Cancelled orders cannot be billed");
    if (!order.purchase_order_lines?.length) throw new Error("Purchase order has no lines");

    // Due date follows the supplier's payment terms (not a fixed 30 days).
    const { data: supplier, error: supplierErr } = await supabase
      .from("contacts" as never)
      .select("payment_terms_days" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("id" as never, order.contact_id as never)
      .maybeSingle();
    if (supplierErr) throw new Error(supplierErr.message);
    const termsDays = Number(
      (supplier as { payment_terms_days: number | null } | null)?.payment_terms_days ?? 30,
    );
    const dueDate = dueDateFromBillDate(order.order_date, termsDays);

    const { allocateDocumentNumber } = await import("@/lib/settings/document-numbering");
    const billNumber = await allocateDocumentNumber(
      supabase as never,
      data.companyId,
      "purchase_bill",
    );

    const { data: bill, error: bErr } = await supabase
      .from("purchase_bills" as never)
      .insert({
        company_id: data.companyId,
        contact_id: order.contact_id,
        bill_number: billNumber,
        bill_date: order.order_date,
        due_date: dueDate,
        payment_terms_days: termsDays,
        tax_calculation: "exclusive",
        currency_code: order.currency_code,
        memo:
          order.memo ?? (order.order_number ? `From purchase order ${order.order_number}` : null),
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

    const cleanupBill = async () => {
      await supabase
        .from("purchase_bill_lines" as never)
        .delete()
        .eq("company_id" as never, data.companyId as never)
        .eq("bill_id" as never, billId as never);
      await supabase
        .from("purchase_bills" as never)
        .delete()
        .eq("company_id" as never, data.companyId as never)
        .eq("id" as never, billId as never)
        .eq("status" as never, "draft" as never);
    };

    const { error: lineErr } = await supabase.from("purchase_bill_lines" as never).insert(
      [...order.purchase_order_lines]
        .sort((x, y) => (x.line_no ?? 0) - (y.line_no ?? 0))
        .map((l, i) => ({
          company_id: data.companyId,
          bill_id: billId,
          line_no: i + 1,
          description: l.description,
          account_id: l.account_id,
          quantity: l.quantity,
          unit_price_minor: l.unit_price_minor,
          discount_minor: impliedDiscountMinor(l),
          tax_rate_bps: l.tax_rate_bps,
          net_minor: l.net_minor,
          tax_minor: l.tax_minor,
        })) as never,
    );
    if (lineErr) {
      await cleanupBill();
      throw new Error(`Could not copy the order lines to the bill: ${lineErr.message}`);
    }
    const { data: marked, error: markErr } = await supabase
      .from("purchase_orders" as never)
      .update({
        status: "billed",
        billed_bill_id: billId,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("id" as never, data.orderId as never)
      .is("billed_bill_id" as never, null as never)
      .select("id");
    if (markErr || !marked || (marked as unknown[]).length === 0) {
      await cleanupBill();
      throw new Error(
        markErr?.message ?? "The purchase order changed while converting. Reload and try again.",
      );
    }
    // No ledger posting - draft bill only.
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

export const getRecurringBill = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; recurringId: string }) => ({
    companyId: assertUuid(input.companyId),
    recurringId: assertUuid(input.recurringId, "recurring"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const { data: row, error } = await context.supabase
      .from("recurring_bills" as never)
      .select(
        "id, name, frequency, next_due_date, is_active, auto_authorise, contact_id, currency_code, template" as never,
      )
      .eq("id" as never, data.recurringId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Recurring bill not found");
    return row as {
      id: string;
      name: string;
      frequency: "weekly" | "monthly" | "quarterly" | "yearly";
      next_due_date: string;
      is_active: boolean;
      auto_authorise: boolean;
      contact_id: string;
      currency_code: string;
      template: {
        lines?: BillLineIn[];
        document?: RecurringTemplateDocument | null;
        notify_on_generation?: boolean;
      };
    };
  });

function recurringDocument(
  input: RecurringTemplateDocument | undefined,
  taxCalculation: TaxCalculationMode,
): RecurringTemplateDocument {
  const address = input?.supplierAddress ?? {};
  const notes = (input?.notes ?? [])
    .map((note) => String(note ?? "").trim())
    .filter((note) => note.length > 0 && note.length <= 4000)
    .slice(0, 50);
  const tax =
    input?.taxCalculation === "inclusive" ||
    input?.taxCalculation === "none" ||
    input?.taxCalculation === "exclusive"
      ? input.taxCalculation
      : taxCalculation;
  return {
    billDate:
      input?.billDate && /^\d{4}-\d{2}-\d{2}$/.test(input.billDate) ? input.billDate : undefined,
    dueDate:
      input?.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(input.dueDate) ? input.dueDate : undefined,
    supplierInvoiceNumber: (input?.supplierInvoiceNumber ?? "").trim().slice(0, 80) || null,
    memo: (input?.memo ?? "").trim().slice(0, 2000) || null,
    taxCalculation: tax,
    paymentTermId: input?.paymentTermId || null,
    paymentTermsDays:
      input?.paymentTermsDays == null ? null : Math.floor(Number(input.paymentTermsDays)),
    dueDateManualOverride: Boolean(input?.dueDateManualOverride),
    fxRateToBase: input?.fxRateToBase == null ? null : Number(input.fxRateToBase),
    supplierAddress: {
      line1: (address.line1 ?? "").slice(0, 200),
      line2: (address.line2 ?? "").slice(0, 200),
      city: (address.city ?? "").slice(0, 120),
      region: (address.region ?? "").slice(0, 120),
      postal: (address.postal ?? "").slice(0, 40),
      country: (address.country ?? "").slice(0, 80),
    },
    notes,
  };
}

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
      activate?: boolean;
      notifyOnGeneration?: boolean;
      recurringId?: string | null;
      templateLines: BillLineIn[];
      scheduleOptions?: Record<string, unknown>;
      document?: RecurringTemplateDocument;
      taxCalculation?: TaxCalculationMode;
    }) => {
      const name = (input.name ?? "").trim();
      if (!name) throw new Error("Name is required");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.nextDueDate)) throw new Error("Next due date required");
      const scheduleOptions = parseScheduleOptions(input.scheduleOptions ?? {});
      if (scheduleOptions.endDate && scheduleOptions.endDate < input.nextDueDate) {
        throw new Error("End date must be on or after the first bill date");
      }
      const frequency = input.frequency;
      if (!["weekly", "monthly", "quarterly", "yearly"].includes(frequency)) {
        throw new Error("Frequency is required");
      }
      const taxCalculation = input.document?.taxCalculation || input.taxCalculation || "exclusive";
      return {
        companyId: assertUuid(input.companyId),
        contactId: assertUuid(input.contactId, "supplier"),
        name,
        frequency,
        nextDueDate: input.nextDueDate,
        currencyCode: input.currencyCode.toUpperCase(),
        autoAuthorise: Boolean(input.autoAuthorise),
        activate: input.activate == null ? true : Boolean(input.activate),
        notifyOnGeneration: Boolean(input.notifyOnGeneration),
        recurringId: input.recurringId ? assertUuid(input.recurringId, "recurring") : null,
        templateLines: validateBillLines(input.templateLines, taxCalculation),
        document: recurringDocument(input.document, taxCalculation),
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
    const template = {
      lines: data.templateLines,
      document: data.document,
      notify_on_generation: data.notifyOnGeneration,
      scheduleOptions: data.scheduleOptions,
      subtotal_minor: Number(totals.subtotal_minor),
      tax_minor: Number(totals.tax_minor),
      total_minor: Number(totals.total_minor),
    };
    const rowFields = {
      contact_id: data.contactId,
      name: data.name,
      frequency: data.frequency,
      next_due_date: data.nextDueDate,
      currency_code: data.currencyCode,
      auto_authorise: data.autoAuthorise,
      is_active: data.activate,
      template,
      updated_at: new Date().toISOString(),
    };
    if (data.recurringId) {
      const { data: existing, error: exErr } = await supabase
        .from("recurring_bills" as never)
        .select("id, is_active" as never)
        .eq("id" as never, data.recurringId as never)
        .eq("company_id" as never, data.companyId as never)
        .maybeSingle();
      if (exErr) throw new Error(exErr.message);
      if (!existing) throw new Error("Recurring bill not found");
      const wasActive = Boolean((existing as { is_active: boolean }).is_active);
      const { error } = await supabase
        .from("recurring_bills" as never)
        .update(rowFields as never)
        .eq("id" as never, data.recurringId as never)
        .eq("company_id" as never, data.companyId as never);
      if (error) throw new Error(error.message);
      await recordBillAudit(
        supabase,
        data.companyId,
        "recurring_bill.update",
        data.recurringId,
        {
          name: data.name,
          total_minor: Number(totals.total_minor),
        },
        "recurring_bill",
      );
      if (data.activate && !wasActive) {
        await recordBillAudit(
          supabase,
          data.companyId,
          "recurring_bill.activate",
          data.recurringId,
          {
            name: data.name,
          },
          "recurring_bill",
        );
      }
      if (!data.activate && wasActive) {
        await recordBillAudit(
          supabase,
          data.companyId,
          "recurring_bill.pause",
          data.recurringId,
          {
            name: data.name,
          },
          "recurring_bill",
        );
      }
      return { id: data.recurringId, notes: data.document.notes ?? [] };
    }
    const { data: row, error } = await supabase
      .from("recurring_bills" as never)
      .insert({
        ...rowFields,
        company_id: data.companyId,
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const id = (row as { id: string }).id;
    const { ensureV2ForLegacyRecurringBill, patchV2ScheduleFromRecurringBill } =
      await import("@/lib/recurring/v2-sync");
    await ensureV2ForLegacyRecurringBill(supabase, id);
    await patchV2ScheduleFromRecurringBill(supabase, id);
    await recordBillAudit(
      supabase,
      data.companyId,
      "recurring_bill.create",
      id,
      {
        name: data.name,
        total_minor: Number(totals.total_minor),
      },
      "recurring_bill",
    );
    if (data.activate) {
      await recordBillAudit(
        supabase,
        data.companyId,
        "recurring_bill.activate",
        id,
        {
          name: data.name,
        },
        "recurring_bill",
      );
    }
    return { id, notes: data.document.notes ?? [] };
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
    const { generatePurchaseBillFromRecurring } =
      await import("@/lib/recurring/generate-purchase-bill");
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
    // Claims are personal: only people who can approve them (or see all purchases) see every claim.
    const { data: canReview } = await context.supabase.rpc("has_company_permission", {
      _company_id: data.companyId,
      _permission: "expenses.approve",
    });
    let q = context.supabase
      .from("employee_expense_claims" as never)
      .select(
        "id, claim_date, description, amount_minor, tax_minor, status, currency_code, claimant_user_id" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("claim_date" as never, { ascending: false } as never)
      .limit(200);
    if (!canReview) q = q.eq("claimant_user_id" as never, context.userId as never);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    const list = (rows ?? []) as unknown as Array<{ claimant_user_id: string }>;
    const names = await lookupActorNames(
      context.supabase,
      list.map((r) => r.claimant_user_id),
    );
    return list.map((r) => ({
      ...r,
      claimant_name: names.get(r.claimant_user_id) ?? null,
      is_mine: r.claimant_user_id === context.userId,
    })) as unknown as Array<
      Record<string, never> & {
        id: string;
        claim_date: string;
        description: string;
        amount_minor: number;
        tax_minor: number;
        status: string;
        currency_code: string;
        claimant_user_id: string;
        claimant_name: string | null;
        is_mine: boolean;
      }
    >;
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
      // `amountMinor` is the net amount; `taxMinor` is recoverable VAT added on top of it.
      const taxMinor = Number(input.taxMinor ?? 0);
      if (!Number.isInteger(taxMinor) || taxMinor < 0) {
        throw new Error("Tax must be a whole number of minor units, zero or more");
      }
      if (taxMinor > amountMinor) throw new Error("Tax cannot be more than the net amount");
      return {
        companyId: assertUuid(input.companyId),
        claimDate: input.claimDate,
        description,
        expenseAccountId: assertUuid(input.expenseAccountId, "account"),
        currencyCode: input.currencyCode.toUpperCase(),
        amountMinor,
        taxMinor,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "expenses.submit");
    await requireAccountInCompany(supabase, data.companyId, data.expenseAccountId);
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
  .inputValidator((input: { companyId: string; claimId: string; paymentAccountId: string }) => ({
    companyId: assertUuid(input.companyId),
    claimId: assertUuid(input.claimId, "claim"),
    paymentAccountId: assertUuid(input.paymentAccountId, "payment account"),
  }))
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
      claimant_user_id: string;
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
    if (c.claimant_user_id === userId) {
      throw new Error("You cannot approve your own expense claim. Ask another approver.");
    }
    await requireBankAccount(supabase, data.companyId, data.paymentAccountId);

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

    const { data: marked, error: markErr } = await supabase
      .from("employee_expense_claims" as never)
      .update({
        status: "reimbursed",
        posted_journal_id: journalId,
        reviewed_by: userId,
        reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("id" as never, data.claimId as never)
      .eq("status" as never, "submitted" as never)
      .select("id");
    if (markErr || !marked || (marked as unknown[]).length === 0) {
      throw new Error(
        `The reimbursement was posted but the claim could not be marked reimbursed (${markErr?.message ?? "it changed while saving"}). Click Approve again - it will not post twice.`,
      );
    }

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
    await recordBillAudit(
      context.supabase,
      data.companyId,
      data.isActive ? "recurring_bill.resume" : "recurring_bill.pause",
      data.recurringId,
      { is_active: data.isActive },
      "recurring_bill",
    );
    return row as { id: string; is_active: boolean };
  });

export const deleteRecurringBill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; recurringId: string }) => ({
    companyId: assertUuid(input.companyId),
    recurringId: assertUuid(input.recurringId, "recurring"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.draft");
    const { data: existing, error: exErr } = await context.supabase
      .from("recurring_bills" as never)
      .select("id, name" as never)
      .eq("id" as never, data.recurringId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (exErr) throw new Error(exErr.message);
    if (!existing) throw new Error("Recurring bill not found");
    await recordBillAudit(
      context.supabase,
      data.companyId,
      "recurring_bill.delete",
      data.recurringId,
      {
        name: (existing as { name: string }).name,
      },
      "recurring_bill",
    );
    const { error } = await context.supabase
      .from("recurring_bills" as never)
      .delete()
      .eq("id" as never, data.recurringId as never)
      .eq("company_id" as never, data.companyId as never);
    if (error) throw new Error(error.message);
    return { id: data.recurringId };
  });

export const rejectEmployeeClaim = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; claimId: string }) => ({
    companyId: assertUuid(input.companyId),
    claimId: assertUuid(input.claimId),
  }))
  .handler(async ({ data, context }) => {
    // Same permission as approving, so anyone who can approve can also reject.
    await assertCompanyPermission(context.supabase, data.companyId, "expenses.approve");
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
  .inputValidator(
    (input: {
      companyId: string;
      contactId: string;
      from?: string;
      to?: string;
      asOf?: string;
      currencyCode?: string;
    }) => ({
      currencyCode: /^[A-Za-z]{3}$/.test(input.currencyCode ?? "")
        ? (input.currencyCode as string).toUpperCase()
        : null,
      companyId: assertUuid(input.companyId),
      contactId: assertUuid(input.contactId, "supplier"),
      from: input.from && /^\d{4}-\d{2}-\d{2}$/.test(input.from) ? input.from : null,
      to: input.to && /^\d{4}-\d{2}-\d{2}$/.test(input.to) ? input.to : null,
      asOf:
        input.asOf && /^\d{4}-\d{2}-\d{2}$/.test(input.asOf)
          ? input.asOf
          : new Date().toISOString().slice(0, 10),
    }),
  )
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
    const { data: billsAll, error } = await billQ;
    if (error) throw new Error(error.message);

    let payQ = context.supabase
      .from("supplier_payments" as never)
      .select(
        "id, payment_date, amount_minor, unallocated_minor, reference, status, currency_code" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .eq("contact_id" as never, data.contactId as never)
      .eq("status" as never, "paid" as never)
      .lte("payment_date" as never, data.asOf as never)
      .order("payment_date" as never);
    if (data.from) payQ = payQ.gte("payment_date" as never, data.from as never);
    if (data.to) payQ = payQ.lte("payment_date" as never, data.to as never);
    const { data: paymentsAll, error: pErr } = await payQ;
    if (pErr) throw new Error(pErr.message);

    let cnQ = context.supabase
      .from("purchase_credit_notes" as never)
      .select(
        "id, credit_date, credit_number, status, total_minor, amount_allocated_minor, currency_code" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .eq("contact_id" as never, data.contactId as never)
      .neq("status" as never, "void" as never)
      .neq("status" as never, "draft" as never)
      .lte("credit_date" as never, data.asOf as never)
      .order("credit_date" as never);
    if (data.from) cnQ = cnQ.gte("credit_date" as never, data.from as never);
    if (data.to) cnQ = cnQ.lte("credit_date" as never, data.to as never);
    const { data: creditNotesAll, error: cErr } = await cnQ;
    if (cErr) throw new Error(cErr.message);

    // A statement is in ONE currency: amounts in different currencies are never netted together.
    const baseCur = await (async () => {
      const { data: co } = await context.supabase
        .from("companies")
        .select("base_currency")
        .eq("id", data.companyId)
        .maybeSingle();
      return (co?.base_currency ?? "GBP").toUpperCase();
    })();
    const cur = (c: string | null | undefined) => (c ?? baseCur).toUpperCase();
    const availableCurrencies = [
      ...new Set([
        ...((billsAll ?? []) as Array<{ currency_code: string | null }>).map((r) =>
          cur(r.currency_code),
        ),
        ...((paymentsAll ?? []) as Array<{ currency_code: string | null }>).map((r) =>
          cur(r.currency_code),
        ),
        ...((creditNotesAll ?? []) as Array<{ currency_code: string | null }>).map((r) =>
          cur(r.currency_code),
        ),
      ]),
    ];
    const statementCurrency =
      data.currencyCode ??
      (availableCurrencies.includes(baseCur) ? baseCur : (availableCurrencies[0] ?? baseCur));
    const bills = ((billsAll ?? []) as Array<{ currency_code: string | null }>).filter(
      (r) => cur(r.currency_code) === statementCurrency,
    ) as typeof billsAll;
    const payments = ((paymentsAll ?? []) as Array<{ currency_code: string | null }>).filter(
      (r) => cur(r.currency_code) === statementCurrency,
    ) as typeof paymentsAll;
    const creditNotes = ((creditNotesAll ?? []) as Array<{ currency_code: string | null }>).filter(
      (r) => cur(r.currency_code) === statementCurrency,
    ) as typeof creditNotesAll;

    // Opening balance: everything dated before the statement period starts (P-24).
    let openingBalanceMinor = 0;
    if (data.from) {
      const sumCol = (rows: unknown, col: string) =>
        ((rows ?? []) as Array<Record<string, number | string | null>>)
          .filter((r) => cur(r["currency_code"] as string | null) === statementCurrency)
          .reduce((n, r) => n + Number(r[col] ?? 0), 0);
      const [priorBills, priorPays, priorCns] = await Promise.all([
        context.supabase
          .from("purchase_bills" as never)
          .select("total_minor, currency_code" as never)
          .eq("company_id" as never, data.companyId as never)
          .eq("contact_id" as never, data.contactId as never)
          .not("status" as never, "in" as never, "(void,draft)" as never)
          .lt("bill_date" as never, data.from as never),
        context.supabase
          .from("supplier_payments" as never)
          .select("amount_minor, currency_code" as never)
          .eq("company_id" as never, data.companyId as never)
          .eq("contact_id" as never, data.contactId as never)
          .eq("status" as never, "paid" as never)
          .lt("payment_date" as never, data.from as never),
        context.supabase
          .from("purchase_credit_notes" as never)
          .select("total_minor, currency_code" as never)
          .eq("company_id" as never, data.companyId as never)
          .eq("contact_id" as never, data.contactId as never)
          .not("status" as never, "in" as never, "(void,draft)" as never)
          .lt("credit_date" as never, data.from as never),
      ]);
      if (priorBills.error) throw new Error(priorBills.error.message);
      if (priorPays.error) throw new Error(priorPays.error.message);
      if (priorCns.error) throw new Error(priorCns.error.message);
      openingBalanceMinor =
        sumCol(priorBills.data, "total_minor") -
        sumCol(priorPays.data, "amount_minor") -
        sumCol(priorCns.data, "total_minor");
    }

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
    let running = openingBalanceMinor;
    const lines = timeline.map((t) => {
      running += t.debit_minor - t.credit_minor;
      return { ...t, balance_minor: running };
    });

    const rows = (
      (bills ?? []) as Array<{
        id: string;
        bill_date: string;
        due_date: string;
        status: string;
        total_minor: number;
        amount_paid_minor: number;
        amount_credited_minor: number;
        supplier_invoice_number: string | null;
        currency_code: string;
      }>
    ).map((b) => ({
      ...b,
      outstanding_minor: b.total_minor - b.amount_paid_minor - b.amount_credited_minor,
    }));
    const open = rows.filter((r) => r.outstanding_minor > 0 && r.status !== "draft");
    const unappliedCredits = (
      (creditNotes ?? []) as Array<{
        total_minor: number;
        amount_allocated_minor: number;
        status: string;
      }>
    )
      .filter((c) => ["authorised", "partly_paid"].includes(c.status))
      .reduce((s, c) => s + (c.total_minor - c.amount_allocated_minor), 0);
    const unappliedPayments = ((payments ?? []) as Array<{ unallocated_minor: number }>).reduce(
      (s, p) => s + (p.unallocated_minor ?? 0),
      0,
    );

    return {
      asOf: data.asOf,
      currencyCode: statementCurrency,
      availableCurrencies,
      bills: rows,
      payments: payments ?? [],
      creditNotes: creditNotes ?? [],
      lines,
      openingBalanceMinor,
      closingBalanceMinor: running,
      openBalanceMinor: open.reduce((s, r) => s + r.outstanding_minor, 0),
      unappliedCreditMinor: unappliedCredits,
      unappliedPaymentMinor: unappliedPayments,
    };
  });

// ---- Paid-from accounts ----

export const listPaymentAccounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await context.supabase
      .from("accounts" as never)
      .select(
        "id, code, name, account_type, is_active, is_postable, archived_at, account_kind, subtype, is_payment_enabled, currency_code" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .eq("account_type" as never, "asset" as never)
      .eq("is_active" as never, true as never)
      .eq("is_postable" as never, true as never)
      .order("code" as never);
    if (error) throw new Error(error.message);
    const bankIds = await loadBankGlAccountIds(context.supabase, data.companyId);
    return (
      (rows ?? []) as unknown as Array<
        AccountCandidate & { code: string; name: string; currency_code: string | null }
      >
    )
      .filter((a) => isBankOrCashAccount(a, bankIds))
      .map((a) => ({
        id: a.id,
        code: a.code,
        name: a.name,
        currency_code: a.currency_code ?? null,
      }));
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
    (input: { companyId: string; name: string; days: number; calculationMethod?: string }) => {
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
  .inputValidator((input: { companyId: string; billId: string; entityType?: string }) => ({
    companyId: assertUuid(input.companyId),
    billId: assertUuid(input.billId, "document"),
    entityType: input.entityType === "recurring_bill" ? "recurring_bill" : "purchase_bill",
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "purchases.view");
    const { data: rows, error } = await context.supabase
      .from("document_attachments" as never)
      .select(
        "id, file_name, content_type, size_bytes, created_at, uploaded_by, storage_path" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .eq("entity_type" as never, data.entityType as never)
      .eq("entity_id" as never, data.billId as never)
      .order("created_at" as never, { ascending: false } as never);
    if (error) throw new Error(error.message);
    return (
      (rows ?? []) as Array<{
        id: string;
        file_name: string;
        content_type: string | null;
        size_bytes: number | null;
        created_at: string;
        uploaded_by: string | null;
        storage_path: string;
      }>
    ).map((r) => ({
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
      entityType?: string;
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
        billId: assertUuid(input.billId, "document"),
        fileName,
        contentType: (input.contentType ?? "").trim().slice(0, 120) || null,
        contentBase64,
        sizeBytes,
        entityType: input.entityType === "recurring_bill" ? "recurring_bill" : "purchase_bill",
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "purchases.draft");
    const ownerTable = data.entityType === "recurring_bill" ? "recurring_bills" : "purchase_bills";
    const { data: bill } = await supabase
      .from(ownerTable as never)
      .select("id" as never)
      .eq("id" as never, data.billId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (!bill)
      throw new Error(
        data.entityType === "recurring_bill" ? "Recurring bill not found" : "Bill not found",
      );

    const { data: row, error } = await supabase
      .from("document_attachments" as never)
      .insert({
        company_id: data.companyId,
        entity_type: data.entityType,
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
    await recordBillAudit(
      supabase,
      data.companyId,
      data.entityType === "recurring_bill"
        ? "recurring_bill.attachment.upload"
        : "bill.attachment.upload",
      data.billId,
      {
        attachment_id: id,
        file_name: data.fileName,
        size_bytes: data.sizeBytes,
      },
      data.entityType,
    );
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
    if (r.entity_type !== "purchase_bill" && r.entity_type !== "recurring_bill") {
      throw new Error("Attachment not found");
    }
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
    if (r.entity_type !== "purchase_bill" && r.entity_type !== "recurring_bill") {
      throw new Error("Attachment not found");
    }
    const { error } = await context.supabase
      .from("document_attachments" as never)
      .delete()
      .eq("id" as never, data.attachmentId as never)
      .eq("company_id" as never, data.companyId as never);
    if (error) throw new Error(error.message);
    await recordBillAudit(
      context.supabase,
      data.companyId,
      r.entity_type === "recurring_bill"
        ? "recurring_bill.attachment.delete"
        : "bill.attachment.delete",
      r.entity_id,
      {
        attachment_id: data.attachmentId,
        file_name: r.file_name,
      },
      r.entity_type,
    );
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
  .inputValidator((input: { companyId: string; billId: string; entityType?: string }) => ({
    companyId: assertUuid(input.companyId),
    billId: assertUuid(input.billId, "document"),
    entityType: input.entityType === "recurring_bill" ? "recurring_bill" : "purchase_bill",
  }))
  .handler(
    async ({
      data,
      context,
    }): Promise<
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
        .eq("entity_type" as never, data.entityType as never)
        .eq("entity_id" as never, data.billId as never)
        .order("created_at" as never, { ascending: false } as never)
        .limit(100);
      if (error) throw new Error(error.message);

      // Payments are stored once, with the bill ids in details, so they still belong in this bill's history.
      const paymentQuery =
        data.entityType === "purchase_bill"
          ? await context.supabase
              .from("audit_events" as never)
              .select(eventSelect)
              .eq("company_id" as never, data.companyId as never)
              .eq("entity_type" as never, "purchase_bill" as never)
              .in("action" as never, ["supplier_payment.post", "supplier_payment.reverse"] as never)
              .contains("details" as never, { bill_ids: [data.billId] } as never)
              .order("created_at" as never, { ascending: false } as never)
              .limit(50)
          : { data: null, error: null };
      const paymentRows = paymentQuery.data;
      const paymentError = paymentQuery.error;
      const linkedPayments = paymentError ? [] : ((paymentRows ?? []) as AuditEventRow[]);

      const allocationQuery =
        data.entityType === "purchase_bill"
          ? await context.supabase
              .from("supplier_payment_allocations" as never)
              .select(
                "payment_id, amount_minor, supplier_payments(id, payment_date, created_at, created_by, status, reference)" as never,
              )
              .eq("company_id" as never, data.companyId as never)
              .eq("bill_id" as never, data.billId as never)
          : { data: null, error: null };
      const allocations = allocationQuery.data;
      const allocationError = allocationQuery.error;
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
            typeof event.details["actor_name"] === "string"
              ? event.details["actor_name"].trim()
              : "";
          return {
            ...event,
            actor_name:
              (event.actor_user_id ? names.get(event.actor_user_id) : null) || storedName || null,
          };
        })
        .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    },
  );

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

    const creditRows = (
      (credits ?? []) as Array<{
        id: string;
        credit_number: string | null;
        credit_date: string;
        status: string;
        total_minor: number;
        amount_allocated_minor: number;
        currency_code: string;
      }>
    ).map((c) => ({
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
