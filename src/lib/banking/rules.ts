/**
 * Bank rule evaluation (BK-12). Rules SUGGEST a coding; nothing here posts anything.
 * Conditions: text field (description / reference / payee) + operator, money direction, absolute amount range,
 * optional bank-account scope. First matching ACTIVE rule by ascending priority wins.
 */

export type BankRuleDef = {
  id: string;
  name: string;
  match_field: string;
  match_type: string;
  match_pattern: string;
  direction: string; // any | in | out
  min_amount_minor: number | null;
  max_amount_minor: number | null;
  bank_account_id: string | null;
  offset_account_id: string;
  tax_code_id: string | null;
  contact_id: string | null;
  priority: number;
  is_active: boolean;
};

export type RuleTarget = {
  bankAccountId: string;
  amountMinor: number;
  description: string | null;
  reference: string | null;
  payee: string | null;
};

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function textMatches(haystack: string, operator: string, pattern: string): boolean {
  const target = norm(haystack);
  const needle = norm(pattern);
  if (!needle) return false;
  if (operator === "equals") return target === needle;
  if (operator === "starts_with") return target.startsWith(needle);
  return target.includes(needle);
}

export function ruleMatchesTransaction(rule: BankRuleDef, txn: RuleTarget): boolean {
  if (!rule.is_active) return false;
  if (rule.bank_account_id && rule.bank_account_id !== txn.bankAccountId) return false;

  const direction = txn.amountMinor >= 0 ? "in" : "out";
  if (rule.direction === "in" && direction !== "in") return false;
  if (rule.direction === "out" && direction !== "out") return false;

  const abs = Math.abs(txn.amountMinor);
  if (rule.min_amount_minor !== null && abs < rule.min_amount_minor) return false;
  if (rule.max_amount_minor !== null && abs > rule.max_amount_minor) return false;

  const field =
    rule.match_field === "reference"
      ? txn.reference
      : rule.match_field === "payee"
        ? (txn.payee ?? txn.description)
        : txn.description;
  return textMatches(field ?? "", rule.match_type, rule.match_pattern);
}

/** Lowest priority number wins; ties broken by name then id for determinism. */
export function pickRule(rules: readonly BankRuleDef[], txn: RuleTarget): BankRuleDef | null {
  const sorted = [...rules].sort(
    (a, b) => a.priority - b.priority || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  return sorted.find((r) => ruleMatchesTransaction(r, txn)) ?? null;
}

export function validateRuleInput(input: {
  name: string;
  matchField: string;
  matchType: string;
  matchPattern: string;
  direction: string;
  minAmountMinor: number | null;
  maxAmountMinor: number | null;
}): string | null {
  if (!input.name.trim()) return "Rule name is required";
  if (!input.matchPattern.trim()) return "Match text is required";
  if (!["description", "reference", "payee"].includes(input.matchField))
    return "Invalid match field";
  if (!["contains", "equals", "starts_with"].includes(input.matchType)) return "Invalid match type";
  if (!["any", "in", "out"].includes(input.direction)) return "Invalid money direction";
  if (input.minAmountMinor !== null && input.minAmountMinor < 0)
    return "Minimum amount cannot be negative";
  if (input.maxAmountMinor !== null && input.maxAmountMinor < 0)
    return "Maximum amount cannot be negative";
  if (
    input.minAmountMinor !== null &&
    input.maxAmountMinor !== null &&
    input.minAmountMinor > input.maxAmountMinor
  ) {
    return "Minimum amount is greater than the maximum";
  }
  return null;
}
