/**
 * One place that derives AP document status from balances (P-13).
 * Bills and supplier credit notes both move through authorised -> partly_paid -> paid
 * purely as a function of how much has been settled, whichever code path settled it.
 */

import { deriveBillStatus } from "@/lib/purchases/line-math";

const SETTLEABLE_BILL = ["authorised", "partly_paid", "paid"];

/**
 * Status of a posted bill after its paid/credited amounts change.
 * Unposted (draft / awaiting_approval) and void bills are never changed by settlement.
 */
export function nextBillStatus(bill: {
  status: string;
  total_minor: bigint | number;
  amount_paid_minor: bigint | number;
  amount_credited_minor: bigint | number;
}): string {
  if (!SETTLEABLE_BILL.includes(bill.status)) return bill.status;
  return deriveBillStatus(bill);
}

/** Status of an authorised supplier credit note from how much of it has been used. */
export function deriveCreditNoteStatus(credit: {
  status: string;
  total_minor: bigint | number;
  amount_allocated_minor: bigint | number;
}): string {
  if (!["authorised", "partly_paid", "paid"].includes(credit.status)) return credit.status;
  const total = BigInt(credit.total_minor);
  const used = BigInt(credit.amount_allocated_minor);
  if (used >= total) return "paid";
  if (used > 0n) return "partly_paid";
  return "authorised";
}

/** Unused credit left on an authorised supplier credit note (never negative). */
export function creditRemainingMinor(credit: {
  total_minor: bigint | number;
  amount_allocated_minor: bigint | number;
}): bigint {
  const left = BigInt(credit.total_minor) - BigInt(credit.amount_allocated_minor);
  return left > 0n ? left : 0n;
}

/** Credit-note statuses whose unused balance may be applied to a bill or refunded. */
export const USABLE_CREDIT_STATUSES = ["authorised", "partly_paid"] as const;
