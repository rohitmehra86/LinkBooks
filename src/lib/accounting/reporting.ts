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
  debit_minor: bigint;
  credit_minor: bigint;
};

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
      debit_minor: 0n,
      credit_minor: 0n,
    };
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

export function buildProfitAndLoss(
  lines: PostedLine[],
  opts: { from: string; to: string },
): { income: bigint; expense: bigint; net: bigint; rows: TrialBalanceRow[] } {
  const filtered = lines.filter(
    (l) =>
      (l.account_type === "income" || l.account_type === "expense") &&
      inDateRange(l.journal_date, opts.from, opts.to),
  );
  const { rows } = buildTrialBalance(filtered, opts);
  let income = 0n;
  let expense = 0n;
  for (const row of rows) {
    if (row.account_type === "income") {
      income += row.credit_minor - row.debit_minor;
    } else {
      expense += row.debit_minor - row.credit_minor;
    }
  }
  return { income, expense, net: income - expense, rows };
}

export function buildBalanceSheet(
  lines: PostedLine[],
  opts: { asOf: string },
): {
  assets: bigint;
  liabilities: bigint;
  equity: bigint;
  rows: TrialBalanceRow[];
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
  return {
    assets,
    liabilities,
    equity,
    rows,
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
  rows: Array<{ category: string; amount_minor: bigint }>;
} {
  const bankSet = new Set(opts.bankAccountIds);
  let opening = 0n;
  for (const l of lines) {
    if (!bankSet.has(l.account_id)) continue;
    if (l.journal_date < opts.from) {
      opening += asBig(l.debit_minor) - asBig(l.credit_minor);
    }
  }

  // Group non-bank lines by journal to classify bank movements
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

    const counterpart = others[0]?.account_type ?? "unknown";
    if (counterpart === "income" || counterpart === "expense" || counterpart === "liability") {
      // AP/AR/tax/opex/revenue → operating
      operating += bankNet;
    } else if (counterpart === "asset") {
      // Non-bank asset (equipment etc.) → investing; if unknown treat as investing when asset
      investing += bankNet;
    } else if (counterpart === "equity") {
      financing += bankNet;
    } else {
      operating += bankNet;
    }
  }

  const net = operating + investing + financing;
  return {
    operating,
    investing,
    financing,
    net_change: net,
    opening_cash: opening,
    closing_cash: opening + net,
    rows: [
      { category: "Operating", amount_minor: operating },
      { category: "Investing", amount_minor: investing },
      { category: "Financing", amount_minor: financing },
      { category: "Net change in cash", amount_minor: net },
    ],
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
