/**
 * High-volume Demo list data for UI/perf testing.
 * Does NOT post additional journals — TB/P&L/BS remain driven by DEMO_JOURNAL_SPECS.
 * Idempotent via unique numbers / names.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { DEMO_CURRENCY } from "@/lib/demo/demo-dataset";

type Client = SupabaseClient<Database>;

const CUSTOMER_NAMES = [
  "Acme Consulting Ltd",
  "Brightside Ltd",
  "Northwind Traders Ltd",
  "Riverbank Digital Ltd",
  "Summit Analytics Ltd",
  "Harbor Creative Ltd",
  "Cedar Systems Ltd",
  "Oakline Partners Ltd",
  "BluePeak Media Ltd",
  "Granite Works Ltd",
  "Silverline Logistics Ltd",
  "Maple Finance Ltd",
  "Aurora Design Co",
  "Pioneer Labs Ltd",
  "Westgate Retail Ltd",
  "Eastfield Services Ltd",
  "Cobalt Engineering Ltd",
  "Horizon IT Ltd",
  "Nimbus Cloud Ltd",
  "Prairie Foods Ltd",
  "Atlas Security Ltd",
  "Beacon Marketing Ltd",
  "Canyon Consulting Ltd",
  "Delta Software Ltd",
  "Evergreen Homes Ltd",
];

const SUPPLIER_NAMES = [
  "Office Supplies Co",
  "Cloud Hosting Partners",
  "PrintShop & Mail Ltd",
  "Metro Couriers Ltd",
  "Bright Ink Printers",
  "City Utilities Demo",
  "Lantern Telecom Ltd",
  "Forge Hardware Ltd",
  "Pinnacle Cleaning Ltd",
  "Stationary Direct Ltd",
  "North Grid Power",
  "SoftServe Licences",
  "QuickParts UK Ltd",
  "GreenLeaf Catering",
  "Ironclad Insurance",
  "ParcelPro Express",
  "DeskCraft Furniture",
  "ByteSafe Antivirus",
  "ClearWater Coolers",
  "Peak Training Ltd",
];

export async function seedDemoVolumeData(
  supabase: Client,
  args: {
    companyId: string;
    userId: string;
    revenueAccountId: string;
    expenseAccountId: string;
    bankGlId: string;
    bankAccountId: string | null;
  },
): Promise<{ contacts: number; invoices: number; bills: number; bankTxns: number; products: number }> {
  const { companyId, userId, revenueAccountId, expenseAccountId, bankGlId, bankAccountId } = args;
  let contacts = 0;
  let invoices = 0;
  let bills = 0;
  let bankTxns = 0;
  let products = 0;

  const customerIds: string[] = [];
  const supplierIds: string[] = [];

  for (const [i, name] of CUSTOMER_NAMES.entries()) {
    const id = await upsertContact(supabase, companyId, {
      kind: "customer",
      name,
      email: `accounts${i + 1}@customer-demo.example`,
      phone: `+44 20 7946 ${String(1000 + i).slice(-4)}`,
      terms: 14 + (i % 3) * 7,
    });
    if (id) {
      customerIds.push(id);
      contacts += 1;
    }
  }
  for (const [i, name] of SUPPLIER_NAMES.entries()) {
    const id = await upsertContact(supabase, companyId, {
      kind: "supplier",
      name,
      email: `billing${i + 1}@supplier-demo.example`,
      phone: `+44 161 555 ${String(2000 + i).slice(-4)}`,
      terms: 30,
    });
    if (id) {
      supplierIds.push(id);
      contacts += 1;
    }
  }

  // Products catalogue (non-inventory)
  const productDefs = [
    { code: "SVC-CONSULT", name: "Consulting day", kind: "service", sales: 800_00, cost: 0, tax: 2000 },
    { code: "SVC-RETAIN", name: "Monthly retainer", kind: "service", sales: 500_00, cost: 0, tax: 2000 },
    { code: "SVC-TRAIN", name: "Training workshop", kind: "service", sales: 1200_00, cost: 0, tax: 2000 },
    { code: "SVC-SUPPORT", name: "Support hours", kind: "service", sales: 95_00, cost: 0, tax: 2000 },
    { code: "NI-HOST", name: "Hosting package", kind: "non_inventory", sales: 75_00, cost: 40_00, tax: 2000 },
    { code: "NI-LICENSE", name: "Software licence", kind: "non_inventory", sales: 250_00, cost: 180_00, tax: 2000 },
    { code: "NI-PRINT", name: "Print pack", kind: "non_inventory", sales: 45_00, cost: 22_00, tax: 2000 },
    { code: "NI-DESIGN", name: "Design asset pack", kind: "non_inventory", sales: 150_00, cost: 0, tax: 2000 },
  ];
  for (const p of productDefs) {
    const { data: existing } = await supabase
      .from("products" as never)
      .select("id" as never)
      .eq("company_id" as never, companyId as never)
      .eq("code" as never, p.code as never)
      .maybeSingle();
    if (existing) continue;
    const { error } = await supabase.from("products" as never).insert({
      company_id: companyId,
      kind: p.kind,
      code: p.code,
      name: p.name,
      description: "Demo catalogue item — not inventory-tracked",
      sales_price_minor: p.sales,
      purchase_cost_minor: p.cost,
      income_account_id: revenueAccountId,
      expense_account_id: expenseAccountId,
      sales_tax_rate_bps: p.tax,
      purchase_tax_rate_bps: p.tax,
      unit: "each",
      is_active: true,
    } as never);
    if (!error) products += 1;
  }

  // ~120 invoice shells for list/perf. Draft-only — never authorised/paid without a
  // posted_journal_id, so AR ageing and open-balance UI cannot diverge from the GL.
  const statuses = ["draft", "draft", "draft", "draft", "draft", "draft"] as const;
  for (let i = 0; i < 120; i++) {
    const num = `INV-V${String(2000 + i).padStart(4, "0")}`;
    const { data: exists } = await supabase
      .from("sales_invoices" as never)
      .select("id" as never)
      .eq("company_id" as never, companyId as never)
      .eq("invoice_number" as never, num as never)
      .maybeSingle();
    if (exists) continue;
    const contactId = customerIds[i % customerIds.length];
    if (!contactId) continue;
    const sub = 50_000 + (i % 40) * 12_500;
    const tax = Math.round(sub * 0.2);
    const total = sub + tax;
    const status = statuses[i % statuses.length];
    const paid = 0; // draft-only shells: no journal, so never paid
    const day = 1 + (i % 28);
    const month = 4 + (i % 6);
    const date = `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const dueDay = Math.min(28, day + 14);
    const due = `2026-${String(month).padStart(2, "0")}-${String(dueDay).padStart(2, "0")}`;
    const { data: inv, error } = await supabase
      .from("sales_invoices" as never)
      .insert({
        company_id: companyId,
        contact_id: contactId,
        invoice_number: num,
        invoice_date: date,
        due_date: due,
        currency_code: DEMO_CURRENCY,
        status,
        subtotal_minor: sub,
        tax_minor: tax,
        total_minor: total,
        amount_paid_minor: paid,
        amount_credited_minor: 0,
        memo: `Volume demo invoice ${i + 1}`,
        created_by: userId,
        authorised_at: status !== "draft" ? new Date().toISOString() : null,
        authorised_by: status !== "draft" ? userId : null,
      } as never)
      .select("id")
      .single();
    if (error || !inv) continue;
    await supabase.from("sales_invoice_lines" as never).insert({
      company_id: companyId,
      invoice_id: (inv as { id: string }).id,
      line_order: 1,
      description: `Volume line ${i + 1}`,
      account_id: revenueAccountId,
      quantity: 1,
      unit_price_minor: sub,
      discount_minor: 0,
      net_minor: sub,
      tax_minor: tax,
      gross_minor: total,
      tax_rate_bps: 2000,
    } as never);
    invoices += 1;
  }

  // ~80 bill shells — draft-only (no authorised/paid without posted_journal_id)
  const billStatuses = ["draft", "draft", "draft", "draft", "draft"] as const;
  for (let i = 0; i < 80; i++) {
    const num = `BILL-V${String(3000 + i).padStart(4, "0")}`;
    const { data: exists } = await supabase
      .from("purchase_bills" as never)
      .select("id" as never)
      .eq("company_id" as never, companyId as never)
      .eq("bill_number" as never, num as never)
      .maybeSingle();
    if (exists) continue;
    const contactId = supplierIds[i % supplierIds.length];
    if (!contactId) continue;
    const sub = 20_000 + (i % 25) * 8_000;
    const tax = Math.round(sub * 0.2);
    const total = sub + tax;
    const status = billStatuses[i % billStatuses.length];
    const paid = 0; // draft-only shells: no journal, so never paid
    const day = 1 + (i % 28);
    const month = 4 + (i % 6);
    const date = `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const { data: bill, error } = await supabase
      .from("purchase_bills" as never)
      .insert({
        company_id: companyId,
        contact_id: contactId,
        bill_number: num,
        bill_date: date,
        due_date: date,
        currency_code: DEMO_CURRENCY,
        status,
        subtotal_minor: sub,
        tax_minor: tax,
        total_minor: total,
        amount_paid_minor: paid,
        amount_credited_minor: 0,
        memo: `Volume demo bill ${i + 1}`,
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (error || !bill) continue;
    await supabase.from("purchase_bill_lines" as never).insert({
      company_id: companyId,
      bill_id: (bill as { id: string }).id,
      line_no: 1,
      description: `Volume purchase ${i + 1}`,
      account_id: expenseAccountId,
      quantity: 1,
      unit_price_minor: sub,
      discount_minor: 0,
      net_minor: sub,
      tax_minor: tax,
      tax_rate_bps: 2000,
    } as never);
    bills += 1;
  }

  // ~200 bank transactions for reconcile/import lists
  if (bankAccountId) {
    for (let i = 0; i < 200; i++) {
      const desc = `VOLUME TXN ${String(i + 1).padStart(4, "0")} DEMO`;
      const day = 1 + (i % 28);
      const month = 4 + (i % 6);
      const txn_date = `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const { data: exists } = await supabase
        .from("bank_transactions" as never)
        .select("id" as never)
        .eq("company_id" as never, companyId as never)
        .eq("description" as never, desc as never)
        .eq("txn_date" as never, txn_date as never)
        .maybeSingle();
      if (exists) continue;
      const amount = i % 3 === 0 ? 10_000 + i * 250 : -(5_000 + (i % 50) * 100);
      const status = i % 7 === 0 ? "reconciled" : i % 5 === 0 ? "matched" : "uncategorised";
      const { error } = await supabase.from("bank_transactions" as never).insert({
        company_id: companyId,
        bank_account_id: bankAccountId,
        amount_minor: amount,
        txn_date,
        description: desc,
        status,
        external_id: `vol-${i + 1}`,
      } as never);
      if (!error) bankTxns += 1;
    }
  }

  // Extra quotes for sales list
  for (let i = 0; i < 40; i++) {
    const num = `QU-V${String(6000 + i).padStart(4, "0")}`;
    const { data: exists } = await supabase
      .from("sales_quotes" as never)
      .select("id" as never)
      .eq("company_id" as never, companyId as never)
      .eq("quote_number" as never, num as never)
      .maybeSingle();
    if (exists) continue;
    const contactId = customerIds[i % customerIds.length];
    if (!contactId) continue;
    const sub = 100_000 + i * 5_000;
    const tax = Math.round(sub * 0.2);
    const { data: q, error } = await supabase
      .from("sales_quotes" as never)
      .insert({
        company_id: companyId,
        contact_id: contactId,
        quote_number: num,
        quote_date: `2026-0${4 + (i % 5)}-10`,
        expiry_date: `2026-0${4 + (i % 5)}-28`,
        currency_code: DEMO_CURRENCY,
        status: i % 4 === 0 ? "draft" : i % 4 === 1 ? "sent" : "accepted",
        subtotal_minor: sub,
        tax_minor: tax,
        total_minor: sub + tax,
        memo: "Volume demo quote",
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (error || !q) continue;
    await supabase.from("sales_quote_lines" as never).insert({
      company_id: companyId,
      quote_id: (q as { id: string }).id,
      line_order: 1,
      description: "Volume quote line",
      account_id: revenueAccountId,
      quantity: 1,
      unit_price_minor: sub,
      discount_minor: 0,
      tax_rate_bps: 2000,
      net_minor: sub,
      tax_minor: tax,
      gross_minor: sub + tax,
    } as never);
  }

  void bankGlId;
  return { contacts, invoices, bills, bankTxns, products };
}

async function upsertContact(
  supabase: Client,
  companyId: string,
  c: { kind: string; name: string; email: string; phone: string; terms: number },
): Promise<string | null> {
  const { data: existing } = await supabase
    .from("contacts" as never)
    .select("id" as never)
    .eq("company_id" as never, companyId as never)
    .eq("name" as never, c.name as never)
    .maybeSingle();
  if (existing) return (existing as { id: string }).id;
  const { data: row, error } = await supabase
    .from("contacts" as never)
    .insert({
      company_id: companyId,
      kind: c.kind,
      name: c.name,
      email: c.email,
      phone: c.phone,
      notes: "Volume demo contact",
      payment_terms_days: c.terms,
    } as never)
    .select("id")
    .single();
  if (error) return null;
  return (row as { id: string }).id;
}
