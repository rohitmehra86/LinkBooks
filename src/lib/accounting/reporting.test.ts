import { describe, expect, it } from "vitest";
import {
  buildBalanceSheet,
  buildGeneralLedger,
  buildProfitAndLoss,
  buildTrialBalance,
  type PostedLine,
} from "./reporting";

const bank = "a1";
const revenue = "a2";
const expense = "a3";
const equity = "a4";

const sample: PostedLine[] = [
  {
    account_id: bank,
    account_code: "1000",
    account_name: "Bank",
    account_type: "asset",
    journal_date: "2026-01-15",
    debit_minor: 10000n,
    credit_minor: 0n,
  },
  {
    account_id: revenue,
    account_code: "4000",
    account_name: "Sales",
    account_type: "income",
    journal_date: "2026-01-15",
    debit_minor: 0n,
    credit_minor: 10000n,
  },
  {
    account_id: expense,
    account_code: "6000",
    account_name: "Expenses",
    account_type: "expense",
    journal_date: "2026-02-01",
    debit_minor: 2500n,
    credit_minor: 0n,
  },
  {
    account_id: bank,
    account_code: "1000",
    account_name: "Bank",
    account_type: "asset",
    journal_date: "2026-02-01",
    debit_minor: 0n,
    credit_minor: 2500n,
  },
];

describe("trial balance", () => {
  it("balances overall", () => {
    const tb = buildTrialBalance(sample, { to: "2026-12-31" });
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(tb.totalDebit).toBe(10000n);
  });
});

describe("profit and loss", () => {
  it("computes net income for a range", () => {
    const pl = buildProfitAndLoss(sample, { from: "2026-01-01", to: "2026-12-31" });
    expect(pl.income).toBe(10000n);
    expect(pl.expense).toBe(2500n);
    expect(pl.net).toBe(7500n);
  });

  it("separates cost of sales for gross profit", () => {
    const withCogs: PostedLine[] = [
      ...sample,
      {
        account_id: "cogs1",
        account_code: "5000",
        account_name: "Cost of Sales",
        account_type: "expense",
        account_subtype: "cogs",
        journal_date: "2026-01-20",
        debit_minor: 3000n,
        credit_minor: 0n,
      },
      {
        account_id: bank,
        account_code: "1000",
        account_name: "Bank",
        account_type: "asset",
        journal_date: "2026-01-20",
        debit_minor: 0n,
        credit_minor: 3000n,
      },
    ];
    const pl = buildProfitAndLoss(withCogs, { from: "2026-01-01", to: "2026-12-31" });
    expect(pl.costOfSales).toBe(3000n);
    expect(pl.grossProfit).toBe(7000n);
    expect(pl.sections.some((s) => s.id === "cost_of_sales")).toBe(true);
  });
});

describe("balance sheet", () => {
  it("assets = liabilities + equity (incl. closed P&L)", () => {
    const bs = buildBalanceSheet(sample, { asOf: "2026-12-31" });
    expect(bs.assets).toBe(7500n);
    expect(bs.liabilities).toBe(0n);
    expect(bs.equity).toBe(7500n);
    expect(bs.assets).toBe(bs.liabilities + bs.equity);
  });
});

describe("general ledger", () => {
  it("filters by account and date", () => {
    const gl = buildGeneralLedger(sample, {
      accountId: bank,
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(gl).toHaveLength(1);
    expect(gl[0]?.credit_minor).toBe(2500n);
  });
});

describe("opening balance style entry", () => {
  it("includes OB equity and bank in TB", () => {
    const ob: PostedLine[] = [
      {
        account_id: bank,
        account_code: "1000",
        account_name: "Bank",
        account_type: "asset",
        journal_date: "2026-01-01",
        debit_minor: 50000n,
        credit_minor: 0n,
      },
      {
        account_id: equity,
        account_code: "3100",
        account_name: "Opening Balance Equity",
        account_type: "equity",
        journal_date: "2026-01-01",
        debit_minor: 0n,
        credit_minor: 50000n,
      },
    ];
    const tb = buildTrialBalance(ob);
    expect(tb.totalDebit).toBe(tb.totalCredit);
    const bs = buildBalanceSheet(ob, { asOf: "2026-01-01" });
    expect(bs.assets).toBe(bs.liabilities + bs.equity);
  });
});
