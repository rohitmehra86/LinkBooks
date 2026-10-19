/**
 * Authoritative money helpers for LinkBooks.
 * Ledger amounts are integer minor units (e.g. cents). Never use IEEE float for totals.
 */

export const DEFAULT_CURRENCY_DECIMALS: Record<string, number> = {
  USD: 2,
  GBP: 2,
  EUR: 2,
  AUD: 2,
  NZD: 2,
  CAD: 2,
  INR: 2,
  SGD: 2,
  ZAR: 2,
  AED: 2,
  JPY: 0,
  KWD: 3,
};

export function decimalPlacesFor(currencyCode: string): number {
  const code = currencyCode.toUpperCase();
  return DEFAULT_CURRENCY_DECIMALS[code] ?? 2;
}

/** Convert a decimal string/number display amount to minor units (half-up). */
export function toMinorUnits(amount: string | number, currencyCode: string): bigint {
  const places = decimalPlacesFor(currencyCode);
  // Avoid Number() for the full value — parse as string parts only.
  // Prefer string inputs. Numbers are accepted only as a convenience and converted
  // via fixed decimal expansion — never accumulate floats across lines.
  const raw =
    typeof amount === "number"
      ? (() => {
          if (!Number.isFinite(amount)) throw new Error(`Invalid money amount: ${amount}`);
          return amount.toFixed(Math.min(places + 4, 12));
        })()
      : String(amount).trim();
  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`Invalid money amount: ${amount}`);
  }
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [wholePart, fracPart = ""] = unsigned.split(".");
  const whole = BigInt(wholePart || "0");
  const scale = 10n ** BigInt(places);
  const kept = fracPart.slice(0, places);
  const roundDigit = fracPart.length > places ? fracPart.charAt(places) : "";
  let frac = BigInt(kept.padEnd(places, "0") || "0");
  if (roundDigit !== "" && roundDigit >= "5") {
    frac += 1n;
  }
  let minor = whole * scale + frac;
  // Carry if rounding overflowed fractional part (e.g. 1.995 → 2.00)
  if (frac >= scale) {
    minor = (whole + frac / scale) * scale + (frac % scale);
  }
  return negative ? -minor : minor;
}

export function fromMinorUnits(minor: bigint | number, currencyCode: string): string {
  const places = decimalPlacesFor(currencyCode);
  const value = typeof minor === "number" ? BigInt(minor) : minor;
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(places);
  const whole = abs / scale;
  const frac = abs % scale;
  const fracStr = frac.toString().padStart(places, "0");
  const body = places === 0 ? whole.toString() : `${whole.toString()}.${fracStr}`;
  return negative ? `-${body}` : body;
}

export function sumMinor(values: Iterable<bigint | number>): bigint {
  let total = 0n;
  for (const v of values) total += typeof v === "number" ? BigInt(v) : v;
  return total;
}

export type JournalLineDraft = {
  account_id: string;
  description?: string;
  debit_minor: bigint | number;
  credit_minor: bigint | number;
};

export function assertLinesBalance(lines: JournalLineDraft[]): { debit: bigint; credit: bigint } {
  if (lines.length < 2) throw new Error("Journal requires at least two lines");
  let debit = 0n;
  let credit = 0n;
  for (const [i, line] of lines.entries()) {
    const d = typeof line.debit_minor === "number" ? BigInt(line.debit_minor) : line.debit_minor;
    const c = typeof line.credit_minor === "number" ? BigInt(line.credit_minor) : line.credit_minor;
    if (d < 0n || c < 0n) throw new Error(`Line ${i + 1}: amounts must be non-negative`);
    if ((d > 0n && c > 0n) || (d === 0n && c === 0n)) {
      throw new Error(`Line ${i + 1}: set either debit or credit, not both or neither`);
    }
    debit += d;
    credit += c;
  }
  if (debit !== credit) {
    throw new Error(`Journal does not balance: debits ${debit} <> credits ${credit} (minor units)`);
  }
  if (debit === 0n) throw new Error("Journal total cannot be zero");
  return { debit, credit };
}
