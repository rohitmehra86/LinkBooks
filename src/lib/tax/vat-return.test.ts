import { describe, expect, it } from "vitest";
import {
  buildReturnLines,
  buildTaxReturnSettlementJournal,
  computeReturnTotals,
  filingAmountMinor,
  scaleByFraction,
  type TaxFact,
} from "./vat-return";

const sale = (net: number, tax: number, over: Partial<TaxFact> = {}): TaxFact => ({
  side: "sales",
  sign: 1,
  treatment: "standard",
  recoverable: true,
  netBase: BigInt(net),
  taxBase: BigInt(tax),
  coded: true,
  ...over,
});
const purchase = (net: number, tax: number, over: Partial<TaxFact> = {}): TaxFact => ({
  ...sale(net, tax, { side: "purchases" }),
  ...over,
});

describe("VAT return totals", () => {
  it("totals boxes 1, 4, 5, 6 and 7 from document lines", () => {
    const t = computeReturnTotals([
      sale(100000, 20000), // standard
      sale(50000, 0, { treatment: "zero_rated" }), // box 6 only
      sale(30000, 0, { treatment: "exempt" }), // box 6 only
      sale(99999, 0, { treatment: "outside_scope" }), // nowhere
      purchase(40000, 8000), // reclaimable
      purchase(10000, 2000, { recoverable: false }), // cost, not box 4
    ]);
    expect(t.outputTax).toBe(20000n);
    expect(t.inputTax).toBe(8000n);
    expect(t.netTax).toBe(12000n);
    expect(t.salesNet).toBe(180000n);
    expect(t.purchasesNet).toBe(50000n);
    expect(t.nonRecoverableTax).toBe(2000n);
    expect(t.counts.outOfScope).toBe(1);
  });

  it("credit notes reduce the boxes and a net refund is negative", () => {
    const t = computeReturnTotals([
      sale(10000, 2000),
      sale(10000, 2000, { sign: -1 }),
      purchase(50000, 10000),
    ]);
    expect(t.outputTax).toBe(0n);
    expect(t.salesNet).toBe(0n);
    expect(t.netTax).toBe(-10000n);
  });

  it("counts uncoded and reverse-charge lines for the warnings", () => {
    const t = computeReturnTotals([
      sale(100, 20, { coded: false, treatment: null }),
      purchase(100, 0, { treatment: "reverse_charge" }),
    ]);
    expect(t.counts).toMatchObject({ lines: 2, uncoded: 1, reverseCharge: 1 });
  });

  it("is empty-safe", () => {
    const t = computeReturnTotals([]);
    expect(t.netTax).toBe(0n);
    expect(t.counts.lines).toBe(0);
  });
});

describe("return lines and labels", () => {
  const totals = computeReturnTotals([sale(100000, 20000), purchase(40000, 8000)]);

  it("uses the UK VAT100 labels for GB and keeps box 3 = box 1 + box 2", () => {
    const lines = buildReturnLines(totals, "GB");
    const byKey = Object.fromEntries(lines.map((l) => [l.box_key, l]));
    expect(byKey["box1"]?.label).toMatch(/VAT due in this period on sales/);
    expect(byKey["box3"]?.amount_minor).toBe(20000);
    expect(byKey["box4"]?.amount_minor).toBe(8000);
    expect(byKey["box5"]?.amount_minor).toBe(12000);
    expect(byKey["box6"]?.amount_minor).toBe(100000);
    expect(byKey["box7"]?.amount_minor).toBe(40000);
    expect(byKey["box2"]?.amount_minor).toBe(0);
    expect(lines.map((l) => l.sort_order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("uses generic labels elsewhere", () => {
    const lines = buildReturnLines(totals, "AU");
    expect(lines[0]?.label).toBe("Output tax due on sales");
    expect(lines.some((l) => /HMRC/.test(l.label))).toBe(false);
  });

  it("truncates boxes 6-9 to whole pounds for UK filing only", () => {
    expect(filingAmountMinor("box6", 123_456, 2, "GB")).toBe(123_400);
    expect(filingAmountMinor("box6", -123_456, 2, "GB")).toBe(-123_400);
    expect(filingAmountMinor("box1", 123_456, 2, "GB")).toBe(123_456);
    expect(filingAmountMinor("box6", 123_456, 2, "AU")).toBe(123_456);
    expect(filingAmountMinor("box7", 5_099, 0, "GB")).toBe(5_099);
  });
});

describe("cash basis fraction", () => {
  it("scales once, half away from zero", () => {
    expect(scaleByFraction(2000n, 500n, 1000n)).toBe(1000n);
    expect(scaleByFraction(1001n, 1n, 2n)).toBe(501n);
    expect(scaleByFraction(-1001n, 1n, 2n)).toBe(-501n);
    expect(scaleByFraction(2000n, 1000n, 1000n)).toBe(2000n);
    expect(scaleByFraction(2000n, 1500n, 1000n)).toBe(2000n); // never more than the document
    expect(scaleByFraction(2000n, 0n, 1000n)).toBe(0n);
    expect(scaleByFraction(2000n, 1n, 0n)).toBe(0n);
  });
});

describe("settlement journal", () => {
  const base = {
    companyId: "c",
    returnId: "11111111-1111-1111-1111-111111111111",
    journalDate: "2026-07-31",
    periodEnd: "2026-06-30",
    outputAccountId: "out",
    inputAccountId: "in",
    settlementAccountId: "pay",
    currencyCode: "GBP",
  };
  const sum = (j: ReturnType<typeof buildTaxReturnSettlementJournal>) =>
    j.lines.reduce((a, l) => a + BigInt(l.debit_minor) - BigInt(l.credit_minor), 0n);

  it("balances and credits the settlement account when tax is payable", () => {
    const j = buildTaxReturnSettlementJournal({
      ...base,
      outputTaxMinor: 20000n,
      inputTaxMinor: 8000n,
    });
    expect(sum(j)).toBe(0n);
    expect(j.source_type).toBe("tax_adjustment");
    expect(j.source_id).toBe(base.returnId);
    expect(j.idempotency_key).toBe(`tax_return_settlement:${base.returnId}`);
    const pay = j.lines.find((l) => l.account_id === "pay");
    expect(pay?.credit_minor).toBe(12000n);
  });

  it("debits the settlement account for a refund", () => {
    const j = buildTaxReturnSettlementJournal({
      ...base,
      outputTaxMinor: 1000n,
      inputTaxMinor: 5000n,
    });
    expect(sum(j)).toBe(0n);
    expect(j.lines.find((l) => l.account_id === "pay")?.debit_minor).toBe(4000n);
  });

  it("refuses unusable account choices and empty returns", () => {
    expect(() =>
      buildTaxReturnSettlementJournal({
        ...base,
        inputAccountId: "out",
        outputTaxMinor: 1n,
        inputTaxMinor: 1n,
      }),
    ).toThrow(/same account/);
    expect(() =>
      buildTaxReturnSettlementJournal({
        ...base,
        settlementAccountId: "in",
        outputTaxMinor: 1n,
        inputTaxMinor: 1n,
      }),
    ).toThrow(/different/);
    expect(() =>
      buildTaxReturnSettlementJournal({ ...base, outputTaxMinor: 0n, inputTaxMinor: 0n }),
    ).toThrow(/nothing to settle|no tax/i);
  });

  it("skips the settlement line when output equals input", () => {
    const j = buildTaxReturnSettlementJournal({
      ...base,
      outputTaxMinor: 700n,
      inputTaxMinor: 700n,
    });
    expect(j.lines).toHaveLength(2);
    expect(sum(j)).toBe(0n);
  });
});
