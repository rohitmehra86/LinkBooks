import {
  ACCOUNT_KINDS,
  type AccountKind,
  isAccountKind,
  kindSpec,
} from "@/lib/accounting/account-kinds";

export type AccountSuggestion = {
  kind: AccountKind;
  label: string;
  reason: string;
};

const HINTS: readonly { pattern: RegExp; kind: AccountKind; reason: string }[] = [
  {
    pattern: /\b(bank|cash|cheque|checking)\b/i,
    kind: "bank",
    reason: "The description names a cash or bank account.",
  },
  {
    pattern: /\b(receivable|debtors)\b/i,
    kind: "accounts_receivable",
    reason: "The description names amounts owed by customers.",
  },
  {
    pattern: /\b(inventory|stock)\b/i,
    kind: "inventory",
    reason: "The description names goods held for sale.",
  },
  {
    pattern: /\b(prepay|prepaid)\b/i,
    kind: "prepayment",
    reason: "The description names a payment in advance.",
  },
  {
    pattern: /\b(payable|creditors)\b/i,
    kind: "accounts_payable",
    reason: "The description names amounts owed to suppliers.",
  },
  {
    pattern: /\b(credit card|visa|mastercard)\b/i,
    kind: "credit_card",
    reason: "The description names a card account.",
  },
  {
    pattern: /\b(loan|mortgage)\b/i,
    kind: "non_current_liability",
    reason: "The description names borrowing.",
  },
  {
    pattern: /\b(sales|revenue|fees)\b/i,
    kind: "revenue",
    reason: "The description names income from ordinary sales.",
  },
  {
    pattern: /\b(discount|refund|returns)\b/i,
    kind: "contra_revenue",
    reason: "The description reduces sales.",
  },
  {
    pattern: /\b(cogs|cost of sales|purchases)\b/i,
    kind: "cost_of_sales",
    reason: "The description names a direct cost.",
  },
  {
    pattern: /\b(depreciation|amortisation|amortization)\b/i,
    kind: "depreciation",
    reason: "The description names a depreciation charge.",
  },
  {
    pattern: /\b(rent|wages|salary|utilities|software)\b/i,
    kind: "expense",
    reason: "The description names a running cost.",
  },
];

export function suggestAccountFromDescription(description: string): AccountSuggestion[] {
  const text = description.trim();
  if (text.length < 3) return [];
  const matches = HINTS.filter((hint) => hint.pattern.test(text)).map((hint) => ({
    kind: hint.kind,
    label: kindSpec(hint.kind).label,
    reason: hint.reason,
  }));
  return matches.slice(0, 3);
}

export type Misclassification = { accountId: string; message: string };

export function misclassificationFlags(
  accounts: readonly { id: string; name: string; kind: string | null }[],
): Misclassification[] {
  const flags: Misclassification[] = [];
  for (const account of accounts) {
    if (!account.kind || !isAccountKind(account.kind)) continue;
    const accountClass = kindSpec(account.kind).accountClass;
    if (/\brent\b/i.test(account.name) && accountClass === "asset") {
      flags.push({
        accountId: account.id,
        message: `${account.name} is an asset, while rent is usually an expense.`,
      });
    }
  }
  return flags;
}

export function nearDuplicateNames(
  accounts: readonly { id: string; name: string }[],
): { leftId: string; rightId: string; message: string }[] {
  const pairs: { leftId: string; rightId: string; message: string }[] = [];
  const seen = new Map<string, { id: string; name: string }>();
  for (const account of accounts) {
    const key = account.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const prior = seen.get(key);
    if (prior && prior.id !== account.id) {
      pairs.push({
        leftId: prior.id,
        rightId: account.id,
        message: `${prior.name} and ${account.name} look like the same account.`,
      });
    } else {
      seen.set(key, account);
    }
  }
  return pairs;
}

export function externalTypeToKind(raw: string): AccountKind | null {
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
  const aliases: Record<string, AccountKind> = {
    bank: "bank",
    "current asset": "current_asset",
    "accounts receivable": "accounts_receivable",
    inventory: "inventory",
    "fixed asset": "fixed_asset",
    "accounts payable": "accounts_payable",
    "credit card": "credit_card",
    "current liability": "current_liability",
    "non current liability": "non_current_liability",
    equity: "equity",
    revenue: "revenue",
    income: "revenue",
    sales: "revenue",
    "other income": "other_income",
    expense: "expense",
    "direct costs": "cost_of_sales",
    "cost of sales": "cost_of_sales",
    overhead: "overhead",
    depreciation: "depreciation",
  };
  const kind = aliases[value];
  return kind && ACCOUNT_KINDS.includes(kind) ? kind : null;
}
