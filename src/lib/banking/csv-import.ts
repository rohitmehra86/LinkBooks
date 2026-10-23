/**
 * Parse a simple bank CSV: date,description,amount[,reference]
 * Amount: positive = money in, negative = money out.
 * Duplicate detection uses external_id = hash of date|amount|description|reference.
 */

export type ParsedBankRow = {
  txn_date: string;
  description: string;
  amount_minor: bigint;
  reference: string | null;
  external_id: string;
  row_number: number;
};

export type ParseResult = {
  rows: ParsedBankRow[];
  errors: Array<{ row_number: number; message: string }>;
};

function parseDate(raw: string): string | null {
  const s = raw.trim();
  // ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // DD/MM/YYYY or DD-MM-YYYY
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) {
    const d = m[1]!.padStart(2, "0");
    const mo = m[2]!.padStart(2, "0");
    return `${m[3]}-${mo}-${d}`;
  }
  return null;
}

function parseAmountToMinor(raw: string): bigint | null {
  const cleaned = raw.replace(/[,£$€\s]/g, "").trim();
  if (!cleaned || cleaned === "-") return null;
  const neg = cleaned.startsWith("(") && cleaned.endsWith(")");
  const n = neg ? cleaned.slice(1, -1) : cleaned;
  const num = Number(n);
  if (!Number.isFinite(num)) return null;
  const minor = BigInt(Math.round(Math.abs(num) * 100));
  const signed = num < 0 || neg ? -minor : minor;
  return signed;
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `csv_${(h >>> 0).toString(16)}_${s.length}`;
}

export function parseBankCsv(text: string): ParseResult {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) {
    return { rows: [], errors: [{ row_number: 0, message: "File is empty" }] };
  }

  let start = 0;
  const header = lines[0]!.toLowerCase();
  if (header.includes("date") && (header.includes("amount") || header.includes("description"))) {
    start = 1;
  }

  const rows: ParsedBankRow[] = [];
  const errors: Array<{ row_number: number; message: string }> = [];

  for (let i = start; i < lines.length; i++) {
    const rowNumber = i + 1;
    const parts = splitCsvLine(lines[i]!);
    if (parts.length < 3) {
      errors.push({
        row_number: rowNumber,
        message: "Expected at least date, description, amount",
      });
      continue;
    }
    const date = parseDate(parts[0]!);
    if (!date) {
      errors.push({ row_number: rowNumber, message: `Invalid date: ${parts[0]}` });
      continue;
    }
    const description = (parts[1] ?? "").trim().slice(0, 500);
    if (!description) {
      errors.push({ row_number: rowNumber, message: "Description is required" });
      continue;
    }
    const amount = parseAmountToMinor(parts[2]!);
    if (amount === null || amount === 0n) {
      errors.push({ row_number: rowNumber, message: `Invalid amount: ${parts[2]}` });
      continue;
    }
    const reference = (parts[3] ?? "").trim().slice(0, 120) || null;
    const external_id = simpleHash(
      `${date}|${amount.toString()}|${description}|${reference ?? ""}`,
    );
    rows.push({
      txn_date: date,
      description,
      amount_minor: amount,
      reference,
      external_id,
      row_number: rowNumber,
    });
  }

  return { rows, errors };
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function applyBankRule(
  description: string,
  reference: string | null,
  rule: {
    match_field: string;
    match_pattern: string;
    match_type: string;
  },
): boolean {
  const field =
    rule.match_field === "reference"
      ? (reference ?? "")
      : rule.match_field === "payee"
        ? description
        : description;
  const target = field.toLowerCase();
  const pattern = rule.match_pattern.toLowerCase();
  if (rule.match_type === "equals") return target === pattern;
  if (rule.match_type === "starts_with") return target.startsWith(pattern);
  return target.includes(pattern);
}
