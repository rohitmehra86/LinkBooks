/**
 * Report calculations from posted journal lines (authoritative ledger).
 * All amounts are minor units (bigint). No floating-point aggregation.
 * Multi-currency: convert each line to base using the journal's stored fx_rate_to_base.
 */

import { lineToBaseMinor } from "@/lib/accounting/fx";

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

export type PostedLine = {
  account_id: string;
  account_code: string;
  account_name: string;
  account_type: AccountType;
  /** CoA section hint: current_asset, non_current_asset, current_liability, … */
  account_subtype?: string | null;
  journal_date: string; // YYYY-MM-DD
  debit_minor: bigint | number;
  credit_minor: bigint | number;
  /** Snapshot rate on the journal; reporting converts to base via this. */
  fx_rate_to_base?: number | string | null;
  currency_code?: string | null;
  journal_id?: string;
  journal_number?: number;
  /** Company base currency; with currency_code enables decimal-aware conversion (RP-07). */
  base_currency?: string | null;
  memo?: string | null;
  source_type?: string;
  source_id?: string | null;
  description?: string | null;
  /** Account classification used for control-account and cash-flow decisions. */
  account_kind?: string | null;
  system_key?: string | null;
  fs_line?: string | null;
  cash_flow_class?: string | null;
};

/** Memo prefix that identifies a user-confirmed year-end closing journal (source_type 'other'). */
export const YEAR_END_CLOSE_MEMO_PREFIX = "Year-end close";

export function isYearEndCloseLine(l: {
  source_type?: string | undefined;
  memo?: string | null | undefined;
}): boolean {
  return l.source_type === "other" && (l.memo ?? "").startsWith(YEAR_END_CLOSE_MEMO_PREFIX);
}

export type TrialBalanceRow = {
  account_id: string;
  code: string;
  name: string;
  account_type: AccountType;
  subtype?: string | null;
  account_kind?: string | null;
  system_key?: string | null;
  debit_minor: bigint;
  credit_minor: bigint;
};

/** Balance-sheet presentation sections (Xero-like). */
export type BalanceSheetSectionId =
  | "current_assets"
  | "non_current_assets"
  | "current_liabilities"
  | "non_current_liabilities"
  | "equity";

export const BALANCE_SHEET_SECTION_LABELS: Record<BalanceSheetSectionId, string> = {
  current_assets: "Current assets",
  non_current_assets: "Non-current assets",
  current_liabilities: "Current liabilities",
  non_current_liabilities: "Non-current liabilities",
  equity: "Equity",
};

export function balanceSheetSectionFor(row: {
  account_type: AccountType;
  subtype?: string | null;
}): BalanceSheetSectionId | null {
  const sub = (row.subtype ?? "").toLowerCase();
  if (row.account_type === "asset") {
    if (
      sub.includes("non_current") ||
      sub.includes("fixed") ||
      sub.includes("depreciation") ||
      sub === "non_current_asset"
    ) {
      return "non_current_assets";
    }
    return "current_assets";
  }
  if (row.account_type === "liability") {
    if (sub.includes("non_current") || sub.includes("loan") || sub === "non_current_liability") {
      return "non_current_liabilities";
    }
    return "current_liabilities";
  }
  if (row.account_type === "equity") return "equity";
  return null;
}

export function groupBalanceSheetRows(rows: TrialBalanceRow[]): Array<{
  id: BalanceSheetSectionId;
  label: string;
  rows: TrialBalanceRow[];
  total_minor: bigint;
}> {
  const order: BalanceSheetSectionId[] = [
    "current_assets",
    "non_current_assets",
    "current_liabilities",
    "non_current_liabilities",
    "equity",
  ];
  const buckets = new Map<BalanceSheetSectionId, TrialBalanceRow[]>();
  for (const id of order) buckets.set(id, []);
  for (const row of rows) {
    const id = balanceSheetSectionFor(row);
    if (!id) continue;
    buckets.get(id)!.push(row);
  }
  return order
    .map((id) => {
      const sectionRows = buckets.get(id) ?? [];
      let total = 0n;
      for (const r of sectionRows) {
        const signed =
          id === "current_assets" || id === "non_current_assets"
            ? r.debit_minor - r.credit_minor
            : r.credit_minor - r.debit_minor;
        total += signed;
      }
      return {
        id,
        label: BALANCE_SHEET_SECTION_LABELS[id],
        rows: sectionRows,
        total_minor: total,
      };
    })
    .filter((s) => s.rows.length > 0);
}

function asBig(v: bigint | number): bigint {
  return typeof v === "number" ? BigInt(v) : v;
}

/** The ONE converter for every report path (RP-07): journal snapshot rate, decimal-aware. */
export function lineAmountToBase(line: PostedLine, amount: bigint | number): bigint {
  return lineToBaseMinor(amount, line.fx_rate_to_base, line.currency_code, line.base_currency);
}

/** Signed (debit - credit) amount of a line in base currency. */
export function lineNetBase(line: PostedLine): bigint {
  return lineAmountToBase(line, line.debit_minor) - lineAmountToBase(line, line.credit_minor);
}

export function inDateRange(date: string, from?: string, to?: string): boolean {
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
}

/** Trial balance as-of `to` (inclusive). Net per account presented on normal side. */
export function buildTrialBalance(
  lines: PostedLine[],
  opts: { to?: string; from?: string } = {},
): { rows: TrialBalanceRow[]; totalDebit: bigint; totalCredit: bigint; balances: boolean } {
  const map = new Map<string, TrialBalanceRow>();
  for (const line of lines) {
    if (!inDateRange(line.journal_date, opts.from, opts.to)) continue;
    const existing = map.get(line.account_id) ?? {
      account_id: line.account_id,
      code: line.account_code,
      name: line.account_name,
      account_type: line.account_type,
      subtype: line.account_subtype ?? null,
      account_kind: line.account_kind ?? null,
      system_key: line.system_key ?? null,
      debit_minor: 0n,
      credit_minor: 0n,
    };
    if (!existing.subtype && line.account_subtype) existing.subtype = line.account_subtype;
    existing.debit_minor += lineAmountToBase(line, line.debit_minor);
    existing.credit_minor += lineAmountToBase(line, line.credit_minor);
    map.set(line.account_id, existing);
  }

  const rows: TrialBalanceRow[] = [];
  let totalDebit = 0n;
  let totalCredit = 0n;
  for (const row of [...map.values()].sort((a, b) => a.code.localeCompare(b.code))) {
    const net = row.debit_minor - row.credit_minor;
    const presented: TrialBalanceRow =
      net >= 0n
        ? { ...row, debit_minor: net, credit_minor: 0n }
        : { ...row, debit_minor: 0n, credit_minor: -net };
    rows.push(presented);
    totalDebit += presented.debit_minor;
    totalCredit += presented.credit_minor;
  }
  return { rows, totalDebit, totalCredit, balances: totalDebit === totalCredit };
}

export type ProfitAndLossSectionId =
  "revenue" | "contra_revenue" | "cost_of_sales" | "operating_expense" | "other";

export const PROFIT_AND_LOSS_SECTION_LABELS: Record<ProfitAndLossSectionId, string> = {
  revenue: "Revenue",
  contra_revenue: "Returns & discounts",
  cost_of_sales: "Cost of sales",
  operating_expense: "Operating expenses",
  other: "Other income & expense",
};

/** Map account subtype / type to a P&L presentation section (no double-count). */
export function profitAndLossSectionFor(row: {
  account_type: AccountType;
  subtype?: string | null;
}): ProfitAndLossSectionId {
  const sub = (row.subtype ?? "").toLowerCase();
  if (row.account_type === "income") {
    if (sub.includes("contra")) return "contra_revenue";
    if (sub.includes("contribution") || sub.includes("other")) return "other";
    return "revenue";
  }
  if (sub === "cogs" || sub.includes("cost_of_sales") || sub.includes("cost of sales")) {
    return "cost_of_sales";
  }
  if (
    sub.includes("finance") ||
    sub.includes("program") ||
    sub.includes("depreciation") ||
    sub === "other_expense"
  ) {
    return "other";
  }
  return "operating_expense";
}

export function buildProfitAndLoss(
  lines: PostedLine[],
  opts: { from: string; to: string },
): {
  income: bigint;
  expense: bigint;
  net: bigint;
  revenue: bigint;
  contraRevenue: bigint;
  costOfSales: bigint;
  grossProfit: bigint;
  operatingExpense: bigint;
  otherNet: bigint;
  rows: TrialBalanceRow[];
  sections: Array<{
    id: ProfitAndLossSectionId;
    label: string;
    rows: TrialBalanceRow[];
    total_minor: bigint;
  }>;
} {
  // Year-end closing journals zero the P&L into retained earnings; they are not trading activity.
  const filtered = lines.filter(
    (l) =>
      (l.account_type === "income" || l.account_type === "expense") &&
      !isYearEndCloseLine(l) &&
      inDateRange(l.journal_date, opts.from, opts.to),
  );
  const { rows } = buildTrialBalance(filtered, opts);
  let income = 0n;
  let expense = 0n;
  let revenue = 0n;
  let contraRevenue = 0n;
  let costOfSales = 0n;
  let operatingExpense = 0n;
  let otherNet = 0n;

  const buckets = new Map<ProfitAndLossSectionId, TrialBalanceRow[]>();
  for (const id of Object.keys(PROFIT_AND_LOSS_SECTION_LABELS) as ProfitAndLossSectionId[]) {
    buckets.set(id, []);
  }

  for (const row of rows) {
    const section = profitAndLossSectionFor(row);
    buckets.get(section)!.push(row);
    if (row.account_type === "income") {
      const signed = row.credit_minor - row.debit_minor;
      income += signed;
      if (section === "contra_revenue") contraRevenue += signed;
      else if (section === "other") otherNet += signed;
      else revenue += signed;
    } else {
      const signed = row.debit_minor - row.credit_minor;
      expense += signed;
      if (section === "cost_of_sales") costOfSales += signed;
      else if (section === "other") otherNet -= signed;
      else operatingExpense += signed;
    }
  }

  const grossProfit = revenue + contraRevenue - costOfSales;
  const sections = (Object.keys(PROFIT_AND_LOSS_SECTION_LABELS) as ProfitAndLossSectionId[])
    .map((id) => {
      const sectionRows = buckets.get(id) ?? [];
      let total = 0n;
      for (const r of sectionRows) {
        total +=
          r.account_type === "income"
            ? r.credit_minor - r.debit_minor
            : -(r.debit_minor - r.credit_minor);
      }
      // Present expenses as positive costs in cost_of_sales / operating sections
      if (id === "cost_of_sales" || id === "operating_expense") {
        total = 0n;
        for (const r of sectionRows) total += r.debit_minor - r.credit_minor;
      }
      return {
        id,
        label: PROFIT_AND_LOSS_SECTION_LABELS[id],
        rows: sectionRows,
        total_minor: total,
      };
    })
    .filter((s) => s.rows.length > 0);

  return {
    income,
    expense,
    net: income - expense,
    revenue,
    contraRevenue,
    costOfSales,
    grossProfit,
    operatingExpense,
    otherNet,
    rows,
    sections,
  };
}

export type BalanceSheetResult = {
  assets: bigint;
  liabilities: bigint;
  equity: bigint;
  rows: TrialBalanceRow[];
  sections: ReturnType<typeof groupBalanceSheetRows>;
  equationHolds: boolean;
  /** Earnings of all fiscal years before `fyStart` that are not yet closed into retained earnings. */
  retainedEarningsMinor: bigint;
  /** Earnings from `fyStart` to `asOf`. */
  currentYearEarningsMinor: bigint;
  fyStart: string | null;
};

const PRIOR_EARNINGS_ID = "__retained_earnings__";
const CURRENT_EARNINGS_ID = "__current_year_earnings__";

function isRetainedEarningsRow(r: TrialBalanceRow): boolean {
  return (
    r.account_type === "equity" &&
    (r.system_key === "retained_earnings" ||
      r.account_kind === "retained_earnings" ||
      (r.subtype ?? "") === "retained")
  );
}

/**
 * Balance sheet as at `asOf`. With `fyStart`, earnings are split (RP-04):
 *  - P&L before fyStart → Retained earnings (merged into the retained-earnings account row),
 *  - P&L from fyStart → Current year earnings.
 * Without `fyStart` all P&L is current-year (legacy behaviour).
 */
export function buildBalanceSheet(
  lines: PostedLine[],
  opts: { asOf: string; fyStart?: string },
): BalanceSheetResult {
  const bsLines = lines.filter(
    (l) =>
      (l.account_type === "asset" ||
        l.account_type === "liability" ||
        l.account_type === "equity") &&
      l.journal_date <= opts.asOf,
  );
  const fyStart = opts.fyStart ?? null;
  // Closing journals are real ledger lines: keep them in the BS maths (they zero closed years).
  const plAll = lines.filter(
    (l) =>
      (l.account_type === "income" || l.account_type === "expense") && l.journal_date <= opts.asOf,
  );
  let prior = 0n;
  let current = 0n;
  for (const l of plAll) {
    const net = lineAmountToBase(l, l.credit_minor) - lineAmountToBase(l, l.debit_minor);
    if (fyStart && l.journal_date < fyStart) prior += net;
    else current += net;
  }
  const { rows } = buildTrialBalance(bsLines, { to: opts.asOf });

  let assets = 0n;
  let liabilities = 0n;
  let equity = 0n;
  for (const row of rows) {
    if (row.account_type === "asset") assets += row.debit_minor - row.credit_minor;
    if (row.account_type === "liability") liabilities += row.credit_minor - row.debit_minor;
    if (row.account_type === "equity") equity += row.credit_minor - row.debit_minor;
  }
  equity += prior + current;

  const rowsWithRe: TrialBalanceRow[] = rows.map((r) => ({ ...r }));
  if (prior !== 0n) {
    const reRow = rowsWithRe.find(isRetainedEarningsRow);
    if (reRow) {
      const net = reRow.credit_minor - reRow.debit_minor + prior;
      reRow.debit_minor = net < 0n ? -net : 0n;
      reRow.credit_minor = net > 0n ? net : 0n;
    } else {
      rowsWithRe.push({
        account_id: PRIOR_EARNINGS_ID,
        code: "RE",
        name: "Retained earnings",
        account_type: "equity",
        subtype: "equity",
        debit_minor: prior < 0n ? -prior : 0n,
        credit_minor: prior > 0n ? prior : 0n,
      });
    }
  }
  if (current !== 0n) {
    rowsWithRe.push({
      account_id: CURRENT_EARNINGS_ID,
      code: "CYE",
      name: "Current year earnings",
      account_type: "equity",
      subtype: "equity",
      debit_minor: current < 0n ? -current : 0n,
      credit_minor: current > 0n ? current : 0n,
    });
  }
  return {
    assets,
    liabilities,
    equity,
    rows: rowsWithRe,
    sections: groupBalanceSheetRows(rowsWithRe),
    retainedEarningsMinor: prior,
    currentYearEarningsMinor: current,
    fyStart,
    equationHolds: assets === liabilities + equity,
  };
}

/**
 * Trial balance as at `to` with fiscal-year-to-date P&L (RP-04):
 * balance-sheet accounts are cumulative; income/expense accounts show only fyStart..to;
 * earnings of earlier years are rolled into the retained-earnings row (or a synthetic row).
 */
export function buildFiscalTrialBalance(
  lines: PostedLine[],
  opts: { to: string; fyStart: string },
): {
  rows: TrialBalanceRow[];
  totalDebit: bigint;
  totalCredit: bigint;
  balances: boolean;
  priorYearsEarningsMinor: bigint;
} {
  const upTo = lines.filter((l) => l.journal_date <= opts.to);
  const bs = upTo.filter((l) => l.account_type !== "income" && l.account_type !== "expense");
  const plCurrent = upTo.filter(
    (l) =>
      (l.account_type === "income" || l.account_type === "expense") &&
      l.journal_date >= opts.fyStart,
  );
  let prior = 0n;
  for (const l of upTo) {
    if (
      (l.account_type === "income" || l.account_type === "expense") &&
      l.journal_date < opts.fyStart
    ) {
      prior += lineAmountToBase(l, l.credit_minor) - lineAmountToBase(l, l.debit_minor);
    }
  }
  const base = buildTrialBalance([...bs, ...plCurrent]);
  const rows = base.rows.map((r) => ({ ...r }));
  if (prior !== 0n) {
    const reRow = rows.find(isRetainedEarningsRow);
    if (reRow) {
      const net = reRow.credit_minor - reRow.debit_minor + prior;
      reRow.debit_minor = net < 0n ? -net : 0n;
      reRow.credit_minor = net > 0n ? net : 0n;
    } else {
      rows.push({
        account_id: PRIOR_EARNINGS_ID,
        code: "RE",
        name: "Retained earnings (prior years)",
        account_type: "equity",
        subtype: "retained",
        debit_minor: prior < 0n ? -prior : 0n,
        credit_minor: prior > 0n ? prior : 0n,
      });
      rows.sort((a, b) => a.code.localeCompare(b.code));
    }
  }
  let totalDebit = 0n;
  let totalCredit = 0n;
  for (const r of rows) {
    totalDebit += r.debit_minor;
    totalCredit += r.credit_minor;
  }
  return {
    rows,
    totalDebit,
    totalCredit,
    balances: totalDebit === totalCredit,
    priorYearsEarningsMinor: prior,
  };
}

/** Copy of a line with debit/credit expressed in base currency (idempotent). */
export function toBaseLine(l: PostedLine): PostedLine {
  return {
    ...l,
    debit_minor: lineAmountToBase(l, l.debit_minor),
    credit_minor: lineAmountToBase(l, l.credit_minor),
    fx_rate_to_base: null,
    ...(l.base_currency ? { currency_code: l.base_currency } : {}),
  };
}

export function buildGeneralLedger(
  lines: PostedLine[],
  opts: { accountId: string; from?: string; to?: string },
): PostedLine[] {
  return lines
    .filter(
      (l) => l.account_id === opts.accountId && inDateRange(l.journal_date, opts.from, opts.to),
    )
    .map(toBaseLine)
    .sort((a, b) => {
      const d = a.journal_date.localeCompare(b.journal_date);
      if (d !== 0) return d;
      return (a.journal_number ?? 0) - (b.journal_number ?? 0);
    });
}

export type AccountTxnRow = PostedLine & {
  opening_balance_minor: bigint;
  running_balance_minor: bigint;
};

/** Account transactions with opening balance (activity before `from`) and running balance. */
export function buildAccountTransactions(
  lines: PostedLine[],
  opts: { accountId: string; from: string; to: string },
): {
  opening_balance_minor: bigint;
  closing_balance_minor: bigint;
  rows: AccountTxnRow[];
} {
  let opening = 0n;
  for (const l of lines) {
    if (l.account_id !== opts.accountId) continue;
    if (l.journal_date < opts.from) {
      opening += lineNetBase(l);
    }
  }
  const period = buildGeneralLedger(lines, opts);
  let running = opening;
  const rows: AccountTxnRow[] = period.map((l) => {
    running += asBig(l.debit_minor) - asBig(l.credit_minor);
    return {
      ...l,
      opening_balance_minor: opening,
      running_balance_minor: running,
    };
  });
  return {
    opening_balance_minor: opening,
    closing_balance_minor: running,
    rows,
  };
}

export type AgingBucket = "current" | "1_30" | "31_60" | "61_90" | "90_plus";

export type AgingDoc = {
  id: string;
  contact_id: string;
  contact_name: string;
  doc_date: string;
  due_date: string;
  reference: string | null;
  outstanding_minor: bigint | number;
};

export type AgingRow = {
  contact_id: string;
  contact_name: string;
  current: bigint;
  b_1_30: bigint;
  b_31_60: bigint;
  b_61_90: bigint;
  b_90_plus: bigint;
  total: bigint;
  docs: Array<AgingDoc & { bucket: AgingBucket }>;
};

export function ageBucket(dueDate: string, asOf: string): AgingBucket {
  const days = daysBetween(dueDate, asOf);
  if (days <= 0) return "current";
  if (days <= 30) return "1_30";
  if (days <= 60) return "31_60";
  if (days <= 90) return "61_90";
  return "90_plus";
}

/** Aged receivables/payables from open documents (not from hardcoded totals). */
export function buildAgingReport(
  docs: AgingDoc[],
  opts: { asOf: string },
): { rows: AgingRow[]; total: bigint; byBucket: Record<AgingBucket, bigint> } {
  const byContact = new Map<string, AgingRow>();
  const byBucket: Record<AgingBucket, bigint> = {
    current: 0n,
    "1_30": 0n,
    "31_60": 0n,
    "61_90": 0n,
    "90_plus": 0n,
  };
  let total = 0n;

  for (const doc of docs) {
    const outstanding = asBig(doc.outstanding_minor);
    if (outstanding <= 0n) continue;
    if (doc.doc_date > opts.asOf) continue;
    const bucket = ageBucket(doc.due_date, opts.asOf);
    byBucket[bucket] += outstanding;
    total += outstanding;

    const row = byContact.get(doc.contact_id) ?? {
      contact_id: doc.contact_id,
      contact_name: doc.contact_name,
      current: 0n,
      b_1_30: 0n,
      b_31_60: 0n,
      b_61_90: 0n,
      b_90_plus: 0n,
      total: 0n,
      docs: [],
    };
    if (bucket === "current") row.current += outstanding;
    else if (bucket === "1_30") row.b_1_30 += outstanding;
    else if (bucket === "31_60") row.b_31_60 += outstanding;
    else if (bucket === "61_90") row.b_61_90 += outstanding;
    else row.b_90_plus += outstanding;
    row.total += outstanding;
    row.docs.push({ ...doc, outstanding_minor: outstanding, bucket });
    byContact.set(doc.contact_id, row);
  }

  return {
    rows: [...byContact.values()].sort((a, b) => a.contact_name.localeCompare(b.contact_name)),
    total,
    byBucket,
  };
}

export type CashFlowSection = "operating" | "investing" | "financing";

export type CashFlowDetailRow = {
  section: CashFlowSection;
  label: string;
  amount_minor: bigint;
};

/**
 * Classify the non-bank side of a cash journal (RP-03). Explicit `cash_flow_class` on the account
 * wins; otherwise by account class/kind:
 *  - investing: fixed / non-current assets
 *  - financing: equity, loans and other non-current liabilities
 *  - operating: everything else (AR, AP, inventory, prepayments, tax, current liabilities,
 *    income and expense accounts)
 */
export function classifyCashCounterpart(l: {
  account_type: AccountType;
  account_subtype?: string | null | undefined;
  account_kind?: string | null | undefined;
  system_key?: string | null | undefined;
  cash_flow_class?: string | null | undefined;
  account_code?: string | undefined;
}): { section: CashFlowSection; label: string } {
  const sub = (l.account_subtype ?? "").toLowerCase();
  const kind = (l.account_kind ?? "").toLowerCase();
  const key = (l.system_key ?? "").toLowerCase();
  const isReceivable = key === "ar" || kind === "accounts_receivable" || sub === "receivable";
  const isPayable = key === "ap" || kind === "accounts_payable" || sub === "payable";
  const isTax = key === "tax" || sub === "tax";

  const explicit = (l.cash_flow_class ?? "").toLowerCase();
  const explicitSection: CashFlowSection | null =
    explicit === "investing" || explicit === "financing" || explicit === "operating"
      ? explicit
      : null;

  let section: CashFlowSection;
  let label: string;
  if (l.account_type === "equity") {
    section = "financing";
    label = "Owner / equity contributions and drawings";
  } else if (
    l.account_type === "liability" &&
    (kind === "non_current_liability" ||
      sub.includes("non_current") ||
      sub.includes("loan") ||
      key === "loan")
  ) {
    section = "financing";
    label = "Loans and other non-current borrowings";
  } else if (
    l.account_type === "asset" &&
    (kind === "fixed_asset" ||
      kind === "non_current_asset" ||
      sub.includes("non_current") ||
      sub.includes("fixed") ||
      sub.includes("depreciation"))
  ) {
    section = "investing";
    label = "Purchase and sale of fixed / non-current assets";
  } else if (isReceivable) {
    section = "operating";
    label = "Receipts from customers";
  } else if (isPayable) {
    section = "operating";
    label = "Payments to suppliers";
  } else if (isTax) {
    section = "operating";
    label = "Tax (VAT / GST) paid and received";
  } else if (l.account_type === "income") {
    section = "operating";
    label = "Income received directly";
  } else if (l.account_type === "expense") {
    section = "operating";
    label = "Expenses paid directly";
  } else if (l.account_type === "asset") {
    section = "operating";
    label = "Inventory, prepayments and other current assets";
  } else {
    section = "operating";
    label = "Other current liabilities";
  }
  if (explicitSection && explicitSection !== section) {
    // Honour an explicit override but never move equity/loans out of financing silently.
    if (section !== "financing") section = explicitSection;
  }
  return { section, label };
}

/**
 * Cash movement report from bank GL accounts (direct method, classified per counterpart line).
 * Every non-bank line of a journal that touches a bank account contributes -(debit-credit) to cash,
 * so multi-line journals (e.g. receipt = bank / AR / VAT) are split exactly across their
 * counterpart lines. Journals that only move between bank accounts net to zero.
 * Not a full IAS 7 statement — indirect reconciliation is not produced.
 */
export type CashFlowLine = PostedLine & { counterpart_type?: AccountType | "unknown" };

export function buildCashFlowFromBank(
  lines: PostedLine[],
  opts: {
    from: string;
    to: string;
    bankAccountIds: string[];
  },
): {
  operating: bigint;
  investing: bigint;
  financing: bigint;
  net_change: bigint;
  opening_cash: bigint;
  closing_cash: bigint;
  /** Bank GL balance as-of `to` (independent of classified movements). */
  closing_cash_ledger: bigint;
  reconciles: boolean;
  rows: Array<{ category: string; amount_minor: bigint }>;
  detail: CashFlowDetailRow[];
  limitation: string;
} {
  const bankSet = new Set(opts.bankAccountIds);
  let opening = 0n;
  let closingLedger = 0n;
  for (const l of lines) {
    if (!bankSet.has(l.account_id)) continue;
    const net = lineNetBase(l);
    if (l.journal_date < opts.from) opening += net;
    if (l.journal_date <= opts.to) closingLedger += net;
  }

  // Group lines by journal to classify bank movements in the period
  const byJournal = new Map<string, PostedLine[]>();
  for (const l of lines) {
    if (!l.journal_id) continue;
    if (!inDateRange(l.journal_date, opts.from, opts.to)) continue;
    const arr = byJournal.get(l.journal_id) ?? [];
    arr.push(l);
    byJournal.set(l.journal_id, arr);
  }

  const totals: Record<CashFlowSection, bigint> = { operating: 0n, investing: 0n, financing: 0n };
  const detailMap = new Map<string, CashFlowDetailRow>();

  for (const [, jlines] of byJournal) {
    const bankLines = jlines.filter((l) => bankSet.has(l.account_id));
    if (!bankLines.length) continue;
    const others = jlines.filter((l) => !bankSet.has(l.account_id));
    let bankNet = 0n;
    for (const b of bankLines) bankNet += lineNetBase(b);

    // Opening-balance / conversion journals are starting cash, not period activity.
    const source = (bankLines[0]?.source_type ?? others[0]?.source_type ?? "").toLowerCase();
    if (source === "opening_balance" || source === "opening") {
      opening += bankNet;
      continue;
    }
    if (!others.length) {
      // Bank-to-bank journal: no change in total cash.
      continue;
    }
    for (const o of others) {
      // Cash effect of this counterpart line = -(debit - credit).
      const cash = -lineNetBase(o);
      if (cash === 0n) continue;
      const cls = classifyCashCounterpart(o);
      totals[cls.section] += cash;
      const key = `${cls.section}|${cls.label}`;
      const row = detailMap.get(key) ?? {
        section: cls.section,
        label: cls.label,
        amount_minor: 0n,
      };
      row.amount_minor += cash;
      detailMap.set(key, row);
    }
  }

  const net = totals.operating + totals.investing + totals.financing;
  const closingFromMovements = opening + net;
  const order: CashFlowSection[] = ["operating", "investing", "financing"];
  const detail = [...detailMap.values()].sort(
    (a, b) => order.indexOf(a.section) - order.indexOf(b.section) || a.label.localeCompare(b.label),
  );
  return {
    operating: totals.operating,
    investing: totals.investing,
    financing: totals.financing,
    net_change: net,
    opening_cash: opening,
    closing_cash: closingFromMovements,
    closing_cash_ledger: closingLedger,
    reconciles: closingFromMovements === closingLedger,
    rows: [
      { category: "Operating", amount_minor: totals.operating },
      { category: "Investing", amount_minor: totals.investing },
      { category: "Financing", amount_minor: totals.financing },
      { category: "Net change in cash", amount_minor: net },
    ],
    detail,
    limitation:
      "Direct method from bank ledger movements, classified by the account on the other side of each journal. Opening-balance journals are treated as opening cash. Not a full IAS 7 / local-GAAP statement (no indirect reconciliation).",
  };
}

/** Tax control account movements in period (posted lines only). */
export function buildTaxSummary(
  lines: PostedLine[],
  opts: { from: string; to: string; taxAccountIds: string[] },
): {
  output_credit_minor: bigint;
  input_debit_minor: bigint;
  net_payable_minor: bigint;
  rows: TrialBalanceRow[];
  detail: PostedLine[];
} {
  const taxSet = new Set(opts.taxAccountIds);
  const detail = lines
    .filter((l) => taxSet.has(l.account_id) && inDateRange(l.journal_date, opts.from, opts.to))
    .map(toBaseLine);
  const { rows } = buildTrialBalance(detail, opts);
  let output = 0n;
  let input = 0n;
  for (const l of detail) {
    output += asBig(l.credit_minor);
    input += asBig(l.debit_minor);
  }
  return {
    output_credit_minor: output,
    input_debit_minor: input,
    net_payable_minor: output - input,
    rows,
    detail,
  };
}

export type JournalReportRow = {
  journal_id: string;
  journal_number: number;
  journal_date: string;
  status: string;
  source_type: string;
  memo: string | null;
  total_debit_minor: bigint;
  total_credit_minor: bigint;
};

export function buildJournalReport(
  journals: Array<{
    id: string;
    journal_number: number;
    journal_date: string;
    status: string;
    source_type: string;
    memo: string | null;
    lines: Array<{ debit_minor: bigint | number; credit_minor: bigint | number }>;
  }>,
  opts: { from?: string; to?: string; status?: string },
): JournalReportRow[] {
  return journals
    .filter((j) => inDateRange(j.journal_date, opts.from, opts.to))
    .filter((j) => !opts.status || j.status === opts.status)
    .map((j) => {
      let d = 0n;
      let c = 0n;
      for (const l of j.lines) {
        d += asBig(l.debit_minor);
        c += asBig(l.credit_minor);
      }
      return {
        journal_id: j.id,
        journal_number: j.journal_number,
        journal_date: j.journal_date,
        status: j.status,
        source_type: j.source_type,
        memo: j.memo,
        total_debit_minor: d,
        total_credit_minor: c,
      };
    })
    .sort(
      (a, b) => a.journal_date.localeCompare(b.journal_date) || a.journal_number - b.journal_number,
    );
}

/** Control account balance from posted lines as-of date. */
export function accountBalanceAsOf(lines: PostedLine[], accountId: string, asOf: string): bigint {
  let bal = 0n;
  for (const l of lines) {
    if (l.account_id !== accountId) continue;
    if (l.journal_date > asOf) continue;
    bal += lineNetBase(l);
  }
  return bal;
}
