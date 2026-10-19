import { describe, expect, it } from "vitest";
import {
  deriveInvoiceStatus,
  invoiceOutstanding,
  nextDate,
  validateSalesLines,
} from "./line-helpers";

describe("validateSalesLines", () => {
  it("computes tax and discount (exclusive)", () => {
    const lines = validateSalesLines([
      {
        description: "Service",
        accountId: "acc",
        quantity: 2,
        unitPriceMinor: 1000,
        discountMinor: 100,
        taxRateBps: 2000,
      },
    ]);
    expect(lines[0]!.net_minor).toBe(1900n);
    expect(lines[0]!.tax_minor).toBe(380n);
    expect(lines[0]!.gross_minor).toBe(2280n);
  });

  it("computes inclusive prices when configured", () => {
    const lines = validateSalesLines(
      [
        {
          description: "Service",
          accountId: "acc",
          quantity: 1,
          unitPriceMinor: 1200,
          taxRateBps: 2000,
        },
      ],
      { treatment: "inclusive" },
    );
    expect(lines[0]!.gross_minor).toBe(1200n);
    expect(lines[0]!.net_minor).toBe(1000n);
    expect(lines[0]!.tax_minor).toBe(200n);
  });

  it("rejects empty description", () => {
    expect(() =>
      validateSalesLines([{ description: " ", accountId: "a", quantity: 1, unitPriceMinor: 1 }]),
    ).toThrow(/description/i);
  });
});

describe("invoice outstanding / status", () => {
  it("tracks partial and full payment", () => {
    expect(
      invoiceOutstanding({ total_minor: 1000, amount_paid_minor: 400, amount_credited_minor: 100 }),
    ).toBe(500n);
    expect(
      deriveInvoiceStatus({
        status: "authorised",
        total_minor: 1000,
        amount_paid_minor: 400,
        amount_credited_minor: 0,
      }),
    ).toBe("partly_paid");
    expect(
      deriveInvoiceStatus({
        status: "authorised",
        total_minor: 1000,
        amount_paid_minor: 1000,
        amount_credited_minor: 0,
      }),
    ).toBe("paid");
  });
});

describe("nextDate", () => {
  it("advances by frequency", () => {
    expect(nextDate("2026-01-15", "monthly")).toBe("2026-02-15");
    expect(nextDate("2026-01-15", "weekly")).toBe("2026-01-22");
  });
});
