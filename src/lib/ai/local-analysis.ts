/**
 * Deterministic analyses — labelled as calculated facts, not model output.
 * Safe to run without an AI provider.
 */

export type BankTxnLike = {
  id: string;
  amount_minor: number;
  txn_date: string;
  description: string | null;
  status: string | null;
};

export type DuplicateCandidate = {
  a_id: string;
  b_id: string;
  reason: string;
  amount_minor: number;
  txn_date: string;
};

export function findPossibleDuplicateTransactions(
  txns: BankTxnLike[],
  opts: { dayWindow?: number } = {},
): DuplicateCandidate[] {
  const dayWindow = opts.dayWindow ?? 3;
  const out: DuplicateCandidate[] = [];
  const sorted = [...txns].sort((a, b) => a.txn_date.localeCompare(b.txn_date));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      const days = Math.abs(daysBetween(a.txn_date, b.txn_date));
      if (days > dayWindow) break;
      if (a.amount_minor !== b.amount_minor) continue;
      const da = normalizeDesc(a.description);
      const db = normalizeDesc(b.description);
      if (da && db && (da === db || da.includes(db) || db.includes(da))) {
        out.push({
          a_id: a.id,
          b_id: b.id,
          amount_minor: a.amount_minor,
          txn_date: a.txn_date,
          reason: `Same amount and similar description within ${dayWindow} days`,
        });
      } else if (days === 0 && a.amount_minor !== 0) {
        out.push({
          a_id: a.id,
          b_id: b.id,
          amount_minor: a.amount_minor,
          txn_date: a.txn_date,
          reason: "Same amount on the same date",
        });
      }
    }
  }
  return out.slice(0, 50);
}

export type ReconcileException = {
  kind: "uncategorised" | "excluded_with_amount";
  id: string;
  description: string;
  amount_minor: number;
  txn_date: string;
};

export function findReconciliationExceptions(txns: BankTxnLike[]): ReconcileException[] {
  const out: ReconcileException[] = [];
  for (const t of txns) {
    const status = (t.status ?? "uncategorised").toLowerCase();
    if (status === "uncategorised") {
      out.push({
        kind: "uncategorised",
        id: t.id,
        description: t.description ?? "(no description)",
        amount_minor: t.amount_minor,
        txn_date: t.txn_date,
      });
    }
  }
  return out.slice(0, 100);
}

export type MovementRow = {
  account_code: string;
  account_name: string;
  net_minor: number;
};

/** Highlight accounts whose absolute net exceeds a floor and (when n≥5) mean+2σ. */
export function highlightUnusualMovements(
  rows: MovementRow[],
  opts: { minAbsMinor?: number } = {},
): MovementRow[] {
  const minAbs = opts.minAbsMinor ?? 100_000; // default £1,000.00
  if (rows.length === 0) return [];
  const abs = rows.map((r) => Math.abs(r.net_minor));
  let threshold = minAbs;
  if (rows.length >= 5) {
    const mean = abs.reduce((a, b) => a + b, 0) / abs.length;
    const variance =
      abs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(abs.length, 1);
    const std = Math.sqrt(variance);
    threshold = Math.max(minAbs, mean + 2 * std);
  }
  return rows
    .filter((r) => Math.abs(r.net_minor) >= threshold)
    .sort((a, b) => Math.abs(b.net_minor) - Math.abs(a.net_minor))
    .slice(0, 20);
}

export const NAVIGATION_HELP: Array<{ q: RegExp; answer: string }> = [
  {
    q: /invoice|sales/i,
    answer: "Sales → Invoices to create or authorise customer invoices. Authorising posts via the shared ledger engine.",
  },
  {
    q: /bill|purchase|supplier/i,
    answer: "Purchases → Bills for supplier bills. Authorising posts AP; payments are under Purchases → Payments.",
  },
  {
    q: /reconcil|bank/i,
    answer: "Banking → Reconcile and Transactions. Import CSV under Banking → Import. Feeds are not connected unless configured.",
  },
  {
    q: /trial\s*balance|report|p&l|profit/i,
    answer: "Reports for Trial Balance, P&L and Balance Sheet built from posted journals only.",
  },
  {
    q: /period|lock|year.?end/i,
    answer: "Accounting → Periods to lock/unlock. Locked periods reject posts. Settings holds financial year end.",
  },
  {
    q: /tax|vat|gst/i,
    answer: "Tax for rates/codes and summaries. Settings holds tax regime. There is no automatic filing integration.",
  },
  {
    q: /demo/i,
    answer: "Open Demo Company from the company switcher. Reset is under Settings → Demo (demo orgs only).",
  },
];

export function answerNavigation(question: string): string | null {
  for (const row of NAVIGATION_HELP) {
    if (row.q.test(question)) return row.answer;
  }
  return null;
}

function normalizeDesc(d: string | null): string {
  return (d ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);
}

function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}
