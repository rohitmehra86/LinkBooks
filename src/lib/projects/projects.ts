/** Pure helpers for the project profitability report. All amounts are integer minor units (base currency). */

export type ProjectProfitRow = {
  projectId: string;
  code: string;
  name: string;
  status: string;
  budgetMinor: number | null;
  revenueMinor: number;
  costMinor: number;
  profitMinor: number;
  unconvertedDocuments: number;
};

export function marginPercent(
  row: Pick<ProjectProfitRow, "revenueMinor" | "profitMinor">,
): number | null {
  if (row.revenueMinor <= 0) return null;
  return Math.round((row.profitMinor / row.revenueMinor) * 1000) / 10;
}

/** Share of the budget already spent as cost, or null when there is no budget. */
export function budgetUsedPercent(
  row: Pick<ProjectProfitRow, "budgetMinor" | "costMinor">,
): number | null {
  if (!row.budgetMinor || row.budgetMinor <= 0) return null;
  return Math.round((row.costMinor / row.budgetMinor) * 1000) / 10;
}

export function totalsOf(rows: ProjectProfitRow[]) {
  let revenue = 0;
  let cost = 0;
  for (const r of rows) {
    revenue += r.revenueMinor;
    cost += r.costMinor;
  }
  return { revenueMinor: revenue, costMinor: cost, profitMinor: revenue - cost };
}

export type TaggableKind =
  | "sales_invoice"
  | "sales_credit_note"
  | "purchase_bill"
  | "purchase_credit_note"
  | "bank_transaction";

export const TAGGABLE_KINDS: readonly TaggableKind[] = [
  "sales_invoice",
  "sales_credit_note",
  "purchase_bill",
  "purchase_credit_note",
  "bank_transaction",
];

/** Header/line table pair used to read the current tag of a document. */
export const KIND_LINE_TABLES: Record<TaggableKind, { table: string; fk: string | null }> = {
  sales_invoice: { table: "sales_invoice_lines", fk: "invoice_id" },
  sales_credit_note: { table: "sales_credit_note_lines", fk: "credit_note_id" },
  purchase_bill: { table: "purchase_bill_lines", fk: "bill_id" },
  purchase_credit_note: { table: "purchase_credit_note_lines", fk: "credit_note_id" },
  bank_transaction: { table: "bank_transactions", fk: null },
};

/** Collapse the project ids found on a document's lines into one tag. */
export function summariseTags(ids: Array<string | null>): {
  projectId: string | null;
  mixed: boolean;
} {
  const distinct = new Set(ids.map((i) => i ?? ""));
  if (distinct.size === 0) return { projectId: null, mixed: false };
  if (distinct.size === 1) {
    const only = [...distinct][0]!;
    return { projectId: only || null, mixed: false };
  }
  return { projectId: null, mixed: true };
}
