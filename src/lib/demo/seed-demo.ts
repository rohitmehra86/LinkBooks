/**
 * Seeds Demo Company masters + sample documents + journals via PostingEngine.
 * Never runs against non-demo companies. Idempotent via journal idempotency keys.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { postJournal } from "@/lib/accounting/posting-engine";
import { requireAccountByCode } from "@/lib/purchases/accounts";
import {
  DEMO_BANK,
  DEMO_CONTACTS,
  DEMO_CURRENCY,
  DEMO_JOURNAL_SPECS,
} from "@/lib/demo/demo-dataset";

type Client = SupabaseClient<Database>;

async function assertDemoCompany(supabase: Client, companyId: string): Promise<void> {
  const { data, error } = await supabase
    .from("companies")
    .select("id, is_demo")
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Company not found");
  if (!data.is_demo) {
    throw new Error("Demo seed denied: company is not a demo company");
  }
}

export async function seedDemoCompanyData(
  supabase: Client,
  args: { companyId: string; userId: string },
): Promise<{ journalsPosted: number; contacts: number }> {
  await assertDemoCompany(supabase, args.companyId);
  const { companyId, userId } = args;

  // Resolve chart (must already be seeded by create/reset)
  const codes = ["1000", "1100", "1200", "2000", "2100", "3100", "4000", "5000", "6000", "6100"] as const;
  const byCode = new Map<string, string>();
  for (const code of codes) {
    const acct = await requireAccountByCode(supabase, companyId, code);
    byCode.set(code, acct.id);
  }

  // Contacts
  const contactIds = new Map<string, string>();
  for (const c of DEMO_CONTACTS) {
    const { data: existing } = await supabase
      .from("contacts" as never)
      .select("id" as never)
      .eq("company_id" as never, companyId as never)
      .eq("name" as never, c.name as never)
      .maybeSingle();
    if (existing) {
      contactIds.set(c.key, (existing as { id: string }).id);
      continue;
    }
    const { data: row, error } = await supabase
      .from("contacts" as never)
      .insert({
        company_id: companyId,
        kind: c.kind,
        name: c.name,
        email: c.email,
        notes: "Sample demo contact — not a real organisation",
        payment_terms_days: 30,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    contactIds.set(c.key, (row as { id: string }).id);
  }

  // Bank account
  let bankAccountId: string | null = null;
  {
    const { data: existing } = await supabase
      .from("bank_accounts" as never)
      .select("id" as never)
      .eq("company_id" as never, companyId as never)
      .eq("name" as never, DEMO_BANK.name as never)
      .maybeSingle();
    if (existing) {
      bankAccountId = (existing as { id: string }).id;
    } else {
      const { data: row, error } = await supabase
        .from("bank_accounts" as never)
        .insert({
          company_id: companyId,
          name: DEMO_BANK.name,
          currency_code: DEMO_BANK.currency,
          gl_account_id: byCode.get("1000"),
          is_active: true,
        } as never)
        .select("id")
        .single();
      if (error) {
        // Schema variants — continue without bank UI rows if insert fails
        console.warn("[demo seed] bank_accounts insert:", error.message);
      } else {
        bankAccountId = (row as { id: string }).id;
      }
    }
  }

  // Sample bank transactions (import / reconcile examples)
  if (bankAccountId) {
    const samples = [
      {
        key: "demo-btxn-rcp",
        amount_minor: 1_200_000,
        txn_date: "2025-07-01",
        description: "ACME CONSULTING RECEIPT",
        status: "reconciled",
      },
      {
        key: "demo-btxn-pay",
        amount_minor: -480_000,
        txn_date: "2025-07-05",
        description: "OFFICE SUPPLIES PAYMENT",
        status: "reconciled",
      },
      {
        key: "demo-btxn-uncat",
        amount_minor: -4_200,
        txn_date: "2026-01-12",
        description: "UNKNOWN CARD PAYMENT",
        status: "uncategorised",
      },
    ];
    for (const s of samples) {
      const { data: exists } = await supabase
        .from("bank_transactions" as never)
        .select("id" as never)
        .eq("company_id" as never, companyId as never)
        .eq("description" as never, s.description as never)
        .eq("txn_date" as never, s.txn_date as never)
        .maybeSingle();
      if (exists) continue;
      await supabase.from("bank_transactions" as never).insert({
        company_id: companyId,
        bank_account_id: bankAccountId,
        amount_minor: s.amount_minor,
        txn_date: s.txn_date,
        description: s.description,
        status: s.status,
      } as never);
    }
  }

  // Document shells linked to contacts (exploration) — posting is via journals below
  const customerId = contactIds.get("customer-acme");
  const supplierId = contactIds.get("supplier-office");
  if (customerId) {
    await upsertDemoInvoice(supabase, {
      companyId,
      userId,
      contactId: customerId,
      number: "INV-1001",
      date: "2025-06-15",
      due: "2025-07-15",
      subtotal: 1_000_000,
      tax: 200_000,
      total: 1_200_000,
      paid: 1_200_000,
      status: "paid",
      accountId: byCode.get("4000")!,
    });
    await upsertDemoInvoice(supabase, {
      companyId,
      userId,
      contactId: contactIds.get("customer-bright") ?? customerId,
      number: "INV-1002",
      date: "2025-09-01",
      due: "2025-10-01",
      subtotal: 500_000,
      tax: 100_000,
      total: 600_000,
      paid: 0,
      credited: 120_000,
      status: "authorised",
      accountId: byCode.get("4000")!,
    });
  }
  if (supplierId) {
    await upsertDemoBill(supabase, {
      companyId,
      userId,
      contactId: supplierId,
      number: "BILL-2001",
      date: "2025-06-20",
      due: "2025-07-20",
      subtotal: 400_000,
      tax: 80_000,
      total: 480_000,
      paid: 480_000,
      status: "paid",
      accountId: byCode.get("6000")!,
    });
  }

  // Authoritative ledger via PostingEngine
  let journalsPosted = 0;
  for (const spec of DEMO_JOURNAL_SPECS) {
    const lines = spec.lines.map((l) => {
      const account_id = byCode.get(l.code);
      if (!account_id) throw new Error(`Missing account ${l.code}`);
      const line: {
        account_id: string;
        debit_minor: bigint;
        credit_minor: bigint;
        description?: string;
      } = {
        account_id,
        debit_minor: l.debit,
        credit_minor: l.credit,
      };
      if (l.description) line.description = l.description;
      return line;
    });
    try {
      await postJournal(supabase, {
        company_id: companyId,
        journal_date: spec.date,
        memo: spec.memo,
        currency_code: DEMO_CURRENCY,
        fx_rate_to_base: 1,
        source_type: spec.source_type,
        idempotency_key: `${spec.key}:${companyId}`,
        lines,
      });
      journalsPosted += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Idempotent replay is OK
      if (!/idempoten|already|duplicate/i.test(msg)) throw e;
    }
  }

  await supabase.rpc("record_audit_event" as never, {
    _company_id: companyId,
    _action: "demo.seed",
    _entity_type: "company",
    _entity_id: companyId,
    _details: { journalsPosted, contacts: contactIds.size, sample: true },
  } as never);

  return { journalsPosted, contacts: contactIds.size };
}

async function upsertDemoInvoice(
  supabase: Client,
  args: {
    companyId: string;
    userId: string;
    contactId: string;
    number: string;
    date: string;
    due: string;
    subtotal: number;
    tax: number;
    total: number;
    paid: number;
    credited?: number;
    status: string;
    accountId: string;
  },
) {
  const { data: existing } = await supabase
    .from("sales_invoices" as never)
    .select("id" as never)
    .eq("company_id" as never, args.companyId as never)
    .eq("invoice_number" as never, args.number as never)
    .maybeSingle();
  if (existing) return;
  const { data: inv, error } = await supabase
    .from("sales_invoices" as never)
    .insert({
      company_id: args.companyId,
      contact_id: args.contactId,
      invoice_number: args.number,
      invoice_date: args.date,
      due_date: args.due,
      currency_code: DEMO_CURRENCY,
      status: args.status,
      subtotal_minor: args.subtotal,
      tax_minor: args.tax,
      total_minor: args.total,
      amount_paid_minor: args.paid,
      amount_credited_minor: args.credited ?? 0,
      memo: "Demo sample invoice — not a real financial record",
      created_by: args.userId,
      authorised_at: args.status !== "draft" ? new Date().toISOString() : null,
    } as never)
    .select("id")
    .single();
  if (error) {
    console.warn("[demo seed] sales_invoices:", error.message);
    return;
  }
  await supabase.from("sales_invoice_lines" as never).insert({
    company_id: args.companyId,
    invoice_id: (inv as { id: string }).id,
    line_order: 1,
    description: "Demo line",
    account_id: args.accountId,
    quantity: 1,
    unit_price_minor: args.subtotal,
    discount_minor: 0,
    net_minor: args.subtotal,
    tax_minor: args.tax,
    gross_minor: args.total,
    tax_rate_bps: 2000,
  } as never);
}

async function upsertDemoBill(
  supabase: Client,
  args: {
    companyId: string;
    userId: string;
    contactId: string;
    number: string;
    date: string;
    due: string;
    subtotal: number;
    tax: number;
    total: number;
    paid: number;
    status: string;
    accountId: string;
  },
) {
  const { data: existing } = await supabase
    .from("purchase_bills" as never)
    .select("id" as never)
    .eq("company_id" as never, args.companyId as never)
    .eq("bill_number" as never, args.number as never)
    .maybeSingle();
  if (existing) return;
  const { data: bill, error } = await supabase
    .from("purchase_bills" as never)
    .insert({
      company_id: args.companyId,
      contact_id: args.contactId,
      bill_number: args.number,
      bill_date: args.date,
      due_date: args.due,
      currency_code: DEMO_CURRENCY,
      status: args.status,
      subtotal_minor: args.subtotal,
      tax_minor: args.tax,
      total_minor: args.total,
      amount_paid_minor: args.paid,
      memo: "Demo sample bill — not a real financial record",
      created_by: args.userId,
    } as never)
    .select("id")
    .single();
  if (error) {
    console.warn("[demo seed] purchase_bills:", error.message);
    return;
  }
  await supabase.from("purchase_bill_lines" as never).insert({
    company_id: args.companyId,
    bill_id: (bill as { id: string }).id,
    line_no: 1,
    description: "Demo supplies",
    account_id: args.accountId,
    quantity: 1,
    unit_price_minor: args.subtotal,
    discount_minor: 0,
    net_minor: args.subtotal,
    tax_minor: args.tax,
    tax_rate_bps: 2000,
  } as never);
}
