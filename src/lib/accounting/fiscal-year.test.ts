import { describe, expect, it } from "vitest";
import {
  addMonthsIso,
  fiscalYearContaining,
  fiscalYearStart,
  previousFiscalYear,
  shiftYear,
} from "./fiscal-year";

describe("fiscal year arithmetic", () => {
  it("March year-end: FY runs 1 Apr to 31 Mar", () => {
    expect(fiscalYearContaining("2026-10-23", 3, 31)).toEqual({
      start: "2026-04-01",
      end: "2027-03-31",
    });
    expect(fiscalYearContaining("2027-03-31", 3, 31)).toEqual({
      start: "2026-04-01",
      end: "2027-03-31",
    });
    expect(fiscalYearContaining("2027-04-01", 3, 31)).toEqual({
      start: "2027-04-01",
      end: "2028-03-31",
    });
  });

  it("December year-end is the calendar year", () => {
    expect(fiscalYearStart("2026-10-23", 12, 31)).toBe("2026-01-01");
    expect(fiscalYearStart("2026-01-01", 12, 31)).toBe("2026-01-01");
  });

  it("clamps day for February year-ends (leap and non-leap)", () => {
    expect(fiscalYearContaining("2027-06-01", 2, 29)).toEqual({
      start: "2027-03-01",
      end: "2028-02-29",
    });
    expect(fiscalYearContaining("2026-06-01", 2, 29)).toEqual({
      start: "2026-03-01",
      end: "2027-02-28",
    });
  });

  it("previous fiscal year", () => {
    expect(previousFiscalYear("2026-10-23", 3, 31)).toEqual({
      start: "2025-04-01",
      end: "2026-03-31",
    });
  });

  it("shiftYear and addMonths clamp day", () => {
    expect(shiftYear("2024-02-29", -1)).toBe("2023-02-28");
    expect(addMonthsIso("2026-01-31", 1)).toBe("2026-02-28");
  });
});
