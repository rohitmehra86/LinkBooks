/**
 * One mapping from a document/record status string to a display label and a colour tone.
 * Pure presentation: it never decides what a status IS, only how it looks, so every list and
 * detail page shows "Awaiting payment" or "Overdue" in the same colour and words.
 */

export type StatusTone = "neutral" | "warning" | "info" | "success" | "danger";

export type StatusDisplay = {
  label: string;
  tone: StatusTone;
  /** Voided documents are drawn struck-through so they are never mistaken for live ones. */
  muted?: boolean;
};

const MAP: Record<string, StatusDisplay> = {
  draft: { label: "Draft", tone: "neutral" },
  submitted: { label: "Awaiting approval", tone: "warning" },
  awaiting_approval: { label: "Awaiting approval", tone: "warning" },
  pending: { label: "Pending", tone: "warning" },
  authorised: { label: "Awaiting payment", tone: "info" },
  awaiting_payment: { label: "Awaiting payment", tone: "info" },
  approved: { label: "Approved", tone: "info" },
  partly_paid: { label: "Partly paid", tone: "info" },
  paid: { label: "Paid", tone: "success" },
  overdue: { label: "Overdue", tone: "danger" },
  void: { label: "Void", tone: "neutral", muted: true },
  voided: { label: "Void", tone: "neutral", muted: true },
  // Quotes
  sent: { label: "Sent", tone: "info" },
  accepted: { label: "Accepted", tone: "success" },
  declined: { label: "Declined", tone: "danger" },
  expired: { label: "Expired", tone: "warning" },
  converted: { label: "Converted", tone: "neutral" },
  // Banking, records
  reconciled: { label: "Reconciled", tone: "success" },
  unreconciled: { label: "Unreconciled", tone: "warning" },
  posted: { label: "Posted", tone: "success" },
  reversed: { label: "Reversed", tone: "neutral", muted: true },
  rejected: { label: "Rejected", tone: "danger" },
  active: { label: "Active", tone: "success" },
  paused: { label: "Paused", tone: "neutral" },
  archived: { label: "Archived", tone: "neutral", muted: true },
};

/** "partly_paid" -> "Partly paid" for statuses we have no explicit entry for. */
export function humanizeStatus(raw: string): string {
  const s = raw.replace(/[_-]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "—";
}

/**
 * Display for a status string. Matching is case/space/underscore-insensitive
 * ("Awaiting payment" and "awaiting_payment" are the same). Unknown statuses render neutral
 * with a humanised label rather than guessing a meaning.
 */
export function statusDisplay(status: string | null | undefined): StatusDisplay {
  if (!status) return { label: "—", tone: "neutral" };
  const key = status
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return MAP[key] ?? { label: humanizeStatus(status), tone: "neutral" };
}

/**
 * Invoice/bill status, promoting an unpaid authorised/part-paid document past its due date
 * to "overdue". `today` and `dueDate` are ISO dates (YYYY-MM-DD); ISO strings compare correctly.
 */
export function effectiveStatus(
  status: string,
  dueDate: string | null | undefined,
  today: string,
): string {
  const open = status === "authorised" || status === "partly_paid" || status === "awaiting_payment";
  if (open && dueDate && dueDate < today) return "overdue";
  return status;
}
