/** Overdue-invoice reminder rules. Pure. */
import { daysOverdue } from "@/lib/documents/helpers";

export type ReminderSettings = {
  /** Days after the due date before the first reminder is due. */
  firstAfterDays: number;
  /** Days between further reminders. */
  repeatEveryDays: number;
  /** Stop after this many reminders per invoice. */
  maxReminders: number;
  /** Include a copy of the payment details in reminders. */
  includeBankDetails: boolean;
};

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  firstAfterDays: 7,
  repeatEveryDays: 14,
  maxReminders: 3,
  includeBankDetails: true,
};

export function normaliseReminderSettings(
  input: Partial<ReminderSettings> | null | undefined,
): ReminderSettings {
  const clamp = (v: unknown, lo: number, hi: number, d: number) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  const d = DEFAULT_REMINDER_SETTINGS;
  return {
    firstAfterDays: clamp(input?.firstAfterDays, 0, 365, d.firstAfterDays),
    repeatEveryDays: clamp(input?.repeatEveryDays, 1, 365, d.repeatEveryDays),
    maxReminders: clamp(input?.maxReminders, 1, 12, d.maxReminders),
    includeBankDetails: input?.includeBankDetails ?? d.includeBankDetails,
  };
}

export type ReminderCandidate = {
  status: string;
  dueDate: string;
  outstandingMinor: number;
  /** Reminders already sent for this invoice. */
  remindersSent: number;
  /** Date (ISO) the last reminder was sent, if any. */
  lastReminderDate: string | null;
};

export type ReminderDecision =
  | { due: true; daysOverdue: number }
  | { due: false; reason: "not_open" | "not_overdue" | "too_early" | "max_reached" | "too_soon" };

/** Whether the next scheduled reminder for an invoice is due today. */
export function reminderDecision(
  c: ReminderCandidate,
  today: string,
  s: ReminderSettings,
): ReminderDecision {
  if (!["authorised", "partly_paid"].includes(c.status) || c.outstandingMinor <= 0) {
    return { due: false, reason: "not_open" };
  }
  const overdue = daysOverdue(c.dueDate, today);
  if (overdue <= 0) return { due: false, reason: "not_overdue" };
  if (c.remindersSent >= s.maxReminders) return { due: false, reason: "max_reached" };
  if (c.remindersSent === 0) {
    return overdue >= s.firstAfterDays
      ? { due: true, daysOverdue: overdue }
      : { due: false, reason: "too_early" };
  }
  if (c.lastReminderDate && daysOverdue(c.lastReminderDate, today) < s.repeatEveryDays) {
    return { due: false, reason: "too_soon" };
  }
  return { due: true, daysOverdue: overdue };
}

export const REMINDER_REASON_TEXT: Record<string, string> = {
  not_open: "Not open",
  not_overdue: "Not overdue yet",
  too_early: "First reminder not due yet",
  max_reached: "Maximum reminders sent",
  too_soon: "Waiting between reminders",
};
