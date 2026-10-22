import { describe, expect, it } from "vitest";
import { evaluateSettingsChange } from "./dependency-engine";

describe("dependency engine", () => {
  it("blocks base currency change after postings", () => {
    const r = evaluateSettingsChange({
      changeType: "change_base_currency",
      context: { hasPostedJournals: true },
    });
    expect(r.verdict).toBe("blocked");
  });

  it("blocks multicurrency disable when FX balances exist", () => {
    const r = evaluateSettingsChange({
      changeType: "disable_feature",
      featureKey: "multicurrency",
      context: { foreignCurrencyBalances: 2 },
    });
    expect(r.verdict).toBe("blocked");
  });

  it("preserves history warning when disabling classes", () => {
    const r = evaluateSettingsChange({
      changeType: "disable_feature",
      featureKey: "classes",
      context: { dimensionAssignments: 12 },
    });
    expect(r.verdict).toBe("allowed_with_warnings");
    expect(r.explanation).toMatch(/preserved/i);
  });

  it("does not auto-approve when disabling approvals", () => {
    const r = evaluateSettingsChange({
      changeType: "disable_approvals",
      context: { pendingApprovals: 3 },
    });
    expect(r.verdict).toBe("allowed_with_warnings");
    expect(r.explanation).toMatch(/does not auto-approve/i);
  });

  it("requires periods.lock for lock policy changes", () => {
    const r = evaluateSettingsChange({ changeType: "change_lock_policy" });
    expect(r.requiredPermission).toBe("periods.lock");
  });
});
