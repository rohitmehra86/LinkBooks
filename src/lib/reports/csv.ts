/** CSV export shared by every report (RP-08). Amounts are plain decimals so spreadsheets can sum them. */

import { fromMinorUnits } from "@/lib/accounting/money";

/** Plain decimal for CSV cells (no symbol or grouping, so spreadsheets can sum it). */
export function csvMoney(minor: number | bigint, currency: string): string {
  return fromMinorUnits(minor, currency);
}

export type CsvCell = string | number | bigint | null | undefined;

export type CsvMeta = {
  company: string;
  report: string;
  period: string;
  currency: string;
  basis?: string;
  generatedAt?: string;
};

const NUMERIC = /^-?\d+(\.\d+)?$/;

/** Quote a cell; neutralise spreadsheet formulas in free text (CSV injection). */
export function csvCell(v: CsvCell): string {
  if (v === null || v === undefined) return '""';
  let s = typeof v === "string" ? v : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s) && !NUMERIC.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(meta: CsvMeta, headers: string[], rows: CsvCell[][]): string {
  const generated = meta.generatedAt ?? new Date().toISOString();
  const header: CsvCell[][] = [
    ["Company", meta.company],
    ["Report", meta.report],
    ["Period", meta.period],
    ["Currency", meta.currency],
    ...(meta.basis ? [["Basis", meta.basis]] : []),
    ["Generated", generated],
    [],
  ];
  return [...header, headers, ...rows]
    .map((r) => (r.length === 0 ? "" : r.map(csvCell).join(",")))
    .join("\r\n");
}

export function csvFilename(report: string, period: string): string {
  const slug = `${report}-${period}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug}.csv`;
}

export function downloadCsv(filename: string, content: string): void {
  // BOM so Excel reads UTF-8 (£, accents) correctly.
  const blob = new Blob(["\uFEFF", content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
