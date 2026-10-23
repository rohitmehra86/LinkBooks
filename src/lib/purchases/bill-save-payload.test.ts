import { describe, expect, it } from "vitest";
import {
  billEditorSnapshot,
  billEditorStateFromBill,
  buildBillSavePayload,
  isBillEditorDirty,
  resolveFxRate,
  type BillForEditor,
} from "@/lib/purchases/bill-save-payload";

const bill: BillForEditor = {
  contact_id: "c1",
  bill_date: "2026-10-01",
  due_date: "2026-10-31",
  due_date_manual_override: true,
  payment_term_id: "t1",
  payment_terms_days: 30,
  supplier_invoice_number: "INV-9",
  memo: "Rent",
  currency_code: "EUR",
  tax_calculation: "inclusive",
  fx_rate_to_base: 0.85,
  duplicate_override: true,
  supplier_address_line1: "1 High St",
  supplier_address_city: "Leeds",
  purchase_bill_lines: [
    {
      description: "Office rent",
      quantity: 2,
      unit_price_minor: 123450,
      discount_minor: 500,
      tax_rate_bps: 2000,
      account_id: "a1",
      product_id: "p1",
      tax_code_id: "tc1",
      class_option_id: "cl1",
      project_id: "pr1",
      customer_contact_id: "cu1",
      is_billable: true,
    },
  ],
};

describe("bill editor round trip", () => {
  it("hydrates every field the old payload dropped", () => {
    const state = billEditorStateFromBill(bill, "GBP");
    expect(state.taxCalculation).toBe("inclusive");
    expect(state.fxRate).toBe("0.85");
    expect(state.paymentTermId).toBe("t1");
    expect(state.paymentTermsDays).toBe(30);
    expect(state.dueDateManualOverride).toBe(true);
    expect(state.acknowledgeDuplicate).toBe(true);
    expect(state.address.line1).toBe("1 High St");
    expect(state.address.city).toBe("Leeds");
    expect(state.lines[0]).toMatchObject({
      productId: "p1",
      taxCodeId: "tc1",
      classOptionId: "cl1",
      projectOptionId: "pr1",
      customerContactId: "cu1",
      isBillable: true,
      unitPrice: "1234.50",
      discount: "5.00",
    });
  });

  it("sends the full state back unchanged", () => {
    const state = billEditorStateFromBill(bill, "GBP");
    const payload = buildBillSavePayload({
      companyId: "co",
      billId: "b1",
      state,
      baseCurrency: "GBP",
    });
    expect(payload).toMatchObject({
      taxCalculation: "inclusive",
      fxRateToBase: 0.85,
      paymentTermId: "t1",
      paymentTermsDays: 30,
      dueDateManualOverride: true,
      acknowledgeDuplicate: true,
      supplierAddress: { line1: "1 High St", city: "Leeds" },
    });
    expect(payload.lines[0]).toMatchObject({
      unitPriceMinor: 123450,
      discountMinor: 500,
      productId: "p1",
      taxCodeId: "tc1",
      classOptionId: "cl1",
      projectOptionId: "pr1",
      customerContactId: "cu1",
      isBillable: true,
    });
  });

  it("uses rate 1 for base-currency bills and demands a rate for foreign ones", () => {
    const base = billEditorStateFromBill({ ...bill, currency_code: "GBP", fx_rate_to_base: null }, "GBP");
    expect(resolveFxRate(base, "GBP")).toBe(1);
    const foreign = billEditorStateFromBill({ ...bill, fx_rate_to_base: null }, "GBP");
    expect(() => resolveFxRate(foreign, "GBP")).toThrow(/exchange rate/i);
  });

  it("accepts thousands separators typed into amounts", () => {
    const state = billEditorStateFromBill(bill, "GBP");
    state.lines[0]!.unitPrice = "1,234.50";
    const payload = buildBillSavePayload({ companyId: "co", billId: "b1", state, baseCurrency: "GBP" });
    expect(payload.lines[0]!.unitPriceMinor).toBe(123450);
  });

  it("detects edits so Authorise only re-saves a dirty form", () => {
    const state = billEditorStateFromBill(bill, "GBP");
    const baseline = billEditorSnapshot(state);
    expect(isBillEditorDirty(state, baseline)).toBe(false);
    expect(isBillEditorDirty({ ...state, memo: "Changed" }, baseline)).toBe(true);
    const lines = [{ ...state.lines[0]!, taxCodeId: "other" }];
    expect(isBillEditorDirty({ ...state, lines }, baseline)).toBe(true);
    expect(isBillEditorDirty(state, null)).toBe(false);
  });
});
