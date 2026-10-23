import { describe, expect, it } from "vitest";
import {
  buildIlikeOr,
  escapeLikeTerm,
  ilikeContainsValue,
  ilikePattern,
} from "@/lib/purchases/search-terms";

describe("search terms", () => {
  it("escapes LIKE wildcards", () => {
    expect(escapeLikeTerm("50%_off\\")).toBe("50\\%\\_off\\\\");
    expect(ilikePattern(" a_b ")).toBe("%a\\_b%");
  });

  it("quotes values so commas and parentheses are data", () => {
    const v = ilikeContainsValue("Smith, J (Ltd)");
    expect(v.startsWith('"%')).toBe(true);
    expect(v.endsWith('%"')).toBe(true);
    expect(v).toContain("Smith, J (Ltd)");
  });

  it("escapes embedded quotes and backslashes for the PostgREST grammar", () => {
    expect(ilikeContainsValue('a"b')).toBe('"%a\\"b%"');
    // a literal % in the term becomes \% for LIKE and \\% after PostgREST quoting
    expect(ilikeContainsValue("5%")).toBe('"%5\\\\%%"');
  });

  it("builds an or() list or null for blank", () => {
    expect(buildIlikeOr(["name", "email"], "x")).toBe('name.ilike."%x%",email.ilike."%x%"');
    expect(buildIlikeOr(["name"], "   ")).toBeNull();
    expect(buildIlikeOr([], "x")).toBeNull();
  });
});
