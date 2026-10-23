import { describe, expect, it } from "vitest";
import { fetchAllPages } from "./fetch-all";

function source(n: number) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: i }));
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
  it("reads past the 1000-row cap", async () => {
    const s = source(2500);
    const all = await fetchAllPages(s.page);
    expect(all).toHaveLength(2500);
    expect(s.calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("stops after a short page and handles exact multiples", async () => {
    const s = source(2000);
    expect(await fetchAllPages(s.page)).toHaveLength(2000);
    expect(s.calls.length).toBe(3); // third page is empty and ends the loop
    expect(await fetchAllPages(source(0).page)).toEqual([]);
  });

  it("surfaces database errors and enforces maxRows", async () => {
    await expect(
      fetchAllPages(async () => ({ data: null, error: { message: "boom" } })),
    ).rejects.toThrow("boom");
    await expect(fetchAllPages(source(50).page, { pageSize: 10, maxRows: 20 })).rejects.toThrow(
      /more than/,
    );
  });
});
