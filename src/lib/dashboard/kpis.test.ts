import { describe, expect, it } from "vitest";
import {
  bucketShares,
  buildChecklist,
  cashTotals,
  formatPercentChange,
  owedSummary,
  percentChange,
  shouldShowChecklist,
  totalCash,
  trendDirection,
} from "./kpis";

describe("percentChange", () => {
  it("computes against the absolute prior and refuses a zero base", () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(50, 100)).toBe(-50);
    expect(percentChange(-50, -100)).toBe(50);
    expect(percentChange(10, 0)).toBeNull();
    expect(percentChange(Number.NaN, 5)).toBeNull();
  });
  it("formats with a real minus and one decimal", () => {
    expect(formatPercentChange(12.34)).toBe("+12.3%");
    expect(formatPercentChange(-3)).toBe("−3.0%");
    expect(formatPercentChange(0.01)).toBe("0.0%");
  });
  it("maps to a direction", () => {
    expect(trendDirection(5)).toBe("up");
    expect(trendDirection(-5)).toBe("down");
    expect(trendDirection(0.02)).toBe("flat");
  });
});

describe("cash and owed", () => {
  it("sums bank balances", () => {
    expect(totalCash([{ ledgerBalanceMinor: 100 }, { ledgerBalanceMinor: -30 }])).toBe(70);
    expect(totalCash([])).toBe(0);
  });
  it("totals cash in/out", () => {
    expect(
      cashTotals([
        { in_minor: 100, out_minor: 40 },
        { in_minor: 0, out_minor: 10 },
      ]),
    ).toEqual({ in: 100, out: 50, net: 50 });
  });
  it("headlines the base currency and flags others", () => {
    const rows = [
      { currency: "GBP", count: 2, total: 500, overdue: 100 },
      { currency: "USD", count: 1, total: 900, overdue: 0 },
    ];
    expect(owedSummary(rows, "GBP")).toEqual({
      total: 500,
      overdue: 100,
      count: 2,
      otherCurrencies: ["USD"],
    });
    expect(owedSummary([], "GBP")).toEqual({ total: 0, overdue: 0, count: 0, otherCurrencies: [] });
  });
  it("shares ageing buckets and ignores negatives", () => {
    expect(bucketShares([50, 50, 0, 0, 0])).toEqual([0.5, 0.5, 0, 0, 0]);
    expect(bucketShares([0, 0])).toEqual([0, 0]);
    expect(bucketShares([-10, 10])).toEqual([0, 1]);
  });
});

describe("checklist", () => {
  const none = {
    banks: 0,
    hasBankMovements: false,
    invoices: false,
    bills: false,
    hasLedgerActivity: false,
  };
  it("flags each step from real signals", () => {
    const items = buildChecklist({ ...none, banks: 2, invoices: true });
    expect(items.find((i) => i.id === "bank")?.done).toBe(true);
    expect(items.find((i) => i.id === "invoice")?.done).toBe(true);
    expect(items.find((i) => i.id === "bill")?.done).toBe(false);
  });
  it("shows only for a company with no ledger activity and steps left", () => {
    expect(shouldShowChecklist(buildChecklist(none), false)).toBe(true);
    expect(shouldShowChecklist(buildChecklist(none), true)).toBe(false);
    const all = buildChecklist({
      banks: 1,
      hasBankMovements: true,
      invoices: true,
      bills: true,
      hasLedgerActivity: true,
    });
    expect(shouldShowChecklist(all, false)).toBe(false);
  });
});
