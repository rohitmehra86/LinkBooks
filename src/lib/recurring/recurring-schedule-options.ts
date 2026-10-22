export type RecurringTemplateMode = "scheduled" | "reminder" | "on_demand";

export type RecurringCatchUpPolicy = "all_missed" | "latest_only" | "review_each";

/** Stored on legacy `recurring_bills.template.scheduleOptions` and mirrored to v2 schedules. */
export type RecurringScheduleOptions = {
  mode: RecurringTemplateMode;
  generateDaysInAdvance: number;
  endDate: string | null;
  maxOccurrences: number | null;
  catchUpPolicy: RecurringCatchUpPolicy;
  /** Days after bill date for supplier invoice due date (Xero/QBO-style terms). */
  dueDaysAfterBillDate: number;
  memo?: string;
};

export function parseScheduleOptions(raw: unknown): RecurringScheduleOptions {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<RecurringScheduleOptions>;
  const mode = o.mode ?? "scheduled";
  if (mode !== "scheduled" && mode !== "reminder" && mode !== "on_demand") {
    throw new Error("Invalid schedule mode");
  }
  const generateDaysInAdvance = Math.min(
    365,
    Math.max(0, Math.floor(Number(o.generateDaysInAdvance ?? 0) || 0)),
  );
  let endDate: string | null = null;
  if (o.endDate && typeof o.endDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.endDate)) {
    endDate = o.endDate;
  }
  let maxOccurrences: number | null = null;
  if (o.maxOccurrences != null && o.maxOccurrences !== "") {
    const n = Math.floor(Number(o.maxOccurrences));
    if (n > 0 && n <= 9999) maxOccurrences = n;
  }
  const catchUpPolicy = o.catchUpPolicy ?? "latest_only";
  if (
    catchUpPolicy !== "all_missed" &&
    catchUpPolicy !== "latest_only" &&
    catchUpPolicy !== "review_each"
  ) {
    throw new Error("Invalid catch-up policy");
  }
  const dueDaysAfterBillDate = Math.min(
    365,
    Math.max(0, Math.floor(Number(o.dueDaysAfterBillDate ?? 0) || 0)),
  );
  const memo = typeof o.memo === "string" ? o.memo.trim().slice(0, 500) : undefined;
  return {
    mode,
    generateDaysInAdvance,
    endDate,
    maxOccurrences,
    catchUpPolicy,
    dueDaysAfterBillDate,
    memo: memo || undefined,
  };
}

export function addCalendarDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
