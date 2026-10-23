import { describe, expect, it } from "vitest";
import { dayBefore, rateStatus, validateRateEndDate } from "./rate-status";

const base = { effective_from: "2026-01-01", effective_to: null, is_active: true };

describe("tax rate status", () => {
  it("classifies current, scheduled, ended and inactive rates", () => {
    expect(rateStatus(base, "2026-06-01")).toBe("current");
    expect(rateStatus(base, "2025-12-31")).toBe("scheduled");
    expect(rateStatus({ ...base, effective_to: "2026-03-31" }, "2026-04-01")).toBe("ended");
    expect(rateStatus({ ...base, effective_to: "2026-03-31" }, "2026-03-31")).toBe("current");
    expect(rateStatus({ ...base, is_active: false }, "2026-06-01")).toBe("inactive");
  });

  it("validates end dates", () => {
    expect(validateRateEndDate("2026-01-01", "2026-03-31")).toBeNull();
    expect(validateRateEndDate("2026-01-01", "2026-01-01")).toBeNull();
    expect(validateRateEndDate("2026-01-01", "2025-12-31")).toMatch(/before/);
    expect(validateRateEndDate("2026-01-01", "31/03/2026")).toMatch(/YYYY-MM-DD/);
  });

  it("finds the day before, across month and year ends", () => {
    expect(dayBefore("2026-03-01")).toBe("2026-02-28");
    expect(dayBefore("2028-03-01")).toBe("2028-02-29");
    expect(dayBefore("2026-01-01")).toBe("2025-12-31");
  });
});
