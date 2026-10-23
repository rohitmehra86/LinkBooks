/**
 * Tolerant money-input parser for banking screens (BK-17).
 *
 * `toMinorUnits` in accounting/money.ts is deliberately strict (digits and one "." only) and throws,
 * so "12,500.00" fails. This module accepts what people actually type or what banks export:
 * thousands separators (`,` `.` space, apostrophe, nbsp), a decimal comma, currency symbols,
 * accounting negatives `(12.50)`, a trailing minus `12.50-` and `CR` / `DR` suffixes.
 * `tryParseMinor` NEVER throws — it returns null for anything it cannot read unambiguously.
 * Result is integer minor units (bigint) using the currency's decimal places; no floats are involved.
 */
import { decimalPlacesFor, toMinorUnits } from "@/lib/accounting/money";

export type DecimalSeparator = "." | "," | "auto";

export type MoneyInputOptions = {
  /** `auto` picks the separator from the text; pass "." or "," when the source format is known (CSV). */
  decimalSeparator?: DecimalSeparator;
  /**
   * When true, digits beyond the currency's decimal places must be zero (e.g. "1.505" for GBP → null).
   * Default false: extra digits are rounded half-up like toMinorUnits.
   */
  strict?: boolean;
  /** Interpret trailing `CR` as positive and `DR` as negative (statement convention). Default false. */
  crDrSuffix?: boolean;
  /** Default true. When false a negative amount returns null. */
  allowNegative?: boolean;
};

const CURRENCY_SYMBOLS = /[£$€¥₹₩₪₫฿₦₱₽₺]/g;
const SPACES = /[\s\u00a0\u202f\u2009']/g;

export type NormalizedAmount = { negative: boolean; digits: string } | null;

/** Normalise free text to `{ negative, digits: "123.45" }`, or null when unreadable. */
export function normalizeAmountText(
  raw: string,
  decimalPlaces: number,
  opts: MoneyInputOptions = {},
): NormalizedAmount {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;

  let negative = false;
  let suffixSign: "cr" | "dr" | null = null;

  const suffix = s.match(/\s*(cr|dr)\.?$/i);
  if (suffix) {
    if (!opts.crDrSuffix) return null;
    suffixSign = suffix[1]!.toLowerCase() === "cr" ? "cr" : "dr";
    s = s.slice(0, suffix.index).trim();
  }

  s = s
    .replace(CURRENCY_SYMBOLS, "")
    .replace(/^[A-Za-z]{3}\s*/, "")
    .replace(/\s*[A-Za-z]{3}$/, "");
  s = s.replace(SPACES, "");

  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1);
  } else if (s.endsWith("+")) {
    s = s.slice(0, -1);
  }
  if (suffixSign === "dr") negative = !negative;

  if (!s || !/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;

  const dots = (s.match(/\./g) ?? []).length;
  const commas = (s.match(/,/g) ?? []).length;
  const mode = opts.decimalSeparator ?? "auto";

  let decimal: "." | "," | null;
  if (mode === "." || mode === ",") {
    decimal = mode;
  } else if (dots > 0 && commas > 0) {
    decimal = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
  } else if (dots > 0) {
    decimal = dots === 1 ? "." : null;
  } else if (commas > 0) {
    if (commas > 1) {
      decimal = null;
    } else {
      const after = s.length - s.indexOf(",") - 1;
      // "1,234" is a thousands separator; "12,5" / "12,50" is a decimal comma.
      decimal = after === 3 && decimalPlaces !== 3 ? null : after === 0 ? null : ",";
    }
  } else {
    decimal = null;
  }

  if (decimal !== null && !s.includes(decimal)) decimal = null;

  let whole: string;
  let frac = "";
  if (decimal === null) {
    // Only thousands separators: every group after the first must be exactly 3 digits.
    if (!/^\d*$/.test(s) && !/^\d{1,3}([.,]\d{3})+$/.test(s)) return null;
    whole = s.replace(/[.,]/g, "");
  } else {
    const idx = s.lastIndexOf(decimal);
    const groupSep = decimal === "." ? "," : ".";
    const rawWhole = s.slice(0, idx);
    const groupRe = new RegExp(`^\\d{1,3}(\\${groupSep}\\d{3})+$`);
    if (!/^\d*$/.test(rawWhole) && !groupRe.test(rawWhole)) return null;
    whole = rawWhole.split(groupSep).join("");
    frac = s.slice(idx + 1);
    // Only one decimal separator is allowed, and the fractional part must be plain digits.
    if (/[.,]/.test(frac)) return null;
  }
  if (/[.,]/.test(whole)) return null;
  if (!whole && !frac) return null;
  if (!whole) whole = "0";

  if (opts.strict && frac.length > decimalPlaces && /[1-9]/.test(frac.slice(decimalPlaces))) {
    return null;
  }

  return { negative, digits: frac ? `${whole}.${frac}` : whole };
}

/** Never throws. Returns minor units or null. */
export function tryParseMinor(
  raw: string | number | null | undefined,
  currencyCode: string,
  opts: MoneyInputOptions = {},
): bigint | null {
  try {
    if (raw === null || raw === undefined) return null;
    const text = typeof raw === "number" ? (Number.isFinite(raw) ? String(raw) : "") : raw;
    const places = decimalPlacesFor(currencyCode);
    const normalized = normalizeAmountText(text, places, opts);
    if (!normalized) return null;
    const minor = toMinorUnits(normalized.digits, currencyCode);
    const signed = normalized.negative ? -minor : minor;
    if (signed < 0n && opts.allowNegative === false) return null;
    return signed;
  } catch {
    return null;
  }
}

/** Throws a user-friendly error naming the field. Prefer `tryParseMinor` in UI validation. */
export function parseMinorOrThrow(
  raw: string,
  currencyCode: string,
  label = "Amount",
  opts: MoneyInputOptions = {},
): bigint {
  const v = tryParseMinor(raw, currencyCode, opts);
  if (v === null) throw new Error(`${label} is not a valid amount`);
  return v;
}
