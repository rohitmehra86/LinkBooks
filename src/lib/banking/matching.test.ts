import { describe, expect, it } from "vitest";
import {
  dayDistance,
  findExactCombination,
  MAX_MATCH_LINES,
  rankCandidates,
  validateMatchSum,
} from "./matching";

const cand = (lineId: string, date: string, amountMinor: number) => ({
  lineId,
  date,
  amountMinor,
});

describe("dayDistance", () => {
  it("counts calendar days across month and leap-year boundaries", () => {
    expect(dayDistance("2026-03-01", "2026-02-27")).toBe(2);
    expect(dayDistance("2028-03-01", "2028-02-28")).toBe(2); // leap year
    expect(dayDistance("2026-01-05", "2026-01-05")).toBe(0);
    expect(dayDistance("2026-01-01", "2025-12-31")).toBe(1);
  });
  it("rejects bad dates", () => {
    expect(() => dayDistance("nope", "2026-01-01")).toThrow();
  });
});

describe("rankCandidates", () => {
  const stmt = { txnDate: "2026-05-10", amountMinor: 12000 };
  it("filters to the window, exact amounts first, then closeness", () => {
    const ranked = rankCandidates(stmt, [
      cand("far", "2026-05-30", 12000),
      cand("near-other", "2026-05-10", 5000),
      cand("exact-3d", "2026-05-13", 12000),
      cand("exact-1d", "2026-05-09", 12000),
      cand("sign-flip", "2026-05-10", -12000),
    ]);
    expect(ranked.map((r) => r.lineId)).toEqual([
      "exact-1d",
      "exact-3d",
      "near-other",
      "sign-flip",
    ]);
    expect(ranked[0]!.exact).toBe(true);
    expect(ranked[2]!.exact).toBe(false);
  });
  it("honours a custom window", () => {
    expect(rankCandidates(stmt, [cand("a", "2026-05-13", 12000)], 2)).toHaveLength(0);
    expect(rankCandidates(stmt, [cand("a", "2026-05-13", 12000)], 3)).toHaveLength(1);
  });
});

describe("validateMatchSum", () => {
  it("accepts one-to-one and many-to-one that add up exactly", () => {
    expect(validateMatchSum(12000, [12000]).ok).toBe(true);
    const r = validateMatchSum(12000, [7000, 5000]);
    expect(r.ok).toBe(true);
    expect(r.difference).toBe(0n);
  });
  it("shows the running difference (target − selected)", () => {
    const r = validateMatchSum(12000, [7000]);
    expect(r.ok).toBe(false);
    expect(r.difference).toBe(5000n);
    expect(validateMatchSum(12000, [7000, 6000]).difference).toBe(-1000n);
  });
  it("works for money out (negative) and mixed signs", () => {
    expect(validateMatchSum(-5000, [-3000, -2000]).ok).toBe(true);
    expect(validateMatchSum(-5000, [-7000, 2000]).ok).toBe(true);
    expect(validateMatchSum(-5000, [5000]).ok).toBe(false);
  });
  it("needs a selection and caps the size", () => {
    expect(validateMatchSum(100, []).ok).toBe(false);
    expect(validateMatchSum(MAX_MATCH_LINES + 1, Array(MAX_MATCH_LINES + 1).fill(1)).ok).toBe(
      false,
    );
  });
  it("uses bigint so very large amounts do not drift", () => {
    expect(validateMatchSum(9007199254740993n, [9007199254740992n, 1n]).ok).toBe(true);
  });
});

describe("findExactCombination", () => {
  it("finds the smallest exact combination", () => {
    const ids = findExactCombination(12000, [
      cand("a", "d", 7000),
      cand("b", "d", 3000),
      cand("c", "d", 5000),
      cand("d", "d", 2000),
    ]);
    expect(ids).toEqual(["a", "c"]);
  });
  it("prefers a single line, returns null when nothing sums", () => {
    expect(findExactCombination(100, [cand("a", "d", 40), cand("b", "d", 100)])).toEqual(["b"]);
    expect(findExactCombination(100, [cand("a", "d", 40), cand("b", "d", 50)])).toBeNull();
  });
});
