/**
 * Pure allocation rules shared by supplier payments and supplier credit notes.
 * Keeping them here (not inline in server functions) makes them unit-testable and keeps
 * payments and credits on exactly the same rules.
 */

/** Only these bills can receive a payment or a credit. */
export const ALLOCATABLE_BILL_STATUSES = ["authorised", "partly_paid"] as const;

export type AllocatableBill = {
  id: string;
  status: string;
  contact_id: string;
  currency_code: string | null;
  total_minor: number | bigint;
  amount_paid_minor: number | bigint;
  amount_credited_minor: number | bigint;
};

export type AllocationRequest = { billId: string; amountMinor: number };

export type AllocationContext = {
  /** Supplier the payment / credit belongs to. */
  contactId: string;
  /** Currency of the payment / credit. */
  currencyCode: string;
  /** "payment" or "credit" - only used in error wording. */
  kind: "payment" | "credit";
};

export function billOutstandingMinor(bill: AllocatableBill): bigint {
  return (
    BigInt(bill.total_minor) - BigInt(bill.amount_paid_minor) - BigInt(bill.amount_credited_minor)
  );
}

function label(bill: AllocatableBill): string {
  return `Bill ${bill.id.slice(0, 8)}`;
}

/**
 * Throws a readable error if `requests` cannot be applied to `bills`.
 * Rules: bill must exist, belong to the same supplier, be authorised/partly paid,
 * share the payment currency, and the summed allocations per bill must not exceed
 * what is outstanding. Allocations for the same bill are summed first.
 */
export function assertAllocationsAllowed(
  bills: AllocatableBill[],
  requests: AllocationRequest[],
  ctx: AllocationContext,
): void {
  const byId = new Map(bills.map((b) => [b.id, b]));
  const totals = new Map<string, bigint>();
  for (const req of requests) {
    if (!Number.isInteger(req.amountMinor) || req.amountMinor <= 0) {
      throw new Error("Allocation amounts must be positive whole minor units");
    }
    totals.set(req.billId, (totals.get(req.billId) ?? 0n) + BigInt(req.amountMinor));
  }
  const noun = ctx.kind === "payment" ? "payment" : "credit";
  for (const [billId, amount] of totals) {
    const bill = byId.get(billId);
    if (!bill) throw new Error("Bill not found for allocation");
    if (bill.contact_id !== ctx.contactId) {
      throw new Error(`${label(bill)} belongs to a different supplier`);
    }
    if (!(ALLOCATABLE_BILL_STATUSES as readonly string[]).includes(bill.status)) {
      throw new Error(
        `${label(bill)} is ${bill.status.replace(/_/g, " ")}; a ${noun} can only be applied to authorised or partly paid bills`,
      );
    }
    const billCurrency = (bill.currency_code ?? "").toUpperCase();
    if (billCurrency && billCurrency !== ctx.currencyCode.toUpperCase()) {
      throw new Error(
        `${label(bill)} is in ${billCurrency} but the ${noun} is in ${ctx.currencyCode.toUpperCase()}. Currencies must match.`,
      );
    }
    const outstanding = billOutstandingMinor(bill);
    if (outstanding <= 0n) throw new Error(`${label(bill)} has no outstanding balance`);
    if (amount > outstanding) {
      throw new Error(
        `Allocation to ${label(bill)} exceeds its outstanding balance - overpayment blocked`,
      );
    }
  }
}

export function sumAllocations(requests: AllocationRequest[]): number {
  return requests.reduce((s, r) => s + r.amountMinor, 0);
}
