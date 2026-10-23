import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { fetchAllPages } from "@/lib/sales/fetch-all";
import { buildCustomerStatement, type StatementDoc } from "@/lib/sales/statement";
import { isIsoDateString } from "@/lib/sales/list-filters";
import { loadCompanyDefaults } from "@/lib/sales/sales-common";
import type { SalesClient } from "@/lib/sales/rpc";

type Q = {
  eq(c: never, v: never): Q;
  in(c: never, v: never): Q;
  order(c: never, o?: never): Q;
  range(
    a: number,
    b: number,
  ): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
};

async function paged<T>(
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

/**
 * Customer statement: opening balance + activity in [from, to] = closing balance, per currency
 * (AR-09). Receipts and credit notes appear at their FULL amount; the "unapplied" figures say what
 * is not yet matched to an invoice.
 */
export async function loadCustomerStatement(
  supabase: SalesClient,
  data: { companyId: string; contactId: string; from: string | null; to: string | null },
) {
  {
    await assertCompanyMember(supabase, data.companyId);
    const forContact = (q: Q) =>
      q
        .eq("company_id" as never, data.companyId as never)
        .eq("contact_id" as never, data.contactId as never);

    const invoices = await paged<{
      id: string;
      invoice_number: string | null;
      invoice_date: string;
      due_date: string;
      status: string;
      currency_code: string;
      total_minor: number;
      amount_paid_minor: number;
      amount_credited_minor: number;
      void_date?: string | null;
    }>(
      supabase,
      "sales_invoices",
      "id, invoice_number, invoice_date, due_date, status, currency_code, total_minor, amount_paid_minor, amount_credited_minor, void_date",
      "id, invoice_number, invoice_date, due_date, status, currency_code, total_minor, amount_paid_minor, amount_credited_minor",
      forContact,
    );
    const receipts = await paged<{
      id: string;
      reference: string | null;
      receipt_date: string;
      status: string;
      currency_code: string;
      amount_minor: number;
      unallocated_minor: number;
      void_date?: string | null;
    }>(
      supabase,
      "sales_receipts",
      "id, reference, receipt_date, status, currency_code, amount_minor, unallocated_minor, void_date",
      "id, reference, receipt_date, status, currency_code, amount_minor, unallocated_minor",
      forContact,
    );
    const credits = await paged<{
      id: string;
      credit_number: string | null;
      credit_date: string;
      status: string;
      currency_code: string;
      total_minor: number;
      amount_allocated_minor: number;
      void_date?: string | null;
    }>(
      supabase,
      "sales_credit_notes",
      "id, credit_number, credit_date, status, currency_code, total_minor, amount_allocated_minor, void_date",
      "id, credit_number, credit_date, status, currency_code, total_minor, amount_allocated_minor",
      forContact,
    );

    const docs: StatementDoc[] = [
      ...invoices.map((i): StatementDoc => ({
        kind: "invoice",
        id: i.id,
        date: i.invoice_date,
        currencyCode: i.currency_code,
        amountMinor: Number(i.total_minor),
        reference: i.invoice_number,
        status: i.status,
        voidDate: i.void_date ?? null,
        dueDate: i.due_date,
      })),
      ...receipts.map((r): StatementDoc => ({
        kind: "receipt",
        id: r.id,
        date: r.receipt_date,
        currencyCode: r.currency_code,
        amountMinor: Number(r.amount_minor),
        reference: r.reference,
        status: r.status,
        voidDate: r.void_date ?? null,
      })),
      ...credits.map((c): StatementDoc => ({
        kind: "credit_note",
        id: c.id,
        date: c.credit_date,
        currencyCode: c.currency_code,
        amountMinor: Number(c.total_minor),
        reference: c.credit_number,
        status: c.status,
        voidDate: c.void_date ?? null,
      })),
    ];
    const currencies = buildCustomerStatement(docs, { from: data.from, to: data.to });

    // Position today, per currency: what is still owed and what is not yet matched.
    const summary = new Map<
      string,
      { outstandingMinor: number; unappliedCreditMinor: number; unappliedReceiptMinor: number }
    >();
    const bucket = (c: string) => {
      const s = summary.get(c) ?? {
        outstandingMinor: 0,
        unappliedCreditMinor: 0,
        unappliedReceiptMinor: 0,
      };
      summary.set(c, s);
      return s;
    };
    for (const i of invoices) {
      if (!["authorised", "partly_paid"].includes(i.status)) continue;
      bucket(i.currency_code).outstandingMinor +=
        Number(i.total_minor) - Number(i.amount_paid_minor) - Number(i.amount_credited_minor);
    }
    for (const c of credits) {
      if (!["authorised", "partly_paid"].includes(c.status)) continue;
      bucket(c.currency_code).unappliedCreditMinor +=
        Number(c.total_minor) - Number(c.amount_allocated_minor);
    }
    for (const r of receipts) {
      if (r.status !== "posted") continue;
      bucket(r.currency_code).unappliedReceiptMinor += Number(r.unallocated_minor ?? 0);
    }

    return {
      from: data.from,
      to: data.to,
      currencies,
      position: [...summary.entries()]
        .map(([currency_code, s]) => ({ currency_code, ...s }))
        .sort((a, b) => a.currency_code.localeCompare(b.currency_code)),
    };
  }
}

export const getCustomerStatement = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; contactId: string; from?: string; to?: string }) => ({
      companyId: assertUuid(input.companyId),
      contactId: assertUuid(input.contactId, "customer"),
      from: isIsoDateString(input.from) ? input.from : null,
      to: isIsoDateString(input.to) ? input.to : null,
    }),
  )
  .handler(async ({ data, context }) => loadCustomerStatement(context.supabase, data));

/**
 * Sales overview tiles. "Today" is the company's local date, every row is read (paged), and
 * amounts are grouped per currency instead of being added across currencies.
 */
export const getSalesOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyMember(supabase, data.companyId);
    const defaults = await loadCompanyDefaults(supabase, data.companyId);
    const today = defaults.today;

    const { count: draftCount, error: dErr } = await supabase
      .from("sales_invoices" as never)
      .select("id" as never, { count: "exact", head: true })
      .eq("company_id" as never, data.companyId as never)
      .eq("status" as never, "draft" as never);
    if (dErr) throw new Error(dErr.message);

    const open = await fetchAllPages<{
      due_date: string;
      currency_code: string;
      total_minor: number;
      amount_paid_minor: number;
      amount_credited_minor: number;
    }>(
      (from, to) =>
        supabase
          .from("sales_invoices" as never)
          .select(
            "id, due_date, currency_code, total_minor, amount_paid_minor, amount_credited_minor" as never,
          )
          .eq("company_id" as never, data.companyId as never)
          .in("status" as never, ["authorised", "partly_paid"] as never)
          .order("id" as never)
          .range(from, to) as unknown as PromiseLike<{
          data: Array<{
            due_date: string;
            currency_code: string;
            total_minor: number;
            amount_paid_minor: number;
            amount_credited_minor: number;
          }> | null;
          error: { message: string } | null;
        }>,
    );

    const by = new Map<
      string,
      { awaitingMinor: number; overdueMinor: number; overdueCount: number }
    >();
    for (const r of open) {
      const out =
        Number(r.total_minor) - Number(r.amount_paid_minor) - Number(r.amount_credited_minor);
      if (out <= 0) continue;
      const s = by.get(r.currency_code) ?? { awaitingMinor: 0, overdueMinor: 0, overdueCount: 0 };
      if (r.due_date < today) {
        s.overdueMinor += out;
        s.overdueCount += 1;
      } else {
        s.awaitingMinor += out;
      }
      by.set(r.currency_code, s);
    }
    const byCurrency = [...by.entries()]
      .map(([currency_code, s]) => ({ currency_code, ...s }))
      .sort((a, b) => a.currency_code.localeCompare(b.currency_code));
    return {
      today,
      baseCurrency: defaults.baseCurrency,
      draftCount: draftCount ?? 0,
      byCurrency,
    };
  });
