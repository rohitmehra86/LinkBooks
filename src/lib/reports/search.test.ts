import { describe, expect, it } from "vitest";
import { parseReportSearch } from "./search";

describe("report URL search params (RP-05)", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  it("keeps valid values and drops junk", () => {
    expect(
      parseReportSearch({
        from: "2026-01-01",
        to: "2026-03-31",
        account: id,
        columns: "month",
        page: "2",
      }),
    ).toEqual({ from: "2026-01-01", to: "2026-03-31", account: id, columns: "month", page: 2 });
    expect(
      parseReportSearch({
        from: "yesterday",
        account: "x",
        columns: "weird",
        page: -1,
        actor: "nope",
      }),
    ).toEqual({});
  });
  it("omits default values", () => {
    expect(parseReportSearch({ columns: "none" })).toEqual({});
  });
});
