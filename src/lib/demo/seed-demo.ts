/**
 * Seeds Demo Company masters + rich sample documents + journals via PostingEngine.
 * Never runs against non-demo companies. Idempotent via journal idempotency keys
 * and document number / name guards.
 *
 * Ledger totals remain driven solely by DEMO_JOURNAL_SPECS (canonical).
 * Extra document shells exist so every Sales/Purchases/Banking list has
 * realistic rows for friend/demo exploration — they do not alter TB/P&L/BS.
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

async function existsBy(
  supabase: Client,
  table: string,
  companyId: string,
  col: string,
  val: string,
): Promise<boolean> {
  const { data } = await supabase
    .from(table as never)
    .select("id" as never)
    .eq("company_id" as never, companyId as never)
    .eq(col as never, val as never)
    .maybeSingle();
  return Boolean(data);
}

export async function seedDemoCompanyData(
  supabase: Client,
  args: { companyId: string; userId: string },
): Promise<{ journalsPosted: number; contacts: number; documents: number }> {
  await assertDemoCompany(supabase, args.companyId);
  const { companyId, userId } = args;
  let documents = 0;

  const codes = ["1000", "1100", "1200", "2000", "2100", "3100", "4000", "5000", "6000", "6100"] as const;
  const byCode = new Map<string, string>();
  for (const code of codes) {
    const acct = await requireAccountByCode(supabase, companyId, code);
    byCode.set(code, acct.id);
  }

  // Tax pack (idempotent RPC when present)
  try {
    await supabase.rpc("seed_default_tax_pack" as never, { _company_id: companyId } as never);
  } catch {
    /* optional */
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
        phone: c.phone ?? null,
        notes: c.notes ?? "Sample demo contact — not a real organisation",
        payment_terms_days: c.terms ?? 30,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    contactIds.set(c.key, (row as { id: string }).id);
  }

  const acme = contactIds.get("customer-acme")!;
  const bright = contactIds.get("customer-bright")!;
  const north = contactIds.get("customer-north")!;
  const office = contactIds.get("supplier-office")!;
  const host = contactIds.get("supplier-host")!;
  const print = contactIds.get("supplier-print")!;
  const revenueId = byCode.get("4000")!;
  const expenseId = byCode.get("6000")!;
  const bankGl = byCode.get("1000")!;

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
          gl_account_id: bankGl,
          is_active: true,
        } as never)
        .select("id")
        .single();
      if (error) {
        console.warn("[demo seed] bank_accounts insert:", error.message);
      } else {
        bankAccountId = (row as { id: string }).id;
      }
    }
  }

  // Bank transactions (one bank account — unique gl_account_id constraint)
  if (bankAccountId) {
    const samples = [
      { amount_minor: 1_200_000, txn_date: "2025-07-01", description: "ACME CONSULTING RECEIPT", status: "reconciled" },
      { amount_minor: -480_000, txn_date: "2025-07-05", description: "OFFICE SUPPLIES PAYMENT", status: "reconciled" },
      { amount_minor: -2_500, txn_date: "2025-12-15", description: "BANK SERVICE FEE", status: "matched" },
      { amount_minor: -4_200, txn_date: "2026-01-12", description: "UNKNOWN CARD PAYMENT", status: "uncategorised" },
      { amount_minor: -18_500, txn_date: "2026-01-18", description: "CLOUD HOSTING MONTHLY", status: "uncategorised" },
      { amount_minor: 350_000, txn_date: "2026-02-03", description: "BRIGHTSIDE PART PAYMENT", status: "uncategorised" },
      { amount_minor: -95_000, txn_date: "2026-02-14", description: "PRINTSHOP INVOICE", status: "uncategorised" },
      { amount_minor: -12_000, txn_date: "2026-02-20", description: "UBER BUSINESS TRAVEL", status: "uncategorised" },
      { amount_minor: 50_000, txn_date: "2026-03-01", description: "NORTHWIND DEPOSIT", status: "uncategorised" },
      { amount_minor: -7_500, txn_date: "2026-03-10", description: "STATIONERY DIRECT DEBIT", status: "uncategorised" },
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
      const { error } = await supabase.from("bank_transactions" as never).insert({
        company_id: companyId,
        bank_account_id: bankAccountId,
        amount_minor: s.amount_minor,
        txn_date: s.txn_date,
        description: s.description,
        status: s.status,
      } as never);
      if (!error) documents += 1;
    }
  }

  // Bank rules
  if (!(await existsBy(supabase, "bank_rules", companyId, "name", "Hosting fees → Operating expenses"))) {
    const { error } = await supabase.from("bank_rules" as never).insert({
      company_id: companyId,
      name: "Hosting fees → Operating expenses",
      match_field: "description",
      match_pattern: "CLOUD HOSTING",
      match_type: "contains",
      offset_account_id: expenseId,
      priority: 10,
      is_active: true,
      created_by: userId,
    } as never);
    if (!error) documents += 1;
  }
  if (!(await existsBy(supabase, "bank_rules", companyId, "name", "Bank fees → Bank Fees"))) {
    const { error } = await supabase.from("bank_rules" as never).insert({
      company_id: companyId,
      name: "Bank fees → Bank Fees",
      match_field: "description",
      match_pattern: "BANK SERVICE",
      match_type: "contains",
      offset_account_id: byCode.get("6100")!,
      priority: 20,
      is_active: true,
      created_by: userId,
    } as never);
    if (!error) documents += 1;
  }

  // ----- Sales documents -----
  documents += await upsertDemoQuote(supabase, {
    companyId,
    userId,
    contactId: north,
    number: "QU-5001",
    date: "2026-01-05",
    expiry: "2026-02-05",
    status: "sent",
    subtotal: 800_000,
    tax: 160_000,
    accountId: revenueId,
    description: "Website redesign proposal",
  });
  documents += await upsertDemoQuote(supabase, {
    companyId,
    userId,
    contactId: acme,
    number: "QU-5002",
    date: "2025-05-01",
    expiry: "2025-06-01",
    status: "accepted",
    subtotal: 1_000_000,
    tax: 200_000,
    accountId: revenueId,
    description: "Website project quote (converted narrative)",
  });
  documents += await upsertDemoQuote(supabase, {
    companyId,
    userId,
    contactId: bright,
    number: "QU-5003",
    date: "2026-03-01",
    expiry: "2026-03-31",
    status: "draft",
    subtotal: 250_000,
    tax: 50_000,
    accountId: revenueId,
    description: "Draft retainer quote",
  });

  documents += await upsertDemoInvoice(supabase, {
    companyId,
    userId,
    contactId: acme,
    number: "INV-1001",
    date: "2025-06-15",
    due: "2025-07-15",
    subtotal: 1_000_000,
    tax: 200_000,
    total: 1_200_000,
    paid: 1_200_000,
    status: "paid",
    accountId: revenueId,
    description: "Website project delivery",
  });
  documents += await upsertDemoInvoice(supabase, {
    companyId,
    userId,
    contactId: bright,
    number: "INV-1002",
    date: "2025-09-01",
    due: "2025-10-01",
    subtotal: 500_000,
    tax: 100_000,
    total: 600_000,
    paid: 0,
    credited: 120_000,
    status: "authorised",
    accountId: revenueId,
    description: "Monthly retainer (part-credited)",
  });
  documents += await upsertDemoInvoice(supabase, {
    companyId,
    userId,
    contactId: north,
    number: "INV-1003",
    date: "2026-02-01",
    due: "2026-03-01",
    subtotal: 300_000,
    tax: 60_000,
    total: 360_000,
    paid: 0,
    status: "authorised",
    accountId: revenueId,
    description: "Strategy workshop (overdue sample)",
  });
  documents += await upsertDemoInvoice(supabase, {
    companyId,
    userId,
    contactId: acme,
    number: "INV-1004",
    date: "2026-03-15",
    due: "2026-04-15",
    subtotal: 150_000,
    tax: 30_000,
    total: 180_000,
    paid: 0,
    status: "draft",
    accountId: revenueId,
    description: "Draft follow-on support",
  });

  // Receipt for INV-1001
  if (!(await existsBy(supabase, "sales_receipts", companyId, "reference", "RCP-1001"))) {
    const { data: inv } = await supabase
      .from("sales_invoices" as never)
      .select("id" as never)
      .eq("company_id" as never, companyId as never)
      .eq("invoice_number" as never, "INV-1001" as never)
      .maybeSingle();
    const { data: rcp, error } = await supabase
      .from("sales_receipts" as never)
      .insert({
        company_id: companyId,
        contact_id: acme,
        receipt_date: "2025-07-01",
        currency_code: DEMO_CURRENCY,
        amount_minor: 1_200_000,
        unallocated_minor: 0,
        bank_account_id: bankGl,
        reference: "RCP-1001",
        memo: "Demo receipt for INV-1001",
        status: "posted",
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (!error && rcp && inv) {
      await supabase.from("sales_receipt_allocations" as never).insert({
        company_id: companyId,
        receipt_id: (rcp as { id: string }).id,
        invoice_id: (inv as { id: string }).id,
        amount_minor: 1_200_000,
        created_by: userId,
      } as never);
      documents += 1;
    }
  }

  // Sales credit note for INV-1002
  if (!(await existsBy(supabase, "sales_credit_notes", companyId, "credit_number", "SCN-1"))) {
    const { data: inv } = await supabase
      .from("sales_invoices" as never)
      .select("id" as never)
      .eq("company_id" as never, companyId as never)
      .eq("invoice_number" as never, "INV-1002" as never)
      .maybeSingle();
    const { data: cn, error } = await supabase
      .from("sales_credit_notes" as never)
      .insert({
        company_id: companyId,
        contact_id: bright,
        credit_number: "SCN-1",
        credit_date: "2025-09-15",
        currency_code: DEMO_CURRENCY,
        status: "authorised",
        subtotal_minor: 100_000,
        tax_minor: 20_000,
        total_minor: 120_000,
        amount_allocated_minor: 120_000,
        memo: "Demo credit against INV-1002",
        invoice_id: inv ? (inv as { id: string }).id : null,
        created_by: userId,
        authorised_at: new Date().toISOString(),
        authorised_by: userId,
      } as never)
      .select("id")
      .single();
    if (!error && cn) {
      await supabase.from("sales_credit_note_lines" as never).insert({
        company_id: companyId,
        credit_note_id: (cn as { id: string }).id,
        line_order: 1,
        description: "Scope reduction credit",
        account_id: revenueId,
        quantity: 1,
        unit_price_minor: 100_000,
        discount_minor: 0,
        tax_rate_bps: 2000,
        net_minor: 100_000,
        tax_minor: 20_000,
        gross_minor: 120_000,
      } as never);
      if (inv) {
        await supabase.from("sales_credit_allocations" as never).insert({
          company_id: companyId,
          credit_note_id: (cn as { id: string }).id,
          invoice_id: (inv as { id: string }).id,
          amount_minor: 120_000,
          created_by: userId,
        } as never);
      }
      documents += 1;
    }
  }

  // Recurring invoice template
  if (!(await existsBy(supabase, "sales_recurring_invoices", companyId, "name", "Brightside monthly retainer"))) {
    const { data: rec, error } = await supabase
      .from("sales_recurring_invoices" as never)
      .insert({
        company_id: companyId,
        contact_id: bright,
        name: "Brightside monthly retainer",
        frequency: "monthly",
        next_due_date: "2026-04-01",
        currency_code: DEMO_CURRENCY,
        is_active: true,
        auto_authorise: false,
        memo: "Demo recurring — generate manually from Sales → Recurring",
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (!error && rec) {
      await supabase.from("sales_recurring_invoice_lines" as never).insert({
        company_id: companyId,
        recurring_id: (rec as { id: string }).id,
        line_order: 1,
        description: "Monthly retainer",
        account_id: revenueId,
        quantity: 1,
        unit_price_minor: 500_000,
        discount_minor: 0,
        tax_rate_bps: 2000,
      } as never);
      documents += 1;
    }
  }

  // ----- Purchases -----
  documents += await upsertDemoBill(supabase, {
    companyId,
    userId,
    contactId: office,
    number: "BILL-2001",
    date: "2025-06-20",
    due: "2025-07-20",
    subtotal: 400_000,
    tax: 80_000,
    total: 480_000,
    paid: 480_000,
    status: "paid",
    accountId: expenseId,
    description: "Office supplies Q2",
  });
  documents += await upsertDemoBill(supabase, {
    companyId,
    userId,
    contactId: host,
    number: "BILL-2002",
    date: "2025-10-01",
    due: "2025-10-31",
    subtotal: 200_000,
    tax: 40_000,
    total: 240_000,
    paid: 0,
    credited: 240_000,
    status: "authorised",
    accountId: expenseId,
    description: "Hosting bill (fully credited)",
  });
  documents += await upsertDemoBill(supabase, {
    companyId,
    userId,
    contactId: print,
    number: "BILL-2003",
    date: "2026-02-10",
    due: "2026-03-10",
    subtotal: 95_000,
    tax: 19_000,
    total: 114_000,
    paid: 0,
    status: "authorised",
    accountId: expenseId,
    description: "Marketing print run (open AP)",
  });
  documents += await upsertDemoBill(supabase, {
    companyId,
    userId,
    contactId: host,
    number: "BILL-2004",
    date: "2026-03-01",
    due: "2026-03-31",
    subtotal: 75_000,
    tax: 15_000,
    total: 90_000,
    paid: 0,
    status: "draft",
    accountId: expenseId,
    description: "Draft March hosting",
  });

  // PO
  if (!(await existsBy(supabase, "purchase_orders", companyId, "order_number", "PO-3001"))) {
    const { data: po, error } = await supabase
      .from("purchase_orders" as never)
      .insert({
        company_id: companyId,
        contact_id: print,
        order_number: "PO-3001",
        order_date: "2026-01-20",
        currency_code: DEMO_CURRENCY,
        status: "sent",
        subtotal_minor: 95_000,
        tax_minor: 19_000,
        total_minor: 114_000,
        memo: "Demo PO — convert to bill from Purchases → Orders",
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (!error && po) {
      await supabase.from("purchase_order_lines" as never).insert({
        company_id: companyId,
        order_id: (po as { id: string }).id,
        line_no: 1,
        description: "Brochure print run",
        account_id: expenseId,
        quantity: 1,
        unit_price_minor: 95_000,
        tax_rate_bps: 2000,
        net_minor: 95_000,
        tax_minor: 19_000,
      } as never);
      documents += 1;
    }
  }

  // Expense
  if (!(await existsBy(supabase, "purchase_expenses", companyId, "reference", "EXP-1"))) {
    const { error } = await supabase.from("purchase_expenses" as never).insert({
      company_id: companyId,
      payee_name: "TravelCo Demo",
      contact_id: null,
      expense_date: "2025-08-10",
      expense_account_id: expenseId,
      payment_account_id: bankGl,
      currency_code: DEMO_CURRENCY,
      reference: "EXP-1",
      memo: "Demo travel expense (posted via ledger)",
      net_minor: 150_000,
      tax_minor: 30_000,
      total_minor: 180_000,
      status: "authorised",
      created_by: userId,
    } as never);
    if (!error) documents += 1;
  }

  // Supplier payment
  if (!(await existsBy(supabase, "supplier_payments", companyId, "reference", "SPAY-2001"))) {
    const { data: bill } = await supabase
      .from("purchase_bills" as never)
      .select("id" as never)
      .eq("company_id" as never, companyId as never)
      .eq("bill_number" as never, "BILL-2001" as never)
      .maybeSingle();
    const { data: pay, error } = await supabase
      .from("supplier_payments" as never)
      .insert({
        company_id: companyId,
        contact_id: office,
        payment_date: "2025-07-05",
        bank_account_id: bankGl,
        currency_code: DEMO_CURRENCY,
        amount_minor: 480_000,
        reference: "SPAY-2001",
        memo: "Demo payment BILL-2001",
        status: "authorised",
        unallocated_minor: 0,
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (!error && pay && bill) {
      await supabase.from("supplier_payment_allocations" as never).insert({
        company_id: companyId,
        payment_id: (pay as { id: string }).id,
        bill_id: (bill as { id: string }).id,
        amount_minor: 480_000,
      } as never);
      documents += 1;
    }
  }

  // Purchase credit note
  if (!(await existsBy(supabase, "purchase_credit_notes", companyId, "credit_number", "PCN-1"))) {
    const { data: cn, error } = await supabase
      .from("purchase_credit_notes" as never)
      .insert({
        company_id: companyId,
        contact_id: host,
        credit_number: "PCN-1",
        credit_date: "2025-10-08",
        currency_code: DEMO_CURRENCY,
        status: "authorised",
        subtotal_minor: 200_000,
        tax_minor: 40_000,
        total_minor: 240_000,
        amount_allocated_minor: 240_000,
        memo: "Demo supplier credit",
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (!error && cn) {
      await supabase.from("purchase_credit_note_lines" as never).insert({
        company_id: companyId,
        credit_note_id: (cn as { id: string }).id,
        line_no: 1,
        description: "Service credit",
        account_id: expenseId,
        net_minor: 200_000,
        tax_minor: 40_000,
      } as never);
      const { data: bill } = await supabase
        .from("purchase_bills" as never)
        .select("id" as never)
        .eq("company_id" as never, companyId as never)
        .eq("bill_number" as never, "BILL-2002" as never)
        .maybeSingle();
      if (bill) {
        await supabase.from("purchase_credit_allocations" as never).insert({
          company_id: companyId,
          credit_note_id: (cn as { id: string }).id,
          bill_id: (bill as { id: string }).id,
          amount_minor: 240_000,
        } as never);
      }
      documents += 1;
    }
  }

  // Recurring bill
  if (!(await existsBy(supabase, "recurring_bills", companyId, "name", "Cloud hosting monthly"))) {
    const { error } = await supabase.from("recurring_bills" as never).insert({
      company_id: companyId,
      contact_id: host,
      name: "Cloud hosting monthly",
      frequency: "monthly",
      next_due_date: "2026-04-01",
      day_of_month: 1,
      currency_code: DEMO_CURRENCY,
      is_active: true,
      auto_authorise: false,
      template: {
        lines: [
          {
            description: "Hosting subscription",
            account_code: "6000",
            net_minor: 75_000,
            tax_rate_bps: 2000,
          },
        ],
      },
      created_by: userId,
    } as never);
    if (!error) documents += 1;
  }

  // Employee expense claim
  if (!(await existsBy(supabase, "employee_expense_claims", companyId, "description", "Client lunch (demo claim)"))) {
    const { error } = await supabase.from("employee_expense_claims" as never).insert({
      company_id: companyId,
      claimant_user_id: userId,
      claim_date: "2026-02-28",
      description: "Client lunch (demo claim)",
      expense_account_id: expenseId,
      currency_code: DEMO_CURRENCY,
      amount_minor: 45_000,
      tax_minor: 0,
      status: "submitted",
    } as never);
    if (!error) documents += 1;
  }
  if (!(await existsBy(supabase, "employee_expense_claims", companyId, "description", "Train to Manchester (approved demo)"))) {
    const { error } = await supabase.from("employee_expense_claims" as never).insert({
      company_id: companyId,
      claimant_user_id: userId,
      claim_date: "2026-01-15",
      description: "Train to Manchester (approved demo)",
      expense_account_id: expenseId,
      currency_code: DEMO_CURRENCY,
      amount_minor: 68_000,
      tax_minor: 0,
      status: "approved",
      reviewed_by: userId,
      reviewed_at: new Date().toISOString(),
    } as never);
    if (!error) documents += 1;
  }

  // Authoritative ledger via PostingEngine (unchanged totals)
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
      if (!/idempoten|already|duplicate/i.test(msg)) throw e;
    }
  }

  await supabase.rpc("record_audit_event" as never, {
    _company_id: companyId,
    _action: "demo.seed",
    _entity_type: "company",
    _entity_id: companyId,
    _details: {
      journalsPosted,
      contacts: contactIds.size,
      documents,
      sample: true,
      rich: true,
    },
  } as never);

  return { journalsPosted, contacts: contactIds.size, documents };
}

async function upsertDemoQuote(
  supabase: Client,
  args: {
    companyId: string;
    userId: string;
    contactId: string;
    number: string;
    date: string;
    expiry: string;
    status: string;
    subtotal: number;
    tax: number;
    accountId: string;
    description: string;
  },
): Promise<number> {
  if (await existsBy(supabase, "sales_quotes", args.companyId, "quote_number", args.number)) return 0;
  const total = args.subtotal + args.tax;
  const { data: q, error } = await supabase
    .from("sales_quotes" as never)
    .insert({
      company_id: args.companyId,
      contact_id: args.contactId,
      quote_number: args.number,
      quote_date: args.date,
      expiry_date: args.expiry,
      currency_code: DEMO_CURRENCY,
      status: args.status,
      subtotal_minor: args.subtotal,
      tax_minor: args.tax,
      total_minor: total,
      memo: "Demo quote — fictional",
      created_by: args.userId,
    } as never)
    .select("id")
    .single();
  if (error || !q) {
    console.warn("[demo seed] sales_quotes:", error?.message);
    return 0;
  }
  await supabase.from("sales_quote_lines" as never).insert({
    company_id: args.companyId,
    quote_id: (q as { id: string }).id,
    line_order: 1,
    description: args.description,
    account_id: args.accountId,
    quantity: 1,
    unit_price_minor: args.subtotal,
    discount_minor: 0,
    tax_rate_bps: 2000,
    net_minor: args.subtotal,
    tax_minor: args.tax,
    gross_minor: total,
  } as never);
  return 1;
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
    description?: string;
  },
): Promise<number> {
  const { data: existing } = await supabase
    .from("sales_invoices" as never)
    .select("id" as never)
    .eq("company_id" as never, args.companyId as never)
    .eq("invoice_number" as never, args.number as never)
    .maybeSingle();
  if (existing) return 0;
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
      authorised_by: args.status !== "draft" ? args.userId : null,
    } as never)
    .select("id")
    .single();
  if (error) {
    console.warn("[demo seed] sales_invoices:", error.message);
    return 0;
  }
  await supabase.from("sales_invoice_lines" as never).insert({
    company_id: args.companyId,
    invoice_id: (inv as { id: string }).id,
    line_order: 1,
    description: args.description ?? "Demo line",
    account_id: args.accountId,
    quantity: 1,
    unit_price_minor: args.subtotal,
    discount_minor: 0,
    net_minor: args.subtotal,
    tax_minor: args.tax,
    gross_minor: args.total,
    tax_rate_bps: 2000,
  } as never);
  return 1;
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
    credited?: number;
    status: string;
    accountId: string;
    description?: string;
  },
): Promise<number> {
  const { data: existing } = await supabase
    .from("purchase_bills" as never)
    .select("id" as never)
    .eq("company_id" as never, args.companyId as never)
    .eq("bill_number" as never, args.number as never)
    .maybeSingle();
  if (existing) return 0;
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
      amount_credited_minor: args.credited ?? 0,
      memo: "Demo sample bill — not a real financial record",
      created_by: args.userId,
    } as never)
    .select("id")
    .single();
  if (error) {
    console.warn("[demo seed] purchase_bills:", error.message);
    return 0;
  }
  await supabase.from("purchase_bill_lines" as never).insert({
    company_id: args.companyId,
    bill_id: (bill as { id: string }).id,
    line_no: 1,
    description: args.description ?? "Demo supplies",
    account_id: args.accountId,
    quantity: 1,
    unit_price_minor: args.subtotal,
    discount_minor: 0,
    net_minor: args.subtotal,
    tax_minor: args.tax,
    tax_rate_bps: 2000,
  } as never);
  return 1;
}
