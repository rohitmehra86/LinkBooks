import { describe, expect, it } from "vitest";
import {
  bankReconciliationReport,
  buildStatementGroups,
  proposeOpeningBalance,
  summariseReconciliation,
} from "./recon-math";

describe("summariseReconciliation", () => {
  it("opening + ticked = closing → balanced", () => {
    const s = summariseReconciliation({
      openingMinor: 100000n,
      closingMinor: 130050n,
      tickedAmountsMinor: [50000, -20000n, 50],
    });
    expect(s.cleared).toBe(30050n);
    expect(s.difference).toBe(0n);
    expect(s.balanced).toBe(true);
  });
  it("reports the signed difference (closing − opening − ticked)", () => {
    const s = summariseReconciliation({
      openingMinor: 0n,
      closingMinor: 10000n,
      tickedAmountsMinor: [7500],
    });
    expect(s.difference).toBe(2500n);
    expect(s.balanced).toBe(false);
    expect(
      summariseReconciliation({ openingMinor: 0n, closingMinor: 100n, tickedAmountsMinor: [250] })
        .difference,
    ).toBe(-150n);
  });
  it("handles an unticked outstanding item (does not count towards cleared)", () => {
    // statement 500.00 = opening 400.00 + ticked 100.00; an outstanding cheque of -50.00 stays unticked
    const s = summariseReconciliation({
      openingMinor: 40000n,
      closingMinor: 50000n,
      tickedAmountsMinor: [10000],
    });
    expect(s.balanced).toBe(true);
  });
});

describe("buildStatementGroups", () => {
  const ledger = new Map<string, number>([
    ["L1", 1000],
    ["L2", 2000],
    ["L3", 3000],
    ["L4", 500],
  ]);

  it("one-to-one groups are consistent", () => {
    const g = buildStatementGroups(
      [{ id: "T1", amountMinor: 1000 }],
      [{ bankTransactionId: "T1", journalLineId: "L1" }],
      ledger,
    );
    expect(g).toHaveLength(1);
    expect(g[0]!.inconsistent).toBe(false);
    expect(g[0]!.ledgerTotal).toBe(1000n);
  });

  it("one statement line to several ledger lines", () => {
    const g = buildStatementGroups(
      [{ id: "T1", amountMinor: 3000 }],
      [
        { bankTransactionId: "T1", journalLineId: "L1" },
        { bankTransactionId: "T1", journalLineId: "L2" },
      ],
      ledger,
    );
    expect(g[0]!.journalLineIds).toEqual(["L1", "L2"]);
    expect(g[0]!.inconsistent).toBe(false);
  });

  it("several statement lines to one ledger line are ticked as one group", () => {
    const g = buildStatementGroups(
      [
        { id: "T2", amountMinor: 1200 },
        { id: "T1", amountMinor: 1800 },
        { id: "T9", amountMinor: 500 },
      ],
      [
        { bankTransactionId: "T1", journalLineId: "L3" },
        { bankTransactionId: "T2", journalLineId: "L3" },
        { bankTransactionId: "T9", journalLineId: "L4" },
      ],
      ledger,
    );
    expect(g).toHaveLength(2);
    const big = g.find((x) => x.bankTransactionIds.length === 2)!;
    expect(big.bankTransactionIds).toEqual(["T1", "T2"]);
    expect(big.statementTotal).toBe(3000n);
    expect(big.inconsistent).toBe(false);
  });

  it("flags a matched line with no link (legacy demo data) as inconsistent", () => {
    const g = buildStatementGroups([{ id: "T1", amountMinor: 1000 }], [], ledger);
    expect(g[0]!.inconsistent).toBe(true);
  });

  it("flags mismatching totals as inconsistent", () => {
    const g = buildStatementGroups(
      [{ id: "T1", amountMinor: 999 }],
      [{ bankTransactionId: "T1", journalLineId: "L1" }],
      ledger,
    );
    expect(g[0]!.inconsistent).toBe(true);
  });
});

describe("bankReconciliationReport", () => {
  it("statement + outstanding receipts − outstanding payments = book balance", () => {
    const r = bankReconciliationReport({
      statementBalanceMinor: 100000n,
      outstandingMinor: [{ amountMinor: 25000 }, { amountMinor: -10000 }, { amountMinor: -5000 }],
      bookBalanceMinor: 110000n,
    });
    expect(r.outstandingReceipts).toBe(25000n);
    expect(r.outstandingPayments).toBe(-15000n);
    expect(r.expectedBookBalance).toBe(110000n);
    expect(r.unexplainedDifference).toBe(0n);
  });
  it("exposes an unexplained difference", () => {
    const r = bankReconciliationReport({
      statementBalanceMinor: 100000,
      outstandingMinor: [],
      bookBalanceMinor: 99000,
    });
    expect(r.unexplainedDifference).toBe(-1000n);
  });
});

describe("proposeOpeningBalance", () => {
  it("takes the closing balance of the latest completed session", () => {
    expect(
      proposeOpeningBalance([
        { status: "completed", statement_date: "2026-01-31", statement_balance_minor: 100 },
        { status: "completed", statement_date: "2026-03-31", statement_balance_minor: 300 },
        { status: "void", statement_date: "2026-04-30", statement_balance_minor: 999 },
      ]),
    ).toBe(300n);
  });
  it("returns null when there is none (entered once for the first session)", () => {
    expect(proposeOpeningBalance([])).toBeNull();
    expect(
      proposeOpeningBalance([{ status: "void", statement_date: "2026-01-31", statement_balance_minor: 1 }]),
    ).toBeNull();
  });
});
