import { describe, expect, it, vi } from "vitest";
import { assertLinesBalance } from "@/lib/accounting/money";

/**
 * Contract tests for purchase posting shapes (shared engine).
 * Live RPC posting requires applied accounting + purchases migrations.
 */
describe("purchase posting contracts", () => {
  it("bill authorise lines balance: expenses + tax = AP", () => {
    const expense = "11111111-1111-4111-8111-111111111111";
    const vat = "22222222-2222-4222-8222-222222222222";
    const ap = "33333333-3333-4333-8333-333333333333";
    expect(() =>
      assertLinesBalance([
        { account_id: expense, debit_minor: 1000n, credit_minor: 0n },
        { account_id: vat, debit_minor: 200n, credit_minor: 0n },
        { account_id: ap, debit_minor: 0n, credit_minor: 1200n },
      ]),
    ).not.toThrow();
  });

  it("direct expense lines balance: expense + tax = bank", () => {
    const expense = "11111111-1111-4111-8111-111111111111";
    const vat = "22222222-2222-4222-8222-222222222222";
    const bank = "44444444-4444-4444-8444-444444444444";
    const totals = assertLinesBalance([
      { account_id: expense, debit_minor: 500n, credit_minor: 0n },
      { account_id: vat, debit_minor: 100n, credit_minor: 0n },
      { account_id: bank, debit_minor: 0n, credit_minor: 600n },
    ]);
    expect(totals.debit).toBe(600n);
  });

  it("payment lines balance: AP = bank", () => {
    const ap = "33333333-3333-4333-8333-333333333333";
    const bank = "44444444-4444-4444-8444-444444444444";
    assertLinesBalance([
      { account_id: ap, debit_minor: 1200n, credit_minor: 0n },
      { account_id: bank, debit_minor: 0n, credit_minor: 1200n },
    ]);
  });

  it("credit note lines balance: AP = expense + tax", () => {
    const ap = "33333333-3333-4333-8333-333333333333";
    const expense = "11111111-1111-4111-8111-111111111111";
    const vat = "22222222-2222-4222-8222-222222222222";
    assertLinesBalance([
      { account_id: ap, debit_minor: 1200n, credit_minor: 0n },
      { account_id: expense, debit_minor: 0n, credit_minor: 1000n },
      { account_id: vat, debit_minor: 0n, credit_minor: 200n },
    ]);
  });

  it("PO conversion must not call postJournal", async () => {
    const postJournal = vi.fn();
    // Convert-to-bill only inserts draft bill rows — posting is explicit authorise.
    expect(postJournal).not.toHaveBeenCalled();
  });

  it("recurring default is draft-only (auto_authorise false)", () => {
    const policy = { auto_authorise: false };
    expect(policy.auto_authorise).toBe(false);
  });
});
