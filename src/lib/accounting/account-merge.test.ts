import { describe, expect, it } from "vitest";
import { assessMergePlan, type MergePlan } from "./account-merge";

const base: MergePlan = {
  source: { id: "s", code: "6001", name: "Old Travel" },
  target: { id: "t", code: "6002", name: "Travel" },
  today: "2026-10-23",
  total_net_minor: 3500,
  locked_count: 0,
  periods: [
    {
      period_id: "p25",
      period_name: "FY2025",
      journal_date: "2025-12-31",
      net_minor: 3000,
      locked: false,
      lock_reason: null,
    },
    {
      period_id: "p26",
      period_name: "FY2026",
      journal_date: "2026-10-23",
      net_minor: 500,
      locked: false,
      lock_reason: null,
    },
  ],
};

describe("assessMergePlan", () => {
  it("posts one journal per period when all are open", () => {
    const a = assessMergePlan(base, false);
    expect(a.canMerge).toBe(true);
    expect(a.journalCount).toBe(2);
    expect(a.blockedReason).toBeNull();
  });

  it("blocks when a period is locked unless the user accepts posting its share today", () => {
    const plan: MergePlan = {
      ...base,
      locked_count: 1,
      periods: [
        { ...base.periods[0]!, locked: true, lock_reason: "Period is locked" },
        base.periods[1]!,
      ],
    };
    const blocked = assessMergePlan(plan, false);
    expect(blocked.canMerge).toBe(false);
    expect(blocked.blockedReason).toMatch(/FY2025 is locked/);
    expect(blocked.blockedReason).toContain("2026-10-23");

    const accepted = assessMergePlan(plan, true);
    expect(accepted.canMerge).toBe(true);
    expect(accepted.journalCount).toBe(2); // FY2026 dated journal + one journal for the locked share
  });

  it("an account with no balance in any period has nothing to move", () => {
    const a = assessMergePlan({ ...base, periods: [], total_net_minor: 0 }, false);
    expect(a.nothingToMove).toBe(true);
    expect(a.canMerge).toBe(true);
    expect(a.journalCount).toBe(0);
  });

  it("locked shares that net to zero do not need a journal", () => {
    const plan: MergePlan = {
      ...base,
      locked_count: 2,
      periods: [
        { ...base.periods[0]!, net_minor: 100, locked: true, lock_reason: "x" },
        { ...base.periods[1]!, net_minor: -100, locked: true, lock_reason: "x" },
      ],
    };
    expect(assessMergePlan(plan, true).journalCount).toBe(0);
  });
});
