import { describe, expect, it } from "vitest";
import {
  buildSearchOr,
  clampPage,
  clampPageSize,
  escapeLikeLiteral,
  hasNextPage,
  orIlike,
  pickSort,
} from "./list-filters";

describe("search escaping", () => {
  it("escapes LIKE wildcards so they match literally", () => {
    expect(escapeLikeLiteral("100%_done\\")).toBe("100\\%\\_done\\\\");
  });

  it("quotes the pattern so commas, parentheses and quotes cannot alter the filter", () => {
    const clause = orIlike("invoice_number", 'a),status.eq.paid,("x');
    expect(clause.startsWith('invoice_number.ilike."%')).toBe(true);
    expect(clause.endsWith('%"')).toBe(true);
    // the injected comma stays inside the quoted value
    expect(clause).toContain('a),status.eq.paid,(\\"x');
    expect(clause.match(/(?<!\\)"/g)!.length).toBe(2);
  });

  it("builds a combined OR across columns and matching customers", () => {
    const or = buildSearchOr(
      "acme",
      ["invoice_number", "memo"],
      ["11111111-1111-1111-1111-111111111111"],
    );
    expect(or).toContain("invoice_number.ilike.");
    expect(or).toContain("memo.ilike.");
    expect(or).toContain("contact_id.in.(11111111-1111-1111-1111-111111111111)");
    expect(buildSearchOr("   ", ["a"])).toBeNull();
  });

  it("ignores non-uuid contact ids", () => {
    expect(buildSearchOr("x", ["a"], ["1,2)"])).not.toContain("contact_id.in");
  });
});

describe("paging and sorting", () => {
  it("clamps page size and page", () => {
    expect(clampPageSize(1000)).toBe(200);
    expect(clampPageSize("abc")).toBe(50);
    expect(clampPageSize(0)).toBe(50);
    expect(clampPage(-3)).toBe(0);
    expect(clampPage("2")).toBe(2);
  });

  it("Next is disabled on the exact final page", () => {
    expect(hasNextPage(100, 0, 50)).toBe(true);
    expect(hasNextPage(100, 1, 50)).toBe(false); // exactly two full pages
    expect(hasNextPage(101, 1, 50)).toBe(true);
    expect(hasNextPage(0, 0, 50)).toBe(false);
  });

  it("only allows whitelisted sort columns", () => {
    expect(pickSort("total_minor", ["invoice_date", "total_minor"] as const, "invoice_date")).toBe(
      "total_minor",
    );
    expect(pickSort("1; drop table", ["invoice_date"] as const, "invoice_date")).toBe(
      "invoice_date",
    );
  });
});
