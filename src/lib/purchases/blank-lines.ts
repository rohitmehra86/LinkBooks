import type { PurchaseLineFormState } from "@/components/purchases/PurchasesDocumentLines";

/** True when a line has no meaningful user input (safe to strip on save). */
export function isCompletelyBlankPurchaseLine(line: PurchaseLineFormState): boolean {
  const empty =
    !line.productId &&
    !line.description.trim() &&
    !line.accountId &&
    !line.taxCodeId &&
    !line.classOptionId &&
    !line.locationOptionId &&
    !line.projectOptionId &&
    !line.customerContactId &&
    !line.isBillable;
  if (!empty) return false;
  const qty = Number(line.quantity);
  const price = Number(String(line.unitPrice).replace(/,/g, ""));
  const discount = Number(String(line.discount).replace(/,/g, ""));
  const tax = Number(line.taxRateBps);
  // Default empty row: qty 1, price 0, discount 0, tax 0
  const defaultsOnly =
    (Number.isNaN(qty) || qty === 1 || qty === 0) &&
    (Number.isNaN(price) || price === 0) &&
    (Number.isNaN(discount) || discount === 0) &&
    (Number.isNaN(tax) || tax === 0);
  return defaultsOnly;
}

/** Strip completely blank rows; keep at least one empty line for editing. */
export function cleanupBlankPurchaseLines(
  lines: PurchaseLineFormState[],
  opts?: { keepOneEmpty?: boolean },
): PurchaseLineFormState[] {
  const kept = lines.filter((l) => !isCompletelyBlankPurchaseLine(l));
  if (kept.length > 0) return kept;
  if (opts?.keepOneEmpty === false) return [];
  return lines.slice(0, 1);
}

/** Partially filled rows that still fail authorisation validation. */
export function incompletePurchaseLines(lines: PurchaseLineFormState[]): number[] {
  return lines
    .map((l, i) => {
      if (isCompletelyBlankPurchaseLine(l)) return -1;
      const missingDesc = !l.description.trim();
      const missingAccount = !l.accountId;
      const badQty = !(Number(l.quantity) > 0);
      return missingDesc || missingAccount || badQty ? i : -1;
    })
    .filter((i) => i >= 0);
}
