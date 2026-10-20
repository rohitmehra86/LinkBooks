import { describe, expect, it } from "vitest";
import {
  accountBalanceAsOf,
  ageBucket,
  buildAccountTransactions,
  buildAgingReport,
  buildBalanceSheet,
  buildCashFlowFromBank,
  buildJournalReport,
  buildTaxSummary,
  buildTrialBalance,
  type PostedLine,
} from "./reporting";

const bank = "bank";
const ar = "ar";
const revenue = "rev";
const tax = "tax";
const expense = "exp";

/**
 * Golden fixture:
 * 2026-01-10: Invoice — DR AR 1200, CR Revenue 1000, CR Tax 200
 * 2026-01-20: Receipt — DR Bank 800, CR AR 800  (partial)
 * 2026-02-05: Expense — DR Expense 300, CR Bank 300
 * Void/reversal pair on 2026-02-10: reverse expense (DR Bank 300, CR Expense 300)
 */
const fixture: PostedLine[] = [
  {
    account_id: ar,
    account_code: "1100",
    account_name: "AR",
    account_type: "asset",
    journal_date: "2026-01-10",
    journal_id: "j1",
    journal_number: 1,
    debit_minor: 1200n,
    credit_minor: 0n,
  },
  {
    account_id: revenue,
    account_code: "4000",
    account_name: "Sales",
    account_type: "income",
    journal_date: "2026-01-10",
    journal_id: "j1",
    journal_number: 1,
    debit_minor: 0n,
    credit_minor: 1000n,
  },
  {
    account_id: tax,
    account_code: "2100",
    account_name: "Tax Payable",
    account_type: "liability",
    journal_date: "2026-01-10",
    journal_id: "j1",
    journal_number: 1,
    debit_minor: 0n,
    credit_minor: 200n,
  },
  {
    account_id: bank,
    account_code: "1000",
    account_name: "Bank",
    account_type: "asset",
    journal_date: "2026-01-20",
    journal_id: "j2",
    journal_number: 2,
    debit_minor: 800n,
    credit_minor: 0n,
  },
  {
    account_id: ar,
    account_code: "1100",
    account_name: "AR",
    account_type: "asset",
    journal_date: "2026-01-20",
    journal_id: "j2",
    journal_number: 2,
    debit_minor: 0n,
    credit_minor: 800n,
  },
  {
    account_id: expense,
    account_code: "6000",
    account_name: "Opex",
    account_type: "expense",
    journal_date: "2026-02-05",
    journal_id: "j3",
    journal_number: 3,
    debit_minor: 300n,
    credit_minor: 0n,
  },
  {
    account_id: bank,
    account_code: "1000",
    account_name: "Bank",
    account_type: "asset",
    journal_date: "2026-02-05",
    journal_id: "j3",
    journal_number: 3,
    debit_minor: 0n,
    credit_minor: 300n,
  },
  // reversal of j3
  {
    account_id: bank,
    account_code: "1000",
    account_name: "Bank",
    account_type: "asset",
    journal_date: "2026-02-10",
    journal_id: "j4",
    journal_number: 4,
    debit_minor: 300n,
    credit_minor: 0n,
  },
  {
    account_id: expense,
    account_code: "6000",
    account_name: "Opex",
    account_type: "expense",
    journal_date: "2026-02-10",
    journal_id: "j4",
    journal_number: 4,
    debit_minor: 0n,
    credit_minor: 300n,
  },
];

describe("golden TB / BS / equation", () => {
  it("TB balances and BS equation holds after reversals", () => {
    const tb = buildTrialBalance(fixture, { to: "2026-12-31" });
    expect(tb.balances).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
    // Net: AR 400, Bank 800, Tax 200 credit, Revenue 1000 credit; expense nets to 0
    const bs = buildBalanceSheet(fixture, { asOf: "2026-12-31" });
    expect(bs.equationHolds).toBe(true);
    expect(bs.assets).toBe(bs.liabilities + bs.equity);
  });

  it("date boundary excludes later journals from TB from/to", () => {
    const jan = buildTrialBalance(fixture, { from: "2026-01-01", to: "2026-01-31" });
    expect(jan.balances).toBe(true);
    // Jan only: AR net 400, Bank 800, Rev 1000, Tax 200 → TB presents 1200/1200
    expect(jan.totalDebit).toBe(1200n);
  });
});

describe("account transactions opening balance", () => {
  it("carries opening into period and running balance", () => {
    const txn = buildAccountTransactions(fixture, {
      accountId: bank,
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(txn.opening_balance_minor).toBe(800n);
    expect(txn.closing_balance_minor).toBe(800n); // -300 +300
    expect(txn.rows).toHaveLength(2);
  });
});

describe("aging", () => {
  it("buckets by days past due and totals", () => {
    expect(ageBucket("2026-03-01", "2026-03-01")).toBe("current");
    expect(ageBucket("2026-02-01", "2026-03-15")).toBe("31_60");
    const aged = buildAgingReport(
      [
        {
          id: "1",
          contact_id: "c1",
          contact_name: "Acme",
          doc_date: "2026-01-01",
          due_date: "2026-01-01",
          reference: "INV-1",
          outstanding_minor: 400n,
        },
        {
          id: "2",
          contact_id: "c1",
          contact_name: "Acme",
          doc_date: "2026-03-01",
          due_date: "2026-03-20",
          reference: "INV-2",
          outstanding_minor: 100n,
        },
      ],
      { asOf: "2026-03-15" },
    );
    expect(aged.total).toBe(500n);
    // 2026-01-01 → 2026-03-15 ≈ 73 days → 61_90 bucket
    expect(aged.byBucket["61_90"]).toBe(400n);
    expect(aged.byBucket.current).toBe(100n);
  });
});

describe("tax summary", () => {
  it("sums tax control credits and debits in period", () => {
    const taxR = buildTaxSummary(fixture, {
      from: "2026-01-01",
      to: "2026-01-31",
      taxAccountIds: [tax],
    });
    expect(taxR.output_credit_minor).toBe(200n);
    expect(taxR.input_debit_minor).toBe(0n);
    expect(taxR.net_payable_minor).toBe(200n);
  });
});

describe("cash flow bank proxy", () => {
  it("nets bank movements and opening cash", () => {
    const cf = buildCashFlowFromBank(fixture, {
      from: "2026-01-01",
      to: "2026-01-31",
      bankAccountIds: [bank],
    });
    expect(cf.opening_cash).toBe(0n);
    expect(cf.closing_cash).toBe(800n);
    expect(cf.closing_cash_ledger).toBe(800n);
    expect(cf.reconciles).toBe(true);
    expect(cf.net_change).toBe(800n);
  });

  it("treats opening_balance journals as opening cash, not period inflow", () => {
    const withOpening = [
      {
        account_id: bank,
        account_code: "1000",
        account_name: "Bank",
        account_type: "asset" as const,
        journal_date: "2026-01-01",
        journal_id: "j-open",
        source_type: "opening_balance",
        debit_minor: 50_000n,
        credit_minor: 0n,
      },
      {
        account_id: "eq",
        account_code: "3100",
        account_name: "Opening equity",
        account_type: "equity" as const,
        journal_date: "2026-01-01",
        journal_id: "j-open",
        source_type: "opening_balance",
        debit_minor: 0n,
        credit_minor: 50_000n,
      },
      {
        account_id: bank,
        account_code: "1000",
        account_name: "Bank",
        account_type: "asset" as const,
        journal_date: "2026-01-15",
        journal_id: "j-sale",
        source_type: "customer_payment",
        debit_minor: 1_000n,
        credit_minor: 0n,
      },
      {
        account_id: ar,
        account_code: "1100",
        account_name: "AR",
        account_type: "asset" as const,
        journal_date: "2026-01-15",
        journal_id: "j-sale",
        source_type: "customer_payment",
        debit_minor: 0n,
        credit_minor: 1_000n,
      },
    ];
    const cf = buildCashFlowFromBank(withOpening, {
      from: "2026-01-01",
      to: "2026-01-31",
      bankAccountIds: [bank],
    });
    expect(cf.opening_cash).toBe(50_000n);
    expect(cf.net_change).toBe(1_000n);
    expect(cf.closing_cash).toBe(51_000n);
    expect(cf.closing_cash_ledger).toBe(51_000n);
    expect(cf.reconciles).toBe(true);
  });
});

describe("journal report + control balance", () => {
  it("filters journals and balances AR control", () => {
    const jr = buildJournalReport(
      [
        {
          id: "j1",
          journal_number: 1,
          journal_date: "2026-01-10",
          status: "posted",
          source_type: "sales_invoice",
          memo: "Inv",
          lines: [
            { debit_minor: 1200, credit_minor: 0 },
            { debit_minor: 0, credit_minor: 1000 },
            { debit_minor: 0, credit_minor: 200 },
          ],
        },
        {
          id: "jX",
          journal_number: 9,
          journal_date: "2026-03-01",
          status: "draft",
          source_type: "manual",
          memo: null,
          lines: [
            { debit_minor: 1, credit_minor: 0 },
            { debit_minor: 0, credit_minor: 1 },
          ],
        },
      ],
      { from: "2026-01-01", to: "2026-01-31", status: "posted" },
    );
    expect(jr).toHaveLength(1);
    expect(jr[0]!.total_debit_minor).toBe(1200n);

    // AR after partial payment
    expect(accountBalanceAsOf(fixture, ar, "2026-01-31")).toBe(400n);
  });
});

describe("org isolation of pure functions", () => {
  it("does not mix lines from different account sets when filtered", () => {
    const other: PostedLine = {
      account_id: "other-bank",
      account_code: "1000",
      account_name: "Other",
      account_type: "asset",
      journal_date: "2026-01-15",
      debit_minor: 99999n,
      credit_minor: 0n,
    };
    const tb = buildTrialBalance([...fixture, other], { to: "2026-12-31" });
    // Still balances only if we add balancing credit — without it TB won't balance
    expect(tb.balances).toBe(false);
  });
});
