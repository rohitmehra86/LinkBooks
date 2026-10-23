import { describe, expect, it } from "vitest";
import {
  assertAllocationsAllowed,
  billOutstandingMinor,
  type AllocatableBill,
} from "@/lib/purchases/allocation";

const bill = (over: Partial<AllocatableBill> = {}): AllocatableBill => ({
  id: "11111111-1111-1111-1111-111111111111",
  status: "authorised",
  contact_id: "c1",
  currency_code: "GBP",
  total_minor: 10000,
  amount_paid_minor: 0,
  amount_credited_minor: 0,
  ...over,
});
const ctx = { contactId: "c1", currencyCode: "GBP", kind: "payment" as const };

describe("assertAllocationsAllowed", () => {
  it("accepts a valid allocation up to outstanding", () => {
    expect(() =>
      assertAllocationsAllowed([bill()], [{ billId: bill().id, amountMinor: 10000 }], ctx),
    ).not.toThrow();
  });

  it("rejects over-allocation, summing repeated bills", () => {
    expect(() =>
      assertAllocationsAllowed(
        [bill({ amount_paid_minor: 2000 })],
        [
          { billId: bill().id, amountMinor: 5000 },
          { billId: bill().id, amountMinor: 3500 },
        ],
        ctx,
      ),
    ).toThrow(/exceeds/);
  });

  it.each(["draft", "awaiting_approval", "void", "paid"])("rejects %s bills", (status) => {
    expect(() =>
      assertAllocationsAllowed([bill({ status })], [{ billId: bill().id, amountMinor: 1 }], {
        ...ctx,
        kind: "credit",
      }),
    ).toThrow(/authorised or partly paid/);
  });

  it("accepts partly paid bills", () => {
    expect(() =>
      assertAllocationsAllowed(
        [bill({ status: "partly_paid", amount_paid_minor: 4000 })],
        [{ billId: bill().id, amountMinor: 6000 }],
        ctx,
      ),
    ).not.toThrow();
  });

  it("rejects another supplier's bill", () => {
    expect(() =>
      assertAllocationsAllowed(
        [bill({ contact_id: "c2" })],
        [{ billId: bill().id, amountMinor: 1 }],
        ctx,
      ),
    ).toThrow(/different supplier/);
  });

  it("rejects a currency mismatch", () => {
    expect(() =>
      assertAllocationsAllowed(
        [bill({ currency_code: "USD" })],
        [{ billId: bill().id, amountMinor: 1 }],
        ctx,
      ),
    ).toThrow(/Currencies must match/);
  });

  it("rejects missing bills and non-positive amounts", () => {
    expect(() => assertAllocationsAllowed([], [{ billId: "x", amountMinor: 1 }], ctx)).toThrow(
      /not found/,
    );
    expect(() =>
      assertAllocationsAllowed([bill()], [{ billId: bill().id, amountMinor: 0 }], ctx),
    ).toThrow(/positive/);
    expect(() =>
      assertAllocationsAllowed([bill()], [{ billId: bill().id, amountMinor: 1.5 }], ctx),
    ).toThrow(/whole minor units/);
  });

  it("computes outstanding with credits", () => {
    expect(billOutstandingMinor(bill({ amount_paid_minor: 100, amount_credited_minor: 50 }))).toBe(
      9850n,
    );
  });
});
