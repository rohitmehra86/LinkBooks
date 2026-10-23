/**
 * Per-currency open balance aggregation for contacts (C-04). Amounts in different currencies
 * are never added together; the base currency is reported separately for headline figures.
 */

export type OpenDocRow = {
  currency_code: string | null;
  total_minor: number | string | bigint;
  amount_paid_minor: number | string | bigint;
  amount_credited_minor: number | string | bigint;
  due_date: string | null;
};

export type CurrencyBalance = {
  currency: string;
  outstandingMinor: number;
  overdueMinor: number;
};

export function aggregateOutstanding(
  rows: OpenDocRow[],
  today: string,
  baseCurrency: string,
): { byCurrency: CurrencyBalance[]; base: CurrencyBalance } {
  const base = baseCurrency.toUpperCase();
  const map = new Map<string, CurrencyBalance>();
  for (const r of rows) {
    const currency = (r.currency_code ?? base).toUpperCase();
    const out =
      Number(r.total_minor) - Number(r.amount_paid_minor) - Number(r.amount_credited_minor);
    if (!(out > 0)) continue;
    const entry = map.get(currency) ?? { currency, outstandingMinor: 0, overdueMinor: 0 };
    entry.outstandingMinor += out;
    if (r.due_date && r.due_date < today) entry.overdueMinor += out;
    map.set(currency, entry);
  }
  const byCurrency = [...map.values()].sort((a, b) =>
    a.currency === base ? -1 : b.currency === base ? 1 : a.currency.localeCompare(b.currency),
  );
  return {
    byCurrency,
    base: map.get(base) ?? { currency: base, outstandingMinor: 0, overdueMinor: 0 },
  };
}
