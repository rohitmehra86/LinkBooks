import { describe, expect, it } from "vitest";
import { isDepositAccount, type AccountRow } from "./ar-accounts";

const acc = (over: Partial<AccountRow>): AccountRow => ({
  id: "a",
  code: "1000",
  name: "Current account",
  account_type: "asset",
  account_kind: "current_asset",
  subtype: "current_asset",
  system_key: null,
  is_control: false,
  is_postable: true,
  is_active: true,
  archived_at: null,
  is_payment_enabled: false,
  ...over,
});

describe("isDepositAccount (AR-25)", () => {
  const none = new Set<string>();

  it("accepts bank and cash accounts", () => {
    expect(isDepositAccount(acc({ account_kind: "bank" }), none)).toBe(true);
    expect(isDepositAccount(acc({ system_key: "bank" }), none)).toBe(true);
    expect(isDepositAccount(acc({ name: "Petty cash" }), none)).toBe(true);
    expect(isDepositAccount(acc({ id: "b1", name: "Operating" }), new Set(["b1"]))).toBe(true);
  });

  it("rejects AR and other control accounts", () => {
    expect(
      isDepositAccount(
        acc({ code: "1100", name: "Accounts Receivable", is_control: true, system_key: "ar" }),
        none,
      ),
    ).toBe(false);
    expect(isDepositAccount(acc({ name: "Bank clearing", is_control: true }), none)).toBe(false);
  });

  it("rejects inventory, fixed assets, inactive, archived, non-postable and non-asset accounts", () => {
    expect(isDepositAccount(acc({ code: "1150", name: "Inventory" }), none)).toBe(false);
    expect(
      isDepositAccount(
        acc({ name: "Equipment", account_kind: "fixed_asset", subtype: "non_current_asset" }),
        none,
      ),
    ).toBe(false);
    expect(isDepositAccount(acc({ account_kind: "bank", is_active: false }), none)).toBe(false);
    expect(isDepositAccount(acc({ account_kind: "bank", archived_at: "2026-01-01" }), none)).toBe(
      false,
    );
    expect(isDepositAccount(acc({ account_kind: "bank", is_postable: false }), none)).toBe(false);
    expect(isDepositAccount(acc({ name: "Bank fees", account_type: "expense" }), none)).toBe(false);
  });
});
