/**
 * Presentation layer for financial statements (RP-06 / RP-09).
 * Turns the raw P&L / balance-sheet builder output into signed, sectioned statement lines with
 * one amount per column (current period, comparatives, months, quarters). The UI and the CSV
 * export both render these same lines so the printed and exported layouts always agree.
 */

import {
  buildBalanceSheet,
  buildProfitAndLoss,
  type BalanceSheetResult,
  type ProfitAndLossSectionId,
  type TrialBalanceRow,
} from "@/lib/accounting/reporting";
import {
  addDaysIso,
  addMonthsIso,
  monthEnd,
  monthStart,
  shiftYear,
} from "@/lib/accounting/fiscal-year";

export type StatementLineKind = "heading" | "account" | "subtotal" | "total";

export type StatementLine = {
  kind: StatementLineKind;
  label: string;
  /** Account code for drill-down rows. */
  code?: string;
  accountId?: string;
  /** One signed amount per column, minor units, base currency. */
  amounts: bigint[];
};

export type StatementColumn = { label: string; from?: string; to: string };

export type PnlResult = ReturnType<typeof buildProfitAndLoss>;

function zeros(n: number): bigint[] {
  return Array.from({ length: n }, () => 0n);
}

function signedPnlRow(sectionId: ProfitAndLossSectionId, r: TrialBalanceRow): bigint {
  if (r.account_type === "income") return r.credit_minor - r.debit_minor;
  const cost = r.debit_minor - r.credit_minor;
  // The "other" section mixes other income and other expense: show income positive.
  return sectionId === "other" ? -cost : cost;
}

type SectionAcc = {
  id: ProfitAndLossSectionId;
  label: string;
  rows: Map<string, { code: string; name: string; amounts: bigint[] }>;
  totals: bigint[];
};

/**
 * Sectioned P&L: Revenue, Returns & discounts, Cost of sales → Gross profit,
 * Operating expenses → Operating profit, Other income & expense → Net profit.
 * Costs are shown as positive numbers inside their section and subtracted in the subtotals.
 */
export function buildPnlStatement(results: PnlResult[]): StatementLine[] {
  const n = results.length;
  const order: ProfitAndLossSectionId[] = [
    "revenue",
    "contra_revenue",
    "cost_of_sales",
    "operating_expense",
    "other",
  ];
  const secs = new Map<ProfitAndLossSectionId, SectionAcc>();
  for (const id of order) secs.set(id, { id, label: "", rows: new Map(), totals: zeros(n) });

  results.forEach((res, col) => {
    for (const section of res.sections) {
      const acc = secs.get(section.id)!;
      acc.label = section.label;
      for (const r of section.rows) {
        const row = acc.rows.get(r.account_id) ?? { code: r.code, name: r.name, amounts: zeros(n) };
        const v = signedPnlRow(section.id, r);
        row.amounts[col] = (row.amounts[col] ?? 0n) + v;
        acc.rows.set(r.account_id, row);
        acc.totals[col] = (acc.totals[col] ?? 0n) + v;
      }
    }
  });

  const labelFor: Record<ProfitAndLossSectionId, string> = {
    revenue: "Revenue",
    contra_revenue: "Returns & discounts",
    cost_of_sales: "Less cost of sales",
    operating_expense: "Operating expenses",
    other: "Other income & expense",
  };

  const lines: StatementLine[] = [];
  const emit = (id: ProfitAndLossSectionId, totalLabel: string) => {
    const acc = secs.get(id)!;
    if (acc.rows.size === 0) return;
    lines.push({ kind: "heading", label: labelFor[id], amounts: zeros(n) });
    for (const [accountId, row] of [...acc.rows.entries()].sort((a, b) =>
      a[1].code.localeCompare(b[1].code),
    )) {
      lines.push({
        kind: "account",
        label: row.name,
        code: row.code,
        accountId,
        amounts: row.amounts,
      });
    }
    lines.push({ kind: "subtotal", label: totalLabel, amounts: acc.totals });
  };

  const rev = secs.get("revenue")!.totals;
  const contra = secs.get("contra_revenue")!.totals;
  const cos = secs.get("cost_of_sales")!.totals;
  const opex = secs.get("operating_expense")!.totals;
  const other = secs.get("other")!.totals;
  const gross = rev.map((v, i) => v + (contra[i] ?? 0n) - (cos[i] ?? 0n));
  const operating = gross.map((v, i) => v - (opex[i] ?? 0n));
  const net = operating.map((v, i) => v + (other[i] ?? 0n));

  emit("revenue", "Total revenue");
  emit("contra_revenue", "Total returns & discounts");
  emit("cost_of_sales", "Total cost of sales");
  lines.push({ kind: "total", label: "Gross profit", amounts: gross });
  emit("operating_expense", "Total operating expenses");
  lines.push({ kind: "subtotal", label: "Operating profit", amounts: operating });
  emit("other", "Total other income & expense");
  lines.push({ kind: "total", label: "Net profit", amounts: net });
  return lines;
}

/** Sectioned balance sheet with signed presentation and one column per as-at date. */
export function buildBalanceSheetStatement(results: BalanceSheetResult[]): StatementLine[] {
  const n = results.length;
  const sectionOrder = [
    "current_assets",
    "non_current_assets",
    "current_liabilities",
    "non_current_liabilities",
    "equity",
  ];
  const labels = new Map<string, string>();
  const rows = new Map<string, Map<string, { code: string; name: string; amounts: bigint[] }>>();
  const totals = new Map<string, bigint[]>();
  for (const id of sectionOrder) {
    rows.set(id, new Map());
    totals.set(id, zeros(n));
  }
  results.forEach((res, col) => {
    for (const section of res.sections) {
      labels.set(section.id, section.label);
      const isAsset = section.id === "current_assets" || section.id === "non_current_assets";
      for (const r of section.rows) {
        const v = isAsset ? r.debit_minor - r.credit_minor : r.credit_minor - r.debit_minor;
        const map = rows.get(section.id)!;
        const row = map.get(r.account_id) ?? { code: r.code, name: r.name, amounts: zeros(n) };
        row.amounts[col] = (row.amounts[col] ?? 0n) + v;
        map.set(r.account_id, row);
        const t = totals.get(section.id)!;
        t[col] = (t[col] ?? 0n) + v;
      }
    }
  });

  const lines: StatementLine[] = [];
  const emit = (id: string) => {
    const map = rows.get(id)!;
    if (map.size === 0) return;
    lines.push({ kind: "heading", label: labels.get(id) ?? id, amounts: zeros(n) });
    for (const [accountId, row] of [...map.entries()].sort((a, b) =>
      a[1].code.localeCompare(b[1].code),
    )) {
      lines.push({
        kind: "account",
        label: row.name,
        code: row.code,
        accountId,
        amounts: row.amounts,
      });
    }
    lines.push({
      kind: "subtotal",
      label: `Total ${(labels.get(id) ?? id).toLowerCase()}`,
      amounts: totals.get(id)!,
    });
  };
  const sum = (ids: string[]) =>
    zeros(n).map((_, i) => ids.reduce((acc, id) => acc + (totals.get(id)![i] ?? 0n), 0n));

  emit("current_assets");
  emit("non_current_assets");
  const assets = sum(["current_assets", "non_current_assets"]);
  lines.push({ kind: "total", label: "Total assets", amounts: assets });
  emit("current_liabilities");
  emit("non_current_liabilities");
  const liabilities = sum(["current_liabilities", "non_current_liabilities"]);
  lines.push({ kind: "total", label: "Total liabilities", amounts: liabilities });
  lines.push({
    kind: "total",
    label: "Net assets",
    amounts: assets.map((v, i) => v - (liabilities[i] ?? 0n)),
  });
  emit("equity");
  return lines;
}

/** Statement amount formatting: signed number → brackets for negatives, blank for zero. */
export function isZeroLine(line: StatementLine): boolean {
  return line.amounts.every((v) => v === 0n);
}

/* ------------------------------------------------------------------ */
/* Column specs (RP-09)                                                */
/* ------------------------------------------------------------------ */

export type ColumnMode = "none" | "prior_period" | "prior_year" | "month" | "quarter";

/** Same-length period immediately before [from, to] (days). */
export function priorPeriodRange(from: string, to: string): { from: string; to: string } {
  const days =
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  const priorTo = addDaysIso(from, -1);
  return { from: addDaysIso(priorTo, -(days - 1)), to: priorTo };
}

export function priorYearRange(from: string, to: string): { from: string; to: string } {
  return { from: shiftYear(from, -1), to: shiftYear(to, -1) };
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Calendar month columns covering [from, to], first/last clipped to the range. Max 24 columns. */
export function monthColumns(
  from: string,
  to: string,
  maxColumns = 24,
): Array<{ label: string; from: string; to: string }> {
  const out: Array<{ label: string; from: string; to: string }> = [];
  let cursor = monthStart(from);
  while (cursor <= to && out.length < maxColumns) {
    const start = cursor < from ? from : cursor;
    const end = monthEnd(cursor) > to ? to : monthEnd(cursor);
    out.push({
      label: `${MONTH_NAMES[Number(cursor.slice(5, 7)) - 1]} ${cursor.slice(0, 4)}`,
      from: start,
      to: end,
    });
    cursor = addMonthsIso(monthStart(cursor), 1);
  }
  return out;
}

/** Calendar quarter columns (Jan-Mar, Apr-Jun…) covering [from, to], clipped. */
export function quarterColumns(
  from: string,
  to: string,
  maxColumns = 12,
): Array<{ label: string; from: string; to: string }> {
  const out: Array<{ label: string; from: string; to: string }> = [];
  const y0 = Number(from.slice(0, 4));
  const q0 = Math.floor((Number(from.slice(5, 7)) - 1) / 3);
  let cursor = `${y0}-${String(q0 * 3 + 1).padStart(2, "0")}-01`;
  while (cursor <= to && out.length < maxColumns) {
    const qEnd = monthEnd(addMonthsIso(cursor, 2));
    const q = Math.floor((Number(cursor.slice(5, 7)) - 1) / 3) + 1;
    out.push({
      label: `Q${q} ${cursor.slice(0, 4)}`,
      from: cursor < from ? from : cursor,
      to: qEnd > to ? to : qEnd,
    });
    cursor = addMonthsIso(cursor, 3);
  }
  return out;
}

/** Re-export so callers can build both statements from one import. */
export { buildBalanceSheet, buildProfitAndLoss };
