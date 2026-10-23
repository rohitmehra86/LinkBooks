/**
 * Accounts-receivable "as at" maths (AR-08). Pure, integer minor units, no I/O.
 *
 * Outstanding at `asOf` is rebuilt from dated events, never from the invoice's CURRENT paid /
 * credited amounts:
 *   outstanding = total − Σ allocations with effective date ≤ asOf and not reversed on/before asOf
 * An invoice only exists at `asOf` if it was authorised (not draft), dated ≤ asOf, and not voided
 * on/before asOf. A legacy void without a recorded void date was reversed at the original invoice
 * date, so it never appears in any period.
 */
import { ageBucket, type AgingBucket } from "@/lib/accounting/reporting";

export type AsAtInvoice = {
  id: string;
  contactId: string;
  contactName: string;
  number: string | null;
  currencyCode: string;
  invoiceDate: string;
  dueDate: string;
  totalMinor: number;
  status: string;
  voidDate: string | null;
};

/** A receipt or credit-note allocation against an invoice. */
export type AsAtAllocation = {
  invoiceId: string;
  amountMinor: number;
  /** Effective date (receipt date / credit application date). */
  effectiveDate: string;
  reversedOn: string | null;
};

export type AsAtReceipt = {
  id: string;
  contactId: string;
  contactName: string;
  reference: string | null;
  currencyCode: string;
  receiptDate: string;
  amountMinor: number;
  status: string; // posted | void
  voidDate: string | null;
  /** Current unallocated balance — used to detect amounts consumed by refunds. */
  unallocatedMinor: number;
};

export type AsAtCreditNote = {
  id: string;
  contactId: string;
  contactName: string;
  number: string | null;
  currencyCode: string;
  creditDate: string;
  totalMinor: number;
  status: string; // draft | authorised | partly_paid | paid | void
  voidDate: string | null;
  amountAllocatedMinor: number;
};

export function isAllocationActiveAt(a: AsAtAllocation, asOf: string): boolean {
  if (a.effectiveDate > asOf) return false;
  if (a.reversedOn && a.reversedOn <= asOf) return false;
  return true;
}

export function allocatedAsAt(allocs: AsAtAllocation[], asOf: string): number {
  return allocs.reduce((s, a) => (isAllocationActiveAt(a, asOf) ? s + a.amountMinor : s), 0);
}

export function invoiceIsOnBooksAt(inv: AsAtInvoice, asOf: string): boolean {
  if (inv.status === "draft") return false;
  if (inv.invoiceDate > asOf) return false;
  if (inv.status === "void") {
    if (!inv.voidDate) return false;
    return inv.voidDate > asOf;
  }
  return true;
}

/** Outstanding balance of one invoice at `asOf` (0 when not on the books or fully settled). */
export function invoiceOutstandingAsAt(
  inv: AsAtInvoice,
  allocs: AsAtAllocation[],
  asOf: string,
): number {
  if (!invoiceIsOnBooksAt(inv, asOf)) return 0;
  return Math.max(0, inv.totalMinor - allocatedAsAt(allocs, asOf));
}

function receiptIsOnBooksAt(r: AsAtReceipt, asOf: string): boolean {
  if (r.receiptDate > asOf) return false;
  if (r.status === "void") return Boolean(r.voidDate) && (r.voidDate as string) > asOf;
  return true;
}

/**
 * Unapplied cash at `asOf`: receipt amount − allocations active at asOf − amount consumed by
 * refunds. Refund consumption is undated in the schema, so it is deducted in full (i.e. the
 * figure is exact for today and for any date after the refund).
 */
export function unappliedReceiptAsAt(
  r: AsAtReceipt,
  allocs: AsAtAllocation[],
  asOf: string,
): number {
  if (!receiptIsOnBooksAt(r, asOf)) return 0;
  const activeNow = allocs.reduce((s, a) => (a.reversedOn ? s : s + a.amountMinor), 0);
  const refunded =
    r.status === "void" ? 0 : Math.max(0, r.amountMinor - activeNow - r.unallocatedMinor);
  return Math.max(0, r.amountMinor - allocatedAsAt(allocs, asOf) - refunded);
}

function creditIsOnBooksAt(c: AsAtCreditNote, asOf: string): boolean {
  if (c.status === "draft") return false;
  if (c.creditDate > asOf) return false;
  if (c.status === "void") return Boolean(c.voidDate) && (c.voidDate as string) > asOf;
  return true;
}

export function unappliedCreditAsAt(
  c: AsAtCreditNote,
  allocs: AsAtAllocation[],
  asOf: string,
): number {
  if (!creditIsOnBooksAt(c, asOf)) return 0;
  const activeNow = allocs.reduce((s, a) => (a.reversedOn ? s : s + a.amountMinor), 0);
  const refunded = c.status === "void" ? 0 : Math.max(0, c.amountAllocatedMinor - activeNow);
  return Math.max(0, c.totalMinor - allocatedAsAt(allocs, asOf) - refunded);
}

// ---------------------------------------------------------------------------
// Aged receivables
// ---------------------------------------------------------------------------

export type AgedLine = {
  kind: "invoice" | "receipt" | "credit_note";
  id: string;
  reference: string | null;
  doc_date: string;
  due_date: string;
  /** Positive for invoices, negative for unapplied receipts / credits. */
  outstanding_minor: number;
  bucket: AgingBucket;
};

export type AgedRow = {
  contact_id: string;
  contact_name: string;
  currency_code: string;
  current: number;
  b_1_30: number;
  b_31_60: number;
  b_61_90: number;
  b_90_plus: number;
  /** Negative: unapplied receipts + credits (already included in the buckets and total). */
  unapplied: number;
  total: number;
  docs: AgedLine[];
};

export type AgedReceivablesAsAt = {
  asOf: string;
  rows: AgedRow[];
  /** Totals per currency — amounts in different currencies are never added together. */
  totalsByCurrency: Array<{
    currency_code: string;
    total: number;
    byBucket: Record<AgingBucket, number>;
    unapplied: number;
  }>;
};

function emptyBuckets(): Record<AgingBucket, number> {
  return { current: 0, "1_30": 0, "31_60": 0, "61_90": 0, "90_plus": 0 };
}

export function buildAgedReceivablesAsAt(input: {
  asOf: string;
  invoices: AsAtInvoice[];
  receipts: AsAtReceipt[];
  creditNotes: AsAtCreditNote[];
  receiptAllocations: Array<AsAtAllocation & { receiptId: string }>;
  creditAllocations: Array<AsAtAllocation & { creditNoteId: string }>;
}): AgedReceivablesAsAt {
  const { asOf } = input;
  const byInvoice = new Map<string, AsAtAllocation[]>();
  const push = (m: Map<string, AsAtAllocation[]>, key: string, a: AsAtAllocation) => {
    const arr = m.get(key);
    if (arr) arr.push(a);
    else m.set(key, [a]);
  };
  const byReceipt = new Map<string, AsAtAllocation[]>();
  const byCredit = new Map<string, AsAtAllocation[]>();
  for (const a of input.receiptAllocations) {
    push(byInvoice, a.invoiceId, a);
    push(byReceipt, a.receiptId, a);
  }
  for (const a of input.creditAllocations) {
    push(byInvoice, a.invoiceId, a);
    push(byCredit, a.creditNoteId, a);
  }

  const rows = new Map<string, AgedRow>();
  const totals = new Map<
    string,
    { total: number; byBucket: Record<AgingBucket, number>; unapplied: number }
  >();

  const add = (
    contactId: string,
    contactName: string,
    currency: string,
    line: Omit<AgedLine, "bucket">,
    negative: boolean,
  ) => {
    const bucket = ageBucket(line.due_date, asOf);
    const key = `${contactId}|${currency}`;
    const row =
      rows.get(key) ??
      ({
        contact_id: contactId,
        contact_name: contactName,
        currency_code: currency,
        current: 0,
        b_1_30: 0,
        b_31_60: 0,
        b_61_90: 0,
        b_90_plus: 0,
        unapplied: 0,
        total: 0,
        docs: [],
      } as AgedRow);
    const amt = line.outstanding_minor;
    if (bucket === "current") row.current += amt;
    else if (bucket === "1_30") row.b_1_30 += amt;
    else if (bucket === "31_60") row.b_31_60 += amt;
    else if (bucket === "61_90") row.b_61_90 += amt;
    else row.b_90_plus += amt;
    row.total += amt;
    if (negative) row.unapplied += amt;
    row.docs.push({ ...line, bucket });
    rows.set(key, row);

    const t = totals.get(currency) ?? { total: 0, byBucket: emptyBuckets(), unapplied: 0 };
    t.total += amt;
    t.byBucket[bucket] += amt;
    if (negative) t.unapplied += amt;
    totals.set(currency, t);
  };

  for (const inv of input.invoices) {
    const out = invoiceOutstandingAsAt(inv, byInvoice.get(inv.id) ?? [], asOf);
    if (out <= 0) continue;
    add(
      inv.contactId,
      inv.contactName,
      inv.currencyCode,
      {
        kind: "invoice",
        id: inv.id,
        reference: inv.number,
        doc_date: inv.invoiceDate,
        due_date: inv.dueDate,
        outstanding_minor: out,
      },
      false,
    );
  }
  for (const r of input.receipts) {
    const un = unappliedReceiptAsAt(r, byReceipt.get(r.id) ?? [], asOf);
    if (un <= 0) continue;
    add(
      r.contactId,
      r.contactName,
      r.currencyCode,
      {
        kind: "receipt",
        id: r.id,
        reference: r.reference ? `Receipt ${r.reference}` : "Unapplied receipt",
        doc_date: r.receiptDate,
        due_date: r.receiptDate,
        outstanding_minor: -un,
      },
      true,
    );
  }
  for (const c of input.creditNotes) {
    const un = unappliedCreditAsAt(c, byCredit.get(c.id) ?? [], asOf);
    if (un <= 0) continue;
    add(
      c.contactId,
      c.contactName,
      c.currencyCode,
      {
        kind: "credit_note",
        id: c.id,
        reference: c.number ? `Credit ${c.number}` : "Unapplied credit note",
        doc_date: c.creditDate,
        due_date: c.creditDate,
        outstanding_minor: -un,
      },
      true,
    );
  }

  const out = [...rows.values()]
    .filter((r) => r.total !== 0 || r.docs.length > 0)
    .sort(
      (a, b) =>
        a.contact_name.localeCompare(b.contact_name) ||
        a.currency_code.localeCompare(b.currency_code),
    );
  for (const r of out) r.docs.sort((a, b) => a.doc_date.localeCompare(b.doc_date));
  return {
    asOf,
    rows: out,
    totalsByCurrency: [...totals.entries()]
      .map(([currency_code, t]) => ({ currency_code, ...t }))
      .sort((a, b) => a.currency_code.localeCompare(b.currency_code)),
  };
}
