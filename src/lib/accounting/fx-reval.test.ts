import { describe, expect, it, vi } from "vitest";
import {
  computeRevaluation,
  nextDay,
  realisedFx,
  realisedFxLines,
  validateAutoReverseDate,
} from "./fx-reval";
import { postJournal, resolveFxRate } from "./posting-engine";

describe("realisedFx", () => {
  it("receipt at a higher rate than the invoice is a gain", () => {
    // EUR 1000.00 booked at 1.10, received at 1.20 => 1100.00 booked, 1200.00 received
    const r = realisedFx("sales", 100000n, "1.10", "1.20", "EUR", "GBP");
    expect(r.documentBase).toBe(110000n);
    expect(r.settlementBase).toBe(120000n);
    expect(r.gainLossBaseMinor).toBe(10000n);
  });

  it("receipt at a lower rate is a loss", () => {
    expect(realisedFx("sales", 50000n, "1.10", "1.00", "EUR", "GBP").gainLossBaseMinor).toBe(
      -5000n,
    );
  });

  it("payment at a lower rate than the bill is a gain (paid less base)", () => {
    // bill 800.00 at 1.10 = 880.00, paid at 1.05 = 840.00
    expect(realisedFx("purchases", 80000n, "1.10", "1.05", "EUR", "GBP").gainLossBaseMinor).toBe(
      4000n,
    );
  });

  it("payment at a higher rate is a loss", () => {
    expect(realisedFx("purchases", 80000n, "1.10", "1.20", "EUR", "GBP").gainLossBaseMinor).toBe(
      -8000n,
    );
  });

  it("same rate gives nothing", () => {
    expect(realisedFx("sales", 12345n, "1.10", "1.10", "EUR", "GBP").gainLossBaseMinor).toBe(0n);
  });

  it("respects currency decimals (JPY has none)", () => {
    // JPY 100000 at 0.0070 = 700.00 GBP, at 0.0065 = 650.00 GBP
    const r = realisedFx("sales", 100000n, "0.0070", "0.0065", "JPY", "GBP");
    expect(r.documentBase).toBe(70000n);
    expect(r.settlementBase).toBe(65000n);
    expect(r.gainLossBaseMinor).toBe(-5000n);
  });
});

describe("realisedFxLines", () => {
  it("gain debits the control account and credits the gain account", () => {
    expect(realisedFxLines(100n, "ar", "gain", "loss")).toEqual([
      { accountId: "ar", debitMinor: 100n, creditMinor: 0n },
      { accountId: "gain", debitMinor: 0n, creditMinor: 100n },
    ]);
  });

  it("loss debits the loss account and credits the control account", () => {
    expect(realisedFxLines(-70n, "ar", "gain", "loss")).toEqual([
      { accountId: "loss", debitMinor: 70n, creditMinor: 0n },
      { accountId: "ar", debitMinor: 0n, creditMinor: 70n },
    ]);
  });

  it("posts nothing for zero", () => {
    expect(realisedFxLines(0n, "ar", "gain", "loss")).toEqual([]);
  });
});

describe("computeRevaluation", () => {
  const base = "GBP";

  it("revalues an open receivable up and balances through unrealised gain", () => {
    const r = computeRevaluation(
      [
        {
          accountId: "ar",
          currencyCode: "EUR",
          txnNetMinor: 100000n,
          bookedBaseMinor: 110000n,
          rate: "1.15",
        },
      ],
      base,
      "ugain",
      "uloss",
    );
    expect(r.missingRates).toEqual([]);
    expect(r.lines[0]).toMatchObject({ closingBaseMinor: 115000n, adjustmentMinor: 5000n });
    expect(r.journals).toHaveLength(1);
    expect(r.journals[0]!.lines).toEqual([
      { accountId: "ar", debitMinor: 5000n, creditMinor: 0n },
      { accountId: "ugain", debitMinor: 0n, creditMinor: 5000n },
    ]);
    expect(r.totalGainMinor).toBe(5000n);
    expect(r.totalLossMinor).toBe(0n);
  });

  it("a payable that grows in base is an unrealised loss", () => {
    // AP -800.00 EUR booked at 1.10 = -880.00; at 1.15 = -920.00 => adjustment -40.00 (credit AP)
    const r = computeRevaluation(
      [
        {
          accountId: "ap",
          currencyCode: "EUR",
          txnNetMinor: -80000n,
          bookedBaseMinor: -88000n,
          rate: "1.15",
        },
      ],
      base,
      "ugain",
      "uloss",
    );
    expect(r.lines[0]!.adjustmentMinor).toBe(-4000n);
    expect(r.journals[0]!.lines).toEqual([
      { accountId: "ap", debitMinor: 0n, creditMinor: 4000n },
      { accountId: "uloss", debitMinor: 4000n, creditMinor: 0n },
    ]);
    expect(r.totalLossMinor).toBe(4000n);
  });

  it("nets AR and AP of the same currency into one journal that balances", () => {
    const r = computeRevaluation(
      [
        {
          accountId: "ar",
          currencyCode: "EUR",
          txnNetMinor: 100000n,
          bookedBaseMinor: 110000n,
          rate: "1.15",
        },
        {
          accountId: "ap",
          currencyCode: "EUR",
          txnNetMinor: -80000n,
          bookedBaseMinor: -88000n,
          rate: "1.15",
        },
      ],
      base,
      "ugain",
      "uloss",
    );
    expect(r.journals).toHaveLength(1);
    const j = r.journals[0]!;
    const debits = j.lines.reduce((s, l) => s + l.debitMinor, 0n);
    const credits = j.lines.reduce((s, l) => s + l.creditMinor, 0n);
    expect(debits).toBe(credits);
    expect(r.totalGainMinor - r.totalLossMinor).toBe(1000n); // +50.00 AR, -40.00 AP => net +10.00
  });

  it("separate journal per currency, deterministic order", () => {
    const r = computeRevaluation(
      [
        {
          accountId: "ar",
          currencyCode: "USD",
          txnNetMinor: 1000n,
          bookedBaseMinor: 700n,
          rate: "0.80",
        },
        {
          accountId: "ar",
          currencyCode: "EUR",
          txnNetMinor: 1000n,
          bookedBaseMinor: 900n,
          rate: "0.95",
        },
      ],
      base,
      "ugain",
      "uloss",
    );
    expect(r.journals.map((j) => j.currencyCode)).toEqual(["EUR", "USD"]);
  });

  it("requires a manual rate: missing or invalid rates are reported, not guessed", () => {
    const r = computeRevaluation(
      [
        {
          accountId: "ar",
          currencyCode: "EUR",
          txnNetMinor: 1000n,
          bookedBaseMinor: 900n,
          rate: undefined,
        },
        {
          accountId: "ar",
          currencyCode: "USD",
          txnNetMinor: 1000n,
          bookedBaseMinor: 900n,
          rate: "0",
        },
      ],
      base,
      "ugain",
      "uloss",
    );
    expect(r.missingRates).toEqual(["EUR", "USD"]);
    expect(r.journals).toEqual([]);
  });

  it("skips balances that already agree and base-currency balances", () => {
    const r = computeRevaluation(
      [
        {
          accountId: "ar",
          currencyCode: "EUR",
          txnNetMinor: 100000n,
          bookedBaseMinor: 110000n,
          rate: "1.10",
        },
        {
          accountId: "ar",
          currencyCode: "GBP",
          txnNetMinor: 5n,
          bookedBaseMinor: 5n,
          rate: undefined,
        },
      ],
      base,
      "ugain",
      "uloss",
    );
    expect(r.missingRates).toEqual([]);
    expect(r.journals).toEqual([]);
  });

  it("clears a leftover base residual on a fully settled foreign balance", () => {
    const r = computeRevaluation(
      [
        {
          accountId: "ar",
          currencyCode: "EUR",
          txnNetMinor: 0n,
          bookedBaseMinor: 500n,
          rate: "1.2",
        },
      ],
      base,
      "ugain",
      "uloss",
    );
    expect(r.lines[0]!.adjustmentMinor).toBe(-500n);
  });
});

describe("auto-reverse dates", () => {
  it("nextDay handles month and year ends and rejects bad input", () => {
    expect(nextDay("2026-09-30")).toBe("2026-10-01");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
    expect(nextDay("2028-02-28")).toBe("2028-02-29");
    expect(nextDay("2026-02-30")).toBeNull();
    expect(nextDay("nope")).toBeNull();
  });

  it("reversal must be after the journal date", () => {
    expect(validateAutoReverseDate("2026-09-30", null)).toBeNull();
    expect(validateAutoReverseDate("2026-09-30", "2026-10-01")).toBeNull();
    expect(validateAutoReverseDate("2026-09-30", "2026-09-30")).toMatch(/after/);
    expect(validateAutoReverseDate("2026-09-30", "2026-09-01")).toMatch(/after/);
    expect(validateAutoReverseDate("2026-09-30", "30/09/2026")).toMatch(/valid/);
  });
});

describe("resolveFxRate (posting engine)", () => {
  const input = { company_id: "c", journal_date: "2026-09-30" };

  it("an explicit rate wins and no lookup happens", async () => {
    const supabase = { rpc: vi.fn() };
    expect(
      await resolveFxRate(supabase as never, {
        ...input,
        currency_code: "EUR",
        fx_rate_to_base: 1.2,
      }),
    ).toBe(1.2);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("no currency means base: 1, no lookup", async () => {
    const supabase = { rpc: vi.fn() };
    expect(await resolveFxRate(supabase as never, input)).toBe(1);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("looks up the stored manual rate for a foreign currency", async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 1.17, error: null }) };
    expect(await resolveFxRate(supabase as never, { ...input, currency_code: "eur" })).toBe(1.17);
    expect(supabase.rpc.mock.calls[0]![1]).toMatchObject({
      _from_currency: "EUR",
      _as_of: "2026-09-30",
    });
  });

  it("refuses to post a foreign journal without a manual rate", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "No exchange rate for EUR → GBP on or before 2026-09-30" },
      }),
    };
    await expect(
      resolveFxRate(supabase as never, { ...input, currency_code: "EUR" }),
    ).rejects.toThrow(/No exchange rate for EUR/);
  });

  it("does not post when the rate is missing (end to end through postJournal)", async () => {
    const supabase = {
      rpc: vi
        .fn()
        .mockResolvedValue({ data: null, error: { message: "No exchange rate for EUR → GBP" } }),
    };
    await expect(
      postJournal(supabase as never, {
        ...input,
        currency_code: "EUR",
        lines: [
          { account_id: "a", debit_minor: 100n, credit_minor: 0n },
          { account_id: "b", debit_minor: 0n, credit_minor: 100n },
        ],
      }),
    ).rejects.toThrow(/exchange rate/i);
    expect(supabase.rpc).toHaveBeenCalledTimes(1); // only the lookup; post_journal was never called
  });
});

describe("auto-reversing manual journals (posting engine)", () => {
  const lines = [
    { account_id: "a", debit_minor: 100n, credit_minor: 0n },
    { account_id: "b", debit_minor: 0n, credit_minor: 100n },
  ];

  it("posts through post_auto_reversing_journal and returns the journal id", async () => {
    const supabase = {
      rpc: vi
        .fn()
        .mockResolvedValue({ data: { journal_id: "j-1", reverse_on: "2026-10-01" }, error: null }),
    };
    const r = await postJournal(supabase as never, {
      company_id: "c",
      journal_date: "2026-09-30",
      auto_reverse_on: "2026-10-01",
      lines,
    });
    expect(r.journalId).toBe("j-1");
    const [name, args] = supabase.rpc.mock.calls[0]!;
    expect(name).toBe("post_auto_reversing_journal");
    expect(args.payload.reverse_on).toBe("2026-10-01");
  });

  it("refuses a reversal date that is not after the journal date, before any RPC", async () => {
    const supabase = { rpc: vi.fn() };
    await expect(
      postJournal(supabase as never, {
        company_id: "c",
        journal_date: "2026-09-30",
        auto_reverse_on: "2026-09-30",
        lines,
      }),
    ).rejects.toThrow(/after the journal date/);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("only manual journals can auto-reverse", async () => {
    const supabase = { rpc: vi.fn() };
    await expect(
      postJournal(supabase as never, {
        company_id: "c",
        journal_date: "2026-09-30",
        auto_reverse_on: "2026-10-01",
        source_type: "other",
        lines,
      }),
    ).rejects.toThrow(/manual/);
  });
});
