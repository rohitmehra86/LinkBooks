import { ageBucket, type AgingBucket, type PostedLine } from "@/lib/accounting/reporting";
import { addMonthsIso, monthStart } from "@/lib/accounting/fiscal-year";

export type OutstandingDoc = {
  due_date: string;
  currency_code: string;
  /** Outstanding amount in the document's own currency, minor units. */
  outstanding_minor: bigint;
};

export type CurrencyAgeing = {
  currency: string;
  count: number;
  current: bigint;
  b_1_30: bigint;
  b_31_60: bigint;
  b_61_90: bigint;
  b_90_plus: bigint;
  total: bigint;
  /** Everything past its due date (1+ days). */
  overdue: bigint;
};

const FIELD: Record<AgingBucket, "current" | "b_1_30" | "b_31_60" | "b_61_90" | "b_90_plus"> = {
  current: "current",
  "1_30": "b_1_30",
  "31_60": "b_31_60",
  "61_90": "b_61_90",
  "90_plus": "b_90_plus",
};

/** Ageing per currency. Different currencies are never added together. */
export function ageOutstandingByCurrency(docs: OutstandingDoc[], asOf: string): CurrencyAgeing[] {
  const map = new Map<string, CurrencyAgeing>();
  for (const d of docs) {
    if (d.outstanding_minor <= 0n) continue;
    const row = map.get(d.currency_code) ?? {
      currency: d.currency_code,
      count: 0,
      current: 0n,
      b_1_30: 0n,
      b_31_60: 0n,
      b_61_90: 0n,
      b_90_plus: 0n,
      total: 0n,
      overdue: 0n,
    };
    const bucket = ageBucket(d.due_date, asOf);
    row[FIELD[bucket]] += d.outstanding_minor;
    row.total += d.outstanding_minor;
    if (bucket !== "current") row.overdue += d.outstanding_minor;
    row.count += 1;
    map.set(d.currency_code, row);
  }
  return [...map.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/** The last `count` calendar months ending with the month of `asOf`, oldest first (YYYY-MM). */
export function lastMonths(asOf: string, count = 12): string[] {
  const out: string[] = [];
  const first = addMonthsIso(monthStart(asOf), -(count - 1));
  for (let i = 0; i < count; i += 1) out.push(addMonthsIso(first, i).slice(0, 7));
  return out;
}

export type CashMonth = { month: string; in_minor: bigint; out_minor: bigint };

/** Source types that move money between the company's own accounts, not in or out of the business. */
const NON_TRADING_SOURCES = new Set(["bank_transfer", "opening_balance"]);

/**
 * Monthly cash in and out from bank-account ledger lines (base currency).
 * Transfers between own bank accounts and opening balances are not cash in/out.
 */
export function monthlyCashSeries(bankLines: PostedLine[], asOf: string, count = 12): CashMonth[] {
  const months = lastMonths(asOf, count);
  const map = new Map<string, CashMonth>(
    months.map((m) => [m, { month: m, in_minor: 0n, out_minor: 0n }]),
  );
  for (const l of bankLines) {
    if (l.source_type && NON_TRADING_SOURCES.has(l.source_type)) continue;
    const row = map.get(l.journal_date.slice(0, 7));
    if (!row) continue;
    row.in_minor += BigInt(l.debit_minor);
    row.out_minor += BigInt(l.credit_minor);
  }
  return months.map((m) => map.get(m)!);
}
