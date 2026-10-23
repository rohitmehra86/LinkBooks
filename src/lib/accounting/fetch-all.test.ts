import { describe, expect, it } from "vitest";
import { fetchAllPages, isMissingRpc } from "./fetch-all";
import {
  fetchAccountTransactionsPage,
  fetchLedgerBalances,
  loadPostedLines,
  type Sb,
} from "./ledger-data";

type Row = {
  id: string;
  account_id: string;
  debit_minor: number;
  credit_minor: number;
  description: string | null;
  journals: Record<string, unknown>;
  accounts: Record<string, unknown>;
};

function makeRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: String(i).padStart(6, "0"),
    account_id: i % 2 === 0 ? "acc-a" : "acc-b",
    debit_minor: i % 2 === 0 ? 100 : 0,
    credit_minor: i % 2 === 0 ? 0 : 100,
    description: null,
    journals: {
      id: `j-${Math.floor(i / 2)}`,
      journal_number: Math.floor(i / 2) + 1,
      journal_date: "2026-05-01",
      status: "posted",
      memo: null,
      source_type: "manual",
      source_id: null,
      currency_code: "GBP",
      fx_rate_to_base: 1,
    },
    accounts: {
      code: i % 2 === 0 ? "1000" : "4000",
      name: i % 2 === 0 ? "Bank" : "Sales",
      account_type: i % 2 === 0 ? "asset" : "income",
      subtype: null,
      account_kind: null,
      system_key: null,
      fs_line: null,
      cash_flow_class: null,
    },
  }));
}

/** Fake PostgREST client: chainable builder that serves .range() windows capped at `maxRows`. */
function fakeClient(rows: Row[], opts: { maxRows?: number; rpc?: Record<string, unknown> } = {}) {
  const maxRows = opts.maxRows ?? 1000;
  const requests: Array<[number, number]> = [];
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    gte: () => builder,
    lte: () => builder,
    order: () => builder,
    range: (from: number, to: number) => {
      requests.push([from, to]);
      const end = Math.min(to, from + maxRows - 1);
      return Promise.resolve({ data: rows.slice(from, end + 1), error: null });
    },
  };
  const client = {
    from: () => builder,
    rpc: (fn: string) => {
      if (opts.rpc && fn in opts.rpc) return Promise.resolve({ data: opts.rpc[fn], error: null });
      return Promise.resolve({
        data: null,
        error: { code: "PGRST202", message: `Could not find the function public.${fn}` },
      });
    },
  };
  return { client: client as unknown as Sb, requests };
}

describe("fetchAllPages", () => {
  it("reads more than 1000 rows by paging until an empty page", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ n: i }));
    const calls: number[] = [];
    const out = await fetchAllPages<{ n: number }>((from, to) => {
      calls.push(from);
      return Promise.resolve({ data: rows.slice(from, Math.min(to, from + 999) + 1), error: null });
    });
    expect(out).toHaveLength(2500);
    expect(out[0]?.n).toBe(0);
    expect(out[2499]?.n).toBe(2499);
    expect(calls).toEqual([0, 1000, 2000, 2500]);
  });

  it("still reads everything when the server caps pages below the requested size", async () => {
    const rows = Array.from({ length: 1234 }, (_, i) => i);
    const out = await fetchAllPages<number>((from, to) =>
      Promise.resolve({ data: rows.slice(from, Math.min(to, from + 499) + 1), error: null }),
    );
    expect(out).toHaveLength(1234);
  });

  it("surfaces errors instead of returning a partial list", async () => {
    await expect(
      fetchAllPages<number>(() => Promise.resolve({ data: null, error: { message: "boom" } })),
    ).rejects.toThrow("boom");
  });

  it("fails loudly past the safety limit", async () => {
    await expect(
      fetchAllPages<number>(
        (from) => Promise.resolve({ data: [from, from + 1, from + 2], error: null }),
        { pageSize: 3, maxRows: 5 },
      ),
    ).rejects.toThrow(/Too many rows/);
  });
});

describe("isMissingRpc", () => {
  it("recognises undeployed RPCs", () => {
    expect(isMissingRpc({ code: "PGRST202", message: "x" })).toBe(true);
    expect(isMissingRpc({ code: "42883", message: "x" })).toBe(true);
    expect(isMissingRpc({ message: "function public.foo() does not exist" })).toBe(true);
    expect(isMissingRpc({ code: "42501", message: "permission denied" })).toBe(false);
  });
});

describe("ledger reads are never truncated at 1000 rows (RP-01)", () => {
  it("loadPostedLines returns all 2500 lines", async () => {
    const { client, requests } = fakeClient(makeRows(2500));
    const lines = await loadPostedLines(client, "company", "GBP");
    expect(lines).toHaveLength(2500);
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(lines.every((l) => l.fx_rate_to_base === null)).toBe(true);
  });

  it("fetchLedgerBalances falls back to the pager and sums every line when the RPC is missing", async () => {
    const { client } = fakeClient(makeRows(2500));
    const balances = await fetchLedgerBalances(client, "company", "GBP", {});
    const a = balances.find((b) => b.account_id === "acc-a");
    const b = balances.find((b) => b.account_id === "acc-b");
    expect(a?.debit_minor).toBe(1250n * 100n);
    expect(a?.line_count).toBe(1250);
    expect(b?.credit_minor).toBe(1250n * 100n);
  });

  it("fetchLedgerBalances prefers the RPC when deployed", async () => {
    const { client, requests } = fakeClient(makeRows(10), {
      rpc: {
        ledger_balances: [{ account_id: "x", debit_minor: 5000, credit_minor: 0, line_count: 3 }],
      },
    });
    const balances = await fetchLedgerBalances(client, "company", "GBP", {});
    expect(balances).toEqual([
      { account_id: "x", debit_minor: 5000n, credit_minor: 0n, line_count: 3 },
    ]);
    expect(requests).toHaveLength(0);
  });

  it("account transactions fall back to paging all lines, with running balance", async () => {
    const rows = makeRows(2500).filter((r) => r.account_id === "acc-a");
    const { client } = fakeClient(rows);
    const page = await fetchAccountTransactionsPage(client, "company", "GBP", {
      accountId: "acc-a",
      from: "2026-01-01",
      to: "2026-12-31",
      limit: 100,
      offset: 1200,
    });
    expect(page.total_count).toBe(1250);
    expect(page.rows).toHaveLength(50);
    expect(page.closing_balance_minor).toBe(125_000n);
    expect(page.rows[49]?.running_balance_minor).toBe(125_000n);
  });
});
