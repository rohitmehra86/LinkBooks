import { describe, expect, it } from "vitest";
import { chunk, fetchAllPages, sumBigint } from "./fetch-all";

function fakeTable(total: number) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i, amount: 1 }));
  const calls: Array<[number, number]> = [];
  return {
    calls,
    page: async (from: number, to: number) => {
      calls.push([from, to]);
      return { data: rows.slice(from, to + 1), error: null };
    },
  };
}

describe("fetchAllPages", () => {
  it("returns more than 1000 rows by paging (BK-04)", async () => {
    const t = fakeTable(2503);
    const rows = await fetchAllPages(t.page);
    expect(rows).toHaveLength(2503);
    expect(t.calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
    expect(sumBigint(rows.map((r) => r.amount))).toBe(2503n);
  });

  it("stops after a short page and handles exact multiples", async () => {
    const t = fakeTable(2000);
    const rows = await fetchAllPages(t.page);
    expect(rows).toHaveLength(2000);
    expect(t.calls).toHaveLength(3); // third page is empty
    const empty = await fetchAllPages(fakeTable(0).page);
    expect(empty).toEqual([]);
  });

  it("surfaces errors and enforces the safety cap", async () => {
    await expect(
      fetchAllPages(async () => ({ data: null, error: { message: "boom" } })),
    ).rejects.toThrow("boom");
    await expect(fetchAllPages(fakeTable(5000).page, { maxRows: 2000 })).rejects.toThrow(/Too many/);
  });
});

describe("helpers", () => {
  it("chunks", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => chunk([1], 0)).toThrow();
  });
  it("sums bigint without float drift", () => {
    expect(sumBigint([9007199254740993n, 1, "2"])).toBe(9007199254740996n);
  });
});
