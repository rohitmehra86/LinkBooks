import { describe, expect, it } from "vitest";
import {
  buildAgedReceivablesAsAt,
  invoiceOutstandingAsAt,
  unappliedCreditAsAt,
  unappliedReceiptAsAt,
  type AsAtAllocation,
  type AsAtCreditNote,
  type AsAtInvoice,
  type AsAtReceipt,
} from "./ar-asat";

const invoice = (over: Partial<AsAtInvoice> = {}): AsAtInvoice => ({
  id: "i1",
  contactId: "c1",
  contactName: "Acme",
  number: "INV-1",
  currencyCode: "GBP",
  invoiceDate: "2026-03-01",
  dueDate: "2026-03-31",
  totalMinor: 10000,
  status: "paid",
  voidDate: null,
  ...over,
});
const alloc = (over: Partial<AsAtAllocation> = {}): AsAtAllocation => ({
  invoiceId: "i1",
  amountMinor: 4000,
  effectiveDate: "2026-04-10",
  reversedOn: null,
  ...over,
});

describe("invoiceOutstandingAsAt", () => {
  it("ignores allocations dated after the as-at date (paid in April still owed at 31 Mar)", () => {
    const inv = invoice();
    const allocs = [alloc({ amountMinor: 10000, effectiveDate: "2026-04-10" })];
    expect(invoiceOutstandingAsAt(inv, allocs, "2026-03-31")).toBe(10000);
    expect(invoiceOutstandingAsAt(inv, allocs, "2026-04-10")).toBe(0);
  });

  it("counts partial allocations dated on or before the date", () => {
    const allocs = [alloc({ amountMinor: 4000, effectiveDate: "2026-03-15" }), alloc({ amountMinor: 1000, effectiveDate: "2026-04-01" })];
    expect(invoiceOutstandingAsAt(invoice(), allocs, "2026-03-31")).toBe(6000);
    expect(invoiceOutstandingAsAt(invoice(), allocs, "2026-04-30")).toBe(5000);
  });

  it("treats a reversed allocation as active until the reversal date", () => {
    const allocs = [alloc({ effectiveDate: "2026-03-10", reversedOn: "2026-04-05" })];
    expect(invoiceOutstandingAsAt(invoice(), allocs, "2026-03-31")).toBe(6000);
    expect(invoiceOutstandingAsAt(invoice(), allocs, "2026-04-05")).toBe(10000);
  });

  it("excludes drafts, future invoices, and invoices voided on/before the date", () => {
    expect(invoiceOutstandingAsAt(invoice({ status: "draft" }), [], "2026-12-31")).toBe(0);
    expect(invoiceOutstandingAsAt(invoice({ invoiceDate: "2026-05-01" }), [], "2026-03-31")).toBe(0);
    expect(invoiceOutstandingAsAt(invoice({ status: "void", voidDate: "2026-04-02" }), [], "2026-04-02")).toBe(0);
    expect(invoiceOutstandingAsAt(invoice({ status: "void", voidDate: "2026-04-02" }), [], "2026-04-01")).toBe(10000);
    // legacy void without a date was reversed at the invoice date
    expect(invoiceOutstandingAsAt(invoice({ status: "void", voidDate: null }), [], "2026-03-15")).toBe(0);
  });
});

describe("unapplied receipts and credits", () => {
  const receipt = (over: Partial<AsAtReceipt> = {}): AsAtReceipt => ({
    id: "r1",
    contactId: "c1",
    contactName: "Acme",
    reference: "BACS",
    currencyCode: "GBP",
    receiptDate: "2026-03-20",
    amountMinor: 8000,
    status: "posted",
    voidDate: null,
    unallocatedMinor: 8000,
    ...over,
  });

  it("is the full amount until it is allocated", () => {
    expect(unappliedReceiptAsAt(receipt(), [], "2026-03-31")).toBe(8000);
    expect(unappliedReceiptAsAt(receipt(), [], "2026-03-19")).toBe(0);
  });

  it("drops by allocations active at the date", () => {
    const a = [alloc({ amountMinor: 3000, effectiveDate: "2026-04-02" })];
    const r = receipt({ unallocatedMinor: 5000 });
    expect(unappliedReceiptAsAt(r, a, "2026-03-31")).toBe(8000);
    expect(unappliedReceiptAsAt(r, a, "2026-04-02")).toBe(5000);
  });

  it("deducts amounts consumed by refunds", () => {
    // 8000 receipt, nothing allocated, but unallocated is only 5000 => 3000 refunded
    expect(unappliedReceiptAsAt(receipt({ unallocatedMinor: 5000 }), [], "2026-12-31")).toBe(5000);
  });

  it("a void receipt counts only until its void date", () => {
    const r = receipt({ status: "void", voidDate: "2026-04-10", unallocatedMinor: 0 });
    expect(unappliedReceiptAsAt(r, [], "2026-04-09")).toBe(8000);
    expect(unappliedReceiptAsAt(r, [], "2026-04-10")).toBe(0);
  });

  it("credit notes: draft excluded, remaining credit reported", () => {
    const c: AsAtCreditNote = {
      id: "cn1",
      contactId: "c1",
      contactName: "Acme",
      number: "SCN-1",
      currencyCode: "GBP",
      creditDate: "2026-03-05",
      totalMinor: 2000,
      status: "authorised",
      voidDate: null,
      amountAllocatedMinor: 0,
    };
    expect(unappliedCreditAsAt(c, [], "2026-03-31")).toBe(2000);
    expect(unappliedCreditAsAt({ ...c, status: "draft" }, [], "2026-03-31")).toBe(0);
    expect(unappliedCreditAsAt(c, [], "2026-03-04")).toBe(0);
  });
});

describe("buildAgedReceivablesAsAt", () => {
  it("builds buckets from dated events and shows unapplied cash as negative lines, per currency", () => {
    const report = buildAgedReceivablesAsAt({
      asOf: "2026-03-31",
      invoices: [
        invoice({ id: "i1", totalMinor: 10000, dueDate: "2026-03-15" }), // 16 days overdue
        invoice({ id: "i2", totalMinor: 5000, dueDate: "2026-04-30", invoiceDate: "2026-03-20" }), // current
        invoice({ id: "i3", totalMinor: 700, currencyCode: "EUR", dueDate: "2025-12-01" }), // 90+
      ],
      receipts: [
        {
          id: "r1",
          contactId: "c1",
          contactName: "Acme",
          reference: null,
          currencyCode: "GBP",
          receiptDate: "2026-03-25",
          amountMinor: 1500,
          status: "posted",
          voidDate: null,
          unallocatedMinor: 1500,
        },
      ],
      creditNotes: [],
      // i1 was paid 4000 in April: must NOT reduce the 31 Mar balance
      receiptAllocations: [
        { receiptId: "rX", invoiceId: "i1", amountMinor: 4000, effectiveDate: "2026-04-10", reversedOn: null },
      ],
      creditAllocations: [],
    });
    const gbp = report.totalsByCurrency.find((t) => t.currency_code === "GBP")!;
    // the unapplied receipt (dated 25 Mar) ages by its own date, i.e. into 1-30, as a negative line
    expect(gbp.byBucket["1_30"]).toBe(10000 - 1500);
    expect(gbp.byBucket.current).toBe(5000);
    expect(gbp.unapplied).toBe(-1500);
    expect(gbp.total).toBe(13500);
    const eur = report.totalsByCurrency.find((t) => t.currency_code === "EUR")!;
    expect(eur.byBucket["90_plus"]).toBe(700);
    expect(report.rows.filter((r) => r.contact_id === "c1")).toHaveLength(2);
    const row = report.rows.find((r) => r.currency_code === "GBP")!;
    expect(row.docs.some((d) => d.kind === "receipt" && d.outstanding_minor === -1500)).toBe(true);
  });
});
