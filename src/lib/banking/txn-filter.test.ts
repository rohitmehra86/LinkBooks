import { describe, expect, it } from "vitest";
import { applyTxnFilter, escapeLike, normaliseTxnFilter } from "./txn-filter";

/** Records every builder call so we can assert exactly what the filter applies. */
function recorder() {
  const calls: Array<[string, ...unknown[]]> = [];
  const chain: Record<string, (...a: unknown[]) => unknown> = {};
  for (const m of ["eq", "in", "gte", "lte", "gt", "lt", "or"]) {
    chain[m] = (...a: unknown[]) => {
      calls.push([m, ...a]);
      return chain;
    };
  }
  return { chain, calls };
}

describe("normaliseTxnFilter", () => {
  it("blanks become null and text is trimmed", () => {
    const f = normaliseTxnFilter({ q: "  amazon ", bankAccountId: "", status: " " });
    expect(f.q).toBe("amazon");
    expect(f.bankAccountId).toBeNull();
    expect(f.status).toBeNull();
  });

  it("rejects non-ISO dates and an inverted range", () => {
    expect(() => normaliseTxnFilter({ dateFrom: "01/02/2026" })).toThrow(/YYYY-MM-DD/);
    expect(() => normaliseTxnFilter({ dateFrom: "2026-03-01", dateTo: "2026-02-01" })).toThrow(
      /after/,
    );
    expect(normaliseTxnFilter({ dateFrom: "2026-02-01", dateTo: "2026-02-01" }).dateFrom).toBe(
      "2026-02-01",
    );
  });

  it("only accepts in/out as direction and caps the search text", () => {
    expect(normaliseTxnFilter({ direction: "sideways" }).direction).toBeNull();
    expect(normaliseTxnFilter({ direction: "in" }).direction).toBe("in");
    expect(normaliseTxnFilter({ q: "x".repeat(500) }).q).toHaveLength(120);
  });
});

describe("escapeLike", () => {
  it("escapes wildcard characters so they match literally", () => {
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
    expect(escapeLike("plain")).toBe("plain");
  });
});

describe("applyTxnFilter", () => {
  it("applies nothing for an empty filter", () => {
    const { chain, calls } = recorder();
    applyTxnFilter(chain, normaliseTxnFilter({}));
    expect(calls).toEqual([]);
  });

  it("maps status groups to IN lists", () => {
    const a = recorder();
    applyTxnFilter(a.chain, normaliseTxnFilter({ statusGroup: "unreconciled" }));
    expect(a.calls).toEqual([["in", "status", ["uncategorised", "matched"]]]);
    const b = recorder();
    applyTxnFilter(b.chain, normaliseTxnFilter({ statusGroup: "posted" }));
    expect(b.calls).toEqual([["in", "status", ["matched", "reconciled"]]]);
  });

  it("applies account, dates and direction", () => {
    const { chain, calls } = recorder();
    applyTxnFilter(
      chain,
      normaliseTxnFilter({
        bankAccountId: "acc-1",
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
        direction: "out",
      }),
    );
    expect(calls).toEqual([
      ["eq", "bank_account_id", "acc-1"],
      ["gte", "txn_date", "2026-01-01"],
      ["lte", "txn_date", "2026-01-31"],
      ["lt", "amount_minor", 0],
    ]);
  });

  it("searches description, reference and payee and strips characters that break .or()", () => {
    const { chain, calls } = recorder();
    applyTxnFilter(chain, normaliseTxnFilter({ q: "a,b(c)%" }));
    const or = calls[0]?.[1] as string;
    expect(or).toContain("description.ilike.%a b c \\%%");
    expect(or).toContain("reference.ilike.");
    expect(or).toContain("payee.ilike.");
  });

  it("searches only the description when extra columns are not installed", () => {
    const { chain, calls } = recorder();
    applyTxnFilter(chain, normaliseTxnFilter({ q: "rent" }), false);
    expect(calls[0]?.[1]).toBe("description.ilike.%rent%");
  });
});
