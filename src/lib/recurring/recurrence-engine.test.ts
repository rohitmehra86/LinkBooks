import { describe, expect, it } from "vitest";
import { nextOccurrenceAfter, previewOccurrences } from "@/lib/recurring/recurrence-engine";
import { legacyFrequencyToRrule } from "@/lib/recurring/legacy-frequency";

describe("recurrence-engine (RRULE)", () => {
  it("advances monthly from Jan 31 with month-end anchor (not drift from previous run)", () => {
    const dtstart = "2026-01-31";
    const rrule = legacyFrequencyToRrule("monthly");
    const feb = nextOccurrenceAfter({ dtstart, rrule }, "2026-01-31");
    expect(feb).toBe("2026-02-28");
    const mar = nextOccurrenceAfter({ dtstart, rrule }, feb!);
    expect(mar).toBe("2026-03-31");
  });

  it("weekly adds seven-day steps", () => {
    const dtstart = "2026-01-01";
    const rrule = legacyFrequencyToRrule("weekly");
    expect(nextOccurrenceAfter({ dtstart, rrule }, "2026-01-01")).toBe("2026-01-08");
  });

  it("quarterly uses INTERVAL=3", () => {
    const dtstart = "2026-01-15";
    const rrule = legacyFrequencyToRrule("quarterly");
    expect(nextOccurrenceAfter({ dtstart, rrule }, "2026-01-15")).toBe("2026-04-15");
  });

  it("preview returns requested count", () => {
    const dates = previewOccurrences(
      { dtstart: "2026-01-01", rrule: legacyFrequencyToRrule("monthly") },
      "2026-01-01",
      4,
    );
    expect(dates).toHaveLength(4);
    expect(dates[0]).toBe("2026-01-01");
    expect(dates[1]).toBe("2026-02-01");
  });
});
