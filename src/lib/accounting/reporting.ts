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
  memo?: string | null;
  source_type?: string;
  description?: string | null;
};

export type TrialBalanceRow = {
  account_id: string;
  code: string;
  name: string;
  account_type: AccountType;
  subtype?: string | null;
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
      debit_minor: 0n,
      credit_minor: 0n,
    };
    if (!existing.subtype && line.account_subtype) existing.subtype = line.account_subtype;
    existing.debit_minor += lineToBaseMinor(line.debit_minor, line.fx_rate_to_base);
    existing.credit_minor += lineToBaseMinor(line.credit_minor, line.fx_rate_to_base);
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
  | "revenue"
  | "contra_revenue"
  | "cost_of_sales"
  | "operating_expense"
  | "other";

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
  const filtered = lines.filter(
    (l) =>
      (l.account_type === "income" || l.account_type === "expense") &&
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

export function buildBalanceSheet(
  lines: PostedLine[],
  opts: { asOf: string },
): {
  assets: bigint;
  liabilities: bigint;
  equity: bigint;
  rows: TrialBalanceRow[];
  sections: ReturnType<typeof groupBalanceSheetRows>;
  equationHolds: boolean;
  retainedEarningsMinor: bigint;
} {
  const bsLines = lines.filter(
    (l) =>
      (l.account_type === "asset" || l.account_type === "liability" || l.account_type === "equity") &&
      l.journal_date <= opts.asOf,
  );
  const pl = buildProfitAndLoss(lines, { from: "0001-01-01", to: opts.asOf });
  const { rows } = buildTrialBalance(bsLines, { to: opts.asOf });

  let assets = 0n;
  let liabilities = 0n;
  let equity = 0n;
  for (const row of rows) {
    if (row.account_type === "asset") assets += row.debit_minor - row.credit_minor;
    if (row.account_type === "liability") liabilities += row.credit_minor - row.debit_minor;
    if (row.account_type === "equity") equity += row.credit_minor - row.debit_minor;
  }
  equity += pl.net;
  // Present retained earnings as a synthetic equity row for sectioned BS
  const rowsWithRe: TrialBalanceRow[] = [...rows];
  if (pl.net !== 0n) {
    rowsWithRe.push({
      account_id: "__retained_earnings__",
      code: "CYRE",
      name: "Current year earnings",
      account_type: "equity",
      subtype: "equity",
      debit_minor: pl.net < 0n ? -pl.net : 0n,
      credit_minor: pl.net > 0n ? pl.net : 0n,
    });
  }
  return {
    assets,
    liabilities,
    equity,
    rows: rowsWithRe,
    sections: groupBalanceSheetRows(rowsWithRe),
    retainedEarningsMinor: pl.net,
    equationHolds: assets === liabilities + equity,
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
      opening += asBig(l.debit_minor) - asBig(l.credit_minor);
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

/**
 * Cash movement report from bank GL accounts (direct method proxy).
 * Classifies by counterpart account_type on the same journal.
 * Not a full IAS 7 statement — see jurisdiction docs.
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
  limitation: string;
} {
  const bankSet = new Set(opts.bankAccountIds);
  let opening = 0n;
  let closingLedger = 0n;
  for (const l of lines) {
    if (!bankSet.has(l.account_id)) continue;
    const net = asBig(l.debit_minor) - asBig(l.credit_minor);
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

  let operating = 0n;
  let investing = 0n;
  let financing = 0n;

  for (const [, jlines] of byJournal) {
    const bankLines = jlines.filter((l) => bankSet.has(l.account_id));
    if (!bankLines.length) continue;
    const others = jlines.filter((l) => !bankSet.has(l.account_id));
    let bankNet = 0n;
    for (const b of bankLines) bankNet += asBig(b.debit_minor) - asBig(b.credit_minor);

    // Opening-balance / conversion journals are starting cash, not period activity.
    const source = (bankLines[0]?.source_type ?? others[0]?.source_type ?? "").toLowerCase();
    if (source === "opening_balance" || source === "opening") {
      opening += bankNet;
      continue;
    }

    const counterpart = others[0]?.account_type ?? "unknown";
    // Prefer counterpart semantics: loans (non-current liability) → financing; PPE → investing
    const counterpartSubtype = (others[0]?.account_subtype ?? "").toLowerCase();
    if (counterpart === "equity" || counterpartSubtype.includes("loan")) {
      financing += bankNet;
    } else if (
      counterpart === "asset" &&
      (counterpartSubtype.includes("non_current") ||
        counterpartSubtype.includes("fixed") ||
        others.some((o) => o.account_code.startsWith("15")))
    ) {
      investing += bankNet;
    } else if (counterpart === "income" || counterpart === "expense" || counterpart === "liability") {
      operating += bankNet;
    } else if (counterpart === "asset") {
      investing += bankNet;
    } else {
      operating += bankNet;
    }
  }

  const net = operating + investing + financing;
  const closingFromMovements = opening + net;
  return {
    operating,
    investing,
    financing,
    net_change: net,
    opening_cash: opening,
    closing_cash: closingFromMovements,
    closing_cash_ledger: closingLedger,
    reconciles: closingFromMovements === closingLedger,
    rows: [
      { category: "Operating", amount_minor: operating },
      { category: "Investing", amount_minor: investing },
      { category: "Financing", amount_minor: financing },
      { category: "Net change in cash", amount_minor: net },
    ],
    limitation:
      "Bank GL direct-method proxy. Opening-balance journals are treated as opening cash, not period inflows. Not a full IAS 7 / local-GAAP cash-flow statement.",
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
  const detail = lines.filter(
    (l) => taxSet.has(l.account_id) && inDateRange(l.journal_date, opts.from, opts.to),
  );
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
    .sort((a, b) => a.journal_date.localeCompare(b.journal_date) || a.journal_number - b.journal_number);
}

/** Control account balance from posted lines as-of date. */
export function accountBalanceAsOf(
  lines: PostedLine[],
  accountId: string,
  asOf: string,
): bigint {
  let bal = 0n;
  for (const l of lines) {
    if (l.account_id !== accountId) continue;
    if (l.journal_date > asOf) continue;
    bal += asBig(l.debit_minor) - asBig(l.credit_minor);
  }
  return bal;
}
