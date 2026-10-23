import { describe, expect, it } from "vitest";
import {
  canVoidCreditNote,
  canVoidInvoice,
  creditNoteStatusLabel,
  deriveCreditNoteStatus,
  deriveSalesInvoiceStatus,
  invoiceOutstandingMinor,
  validateCreditAllocations,
  validateReceiptAllocations,
  type AllocatableInvoice,
} from "./allocation-rules";

const inv = (over: Partial<AllocatableInvoice> = {}): AllocatableInvoice => ({
  id: "inv-1",
  number: "INV-0001",
  contactId: "c1",
  currencyCode: "GBP",
  status: "authorised",
  totalMinor: 10000,
  amountPaidMinor: 0,
  amountCreditedMinor: 0,
  ...over,
});
const map = (...invs: AllocatableInvoice[]) => new Map(invs.map((i) => [i.id, i]));

describe("validateReceiptAllocations", () => {
  const base = { contactId: "c1", currencyCode: "GBP", amountMinor: 10000 };

  it("accepts a valid allocation and reports the unallocated remainder", () => {
    const r = validateReceiptAllocations({
      ...base,
      amountMinor: 12000,
      allocations: [{ invoiceId: "inv-1", amountMinor: 10000 }],
      invoices: map(inv()),
    });
    expect(r).toEqual({ allocatedMinor: 10000, unallocatedMinor: 2000 });
  });

  it("accepts a fully unallocated receipt", () => {
    expect(
      validateReceiptAllocations({ ...base, allocations: [], invoices: map() }).unallocatedMinor,
    ).toBe(10000);
  });

  it("rejects allocation above the invoice outstanding (net of payments and credits)", () => {
    expect(() =>
      validateReceiptAllocations({
        ...base,
        allocations: [{ invoiceId: "inv-1", amountMinor: 6001 }],
        invoices: map(inv({ amountPaidMinor: 2000, amountCreditedMinor: 2000 })),
      }),
    ).toThrow(/outstanding/);
  });

  it("rejects allocations above the receipt amount", () => {
    expect(() =>
      validateReceiptAllocations({
        ...base,
        amountMinor: 5000,
        allocations: [{ invoiceId: "inv-1", amountMinor: 5001 }],
        invoices: map(inv()),
      }),
    ).toThrow(/exceed receipt/);
  });

  it("rejects other customers, other currencies, and non-open statuses", () => {
    const a = [{ invoiceId: "inv-1", amountMinor: 100 }];
    expect(() =>
      validateReceiptAllocations({ ...base, allocations: a, invoices: map(inv({ contactId: "c2" })) }),
    ).toThrow(/different customer/);
    expect(() =>
      validateReceiptAllocations({ ...base, allocations: a, invoices: map(inv({ currencyCode: "EUR" })) }),
    ).toThrow(/EUR/);
    for (const status of ["draft", "void", "paid"]) {
      expect(() =>
        validateReceiptAllocations({ ...base, allocations: a, invoices: map(inv({ status })) }),
      ).toThrow(new RegExp(status));
    }
  });

  it("rejects duplicate invoices, non-positive and unsafe amounts, and unknown invoices", () => {
    expect(() =>
      validateReceiptAllocations({
        ...base,
        allocations: [
          { invoiceId: "inv-1", amountMinor: 100 },
          { invoiceId: "inv-1", amountMinor: 100 },
        ],
        invoices: map(inv()),
      }),
    ).toThrow(/only appear once/);
    expect(() =>
      validateReceiptAllocations({
        ...base,
        allocations: [{ invoiceId: "inv-1", amountMinor: 0 }],
        invoices: map(inv()),
      }),
    ).toThrow(/positive/);
    expect(() =>
      validateReceiptAllocations({
        ...base,
        allocations: [{ invoiceId: "inv-1", amountMinor: 1.5 }],
        invoices: map(inv()),
      }),
    ).toThrow(/positive/);
    expect(() =>
      validateReceiptAllocations({
        ...base,
        allocations: [{ invoiceId: "nope", amountMinor: 100 }],
        invoices: map(inv()),
      }),
    ).toThrow(/not found/);
  });
});

describe("validateCreditAllocations", () => {
  const credit = {
    contactId: "c1",
    currencyCode: "GBP",
    status: "authorised",
    totalMinor: 5000,
    amountAllocatedMinor: 1000,
  };

  it("allows up to the remaining credit", () => {
    const r = validateCreditAllocations({
      credit,
      allocations: [{ invoiceId: "inv-1", amountMinor: 4000 }],
      invoices: map(inv()),
    });
    expect(r.remainingAfterMinor).toBe(0);
  });

  it("rejects over-allocation of credit and credit that is not open", () => {
    expect(() =>
      validateCreditAllocations({
        credit,
        allocations: [{ invoiceId: "inv-1", amountMinor: 4001 }],
        invoices: map(inv()),
      }),
    ).toThrow(/remaining credit/);
    for (const status of ["draft", "paid", "void"]) {
      expect(() =>
        validateCreditAllocations({
          credit: { ...credit, status },
          allocations: [{ invoiceId: "inv-1", amountMinor: 1 }],
          invoices: map(inv()),
        }),
      ).toThrow(/authorised/);
    }
  });

  it("AR-03: refuses void, draft and paid invoices", () => {
    for (const status of ["void", "draft", "paid"]) {
      expect(() =>
        validateCreditAllocations({
          credit,
          allocations: [{ invoiceId: "inv-1", amountMinor: 100 }],
          invoices: map(inv({ status })),
        }),
      ).toThrow(/cannot receive a credit/);
    }
  });

  it("requires at least one allocation", () => {
    expect(() =>
      validateCreditAllocations({ credit, allocations: [], invoices: map() }),
    ).toThrow(/At least one/);
  });
});

describe("status derivation", () => {
  it("derives invoice status from paid + credited", () => {
    expect(deriveSalesInvoiceStatus({ totalMinor: 100, amountPaidMinor: 0, amountCreditedMinor: 0 })).toBe(
      "authorised",
    );
    expect(deriveSalesInvoiceStatus({ totalMinor: 100, amountPaidMinor: 40, amountCreditedMinor: 0 })).toBe(
      "partly_paid",
    );
    expect(deriveSalesInvoiceStatus({ totalMinor: 100, amountPaidMinor: 40, amountCreditedMinor: 60 })).toBe(
      "paid",
    );
  });
  it("derives credit note status and labels", () => {
    expect(deriveCreditNoteStatus({ totalMinor: 100, amountAllocatedMinor: 0 })).toBe("authorised");
    expect(deriveCreditNoteStatus({ totalMinor: 100, amountAllocatedMinor: 30 })).toBe("partly_paid");
    expect(deriveCreditNoteStatus({ totalMinor: 100, amountAllocatedMinor: 100 })).toBe("paid");
    expect(creditNoteStatusLabel("paid")).toBe("Fully applied");
    expect(creditNoteStatusLabel("partly_paid")).toBe("Partly applied");
  });
  it("outstanding helper", () => {
    expect(invoiceOutstandingMinor(inv({ amountPaidMinor: 1, amountCreditedMinor: 2 }))).toBe(9997);
  });
});

describe("void eligibility", () => {
  it("invoice: only authorised with nothing applied", () => {
    expect(canVoidInvoice({ status: "authorised", amountPaidMinor: 0, amountCreditedMinor: 0 })).toBe(true);
    expect(canVoidInvoice({ status: "partly_paid", amountPaidMinor: 1, amountCreditedMinor: 0 })).toBe(false);
    expect(canVoidInvoice({ status: "paid", amountPaidMinor: 10, amountCreditedMinor: 0 })).toBe(false);
    expect(canVoidInvoice({ status: "draft", amountPaidMinor: 0, amountCreditedMinor: 0 })).toBe(false);
    expect(canVoidInvoice({ status: "void", amountPaidMinor: 0, amountCreditedMinor: 0 })).toBe(false);
  });
  it("credit note: only authorised with nothing applied", () => {
    expect(canVoidCreditNote({ status: "authorised", amountAllocatedMinor: 0 })).toBe(true);
    expect(canVoidCreditNote({ status: "partly_paid", amountAllocatedMinor: 5 })).toBe(false);
  });
});
