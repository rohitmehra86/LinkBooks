/**
 * Pure allocation validation for customer receipts and credit notes (AR-01/03/04).
 * Mirrors the checks in the Postgres RPCs so the fallback path and the UI behave identically.
 * Money is integer minor units (number is safe: validated with Number.isSafeInteger).
 */

export type AllocatableInvoice = {
  id: string;
  number?: string | null;
  contactId: string;
  currencyCode: string;
  status: string;
  totalMinor: number;
  amountPaidMinor: number;
  amountCreditedMinor: number;
};

export type AllocationInput = { invoiceId: string; amountMinor: number };

export const PAYABLE_INVOICE_STATUSES = ["authorised", "partly_paid"] as const;

export function invoiceOutstandingMinor(
  inv: Pick<AllocatableInvoice, "totalMinor" | "amountPaidMinor" | "amountCreditedMinor">,
): number {
  return inv.totalMinor - inv.amountPaidMinor - inv.amountCreditedMinor;
}

function label(inv: AllocatableInvoice): string {
  return inv.number?.trim() || inv.id.slice(0, 8);
}

function assertAmounts(allocations: AllocationInput[]): number {
  const seen = new Set<string>();
  let sum = 0;
  for (const a of allocations) {
    if (!Number.isSafeInteger(a.amountMinor) || a.amountMinor <= 0) {
      throw new Error("Allocation amounts must be positive");
    }
    if (seen.has(a.invoiceId)) throw new Error("An invoice can only appear once per allocation");
    seen.add(a.invoiceId);
    sum += a.amountMinor;
  }
  return sum;
}

function assertInvoiceAllocatable(
  inv: AllocatableInvoice | undefined,
  alloc: AllocationInput,
  ctx: { contactId: string; currencyCode: string; noun: "payment" | "credit" },
): void {
  if (!inv) throw new Error("Invoice not found for allocation");
  if (inv.contactId !== ctx.contactId) {
    throw new Error(`Invoice ${label(inv)} belongs to a different customer`);
  }
  if (inv.currencyCode !== ctx.currencyCode) {
    throw new Error(
      `Invoice ${label(inv)} is in ${inv.currencyCode} but the ${ctx.noun === "payment" ? "receipt" : "credit note"} is in ${ctx.currencyCode}`,
    );
  }
  if (!(PAYABLE_INVOICE_STATUSES as readonly string[]).includes(inv.status)) {
    throw new Error(`Invoice ${label(inv)} is ${inv.status} and cannot receive a ${ctx.noun}`);
  }
  if (alloc.amountMinor > invoiceOutstandingMinor(inv)) {
    throw new Error(`Allocation exceeds the outstanding balance of invoice ${label(inv)}`);
  }
}

/** Validate every allocation BEFORE anything is written. Throws on the first problem. */
export function validateReceiptAllocations(args: {
  contactId: string;
  currencyCode: string;
  amountMinor: number;
  allocations: AllocationInput[];
  invoices: ReadonlyMap<string, AllocatableInvoice>;
}): { allocatedMinor: number; unallocatedMinor: number } {
  if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor <= 0) {
    throw new Error("Receipt amount must be positive");
  }
  const sum = assertAmounts(args.allocations);
  if (sum > args.amountMinor) throw new Error("Allocations exceed receipt amount");
  for (const a of args.allocations) {
    assertInvoiceAllocatable(args.invoices.get(a.invoiceId), a, {
      contactId: args.contactId,
      currencyCode: args.currencyCode,
      noun: "payment",
    });
  }
  return { allocatedMinor: sum, unallocatedMinor: args.amountMinor - sum };
}

export function validateCreditAllocations(args: {
  credit: {
    contactId: string;
    currencyCode: string;
    status: string;
    totalMinor: number;
    amountAllocatedMinor: number;
  };
  allocations: AllocationInput[];
  invoices: ReadonlyMap<string, AllocatableInvoice>;
}): { allocatedMinor: number; remainingAfterMinor: number } {
  const { credit } = args;
  if (!["authorised", "partly_paid"].includes(credit.status)) {
    throw new Error(
      "Credit note must be authorised (and not fully applied or void) before allocation",
    );
  }
  if (!args.allocations.length) throw new Error("At least one allocation is required");
  const sum = assertAmounts(args.allocations);
  const remaining = credit.totalMinor - credit.amountAllocatedMinor;
  if (sum > remaining) throw new Error("Allocations exceed the remaining credit");
  for (const a of args.allocations) {
    assertInvoiceAllocatable(args.invoices.get(a.invoiceId), a, {
      contactId: credit.contactId,
      currencyCode: credit.currencyCode,
      noun: "credit",
    });
  }
  return { allocatedMinor: sum, remainingAfterMinor: remaining - sum };
}

/** Invoice status after paid/credited amounts change (matches public.sales_derive_invoice_status). */
export function deriveSalesInvoiceStatus(inv: {
  totalMinor: number;
  amountPaidMinor: number;
  amountCreditedMinor: number;
}): "authorised" | "partly_paid" | "paid" {
  const outstanding = inv.totalMinor - inv.amountPaidMinor - inv.amountCreditedMinor;
  if (outstanding <= 0) return "paid";
  if (inv.amountPaidMinor + inv.amountCreditedMinor > 0) return "partly_paid";
  return "authorised";
}

export function deriveCreditNoteStatus(c: {
  totalMinor: number;
  amountAllocatedMinor: number;
}): "authorised" | "partly_paid" | "paid" {
  if (c.amountAllocatedMinor <= 0) return "authorised";
  if (c.amountAllocatedMinor >= c.totalMinor) return "paid";
  return "partly_paid";
}

/** Label for credit-note statuses: Xero-style wording instead of "paid / partly paid". */
export function creditNoteStatusLabel(status: string): string {
  switch (status) {
    case "paid":
      return "Fully applied";
    case "partly_paid":
      return "Partly applied";
    case "authorised":
      return "Awaiting allocation";
    default:
      return status.replace(/_/g, " ");
  }
}

/** True when an invoice can be voided (authorised, nothing applied). */
export function canVoidInvoice(inv: {
  status: string;
  amountPaidMinor: number;
  amountCreditedMinor: number;
}): boolean {
  return inv.status === "authorised" && inv.amountPaidMinor === 0 && inv.amountCreditedMinor === 0;
}

export function canVoidCreditNote(c: { status: string; amountAllocatedMinor: number }): boolean {
  return c.status === "authorised" && c.amountAllocatedMinor === 0;
}
