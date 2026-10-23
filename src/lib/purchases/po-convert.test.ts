import { describe, expect, it } from "vitest";
import { dueDateFromBillDate, impliedDiscountMinor } from "@/lib/purchases/po-convert";

describe("impliedDiscountMinor", () => {
  it("recovers the discount from qty x unit - net", () => {
    expect(impliedDiscountMinor({ quantity: 2, unit_price_minor: 5000, net_minor: 9000 })).toBe(
      1000,
    );
  });
  it("is zero when there was no discount and never negative", () => {
    expect(impliedDiscountMinor({ quantity: 3, unit_price_minor: 1000, net_minor: 3000 })).toBe(0);
    expect(impliedDiscountMinor({ quantity: 1, unit_price_minor: 100, net_minor: 500 })).toBe(0);
  });
  it("handles fractional quantities by rounding the gross", () => {
    expect(impliedDiscountMinor({ quantity: 1.5, unit_price_minor: 1001, net_minor: 1500 })).toBe(
      2,
    );
  });
});

describe("dueDateFromBillDate", () => {
  it("adds calendar days without local-time drift", () => {
    expect(dueDateFromBillDate("2026-10-23", 30)).toBe("2026-11-22");
    expect(dueDateFromBillDate("2026-12-15", 30)).toBe("2027-01-14");
    expect(dueDateFromBillDate("2026-03-28", 0)).toBe("2026-03-28");
  });
  it("treats invalid terms as zero", () => {
    expect(dueDateFromBillDate("2026-01-01", Number.NaN)).toBe("2026-01-01");
  });
});
