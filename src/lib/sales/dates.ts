/** Date helpers for sales (company-timezone aware "today"; AR-16, AR-26). */

/** YYYY-MM-DD for `now` in an IANA timezone. Falls back to UTC for an unknown zone. */
export function todayInTimezone(
  timeZone: string | null | undefined,
  now: Date = new Date(),
): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const iso = `${get("year")}-${get("month")}-${get("day")}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : now.toISOString().slice(0, 10);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function isOverdue(dueDate: string, today: string, outstandingMinor: number): boolean {
  return outstandingMinor > 0 && dueDate < today;
}
