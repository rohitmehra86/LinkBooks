/** Pure helpers for the "run due now" processors. */
export type DueCandidate = { id: string; next_due_date: string; is_active: boolean };

/** Active schedules whose next date is on or before `today`, oldest first, capped. */
export function selectDueSchedules<T extends DueCandidate>(
  rows: T[],
  today: string,
  cap = 50,
): T[] {
  return rows
    .filter((r) => r.is_active && r.next_due_date <= today)
    .sort((a, b) => a.next_due_date.localeCompare(b.next_due_date) || a.id.localeCompare(b.id))
    .slice(0, cap);
}

export type RunDueSummary = {
  generated: number;
  failed: Array<{ id: string; message: string }>;
};

export function describeRunDue(label: string, summary: RunDueSummary): string {
  if (summary.generated === 0 && summary.failed.length === 0) return `No ${label} are due`;
  const base = `${summary.generated} ${label} generated`;
  return summary.failed.length ? `${base}, ${summary.failed.length} failed` : base;
}
