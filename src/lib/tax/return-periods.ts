import { addDaysIso, addMonthsIso, monthStart } from "@/lib/accounting/fiscal-year";

const MONTHS_BY_FREQUENCY: Record<string, number> = {
  monthly: 1,
  bi_monthly: 2,
  quarterly: 3,
  semi_annually: 6,
  annually: 12,
};

export function monthsForFrequency(frequency: string | null | undefined): number {
  return MONTHS_BY_FREQUENCY[frequency ?? ""] ?? 3;
}

/**
 * Suggested next return period. It follows the last filed return when there is one; otherwise it
 * is the most recent fully finished calendar block of the filing frequency. The user can change
 * both dates, so this is only a starting point.
 */
export function suggestReturnPeriod(args: {
  frequency: string | null | undefined;
  today: string;
  lastFiledEnd: string | null;
}): { start: string; end: string } {
  const months = monthsForFrequency(args.frequency);
  if (args.lastFiledEnd) {
    const start = addDaysIso(args.lastFiledEnd, 1);
    return { start, end: addDaysIso(addMonthsIso(start, months), -1) };
  }
  const thisMonth = monthStart(args.today);
  const monthIndex = Number(thisMonth.slice(5, 7)) - 1;
  const blockStartMonthIndex = monthIndex - (monthIndex % months);
  const blockStart = addMonthsIso(thisMonth, -(monthIndex - blockStartMonthIndex));
  const start = addMonthsIso(blockStart, -months);
  return { start, end: addDaysIso(blockStart, -1) };
}
