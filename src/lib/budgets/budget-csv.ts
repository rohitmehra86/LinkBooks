/**
 * Budget CSV export / import (pure). Amounts are plain decimals in the base currency.
 * Import is validate-first: every problem is reported and nothing is applied until all rows pass.
 */

import { fromMinorUnits, toMinorUnits } from "@/lib/accounting/money";
import { monthLabel } from "@/lib/budgets/budget-math";

export type BudgetGridAccount = { id: string; code: string; name: string };

export function budgetCsvHeaders(months: readonly string[]): string[] {
  return ["Account code", "Account name", ...months.map(monthLabel), "Total"];
}

export function budgetToCsvRows(
  accounts: readonly BudgetGridAccount[],
  values: ReadonlyMap<string, readonly number[]>,
  currency: string,
): string[][] {
  return accounts.map((a) => {
    const row = values.get(a.id) ?? [];
    const total = row.reduce((x, y) => x + y, 0);
    return [
      a.code,
      a.name,
      ...Array.from({ length: Math.max(row.length, 12) }, (_, i) =>
        fromMinorUnits(row[i] ?? 0, currency),
      ),
      fromMinorUnits(total, currency),
    ];
  });
}

export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  return cells;
}

export type BudgetCsvIssue = { row: number; message: string };

export type BudgetCsvResult = {
  /** account id → 12 monthly minor amounts */
  values: Map<string, number[]>;
  issues: BudgetCsvIssue[];
};

/** Parse a decimal cell; blank is 0. Thousands separators and brackets for negatives are tolerated. */
export function parseAmountCell(raw: string, currency: string): number {
  let s = raw.trim().replace(/^\uFEFF/, "");
  if (s === "" || s === "-") return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[,\s]/g, "");
  if (s.startsWith("-")) {
    neg = !neg;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`“${raw.trim()}” is not a number`);
  const minor = Number(toMinorUnits(s, currency));
  if (!Number.isSafeInteger(minor)) throw new Error(`“${raw.trim()}” is too large`);
  return neg ? -minor : minor;
}

/**
 * Parse an exported-format CSV: first two columns are account code and name; the next 12 are the
 * months in fiscal order. A trailing Total column and metadata lines (before the header) are ignored.
 */
export function parseBudgetCsv(
  text: string,
  accounts: readonly BudgetGridAccount[],
  currency: string,
): BudgetCsvResult {
  const issues: BudgetCsvIssue[] = [];
  const values = new Map<string, number[]>();
  const byCode = new Map(accounts.map((a) => [a.code.trim().toLowerCase(), a]));
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l, i) => ({ line: l, n: i + 1 }))
    .filter((l) => l.line.trim().length > 0);
  const headerAt = lines.findIndex((l) => /^"?account code"?\s*,/i.test(l.line.trim()));
  if (headerAt < 0) {
    return {
      values,
      issues: [{ row: 1, message: "Header row “Account code, Account name, …” not found." }],
    };
  }
  for (const { line, n } of lines.slice(headerAt + 1)) {
    const cells = splitCsvLine(line);
    const code = (cells[0] ?? "").trim();
    if (!code) {
      issues.push({ row: n, message: "Missing account code." });
      continue;
    }
    const acct = byCode.get(code.toLowerCase());
    if (!acct) {
      issues.push({
        row: n,
        message: `Account ${code} is not an active income or expense account.`,
      });
      continue;
    }
    if (values.has(acct.id)) {
      issues.push({ row: n, message: `Account ${code} appears more than once.` });
      continue;
    }
    const months: number[] = [];
    let bad = false;
    for (let m = 0; m < 12; m++) {
      try {
        months.push(parseAmountCell(cells[2 + m] ?? "", currency));
      } catch (e) {
        issues.push({ row: n, message: `${code}, month ${m + 1}: ${(e as Error).message}` });
        bad = true;
      }
    }
    if (!bad) values.set(acct.id, months);
  }
  if (values.size === 0 && issues.length === 0) {
    issues.push({ row: lines[headerAt]?.n ?? 1, message: "The file has no account rows." });
  }
  return { values, issues };
}
