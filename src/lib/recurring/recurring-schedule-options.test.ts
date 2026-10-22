import { describe, expect, it } from "vitest";
import {
  parseScheduleOptions,
  resolveGenerationPolicy,
} from "@/lib/recurring/recurring-schedule-options";

describe("parseScheduleOptions", () => {
  it("keeps a saved custom rule and generation policy", () => {
    const parsed = parseScheduleOptions({
      mode: "reminder",
      generateDaysInAdvance: 5,
      endDate: "2026-12-31",
      maxOccurrences: 4,
      catchUpPolicy: "review_each",
      generationPolicy: "submit_approval",
      recurrence: {
        startDate: "2026-01-01",
        frequency: "custom",
        interval: 10,
        customUnit: "days",
        weekdays: null,
        monthDay: null,
        endDate: "2026-12-31",
        maxOccurrences: 4,
        weekendAdjust: "next_business_day",
        holidays: ["2026-12-25"],
      },
    });
    expect(parsed.mode).toBe("reminder");
    expect(parsed.generationPolicy).toBe("submit_approval");
    expect(parsed.recurrence?.frequency).toBe("custom");
    expect(parsed.recurrence?.interval).toBe(10);
  });

  it("rejects a weekday rule on a monthly schedule", () => {
    expect(() =>
      parseScheduleOptions({
        recurrence: {
          startDate: "2026-01-31",
          frequency: "monthly",
          interval: 1,
          customUnit: null,
          weekdays: [1],
          monthDay: null,
          endDate: null,
          maxOccurrences: null,
          weekendAdjust: "none",
          holidays: [],
        },
      }),
    ).toThrow(/weekday/i);
  });
});

describe("resolveGenerationPolicy", () => {
  it("uses the auto-authorise flag only when the template has no policy", () => {
    expect(resolveGenerationPolicy({}, true)).toBe("auto_authorise");
    expect(resolveGenerationPolicy({ generationPolicy: "draft" }, true)).toBe("draft");
    expect(resolveGenerationPolicy({ generationPolicy: "submit_approval" }, false)).toBe(
      "submit_approval",
    );
  });
});
