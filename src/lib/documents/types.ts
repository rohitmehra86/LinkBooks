/**
 * Shared types for printable documents (invoices, bills, statements, ...).
 * Money is always integer minor units in the document's own currency.
 */

export const DOCUMENT_KINDS = [
  "sales_invoice",
  "sales_credit_note",
  "sales_quote",
  "sales_receipt",
  "purchase_bill",
  "purchase_order",
  "purchase_credit_note",
  "supplier_remittance",
] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export function isDocumentKind(v: unknown): v is DocumentKind {
  return typeof v === "string" && (DOCUMENT_KINDS as readonly string[]).includes(v);
}

export const DOCUMENT_KIND_LABEL: Record<DocumentKind, string> = {
  sales_invoice: "Invoice",
  sales_credit_note: "Credit note",
  sales_quote: "Quote",
  sales_receipt: "Payment receipt",
  purchase_bill: "Bill",
  purchase_order: "Purchase order",
  purchase_credit_note: "Supplier credit note",
  supplier_remittance: "Remittance advice",
};

/** Where each document kind lives in the app (used for "open document" links). */
export function documentAppPath(kind: DocumentKind, id: string): string {
  switch (kind) {
    case "sales_invoice":
      return `/sales/invoices/${id}`;
    case "sales_credit_note":
      return `/sales/credit-notes/${id}`;
    case "sales_quote":
      return `/sales/quotes/${id}`;
    case "sales_receipt":
      return `/sales/receipts/${id}`;
    case "purchase_bill":
      return `/purchases/bills/${id}`;
    case "purchase_order":
      return `/purchases/orders`;
    case "purchase_credit_note":
      return `/purchases/credit-notes/${id}`;
    case "supplier_remittance":
      return `/purchases/payments/${id}`;
  }
}

export type DocumentBranding = {
  /** Trading name if set, otherwise the company name. */
  displayName: string;
  legalName: string | null;
  addressLines: string[];
  taxNumber: string | null;
  email: string | null;
  phone: string | null;
  /** Resolved, directly loadable image URL (signed URL or external https URL) or null. */
  logoUrl: string | null;
  /** #RRGGBB */
  accentColor: string;
  footerText: string | null;
  bankDetails: string | null;
  paymentInstructions: string | null;
  defaultNotes: string | null;
  letterheadLine: string | null;
};

export type PrintLine = {
  description: string;
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  taxRateBps: number;
  netMinor: number;
  taxMinor: number;
  grossMinor: number;
};

export type PrintTaxRow = { rateBps: number; netMinor: number; taxMinor: number };

export type PrintMark = "PAID" | "VOID" | "DRAFT";

export type PrintParty = {
  /** Label printed above the party block, e.g. "Bill to", "Supplier". */
  roleLabel: string;
  name: string;
  addressLines: string[];
  email: string | null;
  phone: string | null;
  taxNumber: string | null;
};

export type PrintTotals = {
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  creditedMinor: number;
  /** null when "amount due" does not apply (quotes, drafts, receipts). */
  dueMinor: number | null;
};

export type PrintAllocation = {
  label: string;
  date: string | null;
  amountMinor: number;
};

/** Extra label/value row. Either free text or an amount (formatted in the document currency). */
export type PrintMeta = { label: string; value?: string; amountMinor?: number };

export type PrintDocument = {
  kind: DocumentKind;
  id: string;
  /** Heading, e.g. "Tax invoice". */
  title: string;
  number: string | null;
  status: string;
  mark: PrintMark | null;
  currency: string;
  fxRateToBase: number | null;
  baseCurrency: string;
  issueDate: string;
  dueDate: string | null;
  expiryDate: string | null;
  reference: string | null;
  party: PrintParty;
  lines: PrintLine[];
  /** false for documents with no line detail (receipts, remittances). */
  showLines: boolean;
  taxSummary: PrintTaxRow[];
  totals: PrintTotals;
  /** Invoices / bills settled by a receipt or remittance. */
  allocations: PrintAllocation[];
  allocationsTitle: string | null;
  /** Receipt / remittance headline amount. */
  paymentAmountMinor: number | null;
  extraMeta: PrintMeta[];
  notes: string | null;
  /** Show company bank / payment details on this document (customer-facing sales docs). */
  showPaymentDetails: boolean;
  paymentTermsText: string | null;
  /** Used for e-mail / link recipient defaults. */
  partyEmail: string | null;
  partyId: string | null;
};
