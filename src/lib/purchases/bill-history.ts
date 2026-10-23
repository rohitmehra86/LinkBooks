import { fromMinorUnits } from "@/lib/accounting/money";

/** One row in the bill History and notes table. */
export type BillHistoryRow = {
  id: string;
  at: string;
  user: string;
  action: string;
  detail: string;
  /** Set for payment rows so the detail can open the payment document. */
  paymentId: string | null;
};

export type BillHistoryEvent = {
  id: string;
  created_at: string;
  actor_name?: string | null;
  action: string;
  details?: Record<string, unknown> | null;
};

export type BillHistoryNote = {
  id: string;
  body: string;
  created_at: string;
  created_by_name?: string | null;
};

export type BillHistoryContext = {
  currency: string;
  supplierName?: string | null;
  totalMinor?: number | null;
  creditedMinor?: number | null;
};

export type BillEditSnapshot = {
  totalMinor: number;
  taxMinor: number;
  billDate: string;
  dueDate: string;
  supplierInvoiceNumber: string | null;
  memo: string | null;
  supplierName: string | null;
};

const ACTION_LABELS: Record<string, string> = {
  "bill.draft.create": "Created",
  "bill.draft.update": "Edited",
  "bill.draft.delete": "Deleted",
  "bill.submit_approval": "Submitted",
  "bill.reject_approval": "Returned",
  "bill.authorise": "Approved",
  "bill.void": "Voided",
  "bill.attachment.upload": "File uploaded",
  "bill.attachment.uploaded": "File uploaded",
  "bill.attachment.delete": "File removed",
  "bill.note.add": "Note",
  "supplier_payment.post": "Paid",
  "supplier_payment.reverse": "Payment reversed",
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function minorValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

function formatMoney(minor: number, currency: string): string {
  return fromMinorUnits(BigInt(Math.trunc(minor)), currency);
}

function moneyFrom(details: Record<string, unknown>, currency: string): string | null {
  const raw =
    minorValue(details["allocation_minor"]) ??
    minorValue(details["amount_minor"]) ??
    minorValue(details["total_minor"]);
  if (raw == null) return null;
  try {
    return formatMoney(raw, currency);
  } catch {
    return null;
  }
}

/** Calendar date, not shifted by the viewer’s timezone. */
export function formatHistoryDay(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatHistoryTimestamp(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const zone = timeZone || "UTC";
  try {
    const day = date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: zone,
    });
    const time = date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: zone,
    });
    return `${day} ${time}`;
  } catch {
    return date.toLocaleString();
  }
}

export function historyTimeZoneLabel(timeZone: string): string {
  const zone = timeZone || "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "short",
    }).formatToParts(new Date());
    const name = parts.find((part) => part.type === "timeZoneName")?.value;
    return name ? `Time zone ${name}` : "Time zone UTC";
  } catch {
    return "Time zone UTC";
  }
}

export function billHistoryActionLabel(action: string): string {
  const known = ACTION_LABELS[action];
  if (known) return known;
  const tail = action.split(".").pop() ?? action;
  const words = tail.replace(/[_-]+/g, " ").trim();
  if (!words) return "Updated";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Sentences for a draft save. Amount changes are stated as from → to. */
export function describeBillEdits(
  before: BillEditSnapshot,
  after: BillEditSnapshot,
  currency: string,
  linesChanged: boolean,
): string[] {
  const changes: string[] = [];
  if (before.totalMinor !== after.totalMinor) {
    changes.push(
      `Amount changed from ${formatMoney(before.totalMinor, currency)} to ${formatMoney(after.totalMinor, currency)}.`,
    );
  }
  if ((before.supplierName ?? "") !== (after.supplierName ?? "")) {
    changes.push(
      `Supplier changed from ${before.supplierName || "—"} to ${after.supplierName || "—"}.`,
    );
  }
  if (before.billDate.slice(0, 10) !== after.billDate.slice(0, 10)) {
    changes.push(
      `Bill date changed from ${formatHistoryDay(before.billDate)} to ${formatHistoryDay(after.billDate)}.`,
    );
  }
  if (before.dueDate.slice(0, 10) !== after.dueDate.slice(0, 10)) {
    changes.push(
      `Due date changed from ${formatHistoryDay(before.dueDate)} to ${formatHistoryDay(after.dueDate)}.`,
    );
  }
  if ((before.supplierInvoiceNumber ?? "") !== (after.supplierInvoiceNumber ?? "")) {
    const from = before.supplierInvoiceNumber || "blank";
    const to = after.supplierInvoiceNumber || "blank";
    changes.push(`Supplier invoice number changed from ${from} to ${to}.`);
  }
  if ((before.memo ?? "") !== (after.memo ?? "")) {
    changes.push("Memo was updated.");
  }
  if (before.taxMinor !== after.taxMinor) {
    changes.push(
      `Tax changed from ${formatMoney(before.taxMinor, currency)} to ${formatMoney(after.taxMinor, currency)}.`,
    );
  }
  if (linesChanged && before.totalMinor === after.totalMinor) {
    changes.push("Line items were updated.");
  }
  if (!changes.length) changes.push("Saved the bill. Amount and header were unchanged.");
  return changes;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function paymentClearedIds(events: BillHistoryEvent[], context: BillHistoryContext): Set<string> {
  const posts = events.filter((event) => event.action === "supplier_payment.post");
  const explicit = posts.some((event) => typeof event.details?.["fully_paid"] === "boolean");
  if (explicit) {
    return new Set(
      posts.filter((event) => event.details?.["fully_paid"] === true).map((event) => event.id),
    );
  }
  if (typeof context.totalMinor !== "number") return new Set();
  let remaining = context.totalMinor - (context.creditedMinor ?? 0);
  const ordered = [...posts].sort((a, b) => {
    const left = text(a.details?.["payment_date"]) || a.created_at;
    const right = text(b.details?.["payment_date"]) || b.created_at;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const cleared = new Set<string>();
  for (const event of ordered) {
    const amount =
      minorValue(event.details?.["allocation_minor"]) ??
      minorValue(event.details?.["amount_minor"]);
    if (amount == null) continue;
    remaining -= amount;
    if (remaining <= 0) cleared.add(event.id);
  }
  return cleared;
}

function paymentSentence(
  details: Record<string, unknown>,
  currency: string,
  supplierFallback: string,
  fullyPaid: boolean,
): string {
  const supplier = text(details["supplier_name"]) || supplierFallback;
  const paymentDate = text(details["payment_date"]);
  const amount = moneyFrom(details, currency);
  const who = supplier ? ` to ${supplier}` : "";
  const when = paymentDate ? ` on ${formatHistoryDay(paymentDate)}` : "";
  const amt = amount ? ` for ${amount}` : "";
  const settled = fullyPaid ? " This bill has been fully paid." : "";
  return `Payment made${who}${when}${amt}.${settled}`;
}

function detailFor(
  event: BillHistoryEvent,
  currency: string,
  noteBody: string,
  supplierName: string,
  fullyPaid: boolean,
): string {
  const details = event.details ?? {};
  const changes = stringList(details["changes"]);
  const amount = moneyFrom(details, currency);
  const file = text(details["file_name"]);
  const comment = text(details["comment"]);
  const reason = text(details["reason"]);
  const storedNote = text(details["body"]);
  const supplier = text(details["supplier_name"]) || supplierName;

  switch (event.action) {
    case "bill.draft.create":
      if (supplier && amount) return `Created for ${supplier} for ${amount}.`;
      return amount ? `Created for ${amount}.` : "Bill created.";
    case "bill.draft.update":
      if (changes.length) return changes.join(" ");
      return amount ? `Amount saved as ${amount}.` : "Saved changes.";
    case "bill.draft.delete":
      return "Draft deleted.";
    case "bill.submit_approval":
      return comment ? `Submitted for approval. ${comment}` : "Submitted for approval.";
    case "bill.reject_approval":
      return reason ? `Returned for correction. ${reason}` : "Returned for correction.";
    case "bill.authorise":
      return amount
        ? `Approved for ${amount} and posted to the ledger.`
        : "Approved and posted to the ledger.";
    case "bill.void":
      return "Voided. Posted journals were reversed.";
    case "bill.attachment.upload":
    case "bill.attachment.uploaded":
      return file ? `Uploaded file: ${file}` : "File uploaded.";
    case "bill.attachment.delete":
      return file ? `Removed file: ${file}` : "File removed.";
    case "bill.note.add":
      return noteBody || storedNote || "Internal note added.";
    case "supplier_payment.post":
      return paymentSentence(details, currency, supplierName, fullyPaid);
    case "supplier_payment.reverse":
      return supplier
        ? `Payment to ${supplier} was reversed. The bill balance was restored.`
        : "Payment reversed. The bill balance was restored.";
    default:
      return changes.join(" ");
  }
}

/**
 * One chronological history for a bill. Notes that already have an audit event
 * are shown once, using the note text as the detail.
 */
export function presentBillHistory(
  events: BillHistoryEvent[],
  notes: BillHistoryNote[],
  context: BillHistoryContext,
): BillHistoryRow[] {
  const notesById = new Map(notes.map((note) => [note.id, note]));
  const usedNoteIds = new Set<string>();
  const cleared = paymentClearedIds(events, context);
  const supplierName = text(context.supplierName);
  const rows: BillHistoryRow[] = [];

  for (const event of events) {
    const noteId = text(event.details?.["note_id"]);
    const note = noteId ? notesById.get(noteId) : undefined;
    if (note) usedNoteIds.add(note.id);
    rows.push({
      id: event.id,
      at: event.created_at,
      user: text(event.actor_name) || text(event.details?.["actor_name"]) || "—",
      action: billHistoryActionLabel(event.action),
      detail: detailFor(
        event,
        context.currency,
        note?.body ?? "",
        supplierName,
        cleared.has(event.id),
      ),
      paymentId:
        event.action === "supplier_payment.post" || event.action === "supplier_payment.reverse"
          ? text(event.details?.["payment_id"]) || null
          : null,
    });
  }

  for (const note of notes) {
    if (usedNoteIds.has(note.id)) continue;
    rows.push({
      id: `note:${note.id}`,
      at: note.created_at,
      user: text(note.created_by_name) || "—",
      action: "Note",
      detail: note.body,
      paymentId: null,
    });
  }

  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return rows;
}
