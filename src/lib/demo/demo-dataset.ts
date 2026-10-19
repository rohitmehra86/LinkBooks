/**
 * Canonical Demo Company ledger — deterministic, known expected totals.
 * Posted lines use stable account *codes*; live seed resolves codes → UUIDs.
 * All amounts are GBP minor units. Same rules as production PostingEngine.
 */

import type { AccountType, PostedLine } from "@/lib/accounting/reporting";
import {
  buildBalanceSheet,
  buildProfitAndLoss,
  buildTrialBalance,
} from "@/lib/accounting/reporting";

export const DEMO_COMPANY_NAME = "Demo Company Ltd";
export const DEMO_CURRENCY = "GBP";
export const DEMO_AS_OF = "2026-03-31";
export const DEMO_FY_FROM = "2025-04-01";

/** Stable synthetic account ids for in-memory tests (code-prefixed). */
export const DEMO_ACCOUNT_IDS: Record<string, { id: string; name: string; type: AccountType }> = {
  "1000": { id: "acct-1000", name: "Bank", type: "asset" },
  "1100": { id: "acct-1100", name: "Accounts Receivable", type: "asset" },
  "1200": { id: "acct-1200", name: "Other Current Assets", type: "asset" },
  "2000": { id: "acct-2000", name: "Accounts Payable", type: "liability" },
  "2100": { id: "acct-2100", name: "Tax Payable", type: "liability" },
  "3000": { id: "acct-3000", name: "Owner Equity", type: "equity" },
  "3100": { id: "acct-3100", name: "Opening Balance Equity", type: "equity" },
  "4000": { id: "acct-4000", name: "Sales Revenue", type: "income" },
  "5000": { id: "acct-5000", name: "Cost of Sales", type: "expense" },
  "6000": { id: "acct-6000", name: "Operating Expenses", type: "expense" },
  "6100": { id: "acct-6100", name: "Bank Fees", type: "expense" },
};

export type DemoJournalSpec = {
  key: string;
  date: string;
  memo: string;
  source_type: string;
  lines: Array<{ code: string; debit: bigint; credit: bigint; description?: string }>;
};

/**
 * Full posted demo set. Every major module example maps to at least one of these.
 * Do not change amounts without updating DEMO_EXPECTED_* and tests.
 */
export const DEMO_JOURNAL_SPECS: DemoJournalSpec[] = [
  {
    key: "demo:opening",
    date: "2025-04-01",
    memo: "Opening bank balance",
    source_type: "opening_balance",
    lines: [
      { code: "1000", debit: 5_000_000n, credit: 0n, description: "Opening cash" },
      { code: "3100", debit: 0n, credit: 5_000_000n, description: "Opening equity" },
    ],
  },
  {
    key: "demo:inv-1001",
    date: "2025-06-15",
    memo: "INV-1001 Acme Consulting — website project",
    source_type: "sales_invoice",
    lines: [
      { code: "1100", debit: 1_200_000n, credit: 0n },
      { code: "4000", debit: 0n, credit: 1_000_000n, description: "Consulting" },
      { code: "2100", debit: 0n, credit: 200_000n, description: "Output VAT 20%" },
    ],
  },
  {
    key: "demo:rcp-1001",
    date: "2025-07-01",
    memo: "Receipt INV-1001",
    source_type: "customer_payment",
    lines: [
      { code: "1000", debit: 1_200_000n, credit: 0n },
      { code: "1100", debit: 0n, credit: 1_200_000n },
    ],
  },
  {
    key: "demo:bill-2001",
    date: "2025-06-20",
    memo: "BILL-2001 Office Supplies Co",
    source_type: "purchase_bill",
    lines: [
      { code: "6000", debit: 400_000n, credit: 0n, description: "Supplies" },
      { code: "1200", debit: 80_000n, credit: 0n, description: "Input VAT" },
      { code: "2000", debit: 0n, credit: 480_000n },
    ],
  },
  {
    key: "demo:pay-2001",
    date: "2025-07-05",
    memo: "Payment BILL-2001",
    source_type: "supplier_payment",
    lines: [
      { code: "2000", debit: 480_000n, credit: 0n },
      { code: "1000", debit: 0n, credit: 480_000n },
    ],
  },
  {
    key: "demo:exp-1",
    date: "2025-08-10",
    memo: "Travel expense (paid)",
    source_type: "expense",
    lines: [
      { code: "6000", debit: 150_000n, credit: 0n, description: "Travel" },
      { code: "1200", debit: 30_000n, credit: 0n, description: "Input VAT" },
      { code: "1000", debit: 0n, credit: 180_000n },
    ],
  },
  {
    key: "demo:inv-1002",
    date: "2025-09-01",
    memo: "INV-1002 Brightside Ltd — retainer (open)",
    source_type: "sales_invoice",
    lines: [
      { code: "1100", debit: 600_000n, credit: 0n },
      { code: "4000", debit: 0n, credit: 500_000n },
      { code: "2100", debit: 0n, credit: 100_000n },
    ],
  },
  {
    key: "demo:scn-1",
    date: "2025-09-15",
    memo: "SCN-1 Credit against INV-1002",
    source_type: "sales_credit_note",
    lines: [
      { code: "4000", debit: 100_000n, credit: 0n },
      { code: "2100", debit: 20_000n, credit: 0n },
      { code: "1100", debit: 0n, credit: 120_000n },
    ],
  },
  {
    key: "demo:bill-2002",
    date: "2025-10-01",
    memo: "BILL-2002 then credited",
    source_type: "purchase_bill",
    lines: [
      { code: "6000", debit: 200_000n, credit: 0n },
      { code: "1200", debit: 40_000n, credit: 0n },
      { code: "2000", debit: 0n, credit: 240_000n },
    ],
  },
  {
    key: "demo:pcn-1",
    date: "2025-10-08",
    memo: "PCN-1 Supplier credit",
    source_type: "purchase_credit_note",
    lines: [
      { code: "2000", debit: 240_000n, credit: 0n },
      { code: "6000", debit: 0n, credit: 200_000n },
      { code: "1200", debit: 0n, credit: 40_000n },
    ],
  },
  {
    key: "demo:cos-ap",
    date: "2025-11-01",
    memo: "Cost of sales on account",
    source_type: "manual",
    lines: [
      { code: "5000", debit: 75_000n, credit: 0n },
      { code: "2000", debit: 0n, credit: 75_000n },
    ],
  },
  {
    key: "demo:bank-fee",
    date: "2025-12-15",
    memo: "Bank service fee",
    source_type: "bank_transaction",
    lines: [
      { code: "6100", debit: 2_500n, credit: 0n },
      { code: "1000", debit: 0n, credit: 2_500n },
    ],
  },
];

export function buildDemoPostedLines(): PostedLine[] {
  const lines: PostedLine[] = [];
  let jn = 1;
  for (const spec of DEMO_JOURNAL_SPECS) {
    const journalId = `demo-j-${spec.key}`;
    for (const line of spec.lines) {
      const acct = DEMO_ACCOUNT_IDS[line.code];
      if (!acct) throw new Error(`Unknown demo account code ${line.code}`);
      lines.push({
        account_id: acct.id,
        account_code: line.code,
        account_name: acct.name,
        account_type: acct.type,
        journal_date: spec.date,
        debit_minor: line.debit,
        credit_minor: line.credit,
        fx_rate_to_base: 1,
        currency_code: DEMO_CURRENCY,
        journal_id: journalId,
        journal_number: jn,
        memo: spec.memo,
        source_type: spec.source_type,
        description: line.description ?? null,
      });
    }
    jn += 1;
  }
  return lines;
}

/** Known expected major totals — verified in automated tests. */
export const DEMO_EXPECTED = {
  asOf: DEMO_AS_OF,
  fyFrom: DEMO_FY_FROM,
  currency: DEMO_CURRENCY,
  // Trial balance presentation totals (must balance)
  trialBalanceDebit: 6_755_000n,
  trialBalanceCredit: 6_755_000n,
  // P&L for FY
  income: 1_400_000n,
  expense: 627_500n,
  netProfit: 772_500n,
  // Balance sheet
  assets: 6_127_500n,
  liabilities: 355_000n,
  equity: 5_772_500n,
  // Control accounts
  bank: 5_537_500n,
  ar: 480_000n,
  ap: 75_000n,
  taxPayable: 280_000n,
  vatRecoverable: 110_000n,
} as const;

export function computeDemoReportTotals(lines: PostedLine[] = buildDemoPostedLines()) {
  const tb = buildTrialBalance(lines, { to: DEMO_AS_OF });
  const pl = buildProfitAndLoss(lines, { from: DEMO_FY_FROM, to: DEMO_AS_OF });
  const bs = buildBalanceSheet(lines, { asOf: DEMO_AS_OF });

  const byCode = new Map<string, bigint>();
  for (const row of tb.rows) {
    const net =
      row.account_type === "asset" || row.account_type === "expense"
        ? row.debit_minor - row.credit_minor
        : row.credit_minor - row.debit_minor;
    byCode.set(row.code, net);
  }

  return {
    tbBalances: tb.balances,
    tbDebit: tb.totalDebit,
    tbCredit: tb.totalCredit,
    income: pl.income,
    expense: pl.expense,
    netProfit: pl.net,
    assets: bs.assets,
    liabilities: bs.liabilities,
    equity: bs.equity,
    equationHolds: bs.equationHolds,
    bank: byCode.get("1000") ?? 0n,
    ar: byCode.get("1100") ?? 0n,
    ap: byCode.get("2000") ?? 0n,
    taxPayable: byCode.get("2100") ?? 0n,
    vatRecoverable: byCode.get("1200") ?? 0n,
  };
}

/** Contacts / bank narrative for seed & docs (not ledger). */
export const DEMO_CONTACTS = [
  {
    key: "customer-acme",
    kind: "customer" as const,
    name: "Acme Consulting Ltd",
    email: "ap@acme-demo.example",
    phone: "+44 20 7946 0001",
    terms: 30,
    notes: "Primary demo customer — paid invoice INV-1001",
  },
  {
    key: "customer-bright",
    kind: "customer" as const,
    name: "Brightside Ltd",
    email: "accounts@brightside-demo.example",
    phone: "+44 161 555 0102",
    terms: 30,
    notes: "Open retainer INV-1002 with credit SCN-1",
  },
  {
    key: "customer-north",
    kind: "customer" as const,
    name: "Northwind Traders Ltd",
    email: "finance@northwind-demo.example",
    phone: "+44 113 555 0199",
    terms: 14,
    notes: "Quotes + overdue workshop invoice",
  },
  {
    key: "supplier-office",
    kind: "supplier" as const,
    name: "Office Supplies Co",
    email: "billing@office-demo.example",
    phone: "+44 20 7946 2001",
    terms: 30,
    notes: "Paid bill BILL-2001",
  },
  {
    key: "supplier-host",
    kind: "supplier" as const,
    name: "Cloud Hosting Partners",
    email: "ar@host-demo.example",
    phone: "+44 20 7946 2002",
    terms: 14,
    notes: "Credited bill + recurring hosting",
  },
  {
    key: "supplier-print",
    kind: "supplier" as const,
    name: "PrintShop & Mail Ltd",
    email: "orders@printshop-demo.example",
    phone: "+44 121 555 0144",
    terms: 30,
    notes: "PO + open bill BILL-2003",
  },
];

export const DEMO_BANK = {
  name: "Demo Current Account",
  currency: DEMO_CURRENCY,
  account_number_last4: "4321",
};

/** Module completion honesty for Demo exploration. */
export const DEMO_MODULE_STATUS: Array<{
  path: string;
  label: string;
  status: "ready" | "partial" | "shell";
  note: string;
}> = [
  { path: "/", label: "Dashboard", status: "ready", note: "Figures from posted ledger only" },
  { path: "/banking", label: "Banking", status: "ready", note: "Accounts, import, reconcile samples" },
  { path: "/sales", label: "Sales", status: "ready", note: "Quotes, invoices, receipts, credits, recurring (manual generate)" },
  { path: "/purchases", label: "Purchases", status: "ready", note: "Bills, POs, expenses, payments, credits, claims, recurring" },
  { path: "/contacts", label: "Contacts", status: "ready", note: "6 demo customers/suppliers" },
  {
    path: "/products-services",
    label: "Products & Services",
    status: "shell",
    note: "Catalogue UI not wired — no fake inventory",
  },
  { path: "/accounting", label: "Accounting", status: "ready", note: "CoA, journals, periods" },
  { path: "/reports", label: "Reports", status: "ready", note: "TB, P&L, BS, aging from ledger" },
  { path: "/tax", label: "Tax", status: "ready", note: "Rates and summaries" },
  { path: "/accountant", label: "Accountant", status: "ready", note: "Period-end checklist" },
  { path: "/firm", label: "Firm", status: "ready", note: "Practice linking (optional)" },
  { path: "/ai-assistant", label: "AI Assistant", status: "partial", note: "Needs AI_API_KEY for LLM; local checks work" },
  { path: "/settings", label: "Settings", status: "ready", note: "Includes Demo reset" },
  { path: "/help", label: "Help", status: "shell", note: "Placeholder guides" },
];
