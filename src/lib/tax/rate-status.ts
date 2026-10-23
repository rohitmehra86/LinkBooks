/** Display status and validation for effective-dated tax rates (TX-05). */

export type RateDates = {
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
};

export type RateStatus = "current" | "scheduled" | "ended" | "inactive";

export function rateStatus(rate: RateDates, today: string): RateStatus {
  if (!rate.is_active) return "inactive";
  if (today < rate.effective_from) return "scheduled";
  if (rate.effective_to && today > rate.effective_to) return "ended";
  return "current";
}

export const RATE_STATUS_LABEL: Record<RateStatus, string> = {
  current: "Current",
  scheduled: "Starts later",
  ended: "Ended",
  inactive: "Inactive",
};

/** Returns an error message, or null when the end date is acceptable. */
export function validateRateEndDate(effectiveFrom: string, endDate: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return "Enter the end date as YYYY-MM-DD.";
  if (endDate < effectiveFrom) return "The end date cannot be before the rate starts.";
  return null;
}

/**
 * When a rate changes (e.g. 20% to 22%), keep the old rate's history: end the old rate the day
 * before and start the new one. Returns the old rate's new end date.
 */
export function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
