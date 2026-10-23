/** LinkBooks Reports Centre catalogue — only list reports that are operational or transparently blocked. */

export type ReportStatus = "ready" | "depends";

export type ReportCategoryId =
  | "overview"
  | "financial_statements"
  | "management"
  | "sales"
  | "purchases"
  | "banking"
  | "ledger"
  | "tax"
  | "contacts"
  | "reconciliation"
  | "audit"
  | "custom";

export type ReportDef = {
  id: string;
  title: string;
  description: string;
  category: ReportCategoryId;
  tags: string[];
  status: ReportStatus;
  /** Dependency note when status === depends */
  dependency?: string;
  /** Maps to runner kind in ReportWorkspace */
  runner:
    | "trial_balance"
    | "profit_loss"
    | "balance_sheet"
    | "general_ledger"
    | "cash_flow"
    | "aged_receivables"
    | "aged_payables"
    | "journals"
    | "tax"
    | "audit"
    | "general_ledger_all"
    | "equity"
    | "link"
    | "none";
  /** For runner "link": the existing screen that already does this job. */
  linkTo?: "/banking/reconcile" | "/sales/statements" | "/purchases/statements";
};

export const REPORT_CATEGORIES: Array<{ id: ReportCategoryId; label: string }> = [
  { id: "overview", label: "Business Overview & Analytics" },
  { id: "financial_statements", label: "Financial Statements" },
  { id: "management", label: "Management Accounting & Budgets" },
  { id: "sales", label: "Sales & Receivables" },
  { id: "purchases", label: "Purchases & Payables" },
  { id: "banking", label: "Banking & Cash" },
  { id: "ledger", label: "Accounting & General Ledger" },
  { id: "tax", label: "Tax & Compliance" },
  { id: "contacts", label: "Contacts & Transaction Analysis" },
  { id: "reconciliation", label: "Reconciliation & Control" },
  { id: "audit", label: "Audit & Activity" },
  { id: "custom", label: "Custom & Saved Reports" },
];

export const REPORT_CATALOG: ReportDef[] = [
  {
    id: "profit-and-loss",
    title: "Profit and Loss",
    description:
      "Income, cost of sales, gross profit, expenses and net profit from posted journals.",
    category: "financial_statements",
    tags: ["pl", "income", "pnl"],
    status: "ready",
    runner: "profit_loss",
  },
  {
    id: "balance-sheet",
    title: "Balance Sheet",
    description: "Assets, liabilities and equity as at a date, with accounting-equation check.",
    category: "financial_statements",
    tags: ["bs", "position"],
    status: "ready",
    runner: "balance_sheet",
  },
  {
    id: "trial-balance",
    title: "Trial Balance",
    description: "Debit and credit balances by account with balance check.",
    category: "financial_statements",
    tags: ["tb"],
    status: "ready",
    runner: "trial_balance",
  },
  {
    id: "cash-flow",
    title: "Cash Flow (bank movements)",
    description:
      "Operating, investing and financing classification of bank GL movements (direct-method proxy).",
    category: "financial_statements",
    tags: ["cash", "cf"],
    status: "ready",
    runner: "cash_flow",
  },
  {
    id: "statement-of-changes-in-equity",
    title: "Statement of Changes in Equity",
    description:
      "Opening equity, movement by equity account, profit for the period and closing equity.",
    category: "financial_statements",
    tags: ["equity", "soce"],
    status: "ready",
    runner: "equity",
  },
  {
    id: "general-ledger",
    title: "Account Transactions",
    description:
      "Posted lines for one account with running balance, journal and source-document links.",
    category: "ledger",
    tags: ["gl", "ledger", "account"],
    status: "ready",
    runner: "general_ledger",
  },
  {
    id: "general-ledger-all",
    title: "General Ledger (all accounts)",
    description:
      "Every account with activity: opening balance, lines with running balance, closing balance.",
    category: "ledger",
    tags: ["gl", "ledger", "all accounts"],
    status: "ready",
    runner: "general_ledger_all",
  },
  {
    id: "journal-report",
    title: "Journal Report",
    description: "Posted journals in the period with debit/credit totals.",
    category: "ledger",
    tags: ["journals"],
    status: "ready",
    runner: "journals",
  },
  {
    id: "aged-receivables",
    title: "Aged Receivables",
    description:
      "Outstanding posted customer invoices by ageing bucket, reconciled to the receivables control account.",
    category: "sales",
    tags: ["ar", "ageing"],
    status: "ready",
    runner: "aged_receivables",
  },
  {
    id: "aged-payables",
    title: "Aged Payables",
    description:
      "Outstanding posted supplier bills by ageing bucket, reconciled to the payables control account.",
    category: "purchases",
    tags: ["ap", "ageing"],
    status: "ready",
    runner: "aged_payables",
  },
  {
    id: "tax-summary",
    title: "Tax Summary",
    description: "Tax control account movements for the period.",
    category: "tax",
    tags: ["vat", "gst", "tax"],
    status: "ready",
    runner: "tax",
  },
  {
    id: "audit-log",
    title: "Audit Trail",
    description: "Who did what and when: user, action, entity and details, with filters.",
    category: "audit",
    tags: ["audit"],
    status: "ready",
    runner: "audit",
  },
  {
    id: "bank-reconciliation",
    title: "Bank Reconciliation Report",
    description:
      "Reconciled vs unreconciled bank statement lines. Opens the Banking reconciliation screen.",
    category: "banking",
    tags: ["bank", "recon"],
    status: "ready",
    runner: "link",
    linkTo: "/banking/reconcile",
  },
  {
    id: "budget-vs-actual",
    title: "Budget versus Actual",
    description: "Compare budgets to posted actuals.",
    category: "management",
    tags: ["budget"],
    status: "depends",
    dependency: "Budget module is not implemented — no fabricated zeros.",
    runner: "none",
  },
  {
    id: "fixed-asset-register",
    title: "Fixed Asset Register",
    description: "Asset cost, depreciation and carrying value.",
    category: "ledger",
    tags: ["assets", "ppe"],
    status: "depends",
    dependency: "No fixed-asset register module; PPE exists only as CoA + journals.",
    runner: "none",
  },
  {
    id: "customer-statement",
    title: "Customer Statement",
    description: "Customer activity and balance for a date range. Opens Sales → Statements.",
    category: "sales",
    tags: ["statement"],
    status: "ready",
    runner: "link",
    linkTo: "/sales/statements",
  },
  {
    id: "supplier-statement",
    title: "Supplier Statement",
    description: "Supplier activity and balance for a date range. Opens Purchases → Statements.",
    category: "purchases",
    tags: ["statement"],
    status: "ready",
    runner: "link",
    linkTo: "/purchases/statements",
  },
];

/** Categories that have at least one report matching the list (RP-10: no empty headings). */
export function nonEmptyCategories(reports: ReportDef[] = REPORT_CATALOG) {
  return REPORT_CATEGORIES.filter((c) => reports.some((r) => r.category === c.id));
}

export function getReportById(id: string): ReportDef | undefined {
  return REPORT_CATALOG.find((r) => r.id === id);
}

export function searchReports(q: string): ReportDef[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return REPORT_CATALOG;
  return REPORT_CATALOG.filter((r) => {
    const hay = `${r.title} ${r.description} ${r.tags.join(" ")} ${r.id}`.toLowerCase();
    return hay.includes(needle);
  });
}

export const QUICK_REPORT_IDS = [
  "profit-and-loss",
  "balance-sheet",
  "trial-balance",
  "cash-flow",
  "aged-receivables",
  "aged-payables",
] as const;
