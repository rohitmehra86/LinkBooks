import { describe, expect, it } from "vitest";
import { aggregateOutstanding } from "@/lib/contacts/balances";

const row = (
  currency: string | null,
  total: number,
  paid = 0,
  credited = 0,
  due: string | null = null,
) => ({
  currency_code: currency,
  total_minor: total,
  amount_paid_minor: paid,
  amount_credited_minor: credited,
  due_date: due,
});

describe("aggregateOutstanding", () => {
  it("never mixes currencies and puts base first", () => {
    const r = aggregateOutstanding(
      [row("USD", 1000), row("GBP", 500, 100), row("GBP", 200, 0, 50, "2026-01-01")],
      "2026-10-23",
      "GBP",
    );
    expect(r.byCurrency.map((c) => c.currency)).toEqual(["GBP", "USD"]);
    expect(r.base).toEqual({ currency: "GBP", outstandingMinor: 550, overdueMinor: 150 });
    expect(r.byCurrency[1]).toEqual({ currency: "USD", outstandingMinor: 1000, overdueMinor: 0 });
  });
  it("ignores settled documents and defaults missing currency to base", () => {
    const r = aggregateOutstanding([row(null, 100, 100), row(null, 300)], "2026-10-23", "eur");
    expect(r.base.outstandingMinor).toBe(300);
    expect(r.byCurrency).toHaveLength(1);
  });
  it("returns a zero base row when nothing is open", () => {
    expect(aggregateOutstanding([], "2026-10-23", "GBP").base.outstandingMinor).toBe(0);
  });
});
