/** Where a journal's source document lives in the app (RP-11). */
export type SourceTarget =
  | { kind: "sales_invoice"; id: string }
  | { kind: "sales_credit_note"; id: string }
  | { kind: "purchase_bill"; id: string }
  | { kind: "purchase_credit_note"; id: string }
  | { kind: "expense"; id: string }
  | { kind: "supplier_payment"; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sourceTarget(
  sourceType: string | null | undefined,
  sourceId: string | null | undefined,
): SourceTarget | null {
  if (!sourceType || !sourceId || !UUID.test(sourceId)) return null;
  switch (sourceType) {
    case "sales_invoice":
    case "sales_credit_note":
    case "purchase_bill":
    case "purchase_credit_note":
    case "expense":
    case "supplier_payment":
      return { kind: sourceType, id: sourceId };
    default:
      return null;
  }
}

export const SOURCE_LABELS: Record<string, string> = {
  manual: "Manual journal",
  opening_balance: "Opening balance",
  sales_invoice: "Sales invoice",
  sales_credit_note: "Sales credit note",
  customer_payment: "Customer receipt",
  purchase_bill: "Supplier bill",
  purchase_credit_note: "Supplier credit note",
  supplier_payment: "Supplier payment",
  expense: "Expense",
  bank_transaction: "Bank transaction",
  bank_transfer: "Bank transfer",
  tax_adjustment: "Tax adjustment",
  reversal: "Reversal",
  fx_revaluation: "FX revaluation",
  fx_realised: "Realised FX",
  other: "Other",
};

export function sourceLabel(sourceType: string | null | undefined): string {
  return (sourceType && SOURCE_LABELS[sourceType]) || sourceType || "—";
}
