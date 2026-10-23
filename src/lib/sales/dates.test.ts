import { describe, expect, it } from "vitest";
import { isOverdue, todayInTimezone } from "./dates";

describe("todayInTimezone", () => {
  it("uses the company's calendar day, not UTC", () => {
    const instant = new Date("2026-10-23T20:00:00Z");
    expect(todayInTimezone("UTC", instant)).toBe("2026-10-23");
    expect(todayInTimezone("Asia/Kolkata", instant)).toBe("2026-10-24"); // 01:30 next day
    expect(todayInTimezone("Australia/Sydney", instant)).toBe("2026-10-24");
    expect(todayInTimezone("America/Los_Angeles", instant)).toBe("2026-10-23");
  });

  it("falls back to UTC for an invalid zone", () => {
    expect(todayInTimezone("Not/AZone", new Date("2026-10-23T20:00:00Z"))).toBe("2026-10-23");
  });
});

describe("isOverdue", () => {
  it("is overdue only when past due with a balance", () => {
    expect(isOverdue("2026-10-22", "2026-10-23", 100)).toBe(true);
    expect(isOverdue("2026-10-23", "2026-10-23", 100)).toBe(false);
    expect(isOverdue("2026-10-01", "2026-10-23", 0)).toBe(false);
  });
});
