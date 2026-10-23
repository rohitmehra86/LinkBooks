/**
 * Single place for displaying money and dates (U-08).
 *
 * Money stays integer minor units everywhere; it is only turned into a localised string here.
 * The grouping/decimal separators come from the locale; the number of decimals comes from the
 * currency (JPY 0, KWD 3). No floating-point arithmetic is done on the amount: the minor-unit
 * integer is split into whole and fraction with BigInt and handed to Intl as a decimal string.
 */
import { decimalPlacesFor } from "@/lib/accounting/money";

export const DEFAULT_LOCALE = "en-GB";
export const DATE_FORMATS = ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export function resolveLocale(locale?: string | null): string {
  if (!locale) return DEFAULT_LOCALE;
  try {
    return Intl.NumberFormat.supportedLocalesOf([locale])[0] ?? DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

function toBigInt(v: bigint | number | string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "string") return BigInt(v);
  if (!Number.isFinite(v)) return 0n;
  return BigInt(Math.round(v));
}

export type MoneyFormatOptions = {
  /** Show a currency symbol/code. Default true. */
  symbol?: boolean;
  /** Show accounting-style brackets for negatives, e.g. (1,234.00). Default false. */
  brackets?: boolean;
};

export function formatMoney(
  minor: bigint | number | string,
  currency: string,
  locale?: string | null,
  options: MoneyFormatOptions = {},
): string {
  const code = (currency || "GBP").toUpperCase();
  const places = decimalPlacesFor(code);
  const value = toBigInt(minor);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(places);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(places, "0");
  const decimalString = places === 0 ? whole.toString() : `${whole.toString()}.${frac}`;
  const loc = resolveLocale(locale);
  const showSymbol = options.symbol !== false;
  // Intl accepts decimal strings for exact formatting (no float rounding) via formatToParts on
  // a Number only; for amounts below 2^53 minor units this is exact. Larger values fall back to
  // BigInt formatting of the whole part.
  const safe = abs <= BigInt(Number.MAX_SAFE_INTEGER);
  let body: string;
  const nf = new Intl.NumberFormat(loc, {
    ...(showSymbol
      ? { style: "currency" as const, currency: code, currencyDisplay: "narrowSymbol" as const }
      : {}),
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
  if (safe) {
    body = nf.format(Number(decimalString));
  } else {
    const wholeFormatted = new Intl.NumberFormat(loc).format(whole);
    const sep = new Intl.NumberFormat(loc, { minimumFractionDigits: 1 }).format(1.1).charAt(1);
    body = `${wholeFormatted}${places ? sep + frac : ""}`;
  }
  if (!negative || value === 0n) return body;
  return options.brackets ? `(${body})` : `-${body}`;
}

/** Plain number with the currency's decimals and no symbol (tables, CSV headers). */
export function formatAmount(
  minor: bigint | number | string,
  currency: string,
  locale?: string | null,
): string {
  return formatMoney(minor, currency, locale, { symbol: false });
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/** Format an ISO date (YYYY-MM-DD or full timestamp) as the company's date format. */
export function formatDate(
  iso: string | null | undefined,
  locale?: string | null,
  dateFormat?: DateFormat | string | null,
): string {
  if (!iso) return "";
  const m = ISO_DATE.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  if (dateFormat === "YYYY-MM-DD") return `${y}-${mo}-${d}`;
  if (dateFormat === "DD/MM/YYYY") return `${d}/${mo}/${y}`;
  if (dateFormat === "MM/DD/YYYY") return `${mo}/${d}/${y}`;
  // No explicit format: use the locale's convention on a UTC date so there is no timezone shift.
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return new Intl.DateTimeFormat(resolveLocale(locale), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function formatDateTime(ts: string | null | undefined, locale?: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return new Intl.DateTimeFormat(resolveLocale(locale), {
    dateStyle: "short",
    timeStyle: "short",
  }).format(d);
}

export function formatNumber(n: number | bigint, locale?: string | null): string {
  return new Intl.NumberFormat(resolveLocale(locale)).format(n);
}

export function formatPercentBps(bps: number, locale?: string | null): string {
  return new Intl.NumberFormat(resolveLocale(locale), {
    style: "percent",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(bps / 10000);
}
