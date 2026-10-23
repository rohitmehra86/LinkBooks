import type { AccountClass, AccountKind } from "@/lib/accounting/account-kinds";
import { kindSpec } from "@/lib/accounting/account-kinds";

export type ArchiveFacts = {
  isSystem: boolean;
  isControl: boolean;
  isLocked: boolean;
  activeChildCount: number;
  postedDebitMinor: number;
  postedCreditMinor: number;
  activeRecurringInvoice: boolean;
  activeBankRule: boolean;
  /**
   * AC-07. Income and expense accounts never return to a zero balance without a year-end close,
   * so they may be archived when they have no activity in the current financial year.
   * Leave both undefined for the balance-sheet rule (balance must be zero).
   */
  accountClass?: AccountClass;
  currentYearActivityCount?: number;
};

export function archiveDecision(facts: ArchiveFacts): { ok: true } | { ok: false; reason: string } {
  if (facts.isSystem || facts.isControl || facts.isLocked) {
    return { ok: false, reason: "System accounts cannot be archived." };
  }
  if (facts.activeChildCount > 0) {
    return { ok: false, reason: "Archive blocked: this account has active sub-accounts." };
  }
  const isProfitAndLoss = facts.accountClass === "income" || facts.accountClass === "expense";
  if (isProfitAndLoss && facts.currentYearActivityCount !== undefined) {
    if (facts.currentYearActivityCount > 0) {
      return {
        ok: false,
        reason: "Archive blocked: this account has activity in the current financial year.",
      };
    }
  } else if (facts.postedDebitMinor !== facts.postedCreditMinor) {
    return { ok: false, reason: "Archive blocked: the account balance is not zero." };
  }
  if (facts.activeRecurringInvoice) {
    return { ok: false, reason: "Archive blocked: used on an active recurring invoice." };
  }
  if (facts.activeBankRule) {
    return { ok: false, reason: "Archive blocked: used on an active bank rule." };
  }
  return { ok: true };
}

export type LockedFieldSnapshot = {
  isSystem: boolean;
  isControl: boolean;
  isLocked: boolean;
  code: string;
  accountKind: string | null;
  isHeader: boolean;
};

/**
 * Fields a user may not change on a system, control or locked account (AC-03). Mirrors the
 * database triggers so the user gets a plain message instead of a trigger error.
 */
export function lockedFieldChanges(
  existing: LockedFieldSnapshot,
  incoming: { code: string; accountKind: string | null; isHeader: boolean },
): string[] {
  if (!existing.isSystem && !existing.isControl && !existing.isLocked) return [];
  const changed: string[] = [];
  if (incoming.code !== existing.code) changed.push("code");
  if (incoming.accountKind !== existing.accountKind) changed.push("type");
  if (incoming.isHeader !== existing.isHeader) changed.push("header setting");
  return changed;
}

export type MergeLine = {
  accountId: string;
  debitMinor: number;
  creditMinor: number;
  description: string;
};

export function mergeJournalLines(input: {
  sourceId: string;
  targetId: string;
  netMinor: number;
}): MergeLine[] | { error: string } {
  if (input.sourceId === input.targetId)
    return { error: "Choose a different account to merge into." };
  if (input.netMinor === 0) return [];
  const amount = Math.abs(input.netMinor);
  const description = "Merge account balance";
  if (input.netMinor > 0) {
    return [
      { accountId: input.targetId, debitMinor: amount, creditMinor: 0, description },
      { accountId: input.sourceId, debitMinor: 0, creditMinor: amount, description },
    ];
  }
  return [
    { accountId: input.sourceId, debitMinor: amount, creditMinor: 0, description },
    { accountId: input.targetId, debitMinor: 0, creditMinor: amount, description },
  ];
}

export function mergeAllowed(input: {
  sourceClass: AccountClass;
  targetClass: AccountClass;
  sourceSystem: boolean;
  sourceCurrency: string | null;
  targetCurrency: string | null;
}): { ok: true } | { ok: false; reason: string } {
  if (input.sourceSystem) return { ok: false, reason: "System accounts cannot be merged." };
  if (input.sourceClass !== input.targetClass) {
    return { ok: false, reason: "Accounts can only be merged when they share a class." };
  }
  const left = (input.sourceCurrency ?? "").trim().toUpperCase();
  const right = (input.targetCurrency ?? "").trim().toUpperCase();
  if (left && right && left !== right) {
    return { ok: false, reason: "Accounts with different currencies cannot be merged." };
  }
  return { ok: true };
}

export function signedBalance(kind: AccountKind, debitMinor: number, creditMinor: number): number {
  const normal = kindSpec(kind).normalBalance;
  return normal === "debit" ? debitMinor - creditMinor : creditMinor - debitMinor;
}
