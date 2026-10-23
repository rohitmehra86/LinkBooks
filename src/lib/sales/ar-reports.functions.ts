/**
 * Accounts-receivable reports built from DATED events (AR-08, AR-26).
 *
 * getAgedReceivablesAsAt replaces accounting.getAgedReceivables for the Reports centre:
 *  - outstanding at the as-at date is rebuilt from allocation dates (not today's paid amounts);
 *  - unapplied receipts and unapplied credit notes appear as negative lines;
 *  - amounts are never summed across currencies;
 *  - every table is read in pages, so >1000 documents no longer understates the report.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { fetchAllPages } from "@/lib/sales/fetch-all";
import { resolveArAccount } from "@/lib/sales/ar-accounts";
import {
  buildAgedReceivablesAsAt,
  type AsAtAllocation,
  type AsAtCreditNote,
  type AsAtInvoice,
  type AsAtReceipt,
} from "@/lib/sales/ar-asat";
import { isIsoDateString } from "@/lib/sales/list-filters";
import { loadCompanyDefaults } from "@/lib/sales/sales-common";
import type { SalesClient } from "@/lib/sales/rpc";

type Q = {
  eq(c: never, v: never): Q;
  lte(c: never, v: never): Q;
  neq(c: never, v: never): Q;
  order(c: never, o?: never): Q;
  range(
    a: number,
    b: number,
  ): PromiseLike<{ data: unknown[] | null; error: { message: string; code?: string } | null }>;
};

/** Paged select that retries with a narrower column list on databases missing newer columns. */
async function pagedWithFallback<T>(
  supabase: SalesClient,
  table: string,
  rich: string,
  basic: string,
  filter: (q: Q) => Q,
): Promise<T[]> {
  const run = (cols: string) =>
    fetchAllPages<T>(
      (from, to) =>
        filter(supabase.from(table as never).select(cols as never) as unknown as Q)
          .order("id" as never)
          .range(from, to) as never,
    );
  try {
    return await run(rich);
  } catch (e) {
    if (e instanceof Error && /column .* does not exist/i.test(e.message)) return run(basic);
    throw e;
  }
}

export async function loadArAsAtInputs(supabase: SalesClient, companyId: string, asOf: string) {
  const invoices = await pagedWithFallback<{
    id: string;
    contact_id: string;
    invoice_number: string | null;
    currency_code: string;
    invoice_date: string;
    due_date: string;
    total_minor: number;
    status: string;
    void_date?: string | null;
    contacts: { name: string } | null;
  }>(
    supabase,
    "sales_invoices",
    "id, contact_id, invoice_number, currency_code, invoice_date, due_date, total_minor, status, void_date, contacts(name)",
    "id, contact_id, invoice_number, currency_code, invoice_date, due_date, total_minor, status, contacts(name)",
    (q) =>
      q
        .eq("company_id" as never, companyId as never)
        .neq("status" as never, "draft" as never)
        .lte("invoice_date" as never, asOf as never),
  );

  const receipts = await pagedWithFallback<{
    id: string;
    contact_id: string;
    reference: string | null;
    currency_code: string;
    receipt_date: string;
    amount_minor: number;
    unallocated_minor: number;
    status: string;
    void_date?: string | null;
    contacts: { name: string } | null;
  }>(
    supabase,
    "sales_receipts",
    "id, contact_id, reference, currency_code, receipt_date, amount_minor, unallocated_minor, status, void_date, contacts(name)",
    "id, contact_id, reference, currency_code, receipt_date, amount_minor, unallocated_minor, status, contacts(name)",
    (q) =>
      q.eq("company_id" as never, companyId as never).lte("receipt_date" as never, asOf as never),
  );

  const credits = await pagedWithFallback<{
    id: string;
    contact_id: string;
    credit_number: string | null;
    currency_code: string;
    credit_date: string;
    total_minor: number;
    amount_allocated_minor: number;
    status: string;
    void_date?: string | null;
    contacts: { name: string } | null;
  }>(
    supabase,
    "sales_credit_notes",
    "id, contact_id, credit_number, currency_code, credit_date, total_minor, amount_allocated_minor, status, void_date, contacts(name)",
    "id, contact_id, credit_number, currency_code, credit_date, total_minor, amount_allocated_minor, status, contacts(name)",
    (q) =>
      q
        .eq("company_id" as never, companyId as never)
        .neq("status" as never, "draft" as never)
        .lte("credit_date" as never, asOf as never),
  );

  const receiptDate = new Map(receipts.map((r) => [r.id, r.receipt_date]));
  const creditDate = new Map(credits.map((c) => [c.id, c.credit_date]));

  const rAlloc = await pagedWithFallback<{
    receipt_id: string;
    invoice_id: string;
    amount_minor: number;
    allocated_on?: string | null;
    reversed_on?: string | null;
  }>(
    supabase,
    "sales_receipt_allocations",
    "id, receipt_id, invoice_id, amount_minor, allocated_on, reversed_on",
    "id, receipt_id, invoice_id, amount_minor",
    (q) => q.eq("company_id" as never, companyId as never),
  );
  const cAlloc = await pagedWithFallback<{
    credit_note_id: string;
    invoice_id: string;
    amount_minor: number;
    allocated_on?: string | null;
    reversed_on?: string | null;
  }>(
    supabase,
    "sales_credit_allocations",
    "id, credit_note_id, invoice_id, amount_minor, allocated_on, reversed_on",
    "id, credit_note_id, invoice_id, amount_minor",
    (q) => q.eq("company_id" as never, companyId as never),
  );

  const asInvoices: AsAtInvoice[] = invoices.map((r) => ({
    id: r.id,
    contactId: r.contact_id,
    contactName: r.contacts?.name ?? "Unknown",
    number: r.invoice_number,
    currencyCode: r.currency_code,
    invoiceDate: r.invoice_date,
    dueDate: r.due_date,
    totalMinor: Number(r.total_minor),
    status: r.status,
    voidDate: r.void_date ?? null,
  }));
  const asReceipts: AsAtReceipt[] = receipts.map((r) => ({
    id: r.id,
    contactId: r.contact_id,
    contactName: r.contacts?.name ?? "Unknown",
    reference: r.reference,
    currencyCode: r.currency_code,
    receiptDate: r.receipt_date,
    amountMinor: Number(r.amount_minor),
    status: r.status,
    voidDate: r.void_date ?? null,
    unallocatedMinor: Number(r.unallocated_minor),
  }));
  const asCredits: AsAtCreditNote[] = credits.map((c) => ({
    id: c.id,
    contactId: c.contact_id,
    contactName: c.contacts?.name ?? "Unknown",
    number: c.credit_number,
    currencyCode: c.currency_code,
    creditDate: c.credit_date,
    totalMinor: Number(c.total_minor),
    status: c.status,
    voidDate: c.void_date ?? null,
    amountAllocatedMinor: Number(c.amount_allocated_minor),
  }));
  const receiptAllocations = rAlloc.map((a) => ({
    receiptId: a.receipt_id,
    invoiceId: a.invoice_id,
    amountMinor: Number(a.amount_minor),
    effectiveDate: a.allocated_on ?? receiptDate.get(a.receipt_id) ?? "0000-01-01",
    reversedOn: a.reversed_on ?? null,
  })) satisfies Array<AsAtAllocation & { receiptId: string }>;
  const creditAllocations = cAlloc.map((a) => ({
    creditNoteId: a.credit_note_id,
    invoiceId: a.invoice_id,
    amountMinor: Number(a.amount_minor),
    effectiveDate: a.allocated_on ?? creditDate.get(a.credit_note_id) ?? "0000-01-01",
    reversedOn: a.reversed_on ?? null,
  })) satisfies Array<AsAtAllocation & { creditNoteId: string }>;

  return {
    asOf,
    invoices: asInvoices,
    receipts: asReceipts,
    creditNotes: asCredits,
    receiptAllocations,
    creditAllocations,
  };
}

/** AR control account balance (debits − credits) up to and including `asOf`, in base currency. */
async function arControlBalanceAsAt(
  supabase: SalesClient,
  companyId: string,
  asOf: string,
): Promise<number> {
  const ar = await resolveArAccount(supabase, companyId);
  const rows = await fetchAllPages<{ debit_minor: number; credit_minor: number }>(
    (from, to) =>
      supabase
        .from("journal_lines" as never)
        .select("id, debit_minor, credit_minor, journals!inner(journal_date, status)" as never)
        .eq("company_id" as never, companyId as never)
        .eq("account_id" as never, ar.id as never)
        .eq("journals.status" as never, "posted" as never)
        .lte("journals.journal_date" as never, asOf as never)
        .order("id" as never)
        .range(from, to) as unknown as PromiseLike<{
        data: Array<{ debit_minor: number; credit_minor: number }> | null;
        error: { message: string } | null;
      }>,
  );
  return rows.reduce((s, r) => s + Number(r.debit_minor) - Number(r.credit_minor), 0);
}

export const getAgedReceivablesAsAt = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; asOf?: string }) => {
    if (input.asOf !== undefined && input.asOf !== "" && !isIsoDateString(input.asOf)) {
      throw new Error("As-at date must be YYYY-MM-DD");
    }
    return { companyId: assertUuid(input.companyId), asOf: input.asOf || null };
  })
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyMember(supabase, data.companyId);
    const defaults = await loadCompanyDefaults(supabase, data.companyId);
    const asOf = data.asOf ?? defaults.today;

    const inputs = await loadArAsAtInputs(supabase, data.companyId, asOf);
    const aged = buildAgedReceivablesAsAt(inputs);
    const control = await arControlBalanceAsAt(supabase, data.companyId, asOf);

    const baseOnly = aged.totalsByCurrency.every((t) => t.currency_code === defaults.baseCurrency);
    const baseTotal =
      aged.totalsByCurrency.find((t) => t.currency_code === defaults.baseCurrency)?.total ?? 0;
    const variance = baseOnly ? baseTotal - control : null;
    return {
      asOf,
      baseCurrency: defaults.baseCurrency,
      rows: aged.rows,
      totalsByCurrency: aged.totalsByCurrency,
      arControlBalanceMinor: control,
      varianceMinor: variance,
      tiesToControl: variance === null ? null : variance === 0,
      diagnostic:
        variance === null
          ? "Foreign-currency documents are present: compare each currency's total with the AR control account in that currency's base-equivalent manually."
          : variance === 0
            ? null
            : "Subledger total differs from the AR control account. Check manual journals posted to AR or refunds not recorded against a receipt.",
    };
  });
