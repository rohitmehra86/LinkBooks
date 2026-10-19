import { describe, expect, it } from "vitest";
import { billOutstanding, computeLineAmounts, deriveBillStatus, sumLines } from "./line-math";

describe("purchase line math", () => {
  it("computes net and tax in minor units with half-up", () => {
    const line = computeLineAmounts({
      quantity: 2,
      unit_price_minor: 1000n, // 10.00 each
      tax_rate_bps: 2000, // 20%
    });
    expect(line.net_minor).toBe(2000n);
    expect(line.tax_minor).toBe(400n);
    expect(line.gross_minor).toBe(2400n);
  });

  it("applies discount before tax", () => {
    const line = computeLineAmounts({
      quantity: 1,
      unit_price_minor: 10000n,
      discount_minor: 1000n,
      tax_rate_bps: 1000,
    });
    expect(line.net_minor).toBe(9000n);
    expect(line.tax_minor).toBe(900n);
  });

  it("rejects discount exceeding net", () => {
    expect(() =>
      computeLineAmounts({ quantity: 1, unit_price_minor: 100n, discount_minor: 200n }),
    ).toThrow(/Discount/);
  });

  it("sums lines and derives bill status", () => {
    const totals = sumLines([
      { net_minor: 1000n, tax_minor: 200n, gross_minor: 1200n },
      { net_minor: 500n, tax_minor: 0n, gross_minor: 500n },
    ]);
    expect(totals.total_minor).toBe(1700n);
    expect(
      deriveBillStatus({
        status: "authorised",
        total_minor: 1700n,
        amount_paid_minor: 700n,
        amount_credited_minor: 0n,
      }),
    ).toBe("partly_paid");
    expect(
      deriveBillStatus({
        status: "authorised",
        total_minor: 1700n,
        amount_paid_minor: 1700n,
        amount_credited_minor: 0n,
      }),
    ).toBe("paid");
    expect(
      billOutstanding({ total_minor: 1700n, amount_paid_minor: 700n, amount_credited_minor: 200n }),
    ).toBe(800n);
  });
});
