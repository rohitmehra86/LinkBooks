/**
 * Non-throwing money-input parsing for live (render-time) totals.
 *
 * `toMinorUnits` in `@/lib/accounting/money` throws on anything that is not a plain
 * decimal, which crashes a page when it is called while the user is still typing
 * ("12.", "1,250.00", "-"). Render paths use `tryParseMinor` / `minorOrZero`;
 * submit handlers use `parseMinorOrThrow` so the user gets a readable message.
 */

import { toMinorUnits } from "@/lib/accounting/money";

const GROUPED = /^\d{1,3}(,\d{3})+(\.\d*)?$/;
const PLAIN = /^\d*(\.\d*)?$/;

/**
 * Normalise what a user typed into `[-]digits[.digits]`, or null if it is not a number.
 * Accepts thousands separators ("1,250.00"), a leading currency symbol, spaces,
 * a trailing decimal point ("12.") and a leading one (".5").
 */
export function normaliseMoneyInput(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return normaliseMoneyInput(value.toFixed(6));
  }
  let raw = String(value).replace(/[\s\u00a0\u202f]/g, "");
  if (!raw) return null;
  let negative = false;
  if (raw.startsWith("-")) {
    negative = true;
    raw = raw.slice(1);
  }
  raw = raw.replace(/^[£$€¥₹]+/, "");
  if (!raw) return null;
  if (raw.includes(",")) {
    if (!GROUPED.test(raw)) return null;
    raw = raw.replace(/,/g, "");
  }
  if (!PLAIN.test(raw)) return null;
  if (raw === "" || raw === ".") return null;
  if (raw.startsWith(".")) raw = `0${raw}`;
  if (raw.endsWith(".")) raw = raw.slice(0, -1);
  return negative ? `-${raw}` : raw;
}

/** Parse to minor units; returns null for blank or invalid input. Never throws. */
export function tryParseMinor(
  value: string | number | null | undefined,
  currency: string,
): bigint | null {
  const normalised = normaliseMoneyInput(value);
  if (normalised === null) return null;
  try {
    return toMinorUnits(normalised, currency);
  } catch {
    return null;
  }
}

/** For live totals: invalid or blank input counts as zero instead of crashing. */
export function minorOrZero(value: string | number | null | undefined, currency: string): bigint {
  return tryParseMinor(value, currency) ?? 0n;
}

/** For submit handlers: throws a readable error naming the field. */
export function parseMinorOrThrow(
  value: string | number | null | undefined,
  currency: string,
  label = "Amount",
): bigint {
  const parsed = tryParseMinor(value, currency);
  if (parsed === null) throw new Error(`${label} is not a valid amount`);
  return parsed;
}
