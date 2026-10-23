/**
 * Full-fidelity edit state for an existing draft / awaiting-approval bill (P-01 / P-02).
 *
 * The bill page used to send only description / account / qty / price / discount / tax bps,
 * so every save silently reset tax calculation, FX rate, payment terms, supplier address,
 * the duplicate acknowledgement and each line's product / tax code / tracking.
 * These helpers hydrate every field from `getBill` and send all of it back, and give a
 * stable snapshot so Authorise only re-saves when something actually changed.
 */

import { fromMinorUnits } from "@/lib/accounting/money";
import type { TaxCalculationMode } from "@/lib/purchases/bill-form-helpers";
import { parseMinorOrThrow } from "@/lib/purchases/money-input";

export type BillEditorLine = {
  productId: string;
  description: string;
  accountId: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  taxRateBps: string;
  taxCodeId: string;
  classOptionId: string;
  locationOptionId: string;
  projectOptionId: string;
  customerContactId: string;
  isBillable: boolean;
};

export type BillEditorAddress = {
  line1: string;
  line2: string;
  city: string;
  region: string;
  postal: string;
  country: string;
};

export type BillEditorState = {
  contactId: string;
  billDate: string;
  dueDate: string;
  dueDateManualOverride: boolean;
  paymentTermId: string;
  paymentTermsDays: number | null;
  supplierInvoiceNumber: string;
  memo: string;
  currencyCode: string;
  taxCalculation: TaxCalculationMode;
  /** Rate to base currency as typed; "" when unknown. Ignored for base-currency bills. */
  fxRate: string;
  acknowledgeDuplicate: boolean;
  address: BillEditorAddress;
  lines: BillEditorLine[];
};

/** The subset of `getBill` the editor needs. */
export type BillForEditor = {
  contact_id: string;
  bill_date: string;
  due_date: string;
  due_date_manual_override?: boolean | null;
  payment_term_id?: string | null;
  payment_terms_days?: number | null;
  supplier_invoice_number: string | null;
  memo: string | null;
  currency_code: string | null;
  tax_calculation?: string | null;
  fx_rate_to_base?: number | string | null;
  duplicate_override?: boolean | null;
  supplier_address_line1?: string | null;
  supplier_address_line2?: string | null;
  supplier_address_city?: string | null;
  supplier_address_region?: string | null;
  supplier_address_postal?: string | null;
  supplier_address_country?: string | null;
  purchase_bill_lines: Array<{
    description: string;
    quantity: number;
    unit_price_minor: number;
    discount_minor: number;
    tax_rate_bps: number;
    account_id: string | null;
    product_id?: string | null;
    tax_code_id?: string | null;
    class_option_id?: string | null;
    location_option_id?: string | null;
    project_option_id?: string | null;
    class_id?: string | null;
    location_id?: string | null;
    project_id?: string | null;
    customer_contact_id?: string | null;
    is_billable?: boolean | null;
  }> | null;
};

export function emptyEditorLine(): BillEditorLine {
  return {
    productId: "",
    description: "",
    accountId: "",
    quantity: "1",
    unitPrice: "0.00",
    discount: "0",
    taxRateBps: "0",
    taxCodeId: "",
    classOptionId: "",
    locationOptionId: "",
    projectOptionId: "",
    customerContactId: "",
    isBillable: false,
  };
}

function asTaxMode(value: string | null | undefined): TaxCalculationMode {
  return value === "inclusive" || value === "none" ? value : "exclusive";
}

export function billEditorStateFromBill(
  bill: BillForEditor,
  baseCurrency: string,
): BillEditorState {
  const currency = (bill.currency_code || baseCurrency).toUpperCase();
  const fx = bill.fx_rate_to_base == null ? null : Number(bill.fx_rate_to_base);
  const lines = bill.purchase_bill_lines ?? [];
  return {
    contactId: bill.contact_id,
    billDate: bill.bill_date,
    dueDate: bill.due_date,
    dueDateManualOverride: Boolean(bill.due_date_manual_override),
    paymentTermId: bill.payment_term_id ?? "",
    paymentTermsDays: bill.payment_terms_days ?? null,
    supplierInvoiceNumber: bill.supplier_invoice_number ?? "",
    memo: bill.memo ?? "",
    currencyCode: currency,
    taxCalculation: asTaxMode(bill.tax_calculation),
    // Null in the database means "same currency as base" (rate 1).
    fxRate:
      currency === baseCurrency.toUpperCase()
        ? "1"
        : fx != null && Number.isFinite(fx) && fx > 0
          ? String(fx)
          : "",
    acknowledgeDuplicate: Boolean(bill.duplicate_override),
    address: {
      line1: bill.supplier_address_line1 ?? "",
      line2: bill.supplier_address_line2 ?? "",
      city: bill.supplier_address_city ?? "",
      region: bill.supplier_address_region ?? "",
      postal: bill.supplier_address_postal ?? "",
      country: bill.supplier_address_country ?? "",
    },
    lines: lines.length
      ? lines.map((l) => ({
          productId: l.product_id ?? "",
          description: l.description ?? "",
          accountId: l.account_id ?? "",
          quantity: String(l.quantity ?? 1),
          unitPrice: fromMinorUnits(BigInt(l.unit_price_minor ?? 0), currency),
          discount: fromMinorUnits(BigInt(l.discount_minor ?? 0), currency),
          taxRateBps: String(l.tax_rate_bps ?? 0),
          taxCodeId: l.tax_code_id ?? "",
          classOptionId: l.class_option_id ?? l.class_id ?? "",
          locationOptionId: l.location_option_id ?? l.location_id ?? "",
          projectOptionId: l.project_option_id ?? l.project_id ?? "",
          customerContactId: l.customer_contact_id ?? "",
          isBillable: Boolean(l.is_billable),
        }))
      : [emptyEditorLine()],
  };
}

export type BillSavePayload = {
  companyId: string;
  billId: string;
  contactId: string;
  billDate: string;
  dueDate: string;
  supplierInvoiceNumber: string;
  memo: string;
  currencyCode: string;
  taxCalculation: TaxCalculationMode;
  paymentTermId: string | null;
  paymentTermsDays: number | null;
  dueDateManualOverride: boolean;
  acknowledgeDuplicate: boolean;
  fxRateToBase: number;
  supplierAddress: BillEditorAddress;
  lines: Array<{
    description: string;
    accountId: string;
    quantity: number;
    unitPriceMinor: number;
    discountMinor: number;
    taxRateBps: number;
    productId: string | null;
    taxCodeId: string | null;
    classOptionId: string | null;
    locationOptionId: string | null;
    projectOptionId: string | null;
    customerContactId: string | null;
    isBillable: boolean;
  }>;
};

/** Parse the typed FX rate; throws a readable error when a foreign bill has no usable rate. */
export function resolveFxRate(state: BillEditorState, baseCurrency: string): number {
  if (state.currencyCode.toUpperCase() === baseCurrency.toUpperCase()) return 1;
  const rate = Number(state.fxRate);
  if (!state.fxRate.trim() || !Number.isFinite(rate) || !(rate > 0)) {
    throw new Error(
      `Enter an exchange rate for ${state.currencyCode} to ${baseCurrency.toUpperCase()} before saving`,
    );
  }
  return rate;
}

export function buildBillSavePayload(args: {
  companyId: string;
  billId: string;
  state: BillEditorState;
  baseCurrency: string;
}): BillSavePayload {
  const { state, companyId, billId, baseCurrency } = args;
  if (!state.contactId) throw new Error("Choose a supplier");
  const currency = state.currencyCode;
  return {
    companyId,
    billId,
    contactId: state.contactId,
    billDate: state.billDate,
    dueDate: state.dueDate,
    supplierInvoiceNumber: state.supplierInvoiceNumber,
    memo: state.memo,
    currencyCode: currency,
    taxCalculation: state.taxCalculation,
    paymentTermId: state.paymentTermId || null,
    paymentTermsDays: state.paymentTermsDays,
    dueDateManualOverride: state.dueDateManualOverride,
    acknowledgeDuplicate: state.acknowledgeDuplicate,
    fxRateToBase: resolveFxRate(state, baseCurrency),
    supplierAddress: { ...state.address },
    lines: state.lines.map((l, i) => ({
      description: l.description,
      accountId: l.accountId,
      quantity: Number(l.quantity),
      unitPriceMinor: Number(
        parseMinorOrThrow(l.unitPrice || "0", currency, `Line ${i + 1} unit price`),
      ),
      discountMinor: Number(
        parseMinorOrThrow(l.discount || "0", currency, `Line ${i + 1} discount`),
      ),
      taxRateBps: Number(l.taxRateBps || 0),
      productId: l.productId || null,
      taxCodeId: l.taxCodeId || null,
      classOptionId: l.classOptionId || null,
      locationOptionId: l.locationOptionId || null,
      projectOptionId: l.projectOptionId || null,
      customerContactId: l.customerContactId || null,
      isBillable: l.isBillable,
    })),
  };
}

/** Stable string used for dirty detection. */
export function billEditorSnapshot(state: BillEditorState): string {
  return JSON.stringify(state);
}

export function isBillEditorDirty(
  current: BillEditorState,
  baselineSnapshot: string | null,
): boolean {
  if (baselineSnapshot === null) return false;
  return billEditorSnapshot(current) !== baselineSnapshot;
}
