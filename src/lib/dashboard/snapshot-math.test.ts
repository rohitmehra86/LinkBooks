import { describe, expect, it } from "vitest";
import type { PostedLine } from "@/lib/accounting/reporting";
import { ageOutstandingByCurrency, lastMonths, monthlyCashSeries } from "./snapshot-math";

describe("dashboard ageing (U-02)", () => {
  const asOf = "2026-10-23";
  it("buckets by days overdue and totals the overdue part per currency", () => {
    const rows = ageOutstandingByCurrency(
      [
        { due_date: "2026-11-01", currency_code: "GBP", outstanding_minor: 100n }, // current
        { due_date: "2026-10-23", currency_code: "GBP", outstanding_minor: 50n }, // due today = current
        { due_date: "2026-10-13", currency_code: "GBP", outstanding_minor: 200n }, // 10 days
        { due_date: "2026-09-13", currency_code: "GBP", outstanding_minor: 300n }, // 40
        { due_date: "2026-08-13", currency_code: "GBP", outstanding_minor: 400n }, // 71
        { due_date: "2026-01-01", currency_code: "GBP", outstanding_minor: 500n }, // 90+
      ],
      asOf,
    );
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r).toMatchObject({
      current: 150n,
      b_1_30: 200n,
      b_31_60: 300n,
      b_61_90: 400n,
      b_90_plus: 500n,
      total: 1550n,
    });
    expect(r.overdue).toBe(1400n);
    expect(r.count).toBe(6);
  });
  it("never mixes currencies and ignores settled documents", () => {
    const rows = ageOutstandingByCurrency(
      [
        { due_date: "2026-10-01", currency_code: "USD", outstanding_minor: 10n },
        { due_date: "2026-10-01", currency_code: "EUR", outstanding_minor: 20n },
        { due_date: "2026-10-01", currency_code: "EUR", outstanding_minor: 0n },
      ],
      asOf,
    );
    expect(rows.map((r) => [r.currency, r.overdue])).toEqual([
      ["EUR", 20n],
      ["USD", 10n],
    ]);
  });
});

describe("dashboard 12-month cash chart (U-04)", () => {
  const line = (date: string, debit: bigint, credit: bigint, source?: string): PostedLine => ({
    account_id: "bank",
    account_code: "1000",
    account_name: "Bank",
    account_type: "asset",
    journal_date: date,
    debit_minor: debit,
    credit_minor: credit,
    ...(source ? { source_type: source } : {}),
  });
  it("lists exactly 12 months ending with the current month", () => {
    const m = lastMonths("2026-10-23", 12);
    expect(m).toHaveLength(12);
    expect(m[0]).toBe("2025-11");
    expect(m[11]).toBe("2026-10");
  });
  it("sums in and out per month and skips transfers and opening balances", () => {
    const s = monthlyCashSeries(
      [
        line("2026-10-02", 500n, 0n),
        line("2026-10-05", 0n, 120n),
        line("2026-09-30", 80n, 0n),
        line("2026-10-06", 900n, 0n, "bank_transfer"),
        line("2026-01-01", 1000n, 0n, "opening_balance"),
        line("2024-01-01", 7n, 0n), // outside the window
      ],
      "2026-10-23",
    );
    expect(s[11]).toEqual({ month: "2026-10", in_minor: 500n, out_minor: 120n });
    expect(s[10]).toEqual({ month: "2026-09", in_minor: 80n, out_minor: 0n });
    expect(s.reduce((n, x) => n + x.in_minor, 0n)).toBe(580n);
  });
});
