/** Calendar dates as YYYY-MM-DD in UTC (matches existing LinkBooks date handling). */

export function parseUtcDate(isoDate: string): Date {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${isoDate}`);
  return d;
}

export function formatUtcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}
