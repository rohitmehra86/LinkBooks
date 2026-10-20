/** Local, tenant-scoped coding suggestions — never cross-org. */

export type CodingHistoryRow = {
  payee_normalized: string;
  offset_account_id: string;
  direction: "in" | "out";
  times_used: number;
  account_code: string | null;
  account_name: string | null;
};

export type BankRuleRow = {
  id: string;
  name: string;
  match_field: string;
  match_pattern: string;
  match_type: string;
  offset_account_id: string;
  priority: number;
  is_active: boolean;
  account_code: string | null;
  account_name: string | null;
};

export type Suggestion = {
  offsetAccountId: string;
  accountCode: string | null;
  accountName: string | null;
  confidence: number;
  reason: string;
  source: "history" | "rule" | "none";
  ruleId: string | null;
};

export function normalizePayee(description: string | null | undefined): string {
  return (description ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export function directionFromAmount(amountMinor: number | bigint): "in" | "out" {
  const n = typeof amountMinor === "bigint" ? amountMinor : BigInt(amountMinor);
  return n >= 0n ? "in" : "out";
}

function ruleMatches(
  rule: BankRuleRow,
  description: string,
  amountMinor: number,
): boolean {
  const field = (rule.match_field || "description").toLowerCase();
  const hay =
    field === "amount"
      ? String(Math.abs(amountMinor))
      : description.toLowerCase();
  const needle = (rule.match_pattern ?? "").toLowerCase();
  if (!needle) return false;
  switch ((rule.match_type || "contains").toLowerCase()) {
    case "equals":
      return hay === needle;
    case "starts_with":
      return hay.startsWith(needle);
    case "ends_with":
      return hay.endsWith(needle);
    default:
      return hay.includes(needle);
  }
}

/**
 * Rank suggestions: exact history for payee+direction, then bank rules by priority.
 */
export function rankCodingSuggestions(opts: {
  description: string | null;
  amountMinor: number;
  history: CodingHistoryRow[];
  rules: BankRuleRow[];
}): Suggestion[] {
  const payee = normalizePayee(opts.description);
  const direction = directionFromAmount(opts.amountMinor);
  const out: Suggestion[] = [];

  const hist = opts.history
    .filter((h) => h.direction === direction && (h.payee_normalized === payee || (payee && h.payee_normalized && payee.includes(h.payee_normalized))))
    .sort((a, b) => b.times_used - a.times_used);

  for (const h of hist.slice(0, 3)) {
    const exact = h.payee_normalized === payee;
    out.push({
      offsetAccountId: h.offset_account_id,
      accountCode: h.account_code,
      accountName: h.account_name,
      confidence: exact ? Math.min(0.95, 0.55 + h.times_used * 0.05) : 0.45,
      reason: exact
        ? `Previously coded “${h.payee_normalized}” ${h.times_used} time(s) to this account`
        : `Similar payee history (“${h.payee_normalized}”)`,
      source: "history",
      ruleId: null,
    });
  }

  const desc = (opts.description ?? "").toLowerCase();
  const matchingRules = opts.rules
    .filter((r) => r.is_active && ruleMatches(r, desc, opts.amountMinor))
    .sort((a, b) => a.priority - b.priority);

  for (const r of matchingRules.slice(0, 3)) {
    if (out.some((s) => s.offsetAccountId === r.offset_account_id)) continue;
    out.push({
      offsetAccountId: r.offset_account_id,
      accountCode: r.account_code,
      accountName: r.account_name,
      confidence: 0.7,
      reason: `Bank rule “${r.name}” (${r.match_type} ${r.match_pattern})`,
      source: "rule",
      ruleId: r.id,
    });
  }

  return out.sort((a, b) => b.confidence - a.confidence);
}
