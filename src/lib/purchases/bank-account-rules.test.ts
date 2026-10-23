import { describe, expect, it } from "vitest";
import { isBankOrCashAccount, type AccountCandidate } from "@/lib/purchases/bank-account-rules";

const acc = (over: Partial<AccountCandidate> = {}): AccountCandidate => ({
  id: "a1",
  account_type: "asset",
  is_active: true,
  is_postable: true,
  ...over,
});

describe("isBankOrCashAccount", () => {
  it("accepts the GL account of a Banking bank account", () => {
    expect(isBankOrCashAccount(acc({ account_kind: "current_asset" }), new Set(["a1"]))).toBe(true);
  });

  it("accepts accounts the chart marks as bank / cash or payment-enabled", () => {
    expect(isBankOrCashAccount(acc({ account_kind: "bank" }), new Set())).toBe(true);
    expect(isBankOrCashAccount(acc({ subtype: "cash" }), new Set())).toBe(true);
    expect(isBankOrCashAccount(acc({ is_payment_enabled: true }), new Set())).toBe(true);
  });

  it("rejects receivables, fixed assets and other plain assets", () => {
    expect(isBankOrCashAccount(acc({ account_kind: "current_asset", subtype: "current_asset" }), new Set())).toBe(false);
    expect(isBankOrCashAccount(acc({ account_kind: "fixed_asset" }), new Set())).toBe(false);
  });

  it("rejects non-assets, inactive, archived and header accounts even if linked", () => {
    const linked = new Set(["a1"]);
    expect(isBankOrCashAccount(acc({ account_type: "income" }), linked)).toBe(false);
    expect(isBankOrCashAccount(acc({ account_type: "liability" }), linked)).toBe(false);
    expect(isBankOrCashAccount(acc({ is_active: false }), linked)).toBe(false);
    expect(isBankOrCashAccount(acc({ archived_at: "2026-01-01" }), linked)).toBe(false);
    expect(isBankOrCashAccount(acc({ is_postable: false }), linked)).toBe(false);
  });
});
