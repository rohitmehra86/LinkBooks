import { describe, expect, it } from "vitest";
import {
  buildSchedule,
  depreciableBase,
  depreciationLines,
  disposalLines,
  disposalOutcome,
  monthIndexFor,
  monthlyDepreciation,
  validateAssetTerms,
  type DepreciableAsset,
} from "@/lib/fixed-assets/depreciation";

const sl = (over: Partial<DepreciableAsset> = {}): DepreciableAsset => ({
  method: "straight_line",
  costMinor: 1_200_000,
  residualMinor: 0,
  openingAccumulatedMinor: 0,
  usefulLifeMonths: 36,
  annualRateBps: null,
  ...over,
});

const rb = (over: Partial<DepreciableAsset> = {}): DepreciableAsset => ({
  method: "reducing_balance",
  costMinor: 1_000_000,
  residualMinor: 100_000,
  openingAccumulatedMinor: 0,
  usefulLifeMonths: null,
  annualRateBps: 2_400,
  ...over,
});

describe("straight line", () => {
  it("spreads cost minus residual evenly when it divides exactly", () => {
    const s = buildSchedule(
      sl({ costMinor: 1_200_000, residualMinor: 120_000, usefulLifeMonths: 36 }),
      "2026-01-15",
    );
    expect(s).toHaveLength(36);
    expect(s.every((r) => r.amountMinor === 30_000)).toBe(true);
    expect(s.at(-1)!.accumulatedMinor).toBe(1_080_000);
    expect(s.at(-1)!.netBookValueMinor).toBe(120_000);
  });
  it("puts the rounding remainder in the last period and conserves the total", () => {
    const a = sl({ costMinor: 1_000_000, usefulLifeMonths: 36 });
    const s = buildSchedule(a, "2026-01-01");
    expect(s[0]!.amountMinor).toBe(27_778); // 27,777.78 rounds up
    expect(s[34]!.amountMinor).toBe(27_778);
    expect(s[35]!.amountMinor).toBe(1_000_000 - 27_778 * 35);
    expect(s.reduce((x, r) => x + r.amountMinor, 0)).toBe(1_000_000);
    expect(s.at(-1)!.netBookValueMinor).toBe(0);
  });
  it("never over-depreciates when rounding up would exceed the base", () => {
    const a = sl({ costMinor: 250, usefulLifeMonths: 300 });
    const s = buildSchedule(a, "2026-01-01");
    expect(s.reduce((x, r) => x + r.amountMinor, 0)).toBe(250);
    expect(s.every((r) => r.amountMinor >= 0)).toBe(true);
    expect(s.at(-1)!.netBookValueMinor).toBe(0);
  });
  it("treats opening accumulated depreciation as already taken", () => {
    const a = sl({ costMinor: 120_000, openingAccumulatedMinor: 60_000, usefulLifeMonths: 6 });
    expect(depreciableBase(a)).toBe(60_000);
    const s = buildSchedule(a, "2026-07-01");
    expect(s.map((r) => r.amountMinor)).toEqual([10_000, 10_000, 10_000, 10_000, 10_000, 10_000]);
    expect(s[0]!.accumulatedMinor).toBe(70_000);
    expect(s.at(-1)!.netBookValueMinor).toBe(0);
  });
  it("stops after the useful life and when nothing is left", () => {
    const a = sl({ usefulLifeMonths: 12, costMinor: 12_000 });
    expect(monthlyDepreciation(a, 13, 12_000)).toBe(0);
    expect(monthlyDepreciation(a, 12, 11_000)).toBe(1_000);
    expect(monthlyDepreciation(a, 5, 12_000)).toBe(0);
  });
  it("labels periods by month end, across a leap year", () => {
    const s = buildSchedule(sl({ usefulLifeMonths: 3, costMinor: 3_000 }), "2028-01-31");
    expect(s.map((r) => r.periodEnd)).toEqual(["2028-01-31", "2028-02-29", "2028-03-31"]);
  });
  it("uses a single period for a one-month life", () => {
    const s = buildSchedule(sl({ usefulLifeMonths: 1, costMinor: 999 }), "2026-05-10");
    expect(s).toHaveLength(1);
    expect(s[0]!.amountMinor).toBe(999);
  });
});

describe("reducing balance", () => {
  it("applies annual rate / 12 to the balance above residual", () => {
    // 900,000 above residual × 2400bps / 12 = 18,000
    expect(monthlyDepreciation(rb(), 1, 0)).toBe(18_000);
    // next month: (900,000 − 18,000) × 0.02 = 17,640
    expect(monthlyDepreciation(rb(), 2, 18_000)).toBe(17_640);
  });
  it("never goes below residual value", () => {
    const s = buildSchedule(rb(), "2026-01-01", 1200);
    const last = s.at(-1)!;
    expect(last.netBookValueMinor).toBeGreaterThanOrEqual(100_000);
    expect(last.netBookValueMinor - 100_000).toBeLessThan(50);
    for (let i = 1; i < s.length; i++) {
      expect(s[i]!.amountMinor).toBeLessThanOrEqual(s[i - 1]!.amountMinor);
    }
  });
  it("a 100% rate takes a twelfth of what is above residual each month, capped at what is left", () => {
    const a = rb({ costMinor: 100_120, residualMinor: 100_000, annualRateBps: 10_000 });
    expect(monthlyDepreciation(a, 1, 0)).toBe(10);
    expect(monthlyDepreciation(a, 2, 119)).toBe(0); // 1 left × 1/12 rounds to nothing
  });
});

describe("no depreciation and helpers", () => {
  it("method none depreciates nothing", () => {
    const a: DepreciableAsset = { ...sl(), method: "none" };
    expect(monthlyDepreciation(a, 1, 0)).toBe(0);
    expect(buildSchedule(a, "2026-01-01")).toEqual([]);
  });
  it("computes the month index from the start date", () => {
    expect(monthIndexFor("2026-01-31", "2026-01-31")).toBe(1);
    expect(monthIndexFor("2026-01-31", "2026-02-28")).toBe(2);
    expect(monthIndexFor("2026-11-02", "2027-02-28")).toBe(4);
    expect(monthIndexFor("2026-03-01", "2026-02-28")).toBe(0);
  });
  it("validates terms", () => {
    expect(validateAssetTerms(sl())).toEqual([]);
    expect(validateAssetTerms(sl({ costMinor: 0 }))).toContain("Cost must be greater than zero.");
    expect(validateAssetTerms(sl({ residualMinor: 2_000_000 }))).toContain(
      "Residual value cannot exceed cost.",
    );
    expect(validateAssetTerms(sl({ usefulLifeMonths: 0 })).join()).toMatch(/useful life/);
    expect(validateAssetTerms(rb({ annualRateBps: 0 })).join()).toMatch(/annual rate/);
    expect(
      validateAssetTerms(sl({ residualMinor: 600_000, openingAccumulatedMinor: 700_000 })).join(),
    ).toMatch(/opening/);
    expect(validateAssetTerms(sl({ costMinor: 10.5 })).join()).toMatch(/Cost/);
  });
});

describe("journal lines", () => {
  it("builds a balanced depreciation pair", () => {
    const l = depreciationLines(27_778, "exp", "acc", "Laptop");
    expect(l[0]).toMatchObject({ account_id: "exp", debit_minor: 27_778, credit_minor: 0 });
    expect(l[1]).toMatchObject({ account_id: "acc", debit_minor: 0, credit_minor: 27_778 });
    expect(() => depreciationLines(0, "e", "a", "x")).toThrow();
  });
});

describe("disposal", () => {
  const accts = {
    assetAccountId: "asset",
    accumulatedAccountId: "acc",
    proceedsAccountId: "bank",
    gainLossAccountId: "gl",
  };
  const totals = (lines: ReturnType<typeof disposalLines>) => ({
    d: lines.reduce((a, l) => a + l.debit_minor, 0),
    c: lines.reduce((a, l) => a + l.credit_minor, 0),
  });
  it("posts a gain when proceeds exceed net book value", () => {
    const o = disposalOutcome(1_000_000, 700_000, 400_000);
    expect(o.netBookValueMinor).toBe(300_000);
    expect(o.gainLossMinor).toBe(100_000);
    const l = disposalLines(o, accts, "Sold");
    const t = totals(l);
    expect(t.d).toBe(t.c);
    expect(l.find((x) => x.account_id === "gl")).toMatchObject({ credit_minor: 100_000 });
  });
  it("posts a loss when proceeds are below net book value", () => {
    const o = disposalOutcome(1_000_000, 700_000, 100_000);
    expect(o.gainLossMinor).toBe(-200_000);
    const l = disposalLines(o, accts, "Sold");
    const t = totals(l);
    expect(t.d).toBe(t.c);
    expect(l.find((x) => x.account_id === "gl")).toMatchObject({ debit_minor: 200_000 });
  });
  it("scrapping a fully depreciated asset needs no gain/loss line", () => {
    const o = disposalOutcome(500_000, 500_000, 0);
    const l = disposalLines(
      o,
      { ...accts, proceedsAccountId: null, gainLossAccountId: null },
      "Scrap",
    );
    expect(l).toHaveLength(2);
    expect(totals(l)).toEqual({ d: 500_000, c: 500_000 });
  });
  it("scrapping a part-depreciated asset is a loss of the net book value", () => {
    const o = disposalOutcome(500_000, 200_000, 0);
    expect(o.gainLossMinor).toBe(-300_000);
    const t = totals(disposalLines(o, { ...accts, proceedsAccountId: null }, "Scrap"));
    expect(t.d).toBe(t.c);
  });
  it("requires the accounts it needs and rejects bad inputs", () => {
    const o = disposalOutcome(1_000, 0, 500);
    expect(() => disposalLines(o, { ...accts, gainLossAccountId: null }, "x")).toThrow(
      /gain\/loss/,
    );
    expect(() => disposalLines(o, { ...accts, proceedsAccountId: null }, "x")).toThrow(/proceeds/);
    expect(() => disposalOutcome(100, 200, 0)).toThrow();
    expect(() => disposalOutcome(100, 0, -1)).toThrow();
  });
});
