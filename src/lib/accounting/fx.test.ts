import { describe, expect, it } from "vitest";
import {
  computeRealizedFx,
  computeUnrealizedFx,
  convertMinorToBase,
  lineToBaseMinor,
  roundHalfUpRational,
  scaleMinorByRate,
} from "./fx";
import { buildTrialBalance, type PostedLine } from "./reporting";

describe("FX conversion and rounding", () => {
  it("round half-up at .5", () => {
    expect(roundHalfUpRational(15n, 10n)).toBe(2n);
    expect(roundHalfUpRational(14n, 10n)).toBe(1n);
  });

  it("scales minor units by rate deterministically", () => {
    // 100.00 USD * 0.80 = 80.00 base
    expect(scaleMinorByRate(10_000n, "0.80")).toBe(8_000n);
    // 100.00 * 1.255 → 125.50
    expect(scaleMinorByRate(10_000n, "1.255")).toBe(12_550n);
    // half-up: 1 * 1.005 with 2dp rate scale → 1.005 → round to 1 when... wait
    // 100 minor * 1.005 = 100.5 → round half up → 101
    expect(scaleMinorByRate(100n, "1.005")).toBe(101n);
  });

  it("converts equal-decimal currencies via rate", () => {
    expect(convertMinorToBase(10_000n, "0.75", "USD", "GBP")).toBe(7_500n);
  });

  it("same currency ignores rate (identity)", () => {
    expect(convertMinorToBase(10_000n, "99", "GBP", "GBP")).toBe(10_000n);
  });

  it("JPY (0 dp) to USD (2 dp) scales places", () => {
    // 1000 JPY * 0.0067 = 6.70 USD = 670 cents. Single rounding at the end (RP-07 fix:
    // the old two-stage rounding produced 700 because it rounded 6.7 to 7 before shifting places).
    expect(convertMinorToBase(1000n, "0.0067", "JPY", "USD")).toBe(670n);
    // KWD (3 dp) to GBP (2 dp): 1.000 KWD = 2.4 GBP -> 240 pence, 12.345 KWD -> 2963 pence
    expect(convertMinorToBase(1000n, "2.4", "KWD", "GBP")).toBe(240n);
    expect(convertMinorToBase(12_345n, "2.4", "KWD", "GBP")).toBe(2_963n);
  });

  it("never silently uses a voided/missing path — callers must supply rate", () => {
    expect(() => scaleMinorByRate(100n, "0")).toThrow();
    expect(() => scaleMinorByRate(100n, "-1")).toThrow();
  });
});

describe("realised / unrealised FX", () => {
  it("computes realised gain when settle rate > original", () => {
    const r = computeRealizedFx(10_000n, "0.80", "0.85", "USD", "GBP");
    expect(r.originalBase).toBe(8_000n);
    expect(r.settleBase).toBe(8_500n);
    expect(r.gainLossBaseMinor).toBe(500n);
  });

  it("computes unrealised loss on open balance", () => {
    const { totalGainLossBaseMinor, lines } = computeUnrealizedFx(
      [
        {
          account_id: "ar",
          currency_code: "USD",
          txn_net_minor: 10_000n,
          booked_base_minor: 8_000n,
        },
      ],
      new Map([["USD", "0.78"]]),
      "GBP",
    );
    expect(lines[0]?.gainLossBaseMinor).toBe(-200n);
    expect(totalGainLossBaseMinor).toBe(-200n);
  });
});

describe("reporting uses journal FX snapshot", () => {
  it("TB converts foreign lines via fx_rate_to_base without rewriting source", () => {
    const lines: PostedLine[] = [
      {
        account_id: "1",
        account_code: "1100",
        account_name: "Bank",
        account_type: "asset",
        journal_date: "2026-01-15",
        debit_minor: 10_000n,
        credit_minor: 0n,
        fx_rate_to_base: "0.80",
        currency_code: "USD",
      },
      {
        account_id: "2",
        account_code: "4000",
        account_name: "Sales",
        account_type: "income",
        journal_date: "2026-01-15",
        debit_minor: 0n,
        credit_minor: 10_000n,
        fx_rate_to_base: "0.80",
        currency_code: "USD",
      },
    ];
    const tb = buildTrialBalance(lines);
    expect(tb.balances).toBe(true);
    expect(tb.totalDebit).toBe(8_000n);
    expect(tb.totalCredit).toBe(8_000n);
    // Source minors unchanged on input
    expect(lines[0]?.debit_minor).toBe(10_000n);
  });

  it("lineToBaseMinor is identity when rate omitted", () => {
    expect(lineToBaseMinor(1234n, null)).toBe(1234n);
    expect(lineToBaseMinor(1234n, "1")).toBe(1234n);
  });
});
