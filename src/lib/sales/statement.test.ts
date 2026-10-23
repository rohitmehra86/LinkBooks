import { describe, expect, it } from "vitest";
import { buildCustomerStatement, type StatementDoc } from "./statement";

const inv = (over: Partial<StatementDoc>): StatementDoc => ({
  kind: "invoice",
  id: "i",
  date: "2026-09-10",
  currencyCode: "GBP",
  amountMinor: 10000,
  reference: "INV-1",
  status: "authorised",
  voidDate: null,
  ...over,
});

describe("buildCustomerStatement", () => {
  it("carries a balance brought forward into the opening balance", () => {
    const [gbp] = buildCustomerStatement(
      [
        inv({ id: "i1", date: "2026-09-10", amountMinor: 10000 }),
        { ...inv({ id: "r1", kind: "receipt", date: "2026-09-20", amountMinor: 3000 }), reference: "R" },
        inv({ id: "i2", date: "2026-10-05", amountMinor: 2500, reference: "INV-2" }),
      ],
      { from: "2026-10-01", to: "2026-10-31" },
    );
    expect(gbp!.opening_balance_minor).toBe(7000);
    expect(gbp!.lines).toHaveLength(1);
    expect(gbp!.lines[0]!.balance_minor).toBe(9500);
    expect(gbp!.closing_balance_minor).toBe(9500);
  });

  it("opening balance is zero with no history and running balance accumulates", () => {
    const [gbp] = buildCustomerStatement(
      [
        inv({ id: "i1", date: "2026-10-01", amountMinor: 1000 }),
        inv({ id: "c1", kind: "credit_note", date: "2026-10-02", amountMinor: 400, reference: "SCN-1" }),
        inv({ id: "r1", kind: "receipt", date: "2026-10-03", amountMinor: 600, reference: null }),
      ],
      { from: "2026-10-01", to: "2026-10-31" },
    );
    expect(gbp!.opening_balance_minor).toBe(0);
    expect(gbp!.lines.map((l) => l.balance_minor)).toEqual([1000, 600, 0]);
    expect(gbp!.total_debits_minor).toBe(1000);
    expect(gbp!.total_credits_minor).toBe(1000);
  });

  it("keeps currencies separate", () => {
    const res = buildCustomerStatement(
      [inv({ id: "a", amountMinor: 100 }), inv({ id: "b", currencyCode: "EUR", amountMinor: 900 })],
      { from: null, to: null },
    );
    expect(res.map((r) => [r.currency_code, r.closing_balance_minor])).toEqual([
      ["EUR", 900],
      ["GBP", 100],
    ]);
  });

  it("shows a void as a reversing line on the void date, not by rewriting the opening balance", () => {
    const [gbp] = buildCustomerStatement(
      [inv({ id: "i1", date: "2026-09-10", amountMinor: 5000, status: "void", voidDate: "2026-10-12" })],
      { from: "2026-10-01", to: "2026-10-31" },
    );
    expect(gbp!.opening_balance_minor).toBe(5000);
    expect(gbp!.lines).toHaveLength(1);
    expect(gbp!.lines[0]!.type).toBe("void");
    expect(gbp!.closing_balance_minor).toBe(0);
  });

  it("omits drafts and legacy voids without a void date; excludes activity after `to`", () => {
    const res = buildCustomerStatement(
      [
        inv({ id: "d", status: "draft" }),
        inv({ id: "v", status: "void", voidDate: null }),
        inv({ id: "late", date: "2026-12-01" }),
      ],
      { from: "2026-10-01", to: "2026-10-31" },
    );
    expect(res).toEqual([]);
  });

  it("a receipt voided later reverses the credit", () => {
    const [gbp] = buildCustomerStatement(
      [
        inv({ id: "i1", date: "2026-10-01", amountMinor: 1000 }),
        inv({ id: "r1", kind: "receipt", date: "2026-10-02", amountMinor: 1000, status: "void", voidDate: "2026-10-05", reference: "R" }),
      ],
      { from: "2026-10-01", to: "2026-10-31" },
    );
    expect(gbp!.lines.map((l) => l.balance_minor)).toEqual([1000, 0, 1000]);
  });
});
