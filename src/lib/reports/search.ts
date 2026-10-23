import type { ColumnMode } from "@/lib/reports/statements";

/** URL state of a report page, so every drill-down is linkable and survives reload (RP-05). */
export type ReportSearch = {
  from?: string;
  to?: string;
  account?: string;
  columns?: ColumnMode;
  compare?: "prior_year" | "prior_month" | "months";
  page?: number;
  source?: string;
  status?: string;
  actor?: string;
  entity?: string;
  action?: string;
  basis?: "accrual" | "cash";
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMN_MODES: ColumnMode[] = ["none", "prior_period", "prior_year", "month", "quarter"];
const COMPARES = ["prior_year", "prior_month", "months"] as const;

function str(v: unknown, max = 80): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

export function parseReportSearch(raw: Record<string, unknown>): ReportSearch {
  const out: ReportSearch = {};
  const from = str(raw["from"], 10);
  if (from && ISO.test(from)) out.from = from;
  const to = str(raw["to"], 10);
  if (to && ISO.test(to)) out.to = to;
  const account = str(raw["account"], 36);
  if (account && UUID.test(account)) out.account = account;
  if (COLUMN_MODES.includes(raw["columns"] as ColumnMode) && raw["columns"] !== "none") {
    out.columns = raw["columns"] as ColumnMode;
  }
  if ((COMPARES as readonly unknown[]).includes(raw["compare"])) {
    out.compare = raw["compare"] as (typeof COMPARES)[number];
  }
  const page = Number(raw["page"]);
  if (Number.isInteger(page) && page > 0) out.page = page;
  const source = str(raw["source"], 40);
  if (source) out.source = source;
  const status = str(raw["status"], 20);
  if (status) out.status = status;
  const actor = str(raw["actor"], 36);
  if (actor && UUID.test(actor)) out.actor = actor;
  const entity = str(raw["entity"], 60);
  if (entity) out.entity = entity;
  const action = str(raw["action"], 80);
  if (action) out.action = action;
  if (raw["basis"] === "cash" || raw["basis"] === "accrual") out.basis = raw["basis"];
  return out;
}
