import { describe, expect, it } from "vitest";
import { ariaSortValue, nextSort, sortRows } from "./sort";

describe("sortable headers (U-13)", () => {
  it("cycles direction and exposes aria-sort", () => {
    const a = nextSort<"date" | "amount">(null, "date");
    expect(a).toEqual({ key: "date", dir: "asc" });
    expect(nextSort(a, "date")).toEqual({ key: "date", dir: "desc" });
    expect(nextSort(a, "amount")).toEqual({ key: "amount", dir: "asc" });
    expect(ariaSortValue(false, "asc")).toBe("none");
    expect(ariaSortValue(true, "asc")).toBe("ascending");
    expect(ariaSortValue(true, "desc")).toBe("descending");
  });
  it("sorts numbers numerically, text naturally, keeps ties stable and nulls last", () => {
    const rows = [
      { n: 10, s: "INV-10" },
      { n: 2, s: "INV-2" },
      { n: 2, s: "INV-1" },
      { n: null, s: null },
    ];
    expect(sortRows(rows, (r) => r.n, "asc").map((r) => r.s)).toEqual([
      "INV-2",
      "INV-1",
      "INV-10",
      null,
    ]);
    expect(sortRows(rows, (r) => r.n, "desc").map((r) => r.s)).toEqual([
      "INV-10",
      "INV-2",
      "INV-1",
      null,
    ]);
    expect(sortRows(rows, (r) => r.s, "asc").map((r) => r.s)).toEqual([
      "INV-1",
      "INV-2",
      "INV-10",
      null,
    ]);
  });
});
