/** Explicit quote status transition table (AR-17). */

export const QUOTE_STATUSES = [
  "draft",
  "sent",
  "accepted",
  "declined",
  "expired",
  "converted",
  "void",
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/**
 * `converted` is only reachable through quote -> invoice conversion, never by a manual status change.
 * `converted` and `void` are terminal.
 */
export const QUOTE_TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
  draft: ["sent", "accepted", "declined", "void"],
  sent: ["accepted", "declined", "expired", "void"],
  accepted: ["declined", "void"],
  declined: ["sent", "void"],
  expired: ["sent", "void"],
  converted: [],
  void: [],
};

export function isQuoteStatus(s: string): s is QuoteStatus {
  return (QUOTE_STATUSES as readonly string[]).includes(s);
}

export function canTransitionQuote(from: string, to: string): boolean {
  if (!isQuoteStatus(from) || !isQuoteStatus(to)) return false;
  return QUOTE_TRANSITIONS[from].includes(to);
}

export function assertQuoteTransition(from: string, to: string): void {
  if (from === to) throw new Error(`Quote is already ${to}`);
  if (to === "converted") throw new Error("Use “Convert to invoice” to convert a quote");
  if (!canTransitionQuote(from, to)) {
    throw new Error(`A ${from} quote cannot be changed to ${to}`);
  }
}

/** Timestamp columns that must be stamped when entering a status. */
export function quoteTimestampColumns(to: QuoteStatus, nowIso: string): Record<string, string> {
  switch (to) {
    case "sent":
      return { sent_at: nowIso };
    case "accepted":
      return { accepted_at: nowIso };
    case "declined":
      return { declined_at: nowIso };
    default:
      return {};
  }
}

export function quoteStatusActions(status: string): QuoteStatus[] {
  if (!isQuoteStatus(status)) return [];
  return [...QUOTE_TRANSITIONS[status]];
}

/** A quote past its expiry date cannot be converted until its expiry is extended. */
export function isQuoteConvertible(
  q: { status: string; expiry_date: string | null; converted_invoice_id?: string | null },
  today: string,
): { ok: true } | { ok: false; reason: string } {
  if (q.converted_invoice_id || q.status === "converted") {
    return { ok: false, reason: "Quote already converted" };
  }
  if (!["draft", "sent", "accepted"].includes(q.status)) {
    return { ok: false, reason: `A ${q.status} quote cannot be converted` };
  }
  if (q.expiry_date && q.expiry_date < today) {
    return { ok: false, reason: "Quote has expired — extend the expiry date first" };
  }
  return { ok: true };
}
