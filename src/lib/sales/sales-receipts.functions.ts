import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { callSalesRpc, requireRpc, type SalesClient } from "@/lib/sales/rpc";
import {
  type ListQuery,
  assertReason,
  isIsoDate,
  loadCompanyDefaults,
  normaliseCurrencyAndFx,
  optionalIsoDate,
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

// ---- list / export ----

const RECEIPT_SORTS = [
  "receipt_date",
  "amount_minor",
  "unallocated_minor",
  "reference",
  "status",
] as const;
const RECEIPT_STATUSES = ["posted", "void"] as const;

type ReceiptListInput = {
  companyId: string;
  status?: string;
  contactId?: string;
  /** Only receipts with money still unallocated. */
  unallocatedOnly?: boolean;
  q?: string;
  from?: string;
  to?: string;
  sort?: string;
  dir?: string;
  page?: number;
  pageSize?: number;
};

function parseReceiptListInput(input: ReceiptListInput) {
  const status = (input.status ?? "").trim();
  return {
    companyId: assertUuid(input.companyId),
    status: (RECEIPT_STATUSES as readonly string[]).includes(status) ? status : null,
    contactId: input.contactId ? assertUuid(input.contactId, "customer") : null,
    unallocatedOnly: Boolean(input.unallocatedOnly),
    q: (input.q ?? "").trim().slice(0, 100),
    from: isIsoDateString(input.from) ? input.from : null,
    to: isIsoDateString(input.to) ? input.to : null,
    sort: pickSort(input.sort, RECEIPT_SORTS, "receipt_date"),
    ascending: input.dir === "asc",
    page: clampPage(input.page),
    pageSize: clampPageSize(input.pageSize),
  };
}

const RECEIPT_LIST_COLUMNS =
  "id, receipt_date, amount_minor, unallocated_minor, status, reference, currency_code, contact_id, contacts(name)";

function applyReceiptFilters(
  q: ListQuery,
  f: ReturnType<typeof parseReceiptListInput>,
  or: string | null,
): ListQuery {
  let out = q.eq("company_id" as never, f.companyId as never);
  if (f.status) out = out.eq("status" as never, f.status as never);
  if (f.contactId) out = out.eq("contact_id" as never, f.contactId as never);
  if (f.unallocatedOnly) {
    out = out.gt("unallocated_minor" as never, 0 as never).eq("status" as never, "posted" as never);
  }
  if (f.from) out = out.gte("receipt_date" as never, f.from as never);
  if (f.to) out = out.lte("receipt_date" as never, f.to as never);
  if (or) out = out.or(or as never);
  return out;
}

async function receiptSearchOr(supabase: SalesClient, f: ReturnType<typeof parseReceiptListInput>) {
  const ids = f.q ? await searchContactIds(supabase, f.companyId, f.q) : [];
  return buildSearchOr(f.q, ["reference", "memo"], ids);
}

export const listReceipts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(parseReceiptListInput)
  .handler(async ({ data: f, context }) => {
    await assertCompanyMember(context.supabase, f.companyId);
    const or = await receiptSearchOr(context.supabase, f);
    const base = context.supabase
      .from("sales_receipts" as never)
      .select(RECEIPT_LIST_COLUMNS as never, { count: "exact" });
    const {
      data: rows,
      error,
      count,
    } = await applyReceiptFilters(base as unknown as ListQuery, f, or)
      .order(f.sort as never, { ascending: f.ascending } as never)
      .order("id" as never, { ascending: true } as never)
      .range(f.page * f.pageSize, f.page * f.pageSize + f.pageSize - 1);
    if (error) throw new Error((error as { message: string }).message);
    const total = count ?? 0;
    return {
      rows: (rows ?? []) as unknown as Array<{
        id: string;
        receipt_date: string;
        amount_minor: number;
        unallocated_minor: number;
        status: string;
        reference: string | null;
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

export const exportReceiptsCsv = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(parseReceiptListInput)
  .handler(async ({ data: f, context }) => {
    await assertCompanyMember(context.supabase, f.companyId);
    const or = await receiptSearchOr(context.supabase, f);
    const defaults = await loadCompanyDefaults(context.supabase, f.companyId);
    const rows = await fetchAllPages<Record<string, unknown>>(
      (from, to) =>
        applyReceiptFilters(
          context.supabase
            .from("sales_receipts" as never)
            .select(RECEIPT_LIST_COLUMNS as never) as unknown as ListQuery,
          f,
          or,
        )
          .order(f.sort as never, { ascending: f.ascending } as never)
          .order("id" as never, { ascending: true } as never)
          .range(from, to) as never,
    );
    const csv = toCsv(
      ["Date", "Reference", "Customer", "Status", "Currency", "Amount", "Unallocated"],
      rows.map((r) => [
        r["receipt_date"],
        r["reference"],
        (r["contacts"] as { name?: string } | null)?.name ?? "",
        r["status"],
        r["currency_code"],
        minorToDecimalString(Number(r["amount_minor"])),
        minorToDecimalString(Number(r["unallocated_minor"])),
      ]),
    );
    return { filename: `receipts-${defaults.today}.csv`, csv, rowCount: rows.length };
  });

// ---- detail ----

export const getReceipt = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; receiptId: string }) => ({
    companyId: assertUuid(input.companyId),
    receiptId: assertUuid(input.receiptId, "receipt"),
  }))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyMember(supabase, data.companyId);
    const { data: row, error } = await supabase
      .from("sales_receipts" as never)
      .select("*, contacts(id, name, email), accounts:bank_account_id(id, code, name)" as never)
      .eq("id" as never, data.receiptId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Receipt not found");

    const rich =
      "id, amount_minor, allocated_on, reversed_on, reverse_reason, invoice_id, sales_invoices(id, invoice_number, invoice_date, status, total_minor, currency_code)";
    const basic =
      "id, amount_minor, invoice_id, sales_invoices(id, invoice_number, invoice_date, status, total_minor, currency_code)";
    let alloc = await supabase
      .from("sales_receipt_allocations" as never)
      .select(rich as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("receipt_id" as never, data.receiptId as never);
    if (alloc.error?.code === "42703") {
      alloc = await supabase
        .from("sales_receipt_allocations" as never)
        .select(basic as never)
        .eq("company_id" as never, data.companyId as never)
        .eq("receipt_id" as never, data.receiptId as never);
    }
    if (alloc.error) throw new Error(alloc.error.message);
    type Alloc = {
      id: string;
      amount_minor: number;
      allocated_on: string | null;
      reversed_on: string | null;
      reverse_reason: string | null;
      invoice_id: string;
      sales_invoices: {
        id: string;
        invoice_number: string | null;
        invoice_date: string;
        status: string;
        total_minor: number;
        currency_code: string;
      } | null;
    };
    const allocs = (alloc.data ?? []) as unknown as Alloc[];
    return {
      receipt: row as unknown as {
        id: string;
        receipt_date: string;
        amount_minor: number;
        unallocated_minor: number;
        status: string;
        reference: string | null;
        memo: string | null;
        currency_code: string;
        contact_id: string;
        bank_account_id: string;
        posted_journal_id: string | null;
        void_journal_id: string | null;
        void_reason: string | null;
        voided_at: string | null;
        void_date: string | null;
        contacts: { id: string; name: string; email: string | null } | null;
        accounts: { id: string; code: string; name: string } | null;
      },
      allocations: allocs.filter((a) => !a.reversed_on),
      reversedAllocations: allocs.filter((a) => Boolean(a.reversed_on)),
    };
  });

// ---- open invoices + deposit picker support ----

/** Every invoice that can still receive a payment for ONE customer (AR-06: no 50-row cap). */
export const listOpenInvoicesForCustomer = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; contactId: string; currencyCode?: string }) => ({
    companyId: assertUuid(input.companyId),
    contactId: assertUuid(input.contactId, "customer"),
    currencyCode: input.currencyCode ? input.currencyCode.toUpperCase().slice(0, 3) : null,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const rows = await fetchAllPages<{
      id: string;
      invoice_number: string | null;
      invoice_date: string;
      due_date: string;
      status: string;
      currency_code: string;
      total_minor: number;
      amount_paid_minor: number;
      amount_credited_minor: number;
    }>((from, to) => {
      let q = context.supabase
        .from("sales_invoices" as never)
        .select(
          "id, invoice_number, invoice_date, due_date, status, currency_code, total_minor, amount_paid_minor, amount_credited_minor" as never,
        )
        .eq("company_id" as never, data.companyId as never)
        .eq("contact_id" as never, data.contactId as never)
        .in("status" as never, ["authorised", "partly_paid"] as never)
        .order("due_date" as never, { ascending: true })
        .order("id" as never, { ascending: true });
      if (data.currencyCode) q = q.eq("currency_code" as never, data.currencyCode as never);
      return q.range(from, to) as never;
    });
    return rows
      .map((r) => ({
        ...r,
        outstanding_minor: r.total_minor - r.amount_paid_minor - r.amount_credited_minor,
      }))
      .filter((r) => r.outstanding_minor > 0);
  });

// ---- record receipt ----

type RecordReceiptInput = {
  companyId: string;
  contactId: string;
  receiptDate: string;
  amountMinor: number;
  bankAccountId: string;
  currencyCode: string;
  fxRateToBase?: number;
  reference?: string;
  memo?: string;
  allocations: Array<{ invoiceId: string; amountMinor: number }>;
};

export const recordReceipt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: RecordReceiptInput) => {
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
    if (new Set(allocations.map((a) => a.invoiceId)).size !== allocations.length) {
      throw new Error("An invoice can only appear once per receipt");
    }
    if (allocations.reduce((s, a) => s + a.amountMinor, 0) > amount) {
      throw new Error("Allocations exceed receipt amount");
    }
    return {
      companyId: assertUuid(input.companyId),
      contactId: assertUuid(input.contactId, "customer"),
      receiptDate: input.receiptDate,
      amountMinor: amount,
      bankAccountId: assertUuid(input.bankAccountId, "bank account"),
      currencyCode: input.currencyCode ?? "",
      fxRateToBase: input.fxRateToBase,
      reference: (input.reference ?? "").trim().slice(0, 80) || null,
      memo: (input.memo ?? "").trim().slice(0, 500) || null,
      allocations,
    };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "sales.payment");
    const defaults = await loadCompanyDefaults(supabase, data.companyId);
    const { currencyCode, fxRateToBase } = normaliseCurrencyAndFx(
      data.currencyCode,
      defaults.baseCurrency,
      data.fxRateToBase,
    );
    if (data.receiptDate > addDays(defaults.today, 1)) {
      // Future-dated receipts are almost always a typo (one day of slack for timezones).
      throw new Error("Receipt date cannot be in the future");
    }

    // One transaction: receipt + bank/AR journal + allocations + invoice status.
    const rpc = await callSalesRpc<{
      receipt_id: string;
      journal_id: string;
      unallocated_minor: number;
    }>(supabase, "record_customer_receipt", {
      company_id: data.companyId,
      contact_id: data.contactId,
      receipt_date: data.receiptDate,
      amount_minor: data.amountMinor,
      bank_account_id: data.bankAccountId,
      currency_code: currencyCode,
      fx_rate_to_base: fxRateToBase,
      reference: data.reference,
      memo: data.memo,
      allocations: data.allocations.map((a) => ({
        invoice_id: a.invoiceId,
        amount_minor: a.amountMinor,
      })),
    });
    const done = requireRpc(
      rpc,
      "record_customer_receipt",
      "20261024110200_sales_ar_receipt_credit_rpcs.sql",
    );
    return {
      id: done.receipt_id,
      journalId: done.journal_id,
      unallocatedMinor: Number(done.unallocated_minor),
    };
  });

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---- corrections (AR-05 / AR-21) — atomic RPCs only; a half-applied reversal is worse than none ----

const CORRECTION_MIGRATION = "20261024110300";

export const unallocateReceipt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      receiptId: string;
      invoiceId?: string;
      reason: string;
      reversalDate?: string;
    }) => ({
      companyId: assertUuid(input.companyId),
      receiptId: assertUuid(input.receiptId, "receipt"),
      invoiceId: input.invoiceId ? assertUuid(input.invoiceId, "invoice") : null,
      reason: assertReason(input.reason, "A reason"),
      reversalDate: optionalIsoDate(input.reversalDate, "Date"),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "sales.payment");
    const res = await callSalesRpc<{ freed_minor: number; allocations_removed: number }>(
      context.supabase,
      "unallocate_customer_receipt",
      {
        company_id: data.companyId,
        receipt_id: data.receiptId,
        invoice_id: data.invoiceId,
        reason: data.reason,
        reversal_date: data.reversalDate,
      },
    );
    const out = requireRpc(res, "unallocate_customer_receipt", CORRECTION_MIGRATION);
    return { freedMinor: Number(out.freed_minor), removed: Number(out.allocations_removed) };
  });

export const voidReceipt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; receiptId: string; reason: string; voidDate?: string }) => ({
      companyId: assertUuid(input.companyId),
      receiptId: assertUuid(input.receiptId, "receipt"),
      reason: assertReason(input.reason, "A void reason"),
      voidDate: optionalIsoDate(input.voidDate, "Void date"),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "sales.void");
    const res = await callSalesRpc<{ void_journal_id: string }>(
      context.supabase,
      "void_customer_receipt",
      {
        company_id: data.companyId,
        receipt_id: data.receiptId,
        reason: data.reason,
        void_date: data.voidDate,
      },
    );
    const out = requireRpc(res, "void_customer_receipt", CORRECTION_MIGRATION);
    return { journalId: out.void_journal_id };
  });
