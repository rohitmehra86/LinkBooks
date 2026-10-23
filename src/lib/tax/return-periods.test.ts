import { describe, expect, it } from "vitest";
import { monthsForFrequency, suggestReturnPeriod } from "./return-periods";

describe("suggested return period", () => {
  it("follows the last filed return", () => {
    expect(
      suggestReturnPeriod({
        frequency: "quarterly",
        today: "2026-10-23",
        lastFiledEnd: "2026-06-30",
      }),
    ).toEqual({ start: "2026-07-01", end: "2026-09-30" });
    expect(
      suggestReturnPeriod({
        frequency: "monthly",
        today: "2026-10-23",
        lastFiledEnd: "2026-01-31",
      }),
    ).toEqual({ start: "2026-02-01", end: "2026-02-28" });
  });

  it("uses the last finished calendar block when nothing is filed", () => {
    expect(
      suggestReturnPeriod({ frequency: "quarterly", today: "2026-10-23", lastFiledEnd: null }),
    ).toEqual({ start: "2026-07-01", end: "2026-09-30" });
    expect(
      suggestReturnPeriod({ frequency: "quarterly", today: "2026-01-05", lastFiledEnd: null }),
    ).toEqual({ start: "2025-10-01", end: "2025-12-31" });
    expect(
      suggestReturnPeriod({ frequency: "monthly", today: "2026-03-10", lastFiledEnd: null }),
    ).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(
      suggestReturnPeriod({ frequency: "annually", today: "2026-10-23", lastFiledEnd: null }),
    ).toEqual({ start: "2025-01-01", end: "2025-12-31" });
  });

  it("defaults to quarterly for unknown or missing frequency", () => {
    expect(monthsForFrequency(null)).toBe(3);
    expect(monthsForFrequency("weird")).toBe(3);
    expect(monthsForFrequency("bi_monthly")).toBe(2);
  });
});
