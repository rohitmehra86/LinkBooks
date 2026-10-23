import { formatUtcDate, parseUtcDate } from "@/lib/recurring/dates";

export type FrequencyKind =
  | "daily"
  | "weekly"
  | "fortnightly"
  | "monthly"
  | "quarterly"
  | "half_yearly"
  | "yearly"
  | "custom";

export type CustomUnit = "days" | "weeks" | "months" | "years";
export type MonthDayRule = number | "last_calendar_day" | "last_business_day";
export type WeekendAdjust = "none" | "previous_business_day" | "next_business_day";
export type LegacyFrequencyColumn = "weekly" | "monthly" | "quarterly" | "yearly";

export type RecurrenceSpec = {
  startDate: string;
  frequency: FrequencyKind;
  interval: number;
  customUnit: CustomUnit | null;
  weekdays: number[] | null;
  monthDay: MonthDayRule | null;
  endDate: string | null;
  maxOccurrences: number | null;
  weekendAdjust: WeekendAdjust;
  holidays: string[];
};

const FREQUENCIES: FrequencyKind[] = [
  "daily",
  "weekly",
  "fortnightly",
  "monthly",
  "quarterly",
  "half_yearly",
  "yearly",
  "custom",
];

/** Reject combinations that do not have one deterministic meaning. */
export function validateRecurrenceSpec(spec: RecurrenceSpec): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spec.startDate)) return "Start date is required";
  if (!FREQUENCIES.includes(spec.frequency)) return "Frequency is not supported";
  if (!Number.isInteger(spec.interval) || spec.interval < 1 || spec.interval > 999) {
    return "Interval must be a whole number from 1 to 999";
  }
  if (spec.frequency === "custom" && !spec.customUnit) {
    return "Custom recurrence needs a unit of days, weeks, months, or years";
  }
  if (spec.frequency !== "custom" && spec.customUnit) {
    return "A custom unit only applies to custom recurrence";
  }
  if (spec.weekdays && spec.frequency !== "weekly") {
    return "Weekday selection only applies to weekly recurrence";
  }
  if (spec.frequency === "weekly" && spec.weekdays && spec.weekdays.length === 0) {
    return "Choose at least one weekday";
  }
  if (spec.weekdays?.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return "Weekdays must be Sunday (0) through Saturday (6)";
  }
  if (spec.monthDay != null && !isMonthlyFamily(spec.frequency, spec.customUnit)) {
    return "Day-of-month rules only apply to monthly, quarterly, half-yearly, yearly, or custom month/year recurrence";
  }
  if (typeof spec.monthDay === "number" && (spec.monthDay < 1 || spec.monthDay > 31)) {
    return "Day of month must be 1–31, the last calendar day, or the last business day";
  }
  if (spec.endDate && spec.endDate < spec.startDate) return "End date must be on or after the start date";
  if (spec.maxOccurrences != null && (!Number.isInteger(spec.maxOccurrences) || spec.maxOccurrences < 1)) {
    return "Occurrence count must be at least 1";
  }
  if (spec.holidays.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) return "Holiday dates must be YYYY-MM-DD";
  return null;
}

export function previewOccurrencesFromSpec(spec: RecurrenceSpec, fromDate: string, count: number): string[] {
  const error = validateRecurrenceSpec(spec);
  if (error) throw new Error(error);
  const out: string[] = [];
  let cursor = spec.startDate;
  let produced = 0;
  for (let guard = 0; guard < 2000 && out.length < count; guard += 1) {
    if (spec.maxOccurrences != null && produced >= spec.maxOccurrences) break;
    const adjusted = adjustDate(cursor, spec);
    produced += 1;
    if (spec.endDate && adjusted > spec.endDate) break;
    if (adjusted >= fromDate) out.push(adjusted);
    const next = addStep(cursor, spec);
    if (!next || next <= cursor) break;
    cursor = next;
  }
  return out;
}

export function nextOccurrenceFromSpec(spec: RecurrenceSpec, afterDate: string): string | null {
  const upcoming = previewOccurrencesFromSpec(spec, addDays(afterDate, 1), 1);
  return upcoming[0] ?? null;
}

/** Column value for the legacy enum. The full rule is stored in schedule JSON. */
export function legacyFrequencyForColumn(frequency: FrequencyKind): LegacyFrequencyColumn {
  if (frequency === "monthly") return "monthly";
  if (frequency === "quarterly") return "quarterly";
  if (frequency === "yearly") return "yearly";
  if (frequency === "weekly" || frequency === "fortnightly" || frequency === "daily") return "weekly";
  if (frequency === "half_yearly") return "quarterly";
  return "monthly";
}

/** Civil calendar date in an IANA zone. Does not shift the date through local UTC conversion. */
export function civilDateInTimeZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  if (!year || !month || !day) throw new Error("Could not resolve the organisation date");
  return `${year}-${month}-${day}`;
}

function isMonthlyFamily(frequency: FrequencyKind, customUnit: CustomUnit | null): boolean {
  return (
    frequency === "monthly" ||
    frequency === "quarterly" ||
    frequency === "half_yearly" ||
    frequency === "yearly" ||
    (frequency === "custom" && (customUnit === "months" || customUnit === "years"))
  );
}

function addStep(from: string, spec: RecurrenceSpec): string | null {
  const interval = spec.interval;
  if (spec.frequency === "daily") return addDays(from, interval);
  if (spec.frequency === "weekly") return addDays(from, 7 * interval);
  if (spec.frequency === "fortnightly") return addDays(from, 14);
  if (spec.frequency === "monthly") return addMonths(from, interval, spec);
  if (spec.frequency === "quarterly") return addMonths(from, 3, spec);
  if (spec.frequency === "half_yearly") return addMonths(from, 6, spec);
  if (spec.frequency === "yearly") return addMonths(from, 12 * interval, spec);
  if (spec.customUnit === "days") return addDays(from, interval);
  if (spec.customUnit === "weeks") return addDays(from, 7 * interval);
  if (spec.customUnit === "months") return addMonths(from, interval, spec);
  if (spec.customUnit === "years") return addMonths(from, 12 * interval, spec);
  return null;
}

function addDays(iso: string, days: number): string {
  const d = parseUtcDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return formatUtcDate(d);
}

function addMonths(iso: string, months: number, spec: RecurrenceSpec): string {
  const d = parseUtcDate(iso);
  const anchor = spec.monthDay == null ? parseUtcDate(spec.startDate).getUTCDate() : null;
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const year = target.getUTCFullYear();
  const month = target.getUTCMonth();
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  let day: number;
  if (spec.monthDay === "last_calendar_day" || spec.monthDay === "last_business_day") day = last;
  else if (typeof spec.monthDay === "number") day = Math.min(spec.monthDay, last);
  else day = Math.min(anchor ?? d.getUTCDate(), last);
  target.setUTCDate(day);
  if (spec.monthDay === "last_business_day") {
    return walkToBusinessDay(formatUtcDate(target), spec.holidays, -1);
  }
  return formatUtcDate(target);
}

function adjustDate(iso: string, spec: RecurrenceSpec): string {
  let cursor = iso;
  if (spec.weekendAdjust !== "none" && isWeekend(cursor)) {
    const step = spec.weekendAdjust === "previous_business_day" ? -1 : 1;
    cursor = walkToBusinessDay(cursor, spec.holidays, step);
  }
  if (spec.holidays.includes(cursor)) {
    const step = spec.weekendAdjust === "previous_business_day" ? -1 : 1;
    cursor = walkToOpenDay(cursor, spec, step);
  }
  return cursor;
}

function walkToBusinessDay(iso: string, holidays: string[], step: number): string {
  let cursor = iso;
  for (let i = 0; i < 14 && (isWeekend(cursor) || holidays.includes(cursor)); i += 1) {
    cursor = addDays(cursor, step);
  }
  return cursor;
}

function walkToOpenDay(iso: string, spec: RecurrenceSpec, step: number): string {
  let cursor = addDays(iso, step);
  for (let i = 0; i < 21; i += 1) {
    const blocked =
      spec.holidays.includes(cursor) || (spec.weekendAdjust !== "none" && isWeekend(cursor));
    if (!blocked) return cursor;
    cursor = addDays(cursor, step);
  }
  return cursor;
}

function isWeekend(iso: string): boolean {
  const day = parseUtcDate(iso).getUTCDay();
  return day === 0 || day === 6;
}
