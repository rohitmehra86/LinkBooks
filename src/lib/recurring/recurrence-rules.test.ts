import { describe, expect, it } from "vitest";
import {
  civilDateInTimeZone,
  nextOccurrenceFromSpec,
  previewOccurrencesFromSpec,
  validateRecurrenceSpec,
  type RecurrenceSpec,
} from "./recurrence-rules";

function spec(overrides: Partial<RecurrenceSpec> = {}): RecurrenceSpec {
  return {
    startDate: "2026-01-31",
    frequency: "monthly",
    interval: 1,
    customUnit: null,
    weekdays: null,
    monthDay: null,
    endDate: null,
    maxOccurrences: null,
    weekendAdjust: "none",
    holidays: [],
    ...overrides,
  };
}

describe("recurrence rules", () => {
  it("clamps 31 January to 28 February in a non-leap year and restores 31 March", () => {
    expect(nextOccurrenceFromSpec(spec(), "2026-01-31")).toBe("2026-02-28");
    expect(nextOccurrenceFromSpec(spec(), "2026-02-28")).toBe("2026-03-31");
  });

  it("keeps 29 February on leap years and clamps the years between", () => {
    const yearly = spec({ startDate: "2024-02-29", frequency: "yearly" });
    expect(nextOccurrenceFromSpec(yearly, "2024-02-29")).toBe("2025-02-28");
    expect(nextOccurrenceFromSpec(yearly, "2027-02-28")).toBe("2028-02-29");
  });

  it("crosses the year boundary for daily recurrence", () => {
    expect(nextOccurrenceFromSpec(spec({ startDate: "2026-12-31", frequency: "daily" }), "2026-12-31")).toBe(
      "2027-01-01",
    );
  });

  it("supports fortnightly, half-yearly and custom intervals", () => {
    expect(
      nextOccurrenceFromSpec(spec({ startDate: "2026-01-01", frequency: "fortnightly" }), "2026-01-01"),
    ).toBe("2026-01-15");
    expect(
      nextOccurrenceFromSpec(spec({ startDate: "2026-01-15", frequency: "half_yearly" }), "2026-01-15"),
    ).toBe("2026-07-15");
    expect(
      nextOccurrenceFromSpec(
        spec({ startDate: "2026-01-01", frequency: "custom", customUnit: "days", interval: 10 }),
        "2026-01-01",
      ),
    ).toBe("2026-01-11");
  });

  it("moves a weekend date to the next business day and skips a holiday", () => {
    const dates = previewOccurrencesFromSpec(
      spec({
        startDate: "2026-01-03",
        frequency: "weekly",
        weekendAdjust: "next_business_day",
        holidays: ["2026-01-05"],
      }),
      "2026-01-03",
      2,
    );
    expect(dates[0]).toBe("2026-01-06");
  });

  it("previews 12 occurrences and stops at the end date", () => {
    const dates = previewOccurrencesFromSpec(
      spec({ startDate: "2026-01-01", frequency: "monthly", endDate: "2026-04-01" }),
      "2026-01-01",
      12,
    );
    expect(dates).toEqual(["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"]);
  });

  it("rejects weekday selection on a monthly rule", () => {
    expect(validateRecurrenceSpec(spec({ weekdays: [1] }))).toMatch(/Weekday selection/);
  });

  it("keeps the civil date across a daylight-saving instant", () => {
    expect(civilDateInTimeZone(new Date("2026-03-08T06:30:00.000Z"), "America/New_York")).toBe("2026-03-08");
    expect(civilDateInTimeZone(new Date("2026-03-08T06:30:00.000Z"), "UTC")).toBe("2026-03-08");
  });
});
