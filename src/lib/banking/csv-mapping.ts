/**
 * Real-world bank CSV import (BK-07, BK-08, BK-17, BK-19).
 *
 * Pipeline: parseCsvText → (guessMapping | saved mapping) → applyMapping → assignExternalIds.
 * Everything here is pure and runs identically in the browser (preview) and on the server (authoritative import).
 *  - Dates are validated against the real calendar for DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD, DD-MMM-YYYY (+2-digit years).
 *  - Amounts: single signed column, separate debit / credit columns, or CR/DR suffix; "." or "," decimal separator;
 *    converted with the BANK ACCOUNT currency's decimals (JPY 0, KWD 3), never floats.
 *  - Duplicate keys include the ordinal of identical rows inside the file (two £3.50 coffees stay two rows)
 *    and use SHA-256.
 */
import { decimalPlacesFor } from "@/lib/accounting/money";
import { tryParseMinor } from "@/lib/banking/money-input";

export const DATE_FORMATS = [
  "DD/MM/YYYY",
  "MM/DD/YYYY",
  "YYYY-MM-DD",
  "DD-MMM-YYYY",
  "DD/MM/YY",
  "MM/DD/YY",
] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export const AMOUNT_MODES = ["single", "debit_credit", "suffix"] as const;
export type AmountMode = (typeof AMOUNT_MODES)[number];

export type Delimiter = "auto" | "," | ";" | "\t" | "|";

export type ImportMapping = {
  delimiter: Delimiter;
  hasHeader: boolean;
  dateColumn: number;
  dateFormat: DateFormat;
  /** One or more columns joined with a space (e.g. Description + Memo). */
  descriptionColumns: number[];
  referenceColumn: number | null;
  payeeColumn: number | null;
  /** The bank's own transaction id, when the file has one (best duplicate key). */
  bankIdColumn: number | null;
  /** Running balance column; used only to tell identical rows apart. */
  balanceColumn: number | null;
  amountMode: AmountMode;
  /** `single` and `suffix` modes. */
  amountColumn: number | null;
  /** `debit_credit` mode. Debit = money OUT, credit = money IN (bank statement convention). */
  debitColumn: number | null;
  creditColumn: number | null;
  decimalSeparator: "." | ",";
  /** Flip the sign (some banks export outflows as positive numbers). */
  invertSign: boolean;
};

export const DEFAULT_MAPPING: ImportMapping = {
  delimiter: "auto",
  hasHeader: true,
  dateColumn: 0,
  dateFormat: "DD/MM/YYYY",
  descriptionColumns: [1],
  referenceColumn: null,
  payeeColumn: null,
  bankIdColumn: null,
  balanceColumn: null,
  amountMode: "single",
  amountColumn: 2,
  debitColumn: null,
  creditColumn: null,
  decimalSeparator: ".",
  invertSign: false,
};

// ---------------------------------------------------------------------------
// CSV text → rows
// ---------------------------------------------------------------------------

export function detectDelimiter(text: string): "," | ";" | "\t" | "|" {
  const sample = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .slice(0, 10)
    .join("\n");
  const counts: Array<["," | ";" | "\t" | "|", number]> = [
    [",", 0],
    [";", 0],
    ["\t", 0],
    ["|", 0],
  ];
  for (const entry of counts) {
    let inQuotes = false;
    for (const ch of sample) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (!inQuotes && ch === entry[0]) entry[1] += 1;
    }
  }
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ",";
}

/** RFC-4180-style parser: quoted fields, escaped quotes, embedded delimiters and newlines, BOM, CRLF. */
export function parseCsvText(
  text: string,
  delimiter: Delimiter = "auto",
): { delimiter: "," | ";" | "\t" | "|"; rows: string[][] } {
  const src = text.replace(/^\uFEFF/, "");
  const delim = delimiter === "auto" ? detectDelimiter(src) : delimiter;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldHadContent = false;

  const endField = () => {
    row.push(field);
    field = "";
    fieldHadContent = false;
  };
  const endRow = () => {
    endField();
    if (row.length > 1 || (row[0] ?? "").trim() !== "") rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !fieldHadContent) {
      inQuotes = true;
      fieldHadContent = true;
    } else if (ch === delim) {
      endField();
    } else if (ch === "\r") {
      if (src[i + 1] === "\n") i++;
      endRow();
    } else if (ch === "\n") {
      endRow();
    } else {
      field += ch;
      if (ch.trim() !== "") fieldHadContent = true;
    }
  }
  if (field !== "" || row.length > 0) endRow();
  return { delimiter: delim, rows };
}

// ---------------------------------------------------------------------------
// Dates (real calendar validation)
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

export function isRealDate(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function iso(y: number, m: number, d: number): string | null {
  if (!isRealDate(y, m, d)) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function expandYear(yy: number): number {
  return yy < 70 ? 2000 + yy : 1900 + yy;
}

/** Returns YYYY-MM-DD or null (never throws). Rejects 31/02, 13/13, 29 Feb in non-leap years, … */
export function parseDateValue(raw: string, format: DateFormat): string | null {
  const s = raw
    .trim()
    .replace(/[T\s]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(am|pm)?\s*(z|[+-]\d{2}:?\d{2})?$/i, "")
    .trim();
  if (!s) return null;

  switch (format) {
    case "YYYY-MM-DD": {
      const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
      return m ? iso(Number(m[1]), Number(m[2]), Number(m[3])) : null;
    }
    case "DD/MM/YYYY": {
      const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
      return m ? iso(Number(m[3]), Number(m[2]), Number(m[1])) : null;
    }
    case "MM/DD/YYYY": {
      const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
      return m ? iso(Number(m[3]), Number(m[1]), Number(m[2])) : null;
    }
    case "DD/MM/YY": {
      const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2})$/.exec(s);
      return m ? iso(expandYear(Number(m[3])), Number(m[2]), Number(m[1])) : null;
    }
    case "MM/DD/YY": {
      const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2})$/.exec(s);
      return m ? iso(expandYear(Number(m[3])), Number(m[1]), Number(m[2])) : null;
    }
    case "DD-MMM-YYYY": {
      const m = /^(\d{1,2})[\s/.-]+([A-Za-z]{3,9})\.?[\s/.,-]+(\d{2}|\d{4})$/.exec(s);
      if (!m) return null;
      const name = m[2]!.toLowerCase();
      const mon = MONTHS[name] ?? MONTHS[name.slice(0, 3)];
      if (!mon) return null;
      const year = m[3]!.length === 2 ? expandYear(Number(m[3])) : Number(m[3]);
      return iso(year, mon, Number(m[1]));
    }
    default:
      return null;
  }
}

/** Guess the date format from sample strings (day > 12 settles DD/MM vs MM/DD). */
export function guessDateFormat(samples: readonly string[]): DateFormat {
  let dayFirst = false;
  let monthFirst = false;
  let twoDigitYear = false;
  for (const raw of samples) {
    const s = raw.trim();
    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(s)) return "YYYY-MM-DD";
    if (/^\d{1,2}[\s/.-]+[A-Za-z]{3,}/.test(s)) return "DD-MMM-YYYY";
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
    if (!m) continue;
    if (m[3]!.length === 2) twoDigitYear = true;
    if (Number(m[1]) > 12) dayFirst = true;
    if (Number(m[2]) > 12) monthFirst = true;
  }
  if (monthFirst && !dayFirst) return twoDigitYear ? "MM/DD/YY" : "MM/DD/YYYY";
  return twoDigitYear ? "DD/MM/YY" : "DD/MM/YYYY";
}

// ---------------------------------------------------------------------------
// Header-based mapping guess
// ---------------------------------------------------------------------------

function findHeader(
  headers: readonly string[],
  re: RegExp,
  exclude: ReadonlySet<number>,
): number | null {
  for (let i = 0; i < headers.length; i++) {
    if (!exclude.has(i) && re.test(headers[i]!.trim())) return i;
  }
  return null;
}

/** Best-effort mapping from the header row + a few data rows. The user always reviews it. */
export function guessMapping(
  rows: readonly string[][],
  delimiter: Delimiter = "auto",
): ImportMapping {
  const first = rows[0] ?? [];
  const looksLikeHeader =
    first.some((c) => /[A-Za-z]{3,}/.test(c)) && !first.some((c) => /^\s*[-+]?[\d.,]+\s*$/.test(c));
  const body = looksLikeHeader ? rows.slice(1) : rows;
  const used = new Set<number>();
  const take = (re: RegExp): number | null => {
    const idx = looksLikeHeader ? findHeader(first, re, used) : null;
    if (idx !== null) used.add(idx);
    return idx;
  };

  const date = take(/date|posted/i);
  const debit = take(/debit|paid out|withdraw|money out|^out$/i);
  const credit = take(/credit|paid in|deposit|money in|^in$/i);
  const amount =
    debit === null && credit === null ? take(/^(amount|value|transaction amount)\b/i) : null;
  const balance = take(/balance/i);
  const bankId = take(/transaction id|txn id|trans id|^id$|reference number|fitid/i);
  const reference = take(/\bref/i);
  const payee = take(/payee|beneficiary|counterparty|merchant/i);
  const description = take(/desc|narrat|detail|particular|memo|text|name/i);

  const dateCol = date ?? 0;
  const sampleDates = body.slice(0, 25).map((r) => r[dateCol] ?? "");
  const amountCols = [amount, credit, debit].filter((c): c is number => c !== null);
  if (amountCols.length === 0) amountCols.push(2);
  const sampleAmounts = body
    .slice(0, 25)
    .flatMap((r) => amountCols.map((c) => r[c] ?? ""))
    .filter((v) => v.trim() !== "");
  const decimalComma =
    sampleAmounts.some((v) => /\d,\d{1,2}\s*$/.test(v.trim())) &&
    !sampleAmounts.some((v) => /\d\.\d{1,2}\s*$/.test(v.trim()));

  const useDebitCredit = debit !== null || credit !== null;
  return {
    ...DEFAULT_MAPPING,
    delimiter,
    hasHeader: looksLikeHeader,
    dateColumn: dateCol,
    dateFormat: guessDateFormat(sampleDates),
    descriptionColumns: description !== null ? [description] : [dateCol === 0 ? 1 : 0],
    referenceColumn: reference,
    payeeColumn: payee,
    bankIdColumn: bankId,
    balanceColumn: balance,
    amountMode: useDebitCredit ? "debit_credit" : "single",
    amountColumn: useDebitCredit ? null : (amount ?? 2),
    debitColumn: debit,
    creditColumn: credit,
    decimalSeparator: decimalComma ? "," : ".",
  };
}

// ---------------------------------------------------------------------------
// Mapping → rows
// ---------------------------------------------------------------------------

export type MappedBankRow = {
  rowNumber: number;
  txnDate: string;
  amountMinor: bigint;
  description: string;
  reference: string | null;
  payee: string | null;
  bankId: string | null;
  balanceMinor: bigint | null;
};

export type MappingError = { rowNumber: number; message: string };

function cell(row: readonly string[], idx: number | null): string {
  if (idx === null || idx < 0) return "";
  return (row[idx] ?? "").trim();
}

function parseAmountCell(raw: string, currency: string, mapping: ImportMapping): bigint | null {
  return tryParseMinor(raw, currency, {
    decimalSeparator: mapping.decimalSeparator,
    strict: true,
    crDrSuffix: mapping.amountMode === "suffix",
  });
}

export function applyMapping(
  rows: readonly string[][],
  mapping: ImportMapping,
  currency: string,
): { rows: MappedBankRow[]; errors: MappingError[] } {
  const out: MappedBankRow[] = [];
  const errors: MappingError[] = [];
  const start = mapping.hasHeader ? 1 : 0;

  for (let i = start; i < rows.length; i++) {
    const row = rows[i]!;
    const rowNumber = i + 1;
    const err = (message: string) => errors.push({ rowNumber, message });

    const rawDate = cell(row, mapping.dateColumn);
    const txnDate = parseDateValue(rawDate, mapping.dateFormat);
    if (!txnDate) {
      err(`Invalid date "${rawDate}" for format ${mapping.dateFormat}`);
      continue;
    }

    let amount: bigint | null = null;
    if (mapping.amountMode === "debit_credit") {
      const rawDebit = cell(row, mapping.debitColumn);
      const rawCredit = cell(row, mapping.creditColumn);
      const debit = rawDebit ? parseAmountCell(rawDebit, currency, mapping) : 0n;
      const credit = rawCredit ? parseAmountCell(rawCredit, currency, mapping) : 0n;
      if (debit === null || credit === null) {
        err(`Invalid amount "${debit === null ? rawDebit : rawCredit}"`);
        continue;
      }
      const debitAbs = debit < 0n ? -debit : debit;
      const creditAbs = credit < 0n ? -credit : credit;
      if (debitAbs !== 0n && creditAbs !== 0n) {
        err("Both debit and credit columns have an amount");
        continue;
      }
      amount = creditAbs - debitAbs;
    } else {
      const rawAmount = cell(row, mapping.amountColumn);
      amount = rawAmount ? parseAmountCell(rawAmount, currency, mapping) : null;
      if (amount === null) {
        err(`Invalid amount "${rawAmount}"`);
        continue;
      }
    }
    if (mapping.invertSign) amount = -amount;
    if (amount === 0n) {
      err("Amount is zero");
      continue;
    }

    const reference = cell(row, mapping.referenceColumn).slice(0, 120) || null;
    const payee = cell(row, mapping.payeeColumn).slice(0, 200) || null;
    const description =
      mapping.descriptionColumns
        .map((c) => cell(row, c))
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500) ||
      payee ||
      reference ||
      "(no description)";

    let balanceMinor: bigint | null = null;
    const rawBalance = cell(row, mapping.balanceColumn);
    if (rawBalance) {
      balanceMinor = tryParseMinor(rawBalance, currency, {
        decimalSeparator: mapping.decimalSeparator,
        crDrSuffix: true,
      });
    }

    out.push({
      rowNumber,
      txnDate,
      amountMinor: amount,
      description,
      reference,
      payee,
      bankId: cell(row, mapping.bankIdColumn).slice(0, 120) || null,
      balanceMinor,
    });
  }
  return { rows: out, errors };
}

/** Validate that a mapping refers to real columns and is internally consistent. */
export function validateMapping(mapping: ImportMapping, columnCount: number): string[] {
  const problems: string[] = [];
  const inRange = (n: number | null, label: string, required: boolean) => {
    if (n === null) {
      if (required) problems.push(`${label} column is required`);
    } else if (!Number.isInteger(n) || n < 0 || n >= columnCount) {
      problems.push(`${label} column is out of range`);
    }
  };
  inRange(mapping.dateColumn, "Date", true);
  if (mapping.descriptionColumns.length === 0)
    problems.push("Choose at least one description column");
  for (const c of mapping.descriptionColumns) inRange(c, "Description", true);
  if (mapping.amountMode === "debit_credit") {
    if (mapping.debitColumn === null && mapping.creditColumn === null) {
      problems.push("Choose a debit and/or credit column");
    }
    inRange(mapping.debitColumn, "Debit", false);
    inRange(mapping.creditColumn, "Credit", false);
  } else {
    inRange(mapping.amountColumn, "Amount", true);
  }
  inRange(mapping.referenceColumn, "Reference", false);
  inRange(mapping.payeeColumn, "Payee", false);
  inRange(mapping.bankIdColumn, "Transaction id", false);
  inRange(mapping.balanceColumn, "Balance", false);
  if (!(DATE_FORMATS as readonly string[]).includes(mapping.dateFormat))
    problems.push("Unknown date format");
  return problems;
}

/** Coerce an unknown JSON blob (saved mapping) into a safe ImportMapping. */
export function coerceMapping(raw: unknown): ImportMapping | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
  const dateFormat = (DATE_FORMATS as readonly string[]).includes(String(r["dateFormat"]))
    ? (r["dateFormat"] as DateFormat)
    : DEFAULT_MAPPING.dateFormat;
  const amountMode = (AMOUNT_MODES as readonly string[]).includes(String(r["amountMode"]))
    ? (r["amountMode"] as AmountMode)
    : "single";
  const delimiter = ["auto", ",", ";", "\t", "|"].includes(String(r["delimiter"]))
    ? (r["delimiter"] as Delimiter)
    : "auto";
  const descriptionColumns = Array.isArray(r["descriptionColumns"])
    ? (r["descriptionColumns"] as unknown[]).map(num).filter((n): n is number => n !== null)
    : [];
  const dateColumn = num(r["dateColumn"]);
  if (dateColumn === null || descriptionColumns.length === 0) return null;
  return {
    delimiter,
    hasHeader: r["hasHeader"] !== false,
    dateColumn,
    dateFormat,
    descriptionColumns,
    referenceColumn: num(r["referenceColumn"]),
    payeeColumn: num(r["payeeColumn"]),
    bankIdColumn: num(r["bankIdColumn"]),
    balanceColumn: num(r["balanceColumn"]),
    amountMode,
    amountColumn: num(r["amountColumn"]),
    debitColumn: num(r["debitColumn"]),
    creditColumn: num(r["creditColumn"]),
    decimalSeparator: r["decimalSeparator"] === "," ? "," : ".",
    invertSign: r["invertSign"] === true,
  };
}

// ---------------------------------------------------------------------------
// Duplicate keys (BK-08)
// ---------------------------------------------------------------------------

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function normalizeForKey(description: string): string {
  return description.toLowerCase().replace(/\s+/g, " ").trim();
}

export type KeyedBankRow = MappedBankRow & {
  /** date|amount|description key shared by identical-looking rows. */
  groupKey: string;
  /** 0-based position among identical rows in THIS file. */
  ordinal: number;
  externalId: string;
};

/**
 * Stable external ids. Identical rows in one file get different ordinals, so two genuine £3.50 coffees stay
 * two rows; the same file imported twice produces the same ids (→ flagged as likely duplicates).
 * A bank-supplied transaction id wins over content hashing. A running balance distinguishes identical rows.
 */
export async function assignExternalIds(
  rows: readonly MappedBankRow[],
  bankAccountId: string,
  salt = "",
): Promise<KeyedBankRow[]> {
  const seen = new Map<string, number>();
  const out: KeyedBankRow[] = [];
  for (const r of rows) {
    const groupKey = [
      r.txnDate,
      r.amountMinor.toString(),
      normalizeForKey(r.description),
      normalizeForKey(r.reference ?? ""),
      r.balanceMinor === null ? "" : r.balanceMinor.toString(),
    ].join("|");
    const idKey = r.bankId ? `bankid|${r.bankId}` : groupKey;
    const ordinal = seen.get(idKey) ?? 0;
    seen.set(idKey, ordinal + 1);
    const hash = await sha256Hex(
      `v2|${bankAccountId}|${idKey}|${ordinal}${salt ? `|${salt}` : ""}`,
    );
    out.push({ ...r, groupKey, ordinal, externalId: `csv2_${hash}` });
  }
  return out;
}

/** The (date|amount|description) key used to compare against rows already in the database. */
export function contentKey(
  date: string,
  amountMinor: bigint | number,
  description: string,
): string {
  return `${date}|${BigInt(amountMinor).toString()}|${normalizeForKey(description)}`;
}

export type DuplicateCheck = {
  rowNumber: number;
  reason: "same_external_id" | "same_content_already_imported";
};

/**
 * Flag rows that are likely already in the account. Rows are compared by external id and, because older
 * imports used a different hash, by content with multiplicity: if the database already holds N rows with the
 * same date+amount+description, the first N identical rows of the file are flagged (the rest are new).
 */
export function findLikelyDuplicates(
  rows: readonly KeyedBankRow[],
  existing: {
    externalIds: ReadonlySet<string>;
    contentCounts: ReadonlyMap<string, number>;
  },
): DuplicateCheck[] {
  const flagged: DuplicateCheck[] = [];
  const seenContent = new Map<string, number>();
  for (const r of rows) {
    const key = contentKey(r.txnDate, r.amountMinor, r.description);
    const n = seenContent.get(key) ?? 0;
    seenContent.set(key, n + 1);
    if (existing.externalIds.has(r.externalId)) {
      flagged.push({ rowNumber: r.rowNumber, reason: "same_external_id" });
    } else if (n < (existing.contentCounts.get(key) ?? 0)) {
      flagged.push({ rowNumber: r.rowNumber, reason: "same_content_already_imported" });
    }
  }
  return flagged;
}

/** Decimal places for the bank account currency (exposed for UI formatting hints). */
export function importDecimalPlaces(currency: string): number {
  return decimalPlacesFor(currency);
}
