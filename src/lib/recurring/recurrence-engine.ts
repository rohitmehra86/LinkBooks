import { RRule } from "rrule";
import { formatUtcDate, parseUtcDate } from "@/lib/recurring/dates";
import {
  legacyFrequencyToRrule,
  rruleOptionsFromLegacy,
  type LegacyRecurrenceFrequency,
} from "@/lib/recurring/legacy-frequency";

export type RecurrenceRuleInput = {
  dtstart: string;
  rrule: string;
};

/** Next occurrence strictly after `afterDate` (anchor-based via RRULE). */
export function nextOccurrenceAfter(
  input: RecurrenceRuleInput,
  afterDate: string,
): string | null {
  const normalized = normalizeRrule(input.rrule);
  if (normalized === "FREQ=MONTHLY") {
    return nextMonthlyAnchorDate(input.dtstart, afterDate, 1);
  }
  if (normalized === "FREQ=MONTHLY;INTERVAL=3") {
    return nextMonthlyAnchorDate(input.dtstart, afterDate, 3);
  }

  const dtstart = parseUtcDate(input.dtstart);
  const rule = RRule.fromString(
    `DTSTART:${formatRruleDtstart(dtstart)}\nRRULE:${normalized}`,
  );
  const after = parseUtcDate(afterDate);
  const next = rule.after(after, false);
  return next ? formatUtcDate(next) : null;
}

/** Calendar-month advance using dtstart day-of-month, clamped to month length (anchor rule). */
export function nextMonthlyAnchorDate(
  dtstartIso: string,
  afterIso: string,
  intervalMonths: number,
): string | null {
  const anchorDay = parseUtcDate(dtstartIso).getUTCDate();
  const after = parseUtcDate(afterIso);
  const cursor = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), 1));
  cursor.setUTCMonth(cursor.getUTCMonth() + intervalMonths);
  const lastDay = lastDayOfUtcMonth(cursor.getUTCFullYear(), cursor.getUTCMonth());
  cursor.setUTCDate(Math.min(anchorDay, lastDay));
  const next = formatUtcDate(cursor);
  if (next <= afterIso) {
    return nextMonthlyAnchorDate(dtstartIso, next, intervalMonths);
  }
  return next;
}

function lastDayOfUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** Preview upcoming occurrence dates (inclusive of first on/after `fromDate`). */
export function previewOccurrences(
  input: RecurrenceRuleInput,
  fromDate: string,
  count: number,
): string[] {
  const dtstart = parseUtcDate(input.dtstart);
  const rule = RRule.fromString(
    `DTSTART:${formatRruleDtstart(dtstart)}\nRRULE:${normalizeRrule(input.rrule)}`,
  );
  const from = parseUtcDate(fromDate);
  const dates = rule.between(from, addYears(from, 5), true).slice(0, count);
  return dates.map(formatUtcDate);
}

export function nextFromLegacyFrequency(
  frequency: LegacyRecurrenceFrequency,
  dtstart: string,
  afterDate: string,
): string | null {
  return nextOccurrenceAfter(
    { dtstart, rrule: legacyFrequencyToRrule(frequency) },
    afterDate,
  );
}

export function buildRuleFromLegacy(
  frequency: LegacyRecurrenceFrequency,
  dtstartIso: string,
): RRule {
  const dtstart = parseUtcDate(dtstartIso);
  return new RRule({
    ...rruleOptionsFromLegacy(frequency, dtstart),
  });
}

function normalizeRrule(rrule: string): string {
  return rrule.trim().replace(/^RRULE:/i, "");
}

function formatRruleDtstart(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}T000000Z`;
}

function addYears(d: Date, years: number): Date {
  const copy = new Date(d.getTime());
  copy.setUTCFullYear(copy.getUTCFullYear() + years);
  return copy;
}
