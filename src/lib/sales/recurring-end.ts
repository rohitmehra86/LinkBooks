/** When does a recurring invoice stop? Pure (AR-15). */

export type RecurringEndInput = {
  endDate: string | null;
  maxOccurrences: number | null;
  /** Occurrences generated INCLUDING the one just produced. */
  occurrencesGenerated: number;
  /** Next scheduled date computed from the rule, or null if the rule has no more dates. */
  nextDate: string | null;
};

export function recurringFinished(i: RecurringEndInput): {
  finished: boolean;
  reason: string | null;
} {
  if (!i.nextDate) return { finished: true, reason: "The schedule has no further dates" };
  if (i.endDate && i.nextDate > i.endDate) {
    return { finished: true, reason: `The next date (${i.nextDate}) is after the end date` };
  }
  if (i.maxOccurrences !== null && i.occurrencesGenerated >= i.maxOccurrences) {
    return { finished: true, reason: "The maximum number of invoices has been generated" };
  }
  return { finished: false, reason: null };
}

/** A run is not allowed if its scheduled date is already past the end date. */
export function assertRecurringRunnable(args: {
  scheduledDate: string;
  endDate: string | null;
  maxOccurrences: number | null;
  occurrencesGenerated: number;
}): void {
  if (args.endDate && args.scheduledDate > args.endDate) {
    throw new Error("This recurring invoice has ended");
  }
  if (args.maxOccurrences !== null && args.occurrencesGenerated >= args.maxOccurrences) {
    throw new Error("This recurring invoice has reached its maximum number of invoices");
  }
}
