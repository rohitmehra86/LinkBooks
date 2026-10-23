/**
 * Ledger health check: types and pure helpers for the report returned by the
 * `ledger_health_check` database function. The function does the checking; this file only
 * validates what came back and words it, so nothing here can turn a failure into a pass.
 */

export type HealthStatus = "pass" | "warn" | "fail" | "na";

export type HealthCheckKey =
  | "trial_balance"
  | "unbalanced"
  | "orphans"
  | "document_journals"
  | "subledger_ar"
  | "subledger_ap"
  | "period_locks"
  | "automation";

export type HealthItem = Record<string, string | number | null>;

export type HealthCheck = {
  key: string;
  label: string;
  status: HealthStatus;
  count: number;
  summary: string;
  items: HealthItem[];
};

export type HealthReport = {
  companyId: string;
  baseCurrency: string;
  generatedAt: string;
  overall: "pass" | "warn" | "fail";
  journalsChecked: number;
  linesChecked: number;
  checks: HealthCheck[];
};

const STATUSES = new Set<string>(["pass", "warn", "fail", "na"]);

function asNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Turns the raw JSON into a typed report. An unknown status is treated as a failure, never a pass. */
export function parseHealthReport(raw: unknown): HealthReport {
  if (!raw || typeof raw !== "object") throw new Error("The health check returned no result.");
  const r = raw as Record<string, unknown>;
  const rawChecks = Array.isArray(r["checks"]) ? (r["checks"] as unknown[]) : [];
  const checks: HealthCheck[] = rawChecks.map((c) => {
    const o = (c ?? {}) as Record<string, unknown>;
    const status = asString(o["status"]);
    const items = Array.isArray(o["items"])
      ? (o["items"] as unknown[]).filter(
          (i): i is HealthItem => Boolean(i) && typeof i === "object",
        )
      : [];
    return {
      key: asString(o["key"]),
      label: asString(o["label"]),
      status: STATUSES.has(status) ? (status as HealthStatus) : "fail",
      count: asNumber(o["count"]),
      summary: asString(o["summary"]),
      items,
    };
  });
  return {
    companyId: asString(r["company_id"]),
    baseCurrency: asString(r["base_currency"]),
    generatedAt: asString(r["generated_at"]),
    overall: overallStatus(checks),
    journalsChecked: asNumber(r["journals_checked"]),
    linesChecked: asNumber(r["lines_checked"]),
    checks,
  };
}

/** Worst status wins. Checks that do not apply (`na`) neither pass nor fail the whole report. */
export function overallStatus(checks: Pick<HealthCheck, "status">[]): "pass" | "warn" | "fail" {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "pass";
}

export function headline(report: Pick<HealthReport, "overall" | "checks">): string {
  const failed = report.checks.filter((c) => c.status === "fail").length;
  const warned = report.checks.filter((c) => c.status === "warn").length;
  const applicable = report.checks.filter((c) => c.status !== "na").length;
  if (report.overall === "pass") return `All ${applicable} checks passed.`;
  const parts: string[] = [];
  if (failed > 0) parts.push(`${failed} failed`);
  if (warned > 0) parts.push(`${warned} need a look`);
  return `${parts.join(", ")} of ${applicable} checks.`;
}

const PROBLEM_LABELS: Record<string, string> = {
  line_without_journal: "Line has no journal",
  line_company_differs_from_journal: "Line belongs to a different organisation than its journal",
  line_account_missing_or_other_company:
    "Line points at a missing account or one from another organisation",
  posted_journal_without_lines: "Posted journal has no lines",
  no_journal: "Issued but has no journal",
  journal_missing: "Journal record is missing",
  journal_not_posted: "Journal is not posted",
  journal_reversed_but_document_live: "Journal was reversed but the document is still live",
  voided_but_journal_still_live: "Voided but its journal is still in the ledger",
  posted_after_period_lock: "Posted after the period was locked",
  posted_after_lock_date: "Posted after the lock date was set",
  dated_outside_its_period: "Dated outside its accounting period",
  failed: "Auto-reversal failed",
  overdue: "Auto-reversal overdue",
};

export function problemLabel(problem: string | number | null | undefined): string {
  const key = typeof problem === "string" ? problem : "";
  return PROBLEM_LABELS[key] ?? (key ? key.replace(/_/g, " ") : "Problem");
}

/** In-app place to start fixing each check. */
export function checkHref(key: string): string | null {
  switch (key) {
    case "subledger_ar":
      return "/reports/aged-receivables";
    case "subledger_ap":
      return "/reports/aged-payables";
    case "trial_balance":
    case "unbalanced":
    case "orphans":
      return "/reports/trial-balance";
    case "period_locks":
      return "/reports/journals";
    case "automation":
      return "/accounting";
    default:
      return null;
  }
}
