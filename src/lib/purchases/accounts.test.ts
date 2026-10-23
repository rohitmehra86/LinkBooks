import { describe, expect, it } from "vitest";
import { pickApControlAccount, type ApCandidate } from "./accounts";

const row = (over: Partial<ApCandidate>): ApCandidate => ({
  id: "x",
  code: "2000",
  system_key: null,
  is_active: true,
  archived_at: null,
  ...over,
});

describe("pickApControlAccount", () => {
  it("prefers the account tagged with the ap role over code 2000", () => {
    const picked = pickApControlAccount([
      row({ id: "by-code" }),
      row({ id: "by-role", code: "2050", system_key: "ap" }),
    ]);
    expect(picked).toEqual({ id: "by-role", code: "2050" });
  });
  it("falls back to code 2000", () => {
    expect(pickApControlAccount([row({ id: "only" })])?.id).toBe("only");
  });
  it("ignores inactive and archived accounts", () => {
    expect(
      pickApControlAccount([
        row({ id: "off", system_key: "ap", is_active: false }),
        row({ id: "old", system_key: "ap", archived_at: "2026-01-01" }),
      ]),
    ).toBeNull();
  });
});
