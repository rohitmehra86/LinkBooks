/** Help centre content. Written against the behaviour that exists today; no promises about future features. */

export type HelpLink =
  | "/sales/invoices/new"
  | "/purchases/bills/new"
  | "/banking"
  | "/banking/reconcile"
  | "/reports"
  | "/tax"
  | "/accounting"
  | "/settings"
  | "/contacts";

export type HelpArticle = {
  id: string;
  topic:
    | "Getting started"
    | "Sales and purchases"
    | "Banking"
    | "Reports"
    | "Tax"
    | "Accounting"
    | "Shortcuts";
  title: string;
  summary: string;
  steps: string[];
  link?: { label: string; to: HelpLink };
};

export const HELP_ARTICLES: HelpArticle[] = [
  {
    id: "first-company",
    topic: "Getting started",
    title: "Set up your organisation",
    summary: "Country, currency and financial year decide how reports are laid out.",
    steps: [
      "Open Settings and check the base currency, country and financial year end.",
      "Choose the locale and date format you want to see; amounts and dates follow it everywhere.",
      "Pick a chart of accounts under Accounting, then enter opening balances as a journal dated the day before you start.",
    ],
    link: { label: "Open Settings", to: "/settings" },
  },
  {
    id: "demo",
    topic: "Getting started",
    title: "What is the Demo Company?",
    summary: "A practice organisation that runs on the same accounting engine as a real one.",
    steps: [
      "Its data is fictional and can be reset from Settings → Demo.",
      "Posting, validation and reports behave exactly as they do for a real company.",
      "Switch organisation from the menu at the top to leave it.",
    ],
  },
  {
    id: "invoice",
    topic: "Sales and purchases",
    title: "Send an invoice and record payment",
    summary: "An invoice posts to the ledger when you authorise it.",
    steps: [
      "Create the invoice, choose the customer, add lines and a tax code.",
      "Authorise it. A drafted invoice has no effect on your reports until then.",
      "When the customer pays, record a receipt against the invoice or reconcile the bank line to it.",
      "To correct a posted invoice, raise a credit note or void it. Posted entries are never edited.",
    ],
    link: { label: "New invoice", to: "/sales/invoices/new" },
  },
  {
    id: "bill",
    topic: "Sales and purchases",
    title: "Enter and pay a supplier bill",
    summary: "Bills carry the supplier's invoice number so duplicates can be spotted.",
    steps: [
      "Create the bill, enter the supplier's own invoice number and the lines.",
      "Authorise it (or submit it for approval if your organisation requires that).",
      "Pay it from Purchases → Payments, or by reconciling the bank line.",
    ],
    link: { label: "New bill", to: "/purchases/bills/new" },
  },
  {
    id: "reconcile",
    topic: "Banking",
    title: "Reconcile a bank account",
    summary: "Match each bank statement line to a posted transaction until the difference is zero.",
    steps: [
      "Import a statement or connect a feed under Banking.",
      "Categorise each line, or match it to an invoice, bill or transfer.",
      "Open Reconcile, pick the account and statement date, and tick the lines that appear on the statement.",
      "Finish when the difference is zero.",
    ],
    link: { label: "Open reconciliation", to: "/banking/reconcile" },
  },
  {
    id: "reports",
    topic: "Reports",
    title: "Read the financial statements",
    summary: "Every figure comes from posted journals, converted to your base currency once.",
    steps: [
      "Profit and Loss shows income, cost of sales, expenses and net profit for a period. Compare with the prior period or year, or split by month or quarter.",
      "The Balance Sheet is as at a date. Earnings from earlier years sit in retained earnings; this year's profit is shown separately.",
      "The Trial Balance lists balance sheet accounts as at the date and income and expenses for the financial year to date.",
      "Click an account name in any report to open its transactions with a running balance; click a journal number to open the journal.",
      "Every report has Export CSV and Print / PDF. The URL keeps the dates and filters, so you can share a link to exactly what you see.",
    ],
    link: { label: "Open Reports Centre", to: "/reports" },
  },
  {
    id: "tax",
    topic: "Tax",
    title: "Tax rates, codes and returns",
    summary:
      "LinkBooks calculates tax on documents and totals it for a return. It does not file for you.",
    steps: [
      "Set the tax regime and registration under Tax → Registration, then apply a country pack or add rates and codes yourself.",
      "Ended rates keep working on documents dated inside their dates; end-date a rate instead of deleting it.",
      "Build a return for a period, check the boxes against your own records, then file and lock it. Submitting to the tax authority is done on their site.",
    ],
    link: { label: "Open Tax", to: "/tax" },
  },
  {
    id: "period-close",
    topic: "Accounting",
    title: "Close a period or a financial year",
    summary:
      "Locking a period stops new postings; closing a year moves profit to retained earnings.",
    steps: [
      "Work through the Period close checklist under Accounting.",
      "Lock the period once the books are reviewed. A locked period rejects postings through every screen.",
      "At year end, preview the closing journal and confirm it explicitly. It is only posted when you ask for it.",
    ],
    link: { label: "Open Accounting", to: "/accounting" },
  },
  {
    id: "shortcuts",
    topic: "Shortcuts",
    title: "Keyboard shortcuts",
    summary: "Move around without the mouse.",
    steps: [
      "Ctrl+K (Cmd+K on Mac): search records, jump to pages and reports, or start a new invoice, bill or expense.",
      "Arrow keys move through search results; Enter opens the selected one; Esc closes the palette.",
      "In tables, Tab reaches the sortable column headers; Enter or Space sorts.",
    ],
  },
];

export const GLOSSARY: Array<{ term: string; meaning: string }> = [
  {
    term: "Posted",
    meaning: "Written to the ledger. Posted entries cannot be edited, only reversed or credited.",
  },
  {
    term: "Control account",
    meaning: "The ledger total behind a subledger, such as receivables or payables.",
  },
  {
    term: "Retained earnings",
    meaning: "Profit from earlier financial years that has not been paid out.",
  },
  {
    term: "Minor units",
    meaning:
      "Amounts are stored as whole cents (or the currency's smallest unit) so totals never drift.",
  },
  {
    term: "Idempotent",
    meaning:
      "Doing it twice has the same effect as once, which is why a repeated click does not post twice.",
  },
];

export function searchHelp(query: string, articles: HelpArticle[] = HELP_ARTICLES): HelpArticle[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return articles;
  return articles.filter((a) => {
    const hay = `${a.title} ${a.summary} ${a.topic} ${a.steps.join(" ")}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
