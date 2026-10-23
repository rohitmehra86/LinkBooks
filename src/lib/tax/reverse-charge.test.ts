import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertLinesBalance } from "@/lib/accounting/money";
import {
  isSelfAssessedReverseCharge,
  planReverseCharge,
  reverseChargeTaxMinor,
} from "./reverse-charge";
import { computeReturnTotals, summariseByTreatment, type TaxFact } from "./vat-return";
import { applyReverseChargeToLines } from "@/lib/purchases/reverse-charge-lines";

const posted = vi.hoisted(() => ({ input: null as null | { lines: unknown[] } }));

vi.mock("@/lib/accounting/posting-engine", () => ({
  postJournal: vi.fn(async (_sb: unknown, input: { lines: unknown[] }) => {
    posted.input = input;
    return { journalId: "j1" };
  }),
  reverseJournal: vi.fn(),
}));
vi.mock("@/lib/purchases/accounts", () => ({
  requireAccountByCode: vi.fn(async () => ({ id: "ap", code: "2000" })),
  requireApControlAccount: vi.fn(async () => ({ id: "ap", code: "2000" })),
}));
vi.mock("@/lib/tax/tax-accounts", () => ({
  resolveInputTaxAccount: vi.fn(async () => ({ id: "vat-in", source: "mapping" })),
  resolveOutputTaxAccount: vi.fn(async () => ({ id: "vat-out", source: "mapping" })),
}));

import { postBillAuthorisation } from "@/lib/purchases/posting";

describe("reverseChargeTaxMinor", () => {
  it("rounds half away from zero once", () => {
    expect(reverseChargeTaxMinor(10000n, 2000)).toBe(2000n);
    expect(reverseChargeTaxMinor(1n, 5000)).toBe(1n); // 0.5 rounds up
    expect(reverseChargeTaxMinor(999n, 2000)).toBe(200n); // 199.8
    expect(reverseChargeTaxMinor(0n, 2000)).toBe(0n);
    expect(reverseChargeTaxMinor(5000n, 0)).toBe(0n);
  });
  it("rejects a bad rate", () => {
    expect(() => reverseChargeTaxMinor(100n, -1)).toThrow();
    expect(() => reverseChargeTaxMinor(100n, 10001)).toThrow();
    expect(() => reverseChargeTaxMinor(100n, 12.5)).toThrow();
  });
});

describe("isSelfAssessedReverseCharge", () => {
  it("needs the code and zero stored tax", () => {
    expect(isSelfAssessedReverseCharge("reverse_charge", 0n)).toBe(true);
    expect(isSelfAssessedReverseCharge("reverse_charge", 100n)).toBe(false);
    expect(isSelfAssessedReverseCharge("standard", 0n)).toBe(false);
    expect(isSelfAssessedReverseCharge(null, 0n)).toBe(false);
  });
});

describe("planReverseCharge", () => {
  it("splits recoverable and non-recoverable tax and stays balanced", () => {
    const plan = planReverseCharge([
      {
        netMinor: 10000n,
        rateBps: 2000,
        treatment: "reverse_charge",
        storedTaxMinor: 0n,
        recoverable: true,
      },
      {
        netMinor: 5000n,
        rateBps: 2000,
        treatment: "reverse_charge",
        storedTaxMinor: 0n,
        recoverable: false,
      },
      {
        netMinor: 7000n,
        rateBps: 2000,
        treatment: "standard",
        storedTaxMinor: 1400n,
        recoverable: true,
      },
      {
        netMinor: 3000n,
        rateBps: 2000,
        treatment: "reverse_charge",
        storedTaxMinor: 600n,
        recoverable: true,
      },
    ]);
    expect(plan.perLine).toEqual([2000n, 1000n, 0n, 0n]);
    expect(plan.expenseUplift).toEqual([0n, 1000n, 0n, 0n]);
    expect(plan.inputDebit).toBe(2000n);
    expect(plan.outputCredit).toBe(3000n);
    expect(plan.inputDebit + plan.expenseUplift.reduce((a, b) => a + b, 0n)).toBe(
      plan.outputCredit,
    );
  });
  it("does nothing for ordinary bills", () => {
    const plan = planReverseCharge([
      { netMinor: 100n, rateBps: 2000, treatment: null, storedTaxMinor: 20n, recoverable: true },
    ]);
    expect(plan.outputCredit).toBe(0n);
    expect(plan.inputDebit).toBe(0n);
  });
});

describe("return totals with reverse charge", () => {
  const rc = (net: number, tax: number, over: Partial<TaxFact> = {}): TaxFact => ({
    side: "purchases",
    sign: 1,
    treatment: "reverse_charge",
    recoverable: true,
    netBase: BigInt(net),
    taxBase: BigInt(tax),
    coded: true,
    selfAssessed: true,
    ...over,
  });
  const sale = (net: number, tax: number): TaxFact => ({
    side: "sales",
    sign: 1,
    treatment: "standard",
    recoverable: true,
    netBase: BigInt(net),
    taxBase: BigInt(tax),
    coded: true,
  });

  it("counts the tax in both box 1 and box 4 and nets to zero", () => {
    const t = computeReturnTotals([rc(10000, 2000)]);
    expect(t.outputTax).toBe(2000n);
    expect(t.inputTax).toBe(2000n);
    expect(t.netTax).toBe(0n);
    expect(t.purchasesNet).toBe(10000n);
    expect(t.counts.selfAssessed).toBe(1);
    expect(t.counts.reverseCharge).toBe(1);
  });

  it("combines with ordinary sales", () => {
    const t = computeReturnTotals([sale(50000, 10000), rc(10000, 2000)]);
    expect(t.outputTax).toBe(12000n);
    expect(t.inputTax).toBe(2000n);
    expect(t.netTax).toBe(10000n);
  });

  it("non-recoverable reverse charge is output tax and a cost", () => {
    const t = computeReturnTotals([rc(10000, 2000, { recoverable: false })]);
    expect(t.outputTax).toBe(2000n);
    expect(t.inputTax).toBe(0n);
    expect(t.nonRecoverableTax).toBe(2000n);
    expect(t.netTax).toBe(2000n);
  });

  it("a supplier credit note reduces both sides", () => {
    const t = computeReturnTotals([rc(10000, 2000), rc(2000, 400, { sign: -1 })]);
    expect(t.outputTax).toBe(1600n);
    expect(t.inputTax).toBe(1600n);
  });

  it("legacy reverse-charge lines (tax already charged) stay input-only", () => {
    const t = computeReturnTotals([rc(10000, 2000, { selfAssessed: false })]);
    expect(t.outputTax).toBe(0n);
    expect(t.inputTax).toBe(2000n);
    expect(t.counts.selfAssessed).toBe(0);
  });

  it("summarises by side and treatment", () => {
    const rows = summariseByTreatment([sale(100, 20), sale(50, 10), rc(100, 20)]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      side: "sales",
      treatment: "standard",
      netBase: 150n,
      taxBase: 30n,
      lines: 2,
    });
    expect(rows[1]).toMatchObject({
      side: "purchases",
      treatment: "reverse_charge",
      selfAssessed: true,
    });
  });
});

describe("applyReverseChargeToLines", () => {
  const line = (taxCodeId: string | null, mode: "exclusive" | "inclusive" = "exclusive") => ({
    quantity: 1,
    unitPriceMinor: 12000,
    discountMinor: 0,
    taxRateBps: 2000,
    taxCodeId,
    net_minor: mode === "inclusive" ? 10000n : 12000n,
    tax_minor: mode === "inclusive" ? 2000n : 2400n,
    gross_minor: mode === "inclusive" ? 12000n : 14400n,
  });
  const codes = new Map([
    ["rc", { treatment: "reverse_charge", recoverable: true }],
    ["std", { treatment: "standard", recoverable: true }],
  ]);

  it("zeroes supplier tax but keeps the rate (exclusive)", () => {
    const [l] = applyReverseChargeToLines([line("rc")], codes, "exclusive");
    expect(l).toMatchObject({
      net_minor: 12000n,
      tax_minor: 0n,
      gross_minor: 12000n,
      taxRateBps: 2000,
    });
  });
  it("does not split an inclusive price", () => {
    const [l] = applyReverseChargeToLines([line("rc", "inclusive")], codes, "inclusive");
    expect(l).toMatchObject({ net_minor: 12000n, tax_minor: 0n });
  });
  it("leaves other codes and uncoded lines alone", () => {
    const input = [line("std"), line(null)];
    expect(applyReverseChargeToLines(input, codes, "exclusive")).toEqual(input);
  });
});

describe("postBillAuthorisation with reverse charge", () => {
  beforeEach(() => {
    posted.input = null;
  });

  it("posts input and output tax, AP stays at the net amount, journal balances", async () => {
    await postBillAuthorisation({} as never, {
      company_id: "c",
      bill_id: "b",
      bill_date: "2026-10-01",
      currency_code: "GBP",
      lines: [
        {
          account_id: "exp",
          description: "Software",
          net_minor: 10000,
          tax_minor: 0,
          tax_rate_bps: 2000,
          tax_treatment: "reverse_charge",
          tax_recoverable: true,
        },
      ],
    });
    const lines = posted.input!.lines as Array<{
      account_id: string;
      debit_minor: bigint;
      credit_minor: bigint;
    }>;
    assertLinesBalance(lines as never);
    const by = (id: string) => lines.filter((l) => l.account_id === id);
    expect(by("exp")[0]!.debit_minor).toBe(10000n);
    expect(by("ap")[0]!.credit_minor).toBe(10000n);
    expect(by("vat-in")[0]!.debit_minor).toBe(2000n);
    expect(by("vat-out")[0]!.credit_minor).toBe(2000n);
  });

  it("non-recoverable reverse charge adds the tax to the expense line", async () => {
    await postBillAuthorisation({} as never, {
      company_id: "c",
      bill_id: "b",
      bill_date: "2026-10-01",
      currency_code: "GBP",
      lines: [
        {
          account_id: "exp",
          description: "Entertainment",
          net_minor: 10000,
          tax_minor: 0,
          tax_rate_bps: 2000,
          tax_treatment: "reverse_charge",
          tax_recoverable: false,
        },
      ],
    });
    const lines = posted.input!.lines as Array<{
      account_id: string;
      debit_minor: bigint;
      credit_minor: bigint;
    }>;
    assertLinesBalance(lines as never);
    expect(lines.find((l) => l.account_id === "exp")!.debit_minor).toBe(12000n);
    expect(lines.find((l) => l.account_id === "vat-out")!.credit_minor).toBe(2000n);
    expect(lines.some((l) => l.account_id === "vat-in")).toBe(false);
  });

  it("ordinary bills post exactly as before", async () => {
    await postBillAuthorisation({} as never, {
      company_id: "c",
      bill_id: "b",
      bill_date: "2026-10-01",
      currency_code: "GBP",
      lines: [{ account_id: "exp", description: "Stationery", net_minor: 1000, tax_minor: 200 }],
    });
    const lines = posted.input!.lines as Array<{ account_id: string }>;
    expect(lines.map((l) => l.account_id)).toEqual(["exp", "vat-in", "ap"]);
  });
});
