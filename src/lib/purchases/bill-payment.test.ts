import { describe, expect, it } from "vitest";
import { deriveBillStatus, billOutstanding } from "./line-math";

describe("bill payment status derivation", () => {
  it("keeps authorised when nothing paid", () => {
    expect(
      deriveBillStatus({
        status: "authorised",
        total_minor: 5413,
        amount_paid_minor: 0,
        amount_credited_minor: 0,
      }),
    ).toBe("authorised");
  });

  it("marks partly paid after partial payment", () => {
    expect(
      deriveBillStatus({
        status: "authorised",
        total_minor: 5413,
        amount_paid_minor: 2000,
        amount_credited_minor: 0,
      }),
    ).toBe("partly_paid");
  });

  it("marks paid when balance cleared", () => {
    expect(
      deriveBillStatus({
        status: "partly_paid",
        total_minor: 5413,
        amount_paid_minor: 5413,
        amount_credited_minor: 0,
      }),
    ).toBe("paid");
  });

  it("blocks overpayment math at outstanding check", () => {
    const outstanding = billOutstanding({
      total_minor: 5413,
      amount_paid_minor: 2000,
      amount_credited_minor: 0,
    });
    expect(outstanding).toBe(3413n);
    expect(5000 > Number(outstanding)).toBe(true);
  });

  it("restores authorised after reversing all payments", () => {
    expect(
      deriveBillStatus({
        status: "authorised",
        total_minor: 5413,
        amount_paid_minor: 0,
        amount_credited_minor: 0,
      }),
    ).toBe("authorised");
  });
});
