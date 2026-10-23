import { describe, expect, it } from "vitest";
import {
  codingIdempotencyKey,
  CodingPlanError,
  computeSplitTotals,
  planBankCoding,
  type CodingTaxCode,
} from "./coding";

const BANK = "bank";
const EXP = "expense";
const EXP2 = "expense2";
const INC = "income";
const INPUT = "input-vat";
const OUTPUT = "output-vat";

const codes = new Map<string, CodingTaxCode>([
  ["std", { id: "std", code: "S20", rateBps: 2000, treatment: "standard", taxAccountId: null, isRecoverable: true }],
  ["zero", { id: "zero", code: "Z", rateBps: 0, treatment: "zero_rated", taxAccountId: null, isRecoverable: true }],
  ["exempt", { id: "exempt", code: "EX", rateBps: 0, treatment: "exempt", taxAccountId: null, isRecoverable: true }],
  ["nonrec", { id: "nonrec", code: "NR", rateBps: 2000, treatment: "standard", taxAccountId: null, isRecoverable: false }],
  ["custom", { id: "custom", code: "C", rateBps: 1000, treatment: "reduced", taxAccountId: "custom-tax", isRecoverable: true }],
  ["rc", { id: "rc", code: "RC", rateBps: 2000, treatment: "reverse_charge", taxAccountId: null, isRecoverable: true }],
]);

const base = {
  bankGlAccountId: BANK,
  taxCodes: codes,
  inputTaxAccountId: INPUT,
  outputTaxAccountId: OUTPUT,
};

const sum = (lines: Array<{ debit_minor: bigint | number; credit_minor: bigint | number }>) =>
  lines.reduce(
    (a, l) => ({ d: a.d + BigInt(l.debit_minor), c: a.c + BigInt(l.credit_minor) }),
    { d: 0n, c: 0n },
  );

describe("planBankCoding", () => {
  it("money out, tax-inclusive 20%: net to expense, tax to INPUT account, gross out of bank", () => {
    const p = planBankCoding({
      ...base,
      statementAmountMinor: -12000n,
      treatment: "inclusive",
      splits: [{ accountId: EXP, amountMinor: 12000n, taxCodeId: "std", description: "Stationery" }],
    });
    expect(p.direction).toBe("out");
    expect(p.netMinor).toBe(10000n);
    expect(p.taxMinor).toBe(2000n);
    expect(p.lines).toEqual([
      { account_id: EXP, description: "Stationery", debit_minor: 10000n, credit_minor: 0n },
      { account_id: INPUT, description: "Tax", debit_minor: 2000n, credit_minor: 0n },
      { account_id: BANK, debit_minor: 0n, credit_minor: 12000n },
    ]);
    const t = sum(p.lines);
    expect(t.d).toBe(t.c);
  });

  it("money in uses the OUTPUT tax account and debits the bank", () => {
    const p = planBankCoding({
      ...base,
      statementAmountMinor: 12000n,
      treatment: "inclusive",
      splits: [{ accountId: INC, amountMinor: 12000n, taxCodeId: "std" }],
    });
    expect(p.direction).toBe("in");
    expect(p.lines[0]).toMatchObject({ account_id: BANK, debit_minor: 12000n });
    expect(p.lines.find((l) => l.account_id === OUTPUT)).toMatchObject({ credit_minor: 2000n });
    expect(p.lines.find((l) => l.account_id === INC)).toMatchObject({ credit_minor: 10000n });
  });

  it("tax-exclusive: amounts are net and tax is added to reach the statement gross", () => {
    const p = planBankCoding({
      ...base,
      statementAmountMinor: -12000n,
      treatment: "exclusive",
      splits: [{ accountId: EXP, amountMinor: 10000n, taxCodeId: "std" }],
    });
    expect(p.grossMinor).toBe(12000n);
    expect(p.taxMinor).toBe(2000n);
  });

  it("splits a supermarket line across two accounts with different tax codes, aggregating tax", () => {
    const p = planBankCoding({
      ...base,
      statementAmountMinor: -17000n,
      treatment: "inclusive",
      splits: [
        { accountId: EXP, amountMinor: 12000n, taxCodeId: "std" },
        { accountId: EXP2, amountMinor: 3000n, taxCodeId: "zero" },
        { accountId: EXP, amountMinor: 2000n, taxCodeId: "std" },
      ],
    });
    // 12000 → 10000+2000 ; 3000 zero-rated ; 2000 → 1667 + 333
    expect(p.taxMinor).toBe(2333n);
    const taxLines = p.lines.filter((l) => l.account_id === INPUT);
    expect(taxLines).toHaveLength(1);
    expect(taxLines[0]!.debit_minor).toBe(2333n);
    expect(p.lines.filter((l) => l.account_id === BANK)).toHaveLength(1);
    const t = sum(p.lines);
    expect(t.d).toBe(t.c);
    expect(t.c).toBe(17000n);
  });

  it("no tax code, exempt and zero-rated create no tax line", () => {
    for (const id of [null, "zero", "exempt"]) {
      const p = planBankCoding({
        ...base,
        statementAmountMinor: -5000n,
        treatment: "inclusive",
        splits: [{ accountId: EXP, amountMinor: 5000n, taxCodeId: id }],
      });
      expect(p.lines).toHaveLength(2);
      expect(p.lines[0]!.debit_minor).toBe(5000n);
    }
  });

  it("non-recoverable tax is part of the cost (gross to the expense account)", () => {
    const p = planBankCoding({
      ...base,
      statementAmountMinor: -12000n,
      treatment: "inclusive",
      splits: [{ accountId: EXP, amountMinor: 12000n, taxCodeId: "nonrec" }],
    });
    expect(p.lines).toHaveLength(2);
    expect(p.lines[0]).toMatchObject({ account_id: EXP, debit_minor: 12000n });
  });

  it("a tax code's own tax account overrides the default", () => {
    const p = planBankCoding({
      ...base,
      statementAmountMinor: -11000n,
      treatment: "inclusive",
      splits: [{ accountId: EXP, amountMinor: 11000n, taxCodeId: "custom" }],
    });
    expect(p.lines.find((l) => l.account_id === "custom-tax")).toMatchObject({ debit_minor: 1000n });
    expect(p.lines.find((l) => l.account_id === INPUT)).toBeUndefined();
  });

  it("rejects totals that do not equal the statement line, naming the difference", () => {
    expect(() =>
      planBankCoding({
        ...base,
        statementAmountMinor: -12000n,
        treatment: "inclusive",
        splits: [{ accountId: EXP, amountMinor: 11000n, taxCodeId: "std" }],
      }),
    ).toThrow(/difference 1000/);
    expect(() =>
      planBankCoding({
        ...base,
        statementAmountMinor: -12000n,
        treatment: "exclusive",
        splits: [{ accountId: EXP, amountMinor: 12000n, taxCodeId: "std" }],
      }),
    ).toThrow(CodingPlanError);
  });

  it("rejects empty, zero, missing account, unknown or unsupported tax codes and missing tax accounts", () => {
    const common = { ...base, statementAmountMinor: -1000n, treatment: "inclusive" as const };
    expect(() => planBankCoding({ ...common, splits: [] })).toThrow(/at least one/);
    expect(() => planBankCoding({ ...common, splits: [{ accountId: EXP, amountMinor: 0n }] })).toThrow(/greater than zero/);
    expect(() => planBankCoding({ ...common, splits: [{ accountId: "", amountMinor: 1000n }] })).toThrow(/choose an account/);
    expect(() =>
      planBankCoding({ ...common, splits: [{ accountId: EXP, amountMinor: 1000n, taxCodeId: "nope" }] }),
    ).toThrow(/Unknown tax code/);
    expect(() =>
      planBankCoding({ ...common, splits: [{ accountId: EXP, amountMinor: 1000n, taxCodeId: "rc" }] }),
    ).toThrow(/Reverse-charge/);
    expect(() =>
      planBankCoding({
        ...common,
        inputTaxAccountId: null,
        splits: [{ accountId: EXP, amountMinor: 1000n, taxCodeId: "std" }],
      }),
    ).toThrow(/No input tax account/);
    expect(() =>
      planBankCoding({ ...common, statementAmountMinor: 0n, splits: [{ accountId: EXP, amountMinor: 1n }] }),
    ).toThrow(/zero/);
  });
});

describe("computeSplitTotals", () => {
  it("previews net/tax/gross for the UI", () => {
    const t = computeSplitTotals([{ amountMinor: 12000n, taxCodeId: "std" }], "inclusive", codes);
    expect([t.netMinor, t.taxMinor, t.grossMinor]).toEqual([10000n, 2000n, 12000n]);
  });
});

describe("codingIdempotencyKey", () => {
  it("is stable for first coding and changes after each reversal", () => {
    const id = "00000000-0000-0000-0000-000000000001";
    expect(codingIdempotencyKey(id, 0)).toBe(`bank_transaction:${id}:categorise`);
    expect(codingIdempotencyKey(id, 1)).toBe(`bank_transaction:${id}:categorise:1`);
    expect(codingIdempotencyKey(id, 2)).not.toBe(codingIdempotencyKey(id, 1));
  });
});
