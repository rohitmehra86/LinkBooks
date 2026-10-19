import { describe, expect, it } from "vitest";
import {
  buildBalanceSheet,
  buildGeneralLedger,
  buildProfitAndLoss,
  buildTrialBalance,
} from "@/lib/accounting/reporting";
import { assertLinesBalance } from "@/lib/accounting/money";
import { roleHasPermission } from "@/lib/permissions";
import {
  buildDemoPostedLines,
  computeDemoReportTotals,
  DEMO_EXPECTED,
  DEMO_JOURNAL_SPECS,
  DEMO_MODULE_STATUS,
  DEMO_AS_OF,
  DEMO_FY_FROM,
} from "./demo-dataset";

describe("Demo Company canonical dataset", () => {
  it("every journal spec balances in minor units", () => {
    for (const spec of DEMO_JOURNAL_SPECS) {
      expect(() =>
        assertLinesBalance(
          spec.lines.map((l) => ({
            account_id: l.code,
            debit_minor: l.debit,
            credit_minor: l.credit,
          })),
        ),
      ).not.toThrow();
    }
  });

  it("trial balance balances and matches known totals", () => {
    const lines = buildDemoPostedLines();
    const tb = buildTrialBalance(lines, { to: DEMO_AS_OF });
    expect(tb.balances).toBe(true);
    expect(tb.totalDebit).toBe(DEMO_EXPECTED.trialBalanceDebit);
    expect(tb.totalCredit).toBe(DEMO_EXPECTED.trialBalanceCredit);
  });

  it("P&L matches known income, expense and net", () => {
    const lines = buildDemoPostedLines();
    const pl = buildProfitAndLoss(lines, { from: DEMO_FY_FROM, to: DEMO_AS_OF });
    expect(pl.income).toBe(DEMO_EXPECTED.income);
    expect(pl.expense).toBe(DEMO_EXPECTED.expense);
    expect(pl.net).toBe(DEMO_EXPECTED.netProfit);
  });

  it("balance sheet equation holds and matches known assets/equity", () => {
    const lines = buildDemoPostedLines();
    const bs = buildBalanceSheet(lines, { asOf: DEMO_AS_OF });
    expect(bs.equationHolds).toBe(true);
    expect(bs.assets).toBe(DEMO_EXPECTED.assets);
    expect(bs.liabilities).toBe(DEMO_EXPECTED.liabilities);
    expect(bs.equity).toBe(DEMO_EXPECTED.equity);
  });

  it("control accounts match expected bank, AR, AP, tax", () => {
    const t = computeDemoReportTotals();
    expect(t.bank).toBe(DEMO_EXPECTED.bank);
    expect(t.ar).toBe(DEMO_EXPECTED.ar);
    expect(t.ap).toBe(DEMO_EXPECTED.ap);
    expect(t.taxPayable).toBe(DEMO_EXPECTED.taxPayable);
    expect(t.vatRecoverable).toBe(DEMO_EXPECTED.vatRecoverable);
  });

  it("general ledger for bank is non-empty and nets to expected bank", () => {
    const lines = buildDemoPostedLines();
    const bankId = "acct-1000";
    const gl = buildGeneralLedger(lines, { accountId: bankId, to: DEMO_AS_OF });
    expect(gl.length).toBeGreaterThan(0);
    const net = gl.reduce(
      (n, l) => n + BigInt(l.debit_minor) - BigInt(l.credit_minor),
      0n,
    );
    expect(net).toBe(DEMO_EXPECTED.bank);
  });

  it("receivables and payables nets reconcile to control accounts", () => {
    const t = computeDemoReportTotals();
    // Open AR after paid invoice + open invoice − credit
    expect(t.ar).toBe(480_000n);
    // Open AP = COS on account only
    expect(t.ap).toBe(75_000n);
  });
});

describe("Demo isolation & safe reseeding contracts", () => {
  it("only owner/admin may demo.reset", () => {
    expect(roleHasPermission("owner", "demo.reset")).toBe(true);
    expect(roleHasPermission("admin", "demo.reset")).toBe(true);
    expect(roleHasPermission("accountant", "demo.reset")).toBe(false);
    expect(roleHasPermission("bookkeeper", "demo.reset")).toBe(false);
    expect(roleHasPermission("read_only", "demo.reset")).toBe(false);
  });

  it("is_demo does not appear in posting permission matrix (engine parity)", () => {
    expect(roleHasPermission.toString()).not.toMatch(/is_demo/);
  });

  it("seed helper refuses non-demo companies (code contract)", async () => {
    const { seedDemoCompanyData } = await import("./seed-demo");
    const fake = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { id: "x", is_demo: false }, error: null }),
          }),
        }),
      }),
    };
    await expect(
      seedDemoCompanyData(fake as never, {
        companyId: "11111111-1111-4111-8111-111111111111",
        userId: "22222222-2222-4222-8222-222222222222",
      }),
    ).rejects.toThrow(/not a demo company/i);
  });
});

describe("Demo module honesty", () => {
  it("labels unfinished modules as shell/partial", () => {
    const products = DEMO_MODULE_STATUS.find((m) => m.path === "/products-services");
    const help = DEMO_MODULE_STATUS.find((m) => m.path === "/help");
    expect(products?.status).toBe("shell");
    expect(help?.status).toBe("shell");
    expect(DEMO_MODULE_STATUS.some((m) => m.status === "ready" && m.path === "/reports")).toBe(
      true,
    );
  });

  it("dataset covers sales, purchases, bank, journals sources", () => {
    const sources = new Set(DEMO_JOURNAL_SPECS.map((j) => j.source_type));
    expect(sources.has("sales_invoice")).toBe(true);
    expect(sources.has("customer_payment")).toBe(true);
    expect(sources.has("purchase_bill")).toBe(true);
    expect(sources.has("supplier_payment")).toBe(true);
    expect(sources.has("expense")).toBe(true);
    expect(sources.has("sales_credit_note")).toBe(true);
    expect(sources.has("opening_balance")).toBe(true);
    expect(sources.has("bank_transaction")).toBe(true);
  });
});
