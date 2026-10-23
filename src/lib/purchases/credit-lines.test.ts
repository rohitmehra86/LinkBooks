import { describe, expect, it } from "vitest";
import {
  billAcceptsCredit,
  billOutstandingMinor,
  linesFromBill,
  minorToText,
  suggestedAllocationMinor,
  type BillForCredit,
} from "./credit-lines";

const bill: BillForCredit = {
  id: "b",
  status: "authorised",
  currency_code: "GBP",
  fx_rate_to_base: null,
  total_minor: 12000,
  amount_paid_minor: 2000,
  amount_credited_minor: 1000,
  lines: [
    { description: "Parts", account_id: "a1", net_minor: 10000, tax_minor: 2000 },
    { description: "No account", account_id: null, net_minor: 500, tax_minor: 0 },
    { description: "Zero", account_id: "a2", net_minor: 0, tax_minor: 0 },
  ],
};

describe("credit note form helpers", () => {
  it("formats minor units for any number of decimals", () => {
    expect(minorToText(12345, 2)).toBe("123.45");
    expect(minorToText(5, 2)).toBe("0.05");
    expect(minorToText(1234, 0)).toBe("1234");
    expect(minorToText(12345, 3)).toBe("12.345");
  });
  it("copies postable bill lines only", () => {
    let n = 0;
    const lines = linesFromBill(bill, 2, () => `k${n++}`);
    expect(lines).toEqual([
      { key: "k0", description: "Parts", accountId: "a1", net: "100.00", tax: "20.00" },
    ]);
  });
  it("never allocates more than the bill still owes", () => {
    expect(billOutstandingMinor(bill)).toBe(9000);
    expect(suggestedAllocationMinor(12000, bill)).toBe(9000);
    expect(suggestedAllocationMinor(4000, bill)).toBe(4000);
    expect(suggestedAllocationMinor(-5, bill)).toBe(0);
  });
  it("only posted open bills accept a credit", () => {
    expect(billAcceptsCredit("authorised")).toBe(true);
    expect(billAcceptsCredit("partly_paid")).toBe(true);
    expect(billAcceptsCredit("draft")).toBe(false);
    expect(billAcceptsCredit("paid")).toBe(false);
    expect(billAcceptsCredit("void")).toBe(false);
  });
});
