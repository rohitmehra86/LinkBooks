/**
 * Pure mappers from database rows (as returned by Supabase) to the neutral PrintDocument
 * model used by the on-screen sheet, the print stylesheet and the e-mail templates.
 * No I/O: the server function loads rows, these functions shape them.
 */
import {
  addressLines,
  buildTaxSummary,
  documentMark,
  paymentTermsText,
  safeAccentColor,
  textToLines,
} from "@/lib/documents/helpers";
import type {
  DocumentBranding,
  DocumentKind,
  PrintAllocation,
  PrintDocument,
  PrintLine,
  PrintParty,
} from "@/lib/documents/types";

type Row = Record<string, unknown>;

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

export type MapContext = {
  baseCurrency: string;
  /** Company has a tax registration number: sales invoices are then titled "Tax invoice". */
  companyTaxNumber: string | null;
};

// ---- branding ----

export function mapBranding(
  company: Row | null,
  branding: Row | null,
  logoUrl: string | null,
): DocumentBranding {
  const name = str(company?.["name"]) ?? "Your company";
  return {
    displayName: str(branding?.["trading_name"]) ?? name,
    legalName:
      str(company?.["legal_name"]) && str(company?.["legal_name"]) !== name
        ? str(company?.["legal_name"])
        : null,
    addressLines: textToLines(str(branding?.["address_text"])),
    taxNumber: str(branding?.["tax_number"]),
    email: str(branding?.["invoice_email"]),
    phone: str(branding?.["invoice_phone"]),
    logoUrl,
    accentColor: safeAccentColor(str(company?.["document_theme_color"])),
    footerText: str(company?.["invoice_footer"]),
    bankDetails: str(branding?.["bank_details"]),
    paymentInstructions: str(branding?.["payment_instructions"]),
    defaultNotes: str(branding?.["default_notes"]),
    letterheadLine: str(branding?.["letterhead_line"]),
  };
}

// ---- parties ----

/** Billing address from a contact row (extended columns may be missing on older databases). */
export function contactParty(roleLabel: string, contact: Row | null): PrintParty {
  return {
    roleLabel,
    name: str(contact?.["name"]) ?? "—",
    addressLines: addressLines({
      line1: str(contact?.["billing_address_line1"]),
      line2: str(contact?.["billing_address_line2"]),
      city: str(contact?.["billing_city"]),
      region: str(contact?.["billing_region"]),
      postal: str(contact?.["billing_postal"]),
      country: str(contact?.["billing_country"]),
    }),
    email: str(contact?.["email"]),
    phone: str(contact?.["phone"]),
    taxNumber: str(contact?.["tax_number"]),
  };
}

// ---- lines ----

function salesLine(l: Row): PrintLine {
  const net = num(l["net_minor"]);
  const tax = num(l["tax_minor"]);
  return {
    description: str(l["description"]) ?? "",
    quantity: num(l["quantity"]),
    unitPriceMinor: num(l["unit_price_minor"]),
    discountMinor: num(l["discount_minor"]),
    taxRateBps: num(l["tax_rate_bps"]),
    netMinor: net,
    taxMinor: tax,
    grossMinor: l["gross_minor"] !== undefined ? num(l["gross_minor"]) : net + tax,
  };
}

function sortedLines(lines: Row[], orderKey: "line_order" | "line_no"): Row[] {
  return [...lines].sort((a, b) => num(a[orderKey]) - num(b[orderKey]));
}

/** Credit-note lines carry no quantity / rate: show qty 1 and derive the rate from tax / net. */
function netTaxOnlyLine(l: Row): PrintLine {
  const net = num(l["net_minor"]);
  const tax = num(l["tax_minor"]);
  return {
    description: str(l["description"]) ?? "",
    quantity: 1,
    unitPriceMinor: net,
    discountMinor: 0,
    taxRateBps: net > 0 ? Math.round((tax / net) * 10000) : 0,
    netMinor: net,
    taxMinor: tax,
    grossMinor: net + tax,
  };
}

function base(
  kind: DocumentKind,
  row: Row,
  ctx: MapContext,
): Pick<PrintDocument, "kind" | "id" | "currency" | "fxRateToBase" | "baseCurrency" | "status"> {
  const currency = (str(row["currency_code"]) ?? ctx.baseCurrency).toUpperCase();
  const fx =
    row["fx_rate_to_base"] !== undefined && row["fx_rate_to_base"] !== null
      ? num(row["fx_rate_to_base"])
      : null;
  return {
    kind,
    id: String(row["id"]),
    currency,
    fxRateToBase: currency !== ctx.baseCurrency.toUpperCase() && fx && fx > 0 ? fx : null,
    baseCurrency: ctx.baseCurrency.toUpperCase(),
    status: str(row["status"]) ?? "draft",
  };
}

function settledTotals(row: Row, status: string) {
  const total = num(row["total_minor"]);
  const paid = num(row["amount_paid_minor"]);
  const credited = num(row["amount_credited_minor"]);
  const open = status === "draft" || status === "void" || status === "awaiting_approval";
  return {
    subtotalMinor: num(row["subtotal_minor"]),
    taxMinor: num(row["tax_minor"]),
    totalMinor: total,
    paidMinor: paid,
    creditedMinor: credited,
    dueMinor: open ? null : Math.max(0, total - paid - credited),
  };
}

const EMPTY_TOTALS = {
  subtotalMinor: 0,
  taxMinor: 0,
  totalMinor: 0,
  paidMinor: 0,
  creditedMinor: 0,
  dueMinor: null,
};

function finish(
  partial: Omit<PrintDocument, "taxSummary" | "mark"> & { markOutstanding?: number | null },
): PrintDocument {
  const { markOutstanding, ...doc } = partial;
  return {
    ...doc,
    taxSummary: doc.showLines ? buildTaxSummary(doc.lines) : [],
    mark: documentMark({
      kind: doc.kind,
      status: doc.status,
      outstandingMinor: markOutstanding ?? doc.totals.dueMinor,
      totalMinor: doc.totals.totalMinor,
    }),
  };
}

// ---- sales ----

export function mapSalesInvoice(
  row: Row,
  lines: Row[],
  contact: Row | null,
  ctx: MapContext,
): PrintDocument {
  const b = base("sales_invoice", row, ctx);
  const totals = settledTotals(row, b.status);
  const issue = String(row["invoice_date"]);
  const due = str(row["due_date"]);
  return finish({
    ...b,
    title: ctx.companyTaxNumber ? "Tax invoice" : "Invoice",
    number: str(row["invoice_number"]),
    issueDate: issue,
    dueDate: due,
    expiryDate: null,
    reference: null,
    party: contactParty("Bill to", contact),
    lines: sortedLines(lines, "line_order").map(salesLine),
    showLines: true,
    totals,
    allocations: [],
    allocationsTitle: null,
    paymentAmountMinor: null,
    extraMeta: [],
    notes: str(row["memo"]),
    showPaymentDetails: true,
    paymentTermsText: paymentTermsText(issue, due),
    partyEmail: str(contact?.["email"]),
    partyId: str(row["contact_id"]),
  });
}

export function mapSalesCreditNote(
  row: Row,
  lines: Row[],
  contact: Row | null,
  ctx: MapContext,
): PrintDocument {
  const b = base("sales_credit_note", row, ctx);
  const total = num(row["total_minor"]);
  const applied = num(row["amount_allocated_minor"]);
  const posted = b.status !== "draft" && b.status !== "void";
  return finish({
    ...b,
    title: "Credit note",
    number: str(row["credit_number"]),
    issueDate: String(row["credit_date"]),
    dueDate: null,
    expiryDate: null,
    reference: null,
    party: contactParty("Credit to", contact),
    lines: sortedLines(lines, "line_order").map(salesLine),
    showLines: true,
    totals: {
      subtotalMinor: num(row["subtotal_minor"]),
      taxMinor: num(row["tax_minor"]),
      totalMinor: total,
      paidMinor: 0,
      creditedMinor: applied,
      dueMinor: null,
    },
    allocations: [],
    allocationsTitle: null,
    paymentAmountMinor: null,
    extraMeta: posted
      ? [{ label: "Credit remaining", amountMinor: Math.max(0, total - applied) }]
      : [],
    notes: str(row["memo"]),
    showPaymentDetails: false,
    paymentTermsText: null,
    partyEmail: str(contact?.["email"]),
    partyId: str(row["contact_id"]),
  });
}

export function mapSalesQuote(
  row: Row,
  lines: Row[],
  contact: Row | null,
  ctx: MapContext,
): PrintDocument {
  const b = base("sales_quote", row, ctx);
  return finish({
    ...b,
    title: "Quote",
    number: str(row["quote_number"]),
    issueDate: String(row["quote_date"]),
    dueDate: null,
    expiryDate: str(row["expiry_date"]),
    reference: null,
    party: contactParty("Prepared for", contact),
    lines: sortedLines(lines, "line_order").map(salesLine),
    showLines: true,
    totals: {
      subtotalMinor: num(row["subtotal_minor"]),
      taxMinor: num(row["tax_minor"]),
      totalMinor: num(row["total_minor"]),
      paidMinor: 0,
      creditedMinor: 0,
      dueMinor: null,
    },
    allocations: [],
    allocationsTitle: null,
    paymentAmountMinor: null,
    extraMeta: [],
    notes: str(row["memo"]),
    showPaymentDetails: false,
    paymentTermsText: null,
    partyEmail: str(contact?.["email"]),
    partyId: str(row["contact_id"]),
  });
}

export function mapSalesReceipt(
  row: Row,
  allocations: Array<{
    invoiceNumber: string | null;
    invoiceDate: string | null;
    amountMinor: number;
  }>,
  contact: Row | null,
  depositAccountName: string | null,
  ctx: MapContext,
): PrintDocument {
  const b = base("sales_receipt", row, ctx);
  const alloc: PrintAllocation[] = allocations.map((a) => ({
    label: a.invoiceNumber ? `Invoice ${a.invoiceNumber}` : "Invoice",
    date: a.invoiceDate,
    amountMinor: a.amountMinor,
  }));
  const unallocated = num(row["unallocated_minor"]);
  return finish({
    ...b,
    title: "Payment receipt",
    number: str(row["reference"]),
    issueDate: String(row["receipt_date"]),
    dueDate: null,
    expiryDate: null,
    reference: str(row["reference"]),
    party: contactParty("Received from", contact),
    lines: [],
    showLines: false,
    totals: {
      ...EMPTY_TOTALS,
      totalMinor: num(row["amount_minor"]),
      paidMinor: num(row["amount_minor"]),
    },
    allocations: alloc,
    allocationsTitle: "Payment applied to",
    paymentAmountMinor: num(row["amount_minor"]),
    extraMeta: [
      ...(depositAccountName ? [{ label: "Paid into", value: depositAccountName }] : []),
      ...(unallocated > 0 && b.status !== "void"
        ? [{ label: "Not yet applied to an invoice", amountMinor: unallocated }]
        : []),
    ],
    notes: str(row["memo"]),
    showPaymentDetails: false,
    paymentTermsText: null,
    partyEmail: str(contact?.["email"]),
    partyId: str(row["contact_id"]),
  });
}

// ---- purchases ----

export function supplierParty(
  roleLabel: string,
  contact: Row | null,
  bill?: Row | null,
): PrintParty {
  const fromBill = bill
    ? addressLines({
        line1: str(bill["supplier_address_line1"]),
        line2: str(bill["supplier_address_line2"]),
        city: str(bill["supplier_address_city"]),
        region: str(bill["supplier_address_region"]),
        postal: str(bill["supplier_address_postal"]),
        country: str(bill["supplier_address_country"]),
      })
    : [];
  const party = contactParty(roleLabel, contact);
  return { ...party, addressLines: fromBill.length ? fromBill : party.addressLines };
}

export function mapPurchaseBill(
  row: Row,
  lines: Row[],
  contact: Row | null,
  ctx: MapContext,
): PrintDocument {
  const b = base("purchase_bill", row, ctx);
  const issue = String(row["bill_date"]);
  const due = str(row["due_date"]);
  return finish({
    ...b,
    title: "Bill",
    number: str(row["bill_number"]),
    issueDate: issue,
    dueDate: due,
    expiryDate: null,
    reference: str(row["supplier_invoice_number"]),
    party: supplierParty("Supplier", contact, row),
    lines: sortedLines(lines, "line_no").map(salesLine),
    showLines: true,
    totals: settledTotals(row, b.status),
    allocations: [],
    allocationsTitle: null,
    paymentAmountMinor: null,
    extraMeta: str(row["supplier_invoice_number"])
      ? [{ label: "Supplier invoice no.", value: String(row["supplier_invoice_number"]) }]
      : [],
    notes: str(row["memo"]),
    showPaymentDetails: false,
    paymentTermsText: null,
    partyEmail: str(contact?.["email"]),
    partyId: str(row["contact_id"]),
  });
}

export function mapPurchaseOrder(
  row: Row,
  lines: Row[],
  contact: Row | null,
  ctx: MapContext,
): PrintDocument {
  const b = base("purchase_order", row, ctx);
  return finish({
    ...b,
    title: "Purchase order",
    number: str(row["order_number"]),
    issueDate: String(row["order_date"]),
    dueDate: null,
    expiryDate: null,
    reference: null,
    party: supplierParty("Supplier", contact),
    lines: sortedLines(lines, "line_no").map(salesLine),
    showLines: true,
    totals: {
      subtotalMinor: num(row["subtotal_minor"]),
      taxMinor: num(row["tax_minor"]),
      totalMinor: num(row["total_minor"]),
      paidMinor: 0,
      creditedMinor: 0,
      dueMinor: null,
    },
    allocations: [],
    allocationsTitle: null,
    paymentAmountMinor: null,
    extraMeta: [],
    notes: str(row["memo"]),
    showPaymentDetails: false,
    paymentTermsText: null,
    partyEmail: str(contact?.["email"]),
    partyId: str(row["contact_id"]),
  });
}

export function mapPurchaseCreditNote(
  row: Row,
  lines: Row[],
  contact: Row | null,
  ctx: MapContext,
): PrintDocument {
  const b = base("purchase_credit_note", row, ctx);
  return finish({
    ...b,
    title: "Supplier credit note",
    number: str(row["credit_number"]),
    issueDate: String(row["credit_date"]),
    dueDate: null,
    expiryDate: null,
    reference: null,
    party: supplierParty("Supplier", contact),
    lines: sortedLines(lines, "line_no").map(netTaxOnlyLine),
    showLines: true,
    totals: {
      subtotalMinor: num(row["subtotal_minor"]),
      taxMinor: num(row["tax_minor"]),
      totalMinor: num(row["total_minor"]),
      paidMinor: 0,
      creditedMinor: num(row["amount_allocated_minor"]),
      dueMinor: null,
    },
    allocations: [],
    allocationsTitle: null,
    paymentAmountMinor: null,
    extraMeta: [],
    notes: str(row["memo"]),
    showPaymentDetails: false,
    paymentTermsText: null,
    partyEmail: str(contact?.["email"]),
    partyId: str(row["contact_id"]),
  });
}

export function mapSupplierRemittance(
  row: Row,
  allocations: Array<{
    billNumber: string | null;
    supplierInvoiceNumber: string | null;
    billDate: string | null;
    amountMinor: number;
  }>,
  contact: Row | null,
  paidFromName: string | null,
  ctx: MapContext,
): PrintDocument {
  const b = base("supplier_remittance", row, ctx);
  return finish({
    ...b,
    title: "Remittance advice",
    number: str(row["reference"]),
    issueDate: String(row["payment_date"]),
    dueDate: null,
    expiryDate: null,
    reference: str(row["reference"]),
    party: supplierParty("Paid to", contact),
    lines: [],
    showLines: false,
    totals: {
      ...EMPTY_TOTALS,
      totalMinor: num(row["amount_minor"]),
      paidMinor: num(row["amount_minor"]),
    },
    allocations: allocations.map((a) => ({
      label: a.supplierInvoiceNumber
        ? `Your invoice ${a.supplierInvoiceNumber}`
        : a.billNumber
          ? `Bill ${a.billNumber}`
          : "Bill",
      date: a.billDate,
      amountMinor: a.amountMinor,
    })),
    allocationsTitle: "This payment covers",
    paymentAmountMinor: num(row["amount_minor"]),
    extraMeta: paidFromName ? [{ label: "Paid from", value: paidFromName }] : [],
    notes: str(row["memo"]),
    showPaymentDetails: false,
    paymentTermsText: null,
    partyEmail: str(contact?.["email"]),
    partyId: str(row["contact_id"]),
  });
}
