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
    | "executive_summary"
    | "cash_summary"
    | "gl_summary"
    | "sales_by_contact"
    | "sales_by_item"
    | "purchases_by_supplier"
    | "bank_recon_summary"
    | "cash_flow_indirect"
    | "budget_vs_actual"
    | "fixed_asset_register"
    | "depreciation_schedule"
    | "link"
    | "none";
  /** For runner "link": the existing screen that already does this job. */
  linkTo?: "/banking/reconcile" | "/sales/statements" | "/purchases/statements" | "/projects";
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
    id: "cash-flow-indirect",
    title: "Cash Flow (indirect)",
    description:
      "Net profit adjusted for non-cash items and balance sheet movements, reconciled to the bank ledger.",
    category: "financial_statements",
    tags: ["cash", "cf", "indirect"],
    status: "ready",
    runner: "cash_flow_indirect",
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
    description:
      "Monthly, quarterly or year-to-date budget against posted actuals, with variance and favourable / unfavourable colouring.",
    category: "management",
    tags: ["budget", "variance"],
    status: "ready",
    runner: "budget_vs_actual",
  },
  {
    id: "fixed-asset-register",
    title: "Fixed Asset Register",
    description: "Asset cost, accumulated depreciation and net book value as at a date.",
    category: "ledger",
    tags: ["assets", "ppe"],
    status: "ready",
    runner: "fixed_asset_register",
  },
  {
    id: "depreciation-schedule",
    title: "Depreciation Schedule",
    description: "Opening, charge and closing accumulated depreciation per asset for a period.",
    category: "ledger",
    tags: ["assets", "depreciation"],
    status: "ready",
    runner: "depreciation_schedule",
  },
  {
    id: "executive-summary",
    title: "Executive Summary",
    description:
      "Cash, profitability, position and key ratios for the period against the previous period.",
    category: "overview",
    tags: ["summary", "kpi", "overview"],
    status: "ready",
    runner: "executive_summary",
  },
  {
    id: "cash-summary",
    title: "Cash Summary",
    description:
      "Opening balance, cash received and spent, transfers and closing balance per bank account.",
    category: "banking",
    tags: ["cash", "bank"],
    status: "ready",
    runner: "cash_summary",
  },
  {
    id: "bank-reconciliation-summary",
    title: "Bank Reconciliation Summary",
    description:
      "Book balance against the last reconciliation, with uncleared and uncoded items per bank account.",
    category: "reconciliation",
    tags: ["bank", "recon", "summary"],
    status: "ready",
    runner: "bank_recon_summary",
  },
  {
    id: "general-ledger-summary",
    title: "General Ledger Summary",
    description: "Opening balance, debits, credits and closing balance for every account.",
    category: "ledger",
    tags: ["gl", "ledger", "summary"],
    status: "ready",
    runner: "gl_summary",
  },
  {
    id: "sales-by-contact",
    title: "Sales by Contact",
    description: "Invoices less credit notes per customer, net, tax and gross.",
    category: "sales",
    tags: ["customers", "sales"],
    status: "ready",
    runner: "sales_by_contact",
  },
  {
    id: "sales-by-item",
    title: "Sales by Item",
    description: "Quantity and net sales per product or service.",
    category: "sales",
    tags: ["items", "products", "sales"],
    status: "ready",
    runner: "sales_by_item",
  },
  {
    id: "purchases-by-supplier",
    title: "Purchases by Supplier",
    description: "Bills less credit notes per supplier, net, tax and gross.",
    category: "purchases",
    tags: ["suppliers", "purchases"],
    status: "ready",
    runner: "purchases_by_supplier",
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
  {
    id: "project-profitability",
    title: "Project Profitability",
    description: "Revenue, costs and profit per project from posted figures. Opens Projects.",
    category: "management",
    tags: ["project", "profit", "tracking"],
    status: "ready",
    runner: "link",
    linkTo: "/projects",
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
