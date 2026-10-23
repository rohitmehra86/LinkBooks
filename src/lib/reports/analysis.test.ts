import { describe, expect, it } from "vitest";
import { buildIndirectCashFlow, type CfAccount } from "@/lib/reports/indirect-cash-flow";
import {
  buildExecutiveSummary,
  changeBps,
  daysOf,
  ratioBps,
  type SummaryPeriod,
} from "@/lib/reports/executive-summary";

const acc = (
  id: string,
  code: string,
  name: string,
  account_type: CfAccount["account_type"],
  extra: Partial<CfAccount> = {},
): CfAccount => ({
  id,
  code,
  name,
  account_type,
  subtype: null,
  account_kind: null,
  system_key: null,
  cash_flow_class: null,
  ...extra,
});

const accounts: CfAccount[] = [
  acc("bank", "1000", "Bank", "asset"),
  acc("ar", "1100", "Accounts Receivable", "asset", { system_key: "ar" }),
  acc("ppe", "1500", "Equipment", "asset", { account_kind: "fixed_asset" }),
  acc("acc", "1510", "Accumulated Depreciation", "asset", { subtype: "depreciation" }),
  acc("ap", "2000", "Accounts Payable", "liability", { system_key: "ap" }),
  acc("loan", "2500", "Bank loan", "liability", { subtype: "loan" }),
  acc("eq", "3000", "Owner equity", "equity"),
  acc("sales", "4000", "Sales", "income"),
  acc("opex", "6000", "Operating expenses", "expense"),
  acc("dep", "6200", "Depreciation Expense", "expense"),
];

const mv = (accountId: string, debitMinor: number, creditMinor: number) => ({
  accountId,
  debitMinor,
  creditMinor,
});

describe("buildIndirectCashFlow", () => {
  it("reconciles net profit to the bank movement across all sections", () => {
    // Each block below is one balanced journal.
    const movements = [
      mv("bank", 100_000, 0), // capital in
      mv("eq", 0, 100_000),
      mv("ppe", 30_000, 0), // equipment bought for cash
      mv("bank", 0, 30_000),
      mv("bank", 20_000, 0), // loan drawn
      mv("loan", 0, 20_000),
      mv("bank", 40_000, 0), // sales 50,000, 10,000 still unpaid
      mv("ar", 10_000, 0),
      mv("sales", 0, 50_000),
      mv("opex", 12_000, 0), // expenses 12,000, 2,000 still unpaid
      mv("bank", 0, 10_000),
      mv("ap", 0, 2_000),
      mv("dep", 1_000, 0), // depreciation
      mv("acc", 0, 1_000),
    ];
    const r = buildIndirectCashFlow({
      accounts,
      movements,
      bankAccountIds: ["bank"],
      openingCashMinor: 5_000,
      closingCashLedgerMinor: 5_000 + 120_000,
    });
    expect(r.reconciles).toBe(true);
    expect(r.netProfitMinor).toBe(50_000 - 12_000 - 1_000);
    expect(r.operating.find((x) => x.kind === "non_cash")?.amountMinor).toBe(1_000);
    // Working capital: receivables up 10,000 (−), payables up 2,000 (+)
    expect(r.operatingMinor).toBe(37_000 + 1_000 - 10_000 + 2_000);
    expect(r.investingMinor).toBe(-30_000);
    expect(r.financingMinor).toBe(120_000);
    expect(r.netChangeMinor).toBe(120_000);
  });

  it("reconciles exactly when journals are balanced", () => {
    const movements = [
      mv("bank", 50_000, 0),
      mv("sales", 0, 50_000),
      mv("bank", 0, 20_000),
      mv("opex", 20_000, 0),
    ];
    const r = buildIndirectCashFlow({
      accounts,
      movements,
      bankAccountIds: ["bank"],
      openingCashMinor: 1_000,
      closingCashLedgerMinor: 1_000 + 30_000,
    });
    expect(r.netProfitMinor).toBe(30_000);
    expect(r.netChangeMinor).toBe(30_000);
    expect(r.closingCashMinor).toBe(31_000);
    expect(r.reconciles).toBe(true);
  });

  it("keeps depreciation out of investing and reconciles with a disposal", () => {
    // Equipment 10,000 bought earlier with 4,000 accumulated depreciation; sold for 7,000 cash:
    // Dr Bank 7,000, Dr Accumulated 4,000, Cr Equipment 10,000, Cr Gain (sales) 1,000.
    // Plus a 500 depreciation charge: Dr Dep 500, Cr Accumulated 500.
    const movements = [
      mv("bank", 7_000, 0),
      mv("acc", 4_000, 500),
      mv("ppe", 0, 10_000),
      mv("sales", 0, 1_000),
      mv("dep", 500, 0),
    ];
    // Journals: disposal balanced (7,000 + 4,000 = 10,000 + 1,000); depreciation balanced.
    const r = buildIndirectCashFlow({
      accounts,
      movements,
      bankAccountIds: ["bank"],
      openingCashMinor: 0,
      closingCashLedgerMinor: 7_000,
    });
    expect(r.reconciles).toBe(true);
    expect(r.netProfitMinor).toBe(1_000 - 500);
    // Investing shows net book value released (10,000 − 4,000 = 6,000), the gain stays in profit.
    expect(r.investingMinor).toBe(6_000);
    expect(r.netChangeMinor).toBe(7_000);
  });

  it("flags a ledger that does not reconcile", () => {
    const r = buildIndirectCashFlow({
      accounts,
      movements: [mv("bank", 100, 0), mv("sales", 0, 100)],
      bankAccountIds: ["bank"],
      openingCashMinor: 0,
      closingCashLedgerMinor: 250,
    });
    expect(r.reconciles).toBe(false);
  });

  it("skips accounts it does not know about and zero movements", () => {
    const r = buildIndirectCashFlow({
      accounts,
      movements: [mv("ghost", 5, 0), mv("ar", 0, 0)],
      bankAccountIds: ["bank"],
      openingCashMinor: 0,
      closingCashLedgerMinor: 0,
    });
    expect(r.operating).toHaveLength(1);
    expect(r.netChangeMinor).toBe(0);
  });
});

describe("executive summary maths", () => {
  it("changeBps handles zero and negative priors", () => {
    expect(changeBps(120, 100)).toBe(2_000);
    expect(changeBps(50, 100)).toBe(-5_000);
    expect(changeBps(10, 0)).toBeNull();
    expect(changeBps(-50, -100)).toBe(5_000); // loss halved = +50%
    expect(changeBps(null, 100)).toBeNull();
  });

  it("ratioBps and daysOf guard against zero denominators", () => {
    expect(ratioBps(250, 1_000)).toBe(2_500);
    expect(ratioBps(1, 0)).toBeNull();
    expect(ratioBps(1, -5)).toBeNull();
    expect(daysOf(3_000, 30_000, 30)).toBe(3);
    expect(daysOf(1, 0, 30)).toBeNull();
    expect(daysOf(1, 100, 0)).toBeNull();
  });

  const period = (over: Partial<SummaryPeriod> = {}): SummaryPeriod => ({
    revenueMinor: 100_000,
    costOfSalesMinor: 40_000,
    grossProfitMinor: 60_000,
    operatingExpenseMinor: 30_000,
    netProfitMinor: 30_000,
    cashReceivedMinor: 90_000,
    cashSpentMinor: 50_000,
    closingCashMinor: 70_000,
    receivablesMinor: 20_000,
    payablesMinor: 7_000,
    assetsMinor: 120_000,
    liabilitiesMinor: 20_000,
    days: 30,
    ...over,
  });

  it("builds comparable rows with margins and days", () => {
    const rows = buildExecutiveSummary(
      period(),
      period({ revenueMinor: 80_000, grossProfitMinor: 40_000, netProfitMinor: 10_000 }),
    );
    const get = (k: string) => rows.find((r) => r.key === k)!;
    expect(get("gross_margin").current).toBe(6_000);
    expect(get("gross_margin").prior).toBe(5_000);
    expect(get("net_margin").current).toBe(3_000);
    expect(get("net_profit").changeBps).toBe(20_000);
    expect(get("cash_net").current).toBe(40_000);
    expect(get("net_assets").current).toBe(100_000);
    expect(get("debtor_days").current).toBe(6);
    expect(get("creditor_days").current).toBe(3);
  });

  it("returns nulls rather than dividing by zero when there is no revenue", () => {
    const rows = buildExecutiveSummary(
      period({ revenueMinor: 0, grossProfitMinor: 0 }),
      period({ revenueMinor: 0, grossProfitMinor: 0 }),
    );
    const get = (k: string) => rows.find((r) => r.key === k)!;
    expect(get("gross_margin").current).toBeNull();
    expect(get("debtor_days").current).toBeNull();
  });
});
