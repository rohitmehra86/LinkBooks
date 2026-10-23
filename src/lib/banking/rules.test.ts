import { describe, expect, it } from "vitest";
import { pickRule, ruleMatchesTransaction, textMatches, validateRuleInput, type BankRuleDef } from "./rules";

const rule = (over: Partial<BankRuleDef> = {}): BankRuleDef => ({
  id: "r1",
  name: "Amazon",
  match_field: "description",
  match_type: "contains",
  match_pattern: "amazon",
  direction: "any",
  min_amount_minor: null,
  max_amount_minor: null,
  bank_account_id: null,
  offset_account_id: "acc",
  tax_code_id: null,
  contact_id: null,
  priority: 100,
  is_active: true,
  ...over,
});
const txn = (over: Record<string, unknown> = {}) => ({
  bankAccountId: "bank1",
  amountMinor: -2500,
  description: "AMAZON  MKTPLACE",
  reference: "REF-9",
  payee: null,
  ...over,
});

describe("ruleMatchesTransaction", () => {
  it("matches text case/space-insensitively", () => {
    expect(ruleMatchesTransaction(rule(), txn())).toBe(true);
    expect(textMatches("Costa Coffee", "starts_with", "costa")).toBe(true);
    expect(textMatches("Costa Coffee", "equals", "costa")).toBe(false);
    expect(textMatches("anything", "contains", "")).toBe(false);
  });
  it("uses the stored reference field (BK-12: reference rules can now match)", () => {
    expect(ruleMatchesTransaction(rule({ match_field: "reference", match_pattern: "ref-9" }), txn())).toBe(true);
    expect(ruleMatchesTransaction(rule({ match_field: "reference", match_pattern: "zzz" }), txn())).toBe(false);
    expect(ruleMatchesTransaction(rule({ match_field: "reference", match_pattern: "x" }), txn({ reference: null }))).toBe(false);
  });
  it("payee falls back to the description when no payee was imported", () => {
    expect(ruleMatchesTransaction(rule({ match_field: "payee" }), txn())).toBe(true);
    expect(ruleMatchesTransaction(rule({ match_field: "payee", match_pattern: "bob" }), txn({ payee: "Bob Ltd" }))).toBe(true);
  });
  it("respects money direction and amount range on the absolute amount", () => {
    expect(ruleMatchesTransaction(rule({ direction: "in" }), txn())).toBe(false);
    expect(ruleMatchesTransaction(rule({ direction: "out" }), txn())).toBe(true);
    expect(ruleMatchesTransaction(rule({ min_amount_minor: 3000 }), txn())).toBe(false);
    expect(ruleMatchesTransaction(rule({ min_amount_minor: 2500, max_amount_minor: 2500 }), txn())).toBe(true);
    expect(ruleMatchesTransaction(rule({ max_amount_minor: 2000 }), txn())).toBe(false);
  });
  it("respects bank-account scope and disabled rules", () => {
    expect(ruleMatchesTransaction(rule({ bank_account_id: "bank2" }), txn())).toBe(false);
    expect(ruleMatchesTransaction(rule({ bank_account_id: "bank1" }), txn())).toBe(true);
    expect(ruleMatchesTransaction(rule({ is_active: false }), txn())).toBe(false);
  });
});

describe("pickRule", () => {
  it("lowest priority number wins, then name, then id", () => {
    const a = rule({ id: "a", name: "B", priority: 10 });
    const b = rule({ id: "b", name: "A", priority: 10 });
    const c = rule({ id: "c", name: "Z", priority: 5, match_pattern: "nomatch" });
    expect(pickRule([a, b, c], txn())?.id).toBe("b");
    expect(pickRule([], txn())).toBeNull();
  });
});

describe("validateRuleInput", () => {
  const ok = {
    name: "n",
    matchField: "description",
    matchType: "contains",
    matchPattern: "x",
    direction: "any",
    minAmountMinor: null,
    maxAmountMinor: null,
  };
  it("accepts a valid rule and rejects bad ones", () => {
    expect(validateRuleInput(ok)).toBeNull();
    expect(validateRuleInput({ ...ok, name: " " })).toMatch(/name/);
    expect(validateRuleInput({ ...ok, direction: "sideways" })).toMatch(/direction/);
    expect(validateRuleInput({ ...ok, minAmountMinor: 10, maxAmountMinor: 5 })).toMatch(/greater/);
    expect(validateRuleInput({ ...ok, minAmountMinor: -1 })).toMatch(/negative/);
  });
});
