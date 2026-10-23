import { describe, expect, it } from "vitest";
import {
  buildAccountTransactions,
  buildBalanceSheet,
  buildCashFlowFromBank,
  buildFiscalTrialBalance,
  buildProfitAndLoss,
  buildTaxSummary,
  buildTrialBalance,
  classifyCashCounterpart,
  type PostedLine,
} from "./reporting";
import { findControlAccountIds, resolveTaxAccountIds } from "./control-accounts";

let seq = 0;
function line(
  p: Partial<PostedLine> & Pick<PostedLine, "account_id" | "account_type">,
): PostedLine {
  seq += 1;
  return {
    account_code: p.account_id,
    account_name: p.account_id,
    journal_date: "2026-05-01",
    debit_minor: 0n,
    credit_minor: 0n,
    journal_id: `j${seq}`,
    journal_number: seq,
    ...p,
  };
}

describe("RP-04 year-end: retained earnings vs current-year earnings", () => {
  // FY starts 2026-04-01. Prior year: sold 1000 (cash). This year: sold 400, spent 100.
  const lines: PostedLine[] = [
    line({
      account_id: "bank",
      account_type: "asset",
      journal_date: "2025-06-01",
      debit_minor: 1000n,
      journal_id: "a",
    }),
    line({
      account_id: "sales",
      account_type: "income",
      journal_date: "2025-06-01",
      credit_minor: 1000n,
      journal_id: "a",
    }),
    line({
      account_id: "bank",
      account_type: "asset",
      journal_date: "2026-05-01",
      debit_minor: 400n,
      journal_id: "b",
    }),
    line({
      account_id: "sales",
      account_type: "income",
      journal_date: "2026-05-01",
      credit_minor: 400n,
      journal_id: "b",
    }),
    line({
      account_id: "rent",
      account_type: "expense",
      journal_date: "2026-06-01",
      debit_minor: 100n,
      journal_id: "c",
    }),
    line({
      account_id: "bank",
      account_type: "asset",
      journal_date: "2026-06-01",
      credit_minor: 100n,
      journal_id: "c",
    }),
  ];

  it("balance sheet splits prior earnings (retained) from current year earnings", () => {
    const bs = buildBalanceSheet(lines, { asOf: "2026-12-31", fyStart: "2026-04-01" });
    expect(bs.retainedEarningsMinor).toBe(1000n);
    expect(bs.currentYearEarningsMinor).toBe(300n);
    expect(bs.assets).toBe(1300n);
    expect(bs.equity).toBe(1300n);
    expect(bs.equationHolds).toBe(true);
    const names = bs.rows.map((r) => r.name);
    expect(names).toContain("Retained earnings");
    expect(names).toContain("Current year earnings");
  });

  it("without fyStart all earnings are current-year (legacy)", () => {
    const bs = buildBalanceSheet(lines, { asOf: "2026-12-31" });
    expect(bs.retainedEarningsMinor).toBe(0n);
    expect(bs.currentYearEarningsMinor).toBe(1300n);
    expect(bs.equationHolds).toBe(true);
  });

  it("merges prior earnings into the retained-earnings account row when it exists", () => {
    const withRe = [
      ...lines,
      line({
        account_id: "re",
        account_type: "equity",
        account_kind: "retained_earnings",
        system_key: "retained_earnings",
        journal_date: "2024-01-01",
        credit_minor: 50n,
        journal_id: "z",
      }),
      line({
        account_id: "bank",
        account_type: "asset",
        journal_date: "2024-01-01",
        debit_minor: 50n,
        journal_id: "z",
      }),
    ];
    const bs = buildBalanceSheet(withRe, { asOf: "2026-12-31", fyStart: "2026-04-01" });
    const re = bs.rows.filter((r) => r.name === "re" || r.name === "Retained earnings");
    expect(re).toHaveLength(1);
    expect(re[0]?.credit_minor).toBe(1050n);
    expect(bs.equationHolds).toBe(true);
  });

  it("trial balance shows fiscal-YTD P&L and rolls earlier years into retained earnings, still balancing", () => {
    const tb = buildFiscalTrialBalance(lines, { to: "2026-12-31", fyStart: "2026-04-01" });
    expect(tb.priorYearsEarningsMinor).toBe(1000n);
    expect(tb.balances).toBe(true);
    const sales = tb.rows.find((r) => r.account_id === "sales");
    expect(sales?.credit_minor).toBe(400n); // only this FY
    const re = tb.rows.find((r) => r.account_id === "__retained_earnings__");
    expect(re?.credit_minor).toBe(1000n);
  });

  it("a user-confirmed closing journal keeps the BS correct and is excluded from the P&L report", () => {
    const closing = [
      line({
        account_id: "sales",
        account_type: "income",
        journal_date: "2026-03-31",
        debit_minor: 1000n,
        journal_id: "close",
        source_type: "other",
        memo: "Year-end close FY2025/26",
      }),
      line({
        account_id: "re",
        account_type: "equity",
        account_kind: "retained_earnings",
        system_key: "retained_earnings",
        journal_date: "2026-03-31",
        credit_minor: 1000n,
        journal_id: "close",
        source_type: "other",
        memo: "Year-end close FY2025/26",
      }),
    ];
    const all = [...lines, ...closing];
    const bs = buildBalanceSheet(all, { asOf: "2026-12-31", fyStart: "2026-04-01" });
    // prior P&L nets to zero after closing; the same 1000 now sits on the RE account
    expect(bs.retainedEarningsMinor).toBe(0n);
    expect(bs.equity).toBe(1300n);
    expect(bs.equationHolds).toBe(true);
    // P&L for the closed FY still shows the real trading result
    const pl = buildProfitAndLoss(all, { from: "2025-04-01", to: "2026-03-31" });
    expect(pl.net).toBe(1000n);
  });
});

describe("RP-03 cash flow classification", () => {
  const bank = { account_id: "bank", account_type: "asset" as const, account_kind: "bank" };
  it("customer receipt (DR bank / CR AR) is operating, not investing", () => {
    const lines = [
      line({ ...bank, debit_minor: 120n, journal_id: "r", source_type: "customer_payment" }),
      line({
        account_id: "ar",
        account_type: "asset",
        system_key: "ar",
        credit_minor: 100n,
        journal_id: "r",
      }),
      line({
        account_id: "vat",
        account_type: "liability",
        system_key: "tax",
        credit_minor: 20n,
        journal_id: "r",
      }),
    ];
    const cf = buildCashFlowFromBank(lines, {
      from: "2026-01-01",
      to: "2026-12-31",
      bankAccountIds: ["bank"],
    });
    expect(cf.operating).toBe(120n);
    expect(cf.investing).toBe(0n);
    expect(cf.financing).toBe(0n);
    expect(cf.reconciles).toBe(true);
    expect(cf.detail.map((d) => d.label)).toEqual([
      "Receipts from customers",
      "Tax (VAT / GST) paid and received",
    ]);
  });

  it("splits a multi-line journal across sections pro rata (equipment + loan)", () => {
    // Loan 1000 received, equipment 600 bought, supplier paid 100 from the same journal
    const lines = [
      line({ ...bank, debit_minor: 300n, journal_id: "m" }),
      line({
        account_id: "loan",
        account_type: "liability",
        account_kind: "non_current_liability",
        credit_minor: 1000n,
        journal_id: "m",
      }),
      line({
        account_id: "ppe",
        account_type: "asset",
        account_kind: "fixed_asset",
        debit_minor: 600n,
        journal_id: "m",
      }),
      line({
        account_id: "ap",
        account_type: "liability",
        system_key: "ap",
        debit_minor: 100n,
        journal_id: "m",
      }),
    ];
    const cf = buildCashFlowFromBank(lines, {
      from: "2026-01-01",
      to: "2026-12-31",
      bankAccountIds: ["bank"],
    });
    expect(cf.financing).toBe(1000n);
    expect(cf.investing).toBe(-600n);
    expect(cf.operating).toBe(-100n);
    expect(cf.net_change).toBe(300n);
    expect(cf.reconciles).toBe(true);
  });

  it("bank-to-bank transfers do not move cash; opening-balance journals are opening cash", () => {
    const lines = [
      line({ ...bank, debit_minor: 50n, journal_id: "t" }),
      line({
        account_id: "bank2",
        account_type: "asset",
        account_kind: "bank",
        credit_minor: 50n,
        journal_id: "t",
      }),
      line({ ...bank, debit_minor: 900n, journal_id: "o", source_type: "opening_balance" }),
      line({
        account_id: "obe",
        account_type: "equity",
        credit_minor: 900n,
        journal_id: "o",
        source_type: "opening_balance",
      }),
    ];
    const cf = buildCashFlowFromBank(lines, {
      from: "2026-01-01",
      to: "2026-12-31",
      bankAccountIds: ["bank", "bank2"],
    });
    expect(cf.net_change).toBe(0n);
    expect(cf.opening_cash).toBe(900n);
  });

  it("classifier covers inventory, prepayments, income, expense, equity", () => {
    expect(
      classifyCashCounterpart({ account_type: "asset", account_kind: "inventory" }).section,
    ).toBe("operating");
    expect(
      classifyCashCounterpart({ account_type: "asset", account_kind: "prepayment" }).section,
    ).toBe("operating");
    expect(
      classifyCashCounterpart({ account_type: "asset", account_subtype: "non_current_asset" })
        .section,
    ).toBe("investing");
    expect(classifyCashCounterpart({ account_type: "equity" }).section).toBe("financing");
    expect(classifyCashCounterpart({ account_type: "expense" }).section).toBe("operating");
  });
});

describe("RP-07 one decimal-aware converter across every report path", () => {
  // GBP base. USD invoice 100.00 @0.80 ; JPY expense 1000 @0.0065 GBP/JPY = £6.50
  const base = "GBP";
  const lines: PostedLine[] = [
    line({
      account_id: "ar",
      account_type: "asset",
      system_key: "ar",
      debit_minor: 10_000n,
      currency_code: "USD",
      base_currency: base,
      fx_rate_to_base: "0.80",
      journal_id: "u",
      journal_date: "2026-02-01",
    }),
    line({
      account_id: "sales",
      account_type: "income",
      credit_minor: 10_000n,
      currency_code: "USD",
      base_currency: base,
      fx_rate_to_base: "0.80",
      journal_id: "u",
      journal_date: "2026-02-01",
    }),
    line({
      account_id: "fees",
      account_type: "expense",
      debit_minor: 1000n,
      currency_code: "JPY",
      base_currency: base,
      fx_rate_to_base: "0.0065",
      journal_id: "y",
      journal_date: "2026-02-02",
    }),
    line({
      account_id: "cash",
      account_type: "asset",
      account_kind: "bank",
      credit_minor: 1000n,
      currency_code: "JPY",
      base_currency: base,
      fx_rate_to_base: "0.0065",
      journal_id: "y",
      journal_date: "2026-02-02",
    }),
  ];

  it("trial balance, P&L and balance sheet agree", () => {
    const tb = buildTrialBalance(lines);
    expect(tb.rows.find((r) => r.account_id === "ar")?.debit_minor).toBe(8_000n);
    expect(tb.rows.find((r) => r.account_id === "fees")?.debit_minor).toBe(650n); // JPY 0dp -> GBP 2dp
    expect(tb.balances).toBe(true);
    const pl = buildProfitAndLoss(lines, { from: "2026-01-01", to: "2026-12-31" });
    expect(pl.net).toBe(8_000n - 650n);
    const bs = buildBalanceSheet(lines, { asOf: "2026-12-31" });
    expect(bs.equationHolds).toBe(true);
  });

  it("account transactions, control balance and tax summary use the same base amounts", () => {
    const acct = buildAccountTransactions(lines, {
      accountId: "ar",
      from: "2026-01-01",
      to: "2026-12-31",
    });
    expect(acct.rows[0]?.debit_minor).toBe(8_000n);
    expect(acct.closing_balance_minor).toBe(8_000n);
    const tax = buildTaxSummary(
      [
        line({
          account_id: "vat",
          account_type: "liability",
          credit_minor: 2_000n,
          currency_code: "USD",
          base_currency: base,
          fx_rate_to_base: "0.80",
        }),
      ],
      { from: "2026-01-01", to: "2026-12-31", taxAccountIds: ["vat"] },
    );
    expect(tax.output_credit_minor).toBe(1_600n);
  });

  it("cash flow converts the bank and counterpart lines", () => {
    const cf = buildCashFlowFromBank(lines, {
      from: "2026-01-01",
      to: "2026-12-31",
      bankAccountIds: ["cash"],
    });
    expect(cf.operating).toBe(-650n);
    expect(cf.closing_cash_ledger).toBe(-650n);
    expect(cf.reconciles).toBe(true);
  });
});

describe("RP-12 control accounts are found by role, not code", () => {
  const chart = [
    { id: "1", code: "A100", account_type: "asset", system_key: "ar", is_active: true },
    {
      id: "2",
      code: "B200",
      account_type: "liability",
      account_kind: "accounts_payable",
      is_active: true,
    },
    {
      id: "3",
      code: "1000",
      account_type: "asset",
      account_kind: "current_asset",
      is_active: true,
    },
    { id: "4", code: "VAT1", account_type: "liability", system_key: "tax", is_active: true },
    { id: "5", code: "1100", account_type: "asset", is_active: true },
  ];
  it("prefers system_key over a legacy code", () => {
    expect(findControlAccountIds(chart, "ar")).toEqual(["1"]);
  });
  it("falls back to account_kind, then code only when nothing is keyed", () => {
    expect(findControlAccountIds(chart, "ap")).toEqual(["2"]);
    expect(findControlAccountIds(chart, "bank")).toEqual(["3"]);
    expect(
      findControlAccountIds(
        [{ id: "9", code: "2000", account_type: "liability", is_active: true }],
        "ap",
      ),
    ).toEqual(["9"]);
  });
  it("tax settings win, then keyed accounts", () => {
    expect(
      resolveTaxAccountIds(chart, { output_tax_account_id: "x", input_tax_account_id: null }),
    ).toEqual(["x"]);
    expect(resolveTaxAccountIds(chart, null)).toEqual(["4"]);
  });
  it("ignores inactive accounts", () => {
    expect(
      findControlAccountIds(
        [{ id: "1", code: "1100", account_type: "asset", system_key: "ar", is_active: false }],
        "ar",
      ),
    ).toEqual([]);
  });
});
