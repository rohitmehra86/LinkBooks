export type BatchBill = {
  id: string;
  contact_id: string;
  currency_code: string;
  total_minor: number;
  amount_paid_minor: number;
  amount_credited_minor: number;
};

export type BatchPaymentGroup = {
  contactId: string;
  currencyCode: string;
  totalMinor: number;
  allocations: Array<{ billId: string; amountMinor: number }>;
};

/**
 * Groups selected bills into one payment per supplier + currency, each bill paid in full.
 * Bills with nothing outstanding are skipped. Output order is stable (first appearance).
 */
export function buildBatchPayments(bills: BatchBill[]): BatchPaymentGroup[] {
  const groups = new Map<string, BatchPaymentGroup>();
  for (const bill of bills) {
    const outstanding = bill.total_minor - bill.amount_paid_minor - bill.amount_credited_minor;
    if (!(outstanding > 0)) continue;
    const currencyCode = bill.currency_code.toUpperCase();
    const key = `${bill.contact_id}|${currencyCode}`;
    let group = groups.get(key);
    if (!group) {
      group = { contactId: bill.contact_id, currencyCode, totalMinor: 0, allocations: [] };
      groups.set(key, group);
    }
    group.allocations.push({ billId: bill.id, amountMinor: outstanding });
    group.totalMinor += outstanding;
  }
  return [...groups.values()];
}
