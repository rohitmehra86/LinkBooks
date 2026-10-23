/**
 * AC-08: reading the plan returned by `preview_account_merge`. The database decides the plan (one journal
 * per accounting period, dated inside that period); this module turns it into what the screen can say and
 * whether the merge may go ahead.
 */

export type MergePlanPeriod = {
  period_id: string;
  period_name: string;
  journal_date: string;
  /** Source net in base currency minor units: >0 debit balance moves to the target. */
  net_minor: number;
  locked: boolean;
  lock_reason: string | null;
};

export type MergePlan = {
  source: { id: string; code: string; name: string };
  target: { id: string; code: string; name: string };
  periods: MergePlanPeriod[];
  total_net_minor: number;
  locked_count: number;
  today: string;
};

export type MergeAssessment = {
  /** Number of journals the merge will post. */
  journalCount: number;
  /** Periods that cannot take a dated journal. */
  lockedPeriods: MergePlanPeriod[];
  /** True when nothing blocks the merge (given the locked-period choice). */
  canMerge: boolean;
  /** Nothing to move: the source has no balance in any period. */
  nothingToMove: boolean;
  /** Why it cannot proceed, when it cannot. */
  blockedReason: string | null;
};

export function assessMergePlan(plan: MergePlan, postLockedToday: boolean): MergeAssessment {
  const lockedPeriods = plan.periods.filter((p) => p.locked);
  const open = plan.periods.length - lockedPeriods.length;
  const lockedNet = lockedPeriods.reduce((s, p) => s + p.net_minor, 0);
  const journalCount = open + (postLockedToday && lockedNet !== 0 ? 1 : 0);
  if (lockedPeriods.length > 0 && !postLockedToday) {
    return {
      journalCount,
      lockedPeriods,
      canMerge: false,
      nothingToMove: plan.periods.length === 0,
      blockedReason: `${lockedPeriods.map((p) => p.period_name).join(", ")} ${
        lockedPeriods.length === 1 ? "is" : "are"
      } locked. Unlock ${lockedPeriods.length === 1 ? "it" : "them"}, or accept posting ${
        lockedPeriods.length === 1 ? "its" : "their"
      } share dated ${plan.today}.`,
    };
  }
  return {
    journalCount,
    lockedPeriods,
    canMerge: true,
    nothingToMove: plan.periods.length === 0,
    blockedReason: null,
  };
}
