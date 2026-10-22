import { describe, expect, it } from "vitest";
import {
  billHistoryActionLabel,
  describeBillEdits,
  presentBillHistory,
} from "@/lib/purchases/bill-history";

describe("bill history", () => {
  it("uses plain action labels instead of audit codes", () => {
    expect(billHistoryActionLabel("bill.draft.create")).toBe("Created");
    expect(billHistoryActionLabel("bill.authorise")).toBe("Approved");
    expect(billHistoryActionLabel("bill.attachment.uploaded")).toBe("File uploaded");
    expect(billHistoryActionLabel("supplier_payment.post")).toBe("Paid");
  });

  it("states an amount change as from and to", () => {
    expect(
      describeBillEdits(
        {
          totalMinor: 2100,
          taxMinor: 0,
          billDate: "2026-10-21",
          dueDate: "2026-11-05",
          supplierInvoiceNumber: null,
          memo: null,
          supplierName: "City Utilities Demo",
        },
        {
          totalMinor: 4000,
          taxMinor: 0,
          billDate: "2026-10-21",
          dueDate: "2026-11-05",
          supplierInvoiceNumber: null,
          memo: null,
          supplierName: "City Utilities Demo",
        },
        "USD",
        true,
      ),
    ).toEqual(["Amount changed from 21.00 to 40.00."]);
  });

  it("builds one newest-first history with the user and a payment sentence", () => {
    const rows = presentBillHistory(
      [
        {
          id: "e1",
          created_at: "2024-05-06T05:24:00.000Z",
          actor_name: "Gulshan Kumar",
          action: "bill.draft.create",
          details: { total_minor: 4190, supplier_name: "Instacart" },
        },
        {
          id: "e2",
          created_at: "2024-05-06T05:25:00.000Z",
          actor_name: "Gulshan Kumar",
          action: "bill.draft.update",
          details: { changes: ["Amount changed from 21.00 to 40.00."] },
        },
        {
          id: "e3",
          created_at: "2024-05-06T05:26:00.000Z",
          actor_name: "Gulshan Kumar",
          action: "supplier_payment.post",
          details: {
            allocation_minor: 4190,
            payment_date: "2024-04-09",
            supplier_name: "Instacart",
            fully_paid: true,
            payment_id: "pay-1",
          },
        },
      ],
      [],
      { currency: "USD", supplierName: "Instacart", totalMinor: 4190, creditedMinor: 0 },
    );

    expect(rows.map((row) => row.action)).toEqual(["Paid", "Edited", "Created"]);
    expect(rows.every((row) => row.user === "Gulshan Kumar")).toBe(true);
    expect(rows[0]?.detail).toBe(
      "Payment made to Instacart on April 9, 2024 for 41.90. This bill has been fully paid.",
    );
    expect(rows[0]?.paymentId).toBe("pay-1");
    expect(rows[1]?.detail).toBe("Amount changed from 21.00 to 40.00.");
    expect(rows[2]?.detail).toBe("Created for Instacart for 41.90.");
  });

  it("keeps a note that has no audit event", () => {
    const rows = presentBillHistory(
      [],
      [
        {
          id: "n2",
          body: "Hold until the invoice arrives.",
          created_at: "2026-10-20T00:00:00.000Z",
          created_by_name: "",
        },
      ],
      { currency: "GBP" },
    );
    expect(rows).toEqual([
      {
        id: "note:n2",
        at: "2026-10-20T00:00:00.000Z",
        user: "—",
        action: "Note",
        detail: "Hold until the invoice arrives.",
        paymentId: null,
      },
    ]);
  });
});
