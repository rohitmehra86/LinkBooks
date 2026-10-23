import { describe, expect, it } from "vitest";
import { budgetUsedPercent, marginPercent, summariseTags, totalsOf } from "./projects";

const row = (r: number, c: number, b: number | null = null) => ({
  projectId: "p",
  code: "P",
  name: "n",
  status: "active",
  budgetMinor: b,
  revenueMinor: r,
  costMinor: c,
  profitMinor: r - c,
  unconvertedDocuments: 0,
});

describe("project profitability helpers", () => {
  it("computes margin and budget use", () => {
    expect(marginPercent(row(20000, 5000))).toBe(75);
    expect(marginPercent(row(0, 5000))).toBeNull();
    expect(budgetUsedPercent(row(0, 2500, 10000))).toBe(25);
    expect(budgetUsedPercent(row(0, 2500))).toBeNull();
  });
  it("totals revenue, cost and profit", () => {
    expect(totalsOf([row(100, 40), row(50, 70)])).toEqual({
      revenueMinor: 150,
      costMinor: 110,
      profitMinor: 40,
    });
  });
  it("summarises line tags", () => {
    expect(summariseTags([])).toEqual({ projectId: null, mixed: false });
    expect(summariseTags(["a", "a"])).toEqual({ projectId: "a", mixed: false });
    expect(summariseTags([null, null])).toEqual({ projectId: null, mixed: false });
    expect(summariseTags(["a", null])).toEqual({ projectId: null, mixed: true });
    expect(summariseTags(["a", "b"])).toEqual({ projectId: null, mixed: true });
  });
});
