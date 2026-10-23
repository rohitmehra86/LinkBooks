import {
  validateRecurrenceSpec,
  type CustomUnit,
  type FrequencyKind,
  type MonthDayRule,
  type RecurrenceSpec,
  type WeekendAdjust,
} from "@/lib/recurring/recurrence-rules";

export type RecurringTemplateMode = "scheduled" | "reminder" | "on_demand";

export type RecurringCatchUpPolicy = "all_missed" | "latest_only" | "review_each";
export type GenerationPolicy = "draft" | "submit_approval" | "auto_authorise";

/** Stored on legacy `recurring_bills.template.scheduleOptions` and mirrored to v2 schedules. */
export type RecurringScheduleOptions = {
  mode: RecurringTemplateMode;
  generateDaysInAdvance: number;
  endDate: string | null;
  maxOccurrences: number | null;
  catchUpPolicy: RecurringCatchUpPolicy;
  /** Days after bill date for supplier invoice due date (Xero/QBO-style terms). */
  dueDaysAfterBillDate: number;
  memo?: string | undefined;
  generationPolicy: GenerationPolicy;
  recurrence: RecurrenceSpec | null;
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
  if (o.maxOccurrences != null) {
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
  const generationPolicy = (o as { generationPolicy?: string }).generationPolicy ?? "draft";
  if (
    generationPolicy !== "draft" &&
    generationPolicy !== "submit_approval" &&
    generationPolicy !== "auto_authorise"
  ) {
    throw new Error("Invalid generation policy");
  }
  const recurrence = parseRecurrence((o as { recurrence?: unknown }).recurrence, {
    startDate: endDate,
  });
  if (recurrence?.endDate && endDate && recurrence.endDate !== endDate) {
    throw new Error("The recurrence end date and the schedule end date do not match");
  }
  return {
    mode,
    generateDaysInAdvance,
    endDate,
    maxOccurrences,
    catchUpPolicy,
    dueDaysAfterBillDate,
    memo: memo || undefined,
    generationPolicy,
    recurrence,
  };
}

function parseRecurrence(
  raw: unknown,
  fallback: { startDate: string | null },
): RecurrenceSpec | null {
  if (raw == null) return null;
  if (typeof raw !== "object") throw new Error("Invalid recurrence rule");
  const o = raw as Partial<RecurrenceSpec>;
  const frequency = o.frequency as FrequencyKind;
  const spec: RecurrenceSpec = {
    startDate: typeof o.startDate === "string" ? o.startDate : fallback.startDate ?? "",
    frequency,
    interval: Math.floor(Number(o.interval ?? 1)),
    customUnit: (o.customUnit as CustomUnit | null) ?? null,
    weekdays: Array.isArray(o.weekdays) ? o.weekdays.map((d) => Number(d)) : null,
    monthDay: (o.monthDay as MonthDayRule | null) ?? null,
    endDate: typeof o.endDate === "string" ? o.endDate : null,
    maxOccurrences: o.maxOccurrences == null ? null : Math.floor(Number(o.maxOccurrences)),
    weekendAdjust: (o.weekendAdjust as WeekendAdjust) || "none",
    holidays: Array.isArray(o.holidays) ? o.holidays.map(String) : [],
  };
  const error = validateRecurrenceSpec(spec);
  if (error) throw new Error(error);
  return spec;
}

/** Saved generationPolicy wins. Older templates keep the auto-authorise flag. */
export function resolveGenerationPolicy(raw: unknown, autoAuthoriseFlag: boolean): GenerationPolicy {
  const parsed = parseScheduleOptions(raw ?? {});
  const explicit = Boolean(raw && typeof raw === "object" && "generationPolicy" in raw);
  if (!explicit) return autoAuthoriseFlag ? "auto_authorise" : "draft";
  return parsed.generationPolicy;
}

export function addCalendarDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
