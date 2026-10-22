import { describe, expect, it } from "vitest";
import { generatedDraftHeader } from "./recurring-template";

describe("generatedDraftHeader", () => {
  it("keeps the generated bill a draft and copies the template header", () => {
    const header = generatedDraftHeader({
      contactId: "sup-1",
      currencyCode: "GBP",
      nextDueDate: "2026-11-01",
      document: {
        billDate: "2026-10-22",
        dueDate: "2026-11-21",
        memo: "Monthly utilities",
        supplierInvoiceNumber: "UTIL-1",
        taxCalculation: "exclusive",
        notes: ["Check the meter"],
      },
    });
    expect(header.status).toBe("draft");
    expect(header.memo).toBe("Monthly utilities");
    expect(header.bill_date).toBe("2026-10-22");
    expect(header.due_date).toBe("2026-11-21");
    expect(header.supplier_invoice_number).toBe("UTIL-1");
    expect("posted_journal_id" in header).toBe(false);
  });

  it("falls back to the schedule date when the template has no document header", () => {
    const header = generatedDraftHeader({
      contactId: "sup-1",
      currencyCode: "GBP",
      nextDueDate: "2026-11-01",
    });
    expect(header.status).toBe("draft");
    expect(header.bill_date).toBe("2026-11-01");
    expect(header.memo).toBe("Generated from recurring bill");
  });
});
