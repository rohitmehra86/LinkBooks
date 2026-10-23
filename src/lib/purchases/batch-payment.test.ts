import { describe, expect, it } from "vitest";
import { buildBatchPayments } from "./batch-payment";

const bill = (id: string, contact: string, ccy: string, total: number, paid = 0, credited = 0) => ({
  id,
  contact_id: contact,
  currency_code: ccy,
  total_minor: total,
  amount_paid_minor: paid,
  amount_credited_minor: credited,
});

describe("buildBatchPayments", () => {
  it("groups by supplier and currency and pays each bill in full", () => {
    const groups = buildBatchPayments([
      bill("b1", "s1", "GBP", 1000),
      bill("b2", "s1", "GBP", 500, 200),
      bill("b3", "s1", "eur", 700),
      bill("b4", "s2", "GBP", 900, 0, 100),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({ contactId: "s1", currencyCode: "GBP", totalMinor: 1300 });
    expect(groups[0]!.allocations).toEqual([
      { billId: "b1", amountMinor: 1000 },
      { billId: "b2", amountMinor: 300 },
    ]);
    expect(groups[1]).toMatchObject({ currencyCode: "EUR", totalMinor: 700 });
    expect(groups[2]).toMatchObject({ contactId: "s2", totalMinor: 800 });
  });

  it("skips settled bills", () => {
    expect(buildBatchPayments([bill("b1", "s1", "GBP", 1000, 1000)])).toEqual([]);
  });
});
