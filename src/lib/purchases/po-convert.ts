/**
 * Pure helpers for turning a purchase order into a draft bill (P-15).
 */

/**
 * Purchase order lines store only unit price, net and tax - not the discount that produced
 * that net. When copying a line to a bill, carry the discount across so the bill line
 * (qty x unit - discount = net) reproduces the PO net instead of silently changing it the
 * next time the bill is saved.
 */
export function impliedDiscountMinor(line: {
  quantity: number;
  unit_price_minor: number;
  net_minor: number;
}): number {
  const gross = Math.round(Number(line.quantity) * Number(line.unit_price_minor));
  return Math.max(0, gross - Number(line.net_minor));
}

/** Calendar-safe due date: bill date + `termsDays` days (UTC, no local-time drift). */
export function dueDateFromBillDate(billDate: string, termsDays: number): string {
  const d = new Date(`${billDate}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error("Invalid bill date");
  d.setUTCDate(
    d.getUTCDate() + Math.max(0, Math.floor(Number.isFinite(termsDays) ? termsDays : 0)),
  );
  return d.toISOString().slice(0, 10);
}
