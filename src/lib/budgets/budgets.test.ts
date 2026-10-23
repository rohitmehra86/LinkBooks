import { describe, expect, it } from "vitest";
import {
  applyUpliftBps,
  buildBudgetColumns,
  computeVariance,
  fillRight,
  fiscalMonthStarts,
  naturalActual,
  roundDiv,
  spreadEvenly,
} from "@/lib/budgets/budget-math";
import { buildBudgetVsActual } from "@/lib/budgets/budget-report";
import {
  budgetCsvHeaders,
  budgetToCsvRows,
  parseAmountCell,
  parseBudgetCsv,
} from "@/lib/budgets/budget-csv";
import { toCsv } from "@/lib/reports/csv";

describe("fiscalMonthStarts", () => {
  it("lists twelve month starts from the fiscal year start", () => {
    const m = fiscalMonthStarts("2026-04-01");
    expect(m).toHaveLength(12);
    expect(m[0]).toBe("2026-04-01");
    expect(m[8]).toBe("2026-12-01");
    expect(m[11]).toBe("2027-03-01");
  });
  it("normalises a mid-month date to the month start", () => {
    expect(fiscalMonthStarts("2026-01-15")[0]).toBe("2026-01-01");
  });
});

describe("rounding helpers", () => {
  it("roundDiv rounds half away from zero", () => {
    expect(roundDiv(5n, 2n)).toBe(3n);
    expect(roundDiv(-5n, 2n)).toBe(-3n);
    expect(roundDiv(4n, 3n)).toBe(1n);
    expect(roundDiv(-4n, 3n)).toBe(-1n);
  });
  it("applies uplift in basis points", () => {
    expect(applyUpliftBps(100_000, 1000)).toBe(110_000);
    expect(applyUpliftBps(100_000, -500)).toBe(95_000);
    expect(applyUpliftBps(1_005, 1000)).toBe(1_106); // 1105.5 → 1106
    expect(applyUpliftBps(-1_005, 1000)).toBe(-1_106);
    expect(applyUpliftBps(0, 2500)).toBe(0);
  });
  it("rejects non-integer money", () => {
    expect(() => applyUpliftBps(10.5, 100)).toThrow();
  });
});

describe("fillRight and spreadEvenly", () => {
  it("copies the chosen month into later months only", () => {
    expect(fillRight([1, 2, 3, 4], 1)).toEqual([1, 2, 2, 2]);
    expect(fillRight([1, 2, 3], 9)).toEqual([1, 2, 3]);
  });
  it("puts the rounding remainder in the last month and conserves the total", () => {
    const s = spreadEvenly(100_000, 12);
    expect(s.reduce((a, b) => a + b, 0)).toBe(100_000);
    expect(s.slice(0, 11).every((x) => x === 8_333)).toBe(true);
    expect(s[11]).toBe(100_000 - 8_333 * 11);
    expect(spreadEvenly(10, 3)).toEqual([3, 3, 4]);
    expect(spreadEvenly(-10, 3)).toEqual([-3, -3, -4]);
  });
});

describe("variance", () => {
  it("income: above budget is favourable", () => {
    const v = computeVariance("income", 100_000, 120_000);
    expect(v.varianceMinor).toBe(20_000);
    expect(v.variancePctBps).toBe(2_000);
    expect(v.status).toBe("favourable");
  });
  it("income: below budget is unfavourable", () => {
    const v = computeVariance("income", 100_000, 90_000);
    expect(v.varianceMinor).toBe(-10_000);
    expect(v.variancePctBps).toBe(-1_000);
    expect(v.status).toBe("unfavourable");
  });
  it("expense: overspend is unfavourable, underspend favourable", () => {
    expect(computeVariance("expense", 50_000, 60_000)).toMatchObject({
      varianceMinor: -10_000,
      variancePctBps: -2_000,
      status: "unfavourable",
    });
    expect(computeVariance("expense", 50_000, 40_000)).toMatchObject({
      varianceMinor: 10_000,
      status: "favourable",
    });
  });
  it("has no percentage when the budget is zero", () => {
    const v = computeVariance("expense", 0, 5_000);
    expect(v.variancePctBps).toBeNull();
    expect(v.status).toBe("unfavourable");
    expect(computeVariance("income", 0, 0).status).toBe("on_budget");
  });
  it("naturalActual follows the account's normal side", () => {
    expect(naturalActual("income", 1_000, 5_000)).toBe(4_000);
    expect(naturalActual("expense", 5_000, 1_000)).toBe(4_000);
  });
});

describe("buildBudgetColumns", () => {
  const months = fiscalMonthStarts("2026-01-01");
  it("month view stops at the selected month and adds YTD", () => {
    const cols = buildBudgetColumns("month", months, "2026-03-20");
    expect(cols.map((c) => c.key)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01", "ytd"]);
    expect(cols[3]!.months).toHaveLength(3);
  });
  it("quarter view includes partial quarters only up to the selected month", () => {
    const cols = buildBudgetColumns("quarter", months, "2026-05-01");
    expect(cols.map((c) => c.key)).toEqual(["q1", "q2", "ytd"]);
    expect(cols[1]!.months).toEqual(["2026-04-01", "2026-05-01"]);
  });
  it("ytd view shows the current month and YTD", () => {
    const cols = buildBudgetColumns("ytd", months, "2026-06-30");
    expect(cols.map((c) => c.key)).toEqual(["current", "ytd"]);
    expect(cols[1]!.months).toHaveLength(6);
  });
  it("returns nothing when the year has not started", () => {
    expect(buildBudgetColumns("month", months, "2025-12-31")).toEqual([]);
  });
});

describe("buildBudgetVsActual", () => {
  const months = fiscalMonthStarts("2026-01-01");
  const accounts = [
    { id: "i1", code: "200", name: "Sales", kind: "income" as const },
    { id: "e1", code: "400", name: "Rent", kind: "expense" as const },
    { id: "e2", code: "410", name: "Unused", kind: "expense" as const },
  ];
  const columns = buildBudgetColumns("month", months, "2026-02-28");
  const report = buildBudgetVsActual({
    accounts,
    columns,
    budget: [
      { accountId: "i1", month: "2026-01-01", amountMinor: 100_000 },
      { accountId: "i1", month: "2026-02-01", amountMinor: 100_000 },
      { accountId: "e1", month: "2026-01-01", amountMinor: 30_000 },
      { accountId: "e1", month: "2026-02-01", amountMinor: 30_000 },
    ],
    actuals: [
      { accountId: "i1", month: "2026-01-01", debitMinor: 0, creditMinor: 110_000 },
      { accountId: "i1", month: "2026-02-01", debitMinor: 5_000, creditMinor: 85_000 },
      { accountId: "e1", month: "2026-01-01", debitMinor: 30_000, creditMinor: 0 },
      { accountId: "e1", month: "2026-02-01", debitMinor: 35_000, creditMinor: 0 },
    ],
  });
  it("omits accounts with neither budget nor actual", () => {
    expect(report.expense.rows.map((r) => r.code)).toEqual(["400"]);
  });
  it("computes YTD per account with the right direction", () => {
    const sales = report.income.rows[0]!.cells.at(-1)!;
    expect(sales.budgetMinor).toBe(200_000);
    expect(sales.actualMinor).toBe(190_000);
    expect(sales.status).toBe("unfavourable");
    const rent = report.expense.rows[0]!.cells.at(-1)!;
    expect(rent.actualMinor).toBe(65_000);
    expect(rent.varianceMinor).toBe(-5_000);
  });
  it("totals sections and net profit", () => {
    const ytd = report.columns.length - 1;
    expect(report.income.totals[ytd]!.actualMinor).toBe(190_000);
    expect(report.expense.totals[ytd]!.budgetMinor).toBe(60_000);
    const net = report.net[ytd]!;
    expect(net.budgetMinor).toBe(140_000);
    expect(net.actualMinor).toBe(125_000);
    expect(net.varianceMinor).toBe(-15_000);
    expect(net.status).toBe("unfavourable");
  });
});

describe("budget CSV", () => {
  const accounts = [
    { id: "a", code: "200", name: "Sales" },
    { id: "b", code: "400", name: "Rent, premises" },
  ];
  const months = fiscalMonthStarts("2026-01-01");
  it("round-trips through the shared report CSV writer", () => {
    const values = new Map<string, number[]>([
      ["a", [100_050, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 12_345]],
      ["b", Array.from({ length: 12 }, () => 30_000)],
    ]);
    const text = toCsv(
      { company: "Acme", report: "Budget", period: "FY2026", currency: "GBP" },
      budgetCsvHeaders(months),
      budgetToCsvRows(accounts, values, "GBP"),
    );
    const parsed = parseBudgetCsv(text, accounts, "GBP");
    expect(parsed.issues).toEqual([]);
    expect(parsed.values.get("a")).toEqual(values.get("a"));
    expect(parsed.values.get("b")).toEqual(values.get("b"));
  });
  it("reports unknown accounts, bad numbers and duplicates without applying anything silently", () => {
    const text = [
      "Account code,Account name,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec",
      "999,Nope,1,1,1,1,1,1,1,1,1,1,1,1",
      "200,Sales,abc,1,1,1,1,1,1,1,1,1,1,1",
      "400,Rent,1,1,1,1,1,1,1,1,1,1,1,1",
      "400,Rent,2,2,2,2,2,2,2,2,2,2,2,2",
    ].join("\n");
    const r = parseBudgetCsv(text, accounts, "GBP");
    expect(r.issues.map((i) => i.row)).toEqual([2, 3, 5]);
    expect(r.values.has("b")).toBe(true);
    expect(r.values.has("a")).toBe(false);
  });
  it("requires the header row", () => {
    expect(parseBudgetCsv("x,y\n1,2", accounts, "GBP").issues[0]!.message).toMatch(/Header/);
  });
  it("parses brackets, commas and blanks", () => {
    expect(parseAmountCell("(1,234.50)", "GBP")).toBe(-123_450);
    expect(parseAmountCell("", "GBP")).toBe(0);
    expect(parseAmountCell("1000", "JPY")).toBe(1000);
    expect(() => parseAmountCell("1e5", "GBP")).toThrow();
  });
});
