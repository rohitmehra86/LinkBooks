/**
 * Fiscal-year arithmetic from the company's year-end (month + day). Pure, UTC-only, string dates.
 * A "FY ending 31 Mar" runs 1 Apr → 31 Mar. Feb-29 year-ends use the last day of February.
 */

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;
}

export function addDaysIso(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** FY end date that falls in calendar `year` (clamped to month length). */
export function fiscalYearEndInYear(year: number, endMonth: number, endDay: number): string {
  const m = Math.min(12, Math.max(1, Math.floor(endMonth || 12)));
  const d = Math.min(daysInMonth(year, m), Math.max(1, Math.floor(endDay || 31)));
  return iso(year, m, d);
}

export type FiscalYear = { start: string; end: string };

/** The fiscal year containing `date` for a company whose year ends on endMonth/endDay. */
export function fiscalYearContaining(date: string, endMonth: number, endDay: number): FiscalYear {
  const year = Number(date.slice(0, 4));
  const endThisYear = fiscalYearEndInYear(year, endMonth, endDay);
  const end = date <= endThisYear ? endThisYear : fiscalYearEndInYear(year + 1, endMonth, endDay);
  const endYear = Number(end.slice(0, 4));
  const previousEnd = fiscalYearEndInYear(endYear - 1, endMonth, endDay);
  return { start: addDaysIso(previousEnd, 1), end };
}

export function fiscalYearStart(date: string, endMonth: number, endDay: number): string {
  return fiscalYearContaining(date, endMonth, endDay).start;
}

/** The fiscal year immediately before the one containing `date`. */
export function previousFiscalYear(date: string, endMonth: number, endDay: number): FiscalYear {
  const current = fiscalYearContaining(date, endMonth, endDay);
  return fiscalYearContaining(addDaysIso(current.start, -1), endMonth, endDay);
}

/** Same range one year earlier (for comparatives). Feb 29 maps to Feb 28. */
export function shiftYear(date: string, years: number): string {
  const y = Number(date.slice(0, 4)) + years;
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return iso(y, m, Math.min(d, daysInMonth(y, m)));
}

export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function monthEnd(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return iso(y, m, daysInMonth(y, m));
}

/** Add whole months, clamping the day. */
export function addMonthsIso(date: string, months: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)) - 1 + months;
  const year = y + Math.floor(m / 12);
  const month = (((m % 12) + 12) % 12) + 1;
  const d = Math.min(Number(date.slice(8, 10)), daysInMonth(year, month));
  return iso(year, month, d);
}

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
