import { describe, expect, it } from "vitest";
import { assertRecurringRunnable, recurringFinished } from "./recurring-end";

describe("recurringFinished", () => {
  it("keeps going when there is no limit", () => {
    expect(
      recurringFinished({
        endDate: null,
        maxOccurrences: null,
        occurrencesGenerated: 5,
        nextDate: "2026-12-01",
      }).finished,
    ).toBe(false);
  });
  it("finishes when the next date is past the end date", () => {
    expect(
      recurringFinished({
        endDate: "2026-11-30",
        maxOccurrences: null,
        occurrencesGenerated: 1,
        nextDate: "2026-12-01",
      }).finished,
    ).toBe(true);
  });
  it("includes the end date itself", () => {
    expect(
      recurringFinished({
        endDate: "2026-12-01",
        maxOccurrences: null,
        occurrencesGenerated: 1,
        nextDate: "2026-12-01",
      }).finished,
    ).toBe(false);
  });
  it("finishes at the maximum count and when the rule is exhausted", () => {
    expect(
      recurringFinished({
        endDate: null,
        maxOccurrences: 3,
        occurrencesGenerated: 3,
        nextDate: "2027-01-01",
      }).finished,
    ).toBe(true);
    expect(
      recurringFinished({
        endDate: null,
        maxOccurrences: null,
        occurrencesGenerated: 1,
        nextDate: null,
      }).finished,
    ).toBe(true);
  });
});

describe("assertRecurringRunnable", () => {
  it("rejects runs past the end date or count", () => {
    expect(() =>
      assertRecurringRunnable({
        scheduledDate: "2026-12-01",
        endDate: "2026-11-30",
        maxOccurrences: null,
        occurrencesGenerated: 0,
      }),
    ).toThrow(/ended/);
    expect(() =>
      assertRecurringRunnable({
        scheduledDate: "2026-12-01",
        endDate: null,
        maxOccurrences: 2,
        occurrencesGenerated: 2,
      }),
    ).toThrow(/maximum/);
    expect(() =>
      assertRecurringRunnable({
        scheduledDate: "2026-12-01",
        endDate: "2026-12-01",
        maxOccurrences: 2,
        occurrencesGenerated: 1,
      }),
    ).not.toThrow();
  });
});
