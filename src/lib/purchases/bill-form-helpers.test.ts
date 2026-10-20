import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_ACCEPT_EXTENSIONS,
  CANCEL_UNSAVED_MESSAGE,
  calculateDueDate,
  computeBillLine,
  computeBillTotals,
  endOfMonthIso,
  hasUnsavedBillChanges,
  MAX_ATTACHMENT_BYTES,
  validateAttachmentFile,
  type BillFormSnapshot,
} from "./bill-form-helpers";

const baseSnap = (): BillFormSnapshot => ({
  contactId: "",
  billDate: "2026-10-20",
  dueDate: "2026-11-19",
  dueDateManualOverride: false,
  paymentTermId: "",
  supplierInvoiceNumber: "",
  memo: "",
  currencyCode: "GBP",
  taxCalculation: "exclusive",
  addressLine1: "",
  addressLine2: "",
  addressCity: "",
  addressRegion: "",
  addressPostal: "",
  addressCountry: "",
  lines: [
    {
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
    },
  ],
  attachmentIds: [],
  internalNoteDraft: "",
});

describe("due date calculation", () => {
  it("adds days after bill date", () => {
    expect(
      calculateDueDate("2026-01-15", { days: 30, calculation_method: "days_after_bill_date" }),
    ).toBe("2026-02-14");
  });

  it("due on receipt equals bill date", () => {
    expect(
      calculateDueDate("2026-03-01", { days: 0, calculation_method: "due_on_receipt" }),
    ).toBe("2026-03-01");
  });

  it("days after month end", () => {
    expect(endOfMonthIso("2026-02-10")).toBe("2026-02-28");
    expect(
      calculateDueDate("2026-02-10", { days: 10, calculation_method: "days_after_month_end" }),
    ).toBe("2026-03-10");
  });
});

describe("tax calculation modes", () => {
  it("exclusive adds tax on net", () => {
    const line = computeBillLine(
      { quantity: 1, unitPriceMinor: 10000, taxRateBps: 2000 },
      "exclusive",
    );
    expect(line.net_minor).toBe(10000n);
    expect(line.tax_minor).toBe(2000n);
    expect(line.gross_minor).toBe(12000n);
  });

  it("inclusive extracts tax from gross", () => {
    const line = computeBillLine(
      { quantity: 1, unitPriceMinor: 12000, taxRateBps: 2000 },
      "inclusive",
    );
    expect(line.gross_minor).toBe(12000n);
    expect(line.net_minor).toBe(10000n);
    expect(line.tax_minor).toBe(2000n);
  });

  it("none zeros tax even when rate provided", () => {
    const line = computeBillLine(
      { quantity: 2, unitPriceMinor: 5000, taxRateBps: 2000 },
      "none",
    );
    expect(line.net_minor).toBe(10000n);
    expect(line.tax_minor).toBe(0n);
    expect(line.gross_minor).toBe(10000n);
  });

  it("totals across modes with discount", () => {
    const totals = computeBillTotals(
      [{ quantity: 1, unitPriceMinor: 10000, discountMinor: 1000, taxRateBps: 1000 }],
      "exclusive",
    );
    expect(totals.subtotal_minor).toBe(9000n);
    expect(totals.tax_minor).toBe(900n);
    expect(totals.total_minor).toBe(9900n);
  });
});

describe("attachments", () => {
  it("enforces 20 MB and allowed extensions", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(20 * 1024 * 1024);
    expect(ATTACHMENT_ACCEPT_EXTENSIONS).toContain("pdf");
    expect(ATTACHMENT_ACCEPT_EXTENSIONS).toContain("xlsx");
    expect(validateAttachmentFile({ fileName: "a.pdf", sizeBytes: 100 }).ok).toBe(true);
    expect(validateAttachmentFile({ fileName: "a.exe", sizeBytes: 100 }).ok).toBe(false);
    expect(
      validateAttachmentFile({ fileName: "a.pdf", sizeBytes: MAX_ATTACHMENT_BYTES + 1 }).ok,
    ).toBe(false);
  });

  it("rejects mismatched content type", () => {
    const r = validateAttachmentFile({
      fileName: "photo.png",
      sizeBytes: 10,
      contentType: "application/pdf",
    });
    expect(r.ok).toBe(false);
  });
});

describe("unsaved changes / cancel dialog", () => {
  it("exact cancel message", () => {
    expect(CANCEL_UNSAVED_MESSAGE).toBe(
      "You have unsaved changes. Would you like to save this bill before leaving?",
    );
  });

  it("no dirty when baseline equals current", () => {
    const a = baseSnap();
    expect(hasUnsavedBillChanges(a, a)).toBe(false);
  });

  it("dirty when line description changes", () => {
    const baseline = baseSnap();
    const current = baseSnap();
    current.lines[0]!.description = "Office supplies";
    expect(hasUnsavedBillChanges(current, baseline)).toBe(true);
  });

  it("null baseline is not dirty (form just opened)", () => {
    expect(hasUnsavedBillChanges(baseSnap(), null)).toBe(false);
  });
});
