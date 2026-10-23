/**
 * Pure presentation maths for the dashboard KPI row and checklist. Everything here is derived
 * from the snapshot the server already computed; nothing is invented or estimated.
 */

export type AgeingRow = { currency: string; count: number; total: number; overdue: number };

/** Percentage change from `prior` to `current`; null when prior is zero (no meaningful base). */
export function percentChange(current: number, prior: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(prior) || prior === 0) return null;
  return ((current - prior) / Math.abs(prior)) * 100;
}

/** "+12.4%" / "−3.0%" / "0.0%" — one decimal, real minus sign. */
export function formatPercentChange(pct: number): string {
  const rounded = Math.round(Math.abs(pct) * 10) / 10;
  if (rounded === 0) return "0.0%";
  return `${pct > 0 ? "+" : "−"}${rounded.toFixed(1)}%`;
}

export function trendDirection(pct: number): "up" | "down" | "flat" {
  const rounded = Math.round(Math.abs(pct) * 10) / 10;
  if (rounded === 0) return "flat";
  return pct > 0 ? "up" : "down";
}

/** Sum of bank ledger balances (all already in the base currency by the snapshot). */
export function totalCash(banks: Array<{ ledgerBalanceMinor: number }>): number {
  return banks.reduce((s, b) => s + b.ledgerBalanceMinor, 0);
}

/**
 * Totals owed (receivables or payables). Amounts in the base currency are returned as the
 * headline; if documents exist in other currencies, `otherCurrencies` lists them so the UI can say
 * so rather than silently adding unlike currencies.
 */
export function owedSummary(rows: AgeingRow[], baseCurrency: string) {
  const base = rows.find((r) => r.currency === baseCurrency);
  return {
    total: base?.total ?? 0,
    overdue: base?.overdue ?? 0,
    count: base?.count ?? 0,
    otherCurrencies: rows.filter((r) => r.currency !== baseCurrency).map((r) => r.currency),
  };
}

export type CashTotals = { in: number; out: number; net: number };

export function cashTotals(months: Array<{ in_minor: number; out_minor: number }>): CashTotals {
  const inn = months.reduce((s, m) => s + m.in_minor, 0);
  const out = months.reduce((s, m) => s + m.out_minor, 0);
  return { in: inn, out, net: inn - out };
}

/** Share of each ageing bucket (0–1) of the bucket total, for the proportional bar. */
export function bucketShares(buckets: number[]): number[] {
  const sum = buckets.reduce((s, b) => s + Math.max(b, 0), 0);
  if (sum <= 0) return buckets.map(() => 0);
  return buckets.map((b) => Math.max(b, 0) / sum);
}

export type ChecklistInput = {
  banks: number;
  hasBankMovements: boolean;
  invoices: boolean;
  bills: boolean;
  hasLedgerActivity: boolean;
};

export type ChecklistItem = {
  id: "bank" | "bank-data" | "invoice" | "bill" | "ledger";
  label: string;
  hint: string;
  to: string;
  done: boolean;
};

/** Getting-started steps. Each `done` flag is read from the company's real records. */
export function buildChecklist(i: ChecklistInput): ChecklistItem[] {
  return [
    {
      id: "bank",
      label: "Add a bank account",
      hint: "So balances and reconciliation have somewhere to live.",
      to: "/banking",
      done: i.banks > 0,
    },
    {
      id: "bank-data",
      label: "Bring in bank transactions",
      hint: "Import a statement file to start reconciling.",
      to: "/banking/import",
      done: i.hasBankMovements,
    },
    {
      id: "invoice",
      label: "Create your first invoice",
      hint: "Bill a customer and track what they owe.",
      to: "/sales/invoices/new",
      done: i.invoices,
    },
    {
      id: "bill",
      label: "Enter your first bill",
      hint: "Record what you owe a supplier.",
      to: "/purchases/bills/new",
      done: i.bills,
    },
    {
      id: "ledger",
      label: "Post to the ledger",
      hint: "Approved documents and journals feed every report.",
      to: "/accounting",
      done: i.hasLedgerActivity,
    },
  ];
}

/** Show the checklist only for a company that has not yet posted anything and has steps left. */
export function shouldShowChecklist(items: ChecklistItem[], hasLedgerActivity: boolean): boolean {
  return !hasLedgerActivity && items.some((i) => !i.done);
}
