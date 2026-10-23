import { useMemo } from "react";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  DEFAULT_LOCALE,
  formatAmount,
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPercentBps,
  type MoneyFormatOptions,
} from "@/lib/format/format";

/** Formatters bound to the active company's locale, date format and base currency (U-08). */
export function useFormat() {
  const { company } = useActiveCompany();
  const locale = company?.locale ?? DEFAULT_LOCALE;
  const dateFormat = company?.date_format ?? null;
  const baseCurrency = company?.base_currency ?? "GBP";
  return useMemo(
    () => ({
      locale,
      baseCurrency,
      /** Money with symbol; currency defaults to the company base currency. */
      money: (minor: bigint | number | string, currency?: string, opts?: MoneyFormatOptions) =>
        formatMoney(minor, currency ?? baseCurrency, locale, opts),
      /** Number with the currency's decimals, no symbol. */
      amount: (minor: bigint | number | string, currency?: string) =>
        formatAmount(minor, currency ?? baseCurrency, locale),
      date: (iso: string | null | undefined) => formatDate(iso, locale, dateFormat),
      dateTime: (ts: string | null | undefined) => formatDateTime(ts, locale),
      number: (n: number | bigint) => formatNumber(n, locale),
      percentBps: (bps: number) => formatPercentBps(bps, locale),
    }),
    [locale, dateFormat, baseCurrency],
  );
}
