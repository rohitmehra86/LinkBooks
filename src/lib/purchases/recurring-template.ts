export type RecurringTemplateDocument = {
  billDate?: string | undefined;
  dueDate?: string | undefined;
  supplierInvoiceNumber?: string | null;
  memo?: string | null;
  taxCalculation?: "exclusive" | "inclusive" | "none";
  paymentTermId?: string | null;
  paymentTermsDays?: number | null;
  dueDateManualOverride?: boolean;
  fxRateToBase?: number | null;
  supplierAddress?: {
    line1?: string;
    line2?: string;
    city?: string;
    region?: string;
    postal?: string;
    country?: string;
  };
  notes?: string[];
};

/** Header for a bill generated from a template. Always a draft — activation does not post AP. */
export function generatedDraftHeader(input: {
  contactId: string;
  currencyCode: string;
  nextDueDate: string;
  document?: RecurringTemplateDocument | null;
}) {
  const doc = input.document ?? {};
  const address = doc.supplierAddress ?? {};
  return {
    contact_id: input.contactId,
    bill_date: doc.billDate || input.nextDueDate,
    due_date: doc.dueDate || input.nextDueDate,
    currency_code: input.currencyCode,
    status: "draft" as const,
    supplier_invoice_number: doc.supplierInvoiceNumber || null,
    memo: doc.memo?.trim() || "Generated from recurring bill",
    tax_calculation: doc.taxCalculation || "exclusive",
    payment_term_id: doc.paymentTermId || null,
    payment_terms_days: doc.paymentTermsDays ?? null,
    due_date_manual_override: Boolean(doc.dueDateManualOverride),
    fx_rate_to_base: doc.fxRateToBase ?? 1,
    supplier_address_line1: address.line1 || null,
    supplier_address_line2: address.line2 || null,
    supplier_address_city: address.city || null,
    supplier_address_region: address.region || null,
    supplier_address_postal: address.postal || null,
    supplier_address_country: address.country || null,
  };
}
