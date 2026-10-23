import { describe, expect, it } from "vitest";
import { buildYearEndJournal, planYearEndClose, YEAR_END_MEMO_PREFIX } from "./year-end";

describe("RP-04 year-end closing journal", () => {
  const re = "re";
  it("clears each P&L balance and moves the profit to retained earnings", () => {
    const plan = planYearEndClose(
      [
        { account_id: "sales", net_debit_minor: -1000n }, // credit balance 1000
        { account_id: "rent", net_debit_minor: 300n },
        { account_id: "zero", net_debit_minor: 0n },
      ],
      re,
    );
    expect(plan.netProfitMinor).toBe(700n);
    expect(plan.lines.map((l) => l.account_id)).toEqual(["sales", "rent", "re"]);
    const sales = plan.lines[0]!;
    expect(sales.debit_minor).toBe(1000n);
    const rent = plan.lines[1]!;
    expect(rent.credit_minor).toBe(300n);
    expect(plan.lines[2]!.credit_minor).toBe(700n);
    const d = plan.lines.reduce((n, l) => n + l.debit_minor, 0n);
    const c = plan.lines.reduce((n, l) => n + l.credit_minor, 0n);
    expect(d).toBe(c);
  });
  it("a loss debits retained earnings", () => {
    const plan = planYearEndClose([{ account_id: "rent", net_debit_minor: 300n }], re);
    expect(plan.netProfitMinor).toBe(-300n);
    expect(plan.lines[1]).toMatchObject({ account_id: "re", debit_minor: 300n, credit_minor: 0n });
  });
  it("nets to zero profit: only the P&L clearing lines remain and still balance", () => {
    const plan = planYearEndClose(
      [
        { account_id: "a", net_debit_minor: 100n },
        { account_id: "b", net_debit_minor: -100n },
      ],
      re,
    );
    expect(plan.lines).toHaveLength(2);
  });
  it("journal is source_type other, keyed per year and recognisable by the reports", () => {
    const plan = planYearEndClose([{ account_id: "sales", net_debit_minor: -50n }], re);
    const j = buildYearEndJournal({
      companyId: "c",
      fyStart: "2025-04-01",
      fyEnd: "2026-03-31",
      baseCurrency: "GBP",
      plan,
    });
    expect(j.source_type).toBe("other");
    expect(j.memo?.startsWith(YEAR_END_MEMO_PREFIX)).toBe(true);
    expect(j.journal_date).toBe("2026-03-31");
    expect(j.idempotency_key).toBe("year_end_close:c:2026-03-31");
  });
  it("refuses to build an empty journal", () => {
    expect(() =>
      buildYearEndJournal({
        companyId: "c",
        fyStart: "a",
        fyEnd: "b",
        baseCurrency: "GBP",
        plan: { netProfitMinor: 0n, lines: [] },
      }),
    ).toThrow();
  });
});
