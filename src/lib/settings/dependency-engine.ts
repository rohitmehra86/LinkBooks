export type DependencyVerdict = "blocked" | "allowed_with_warnings" | "allowed";

export type DependencyResult = {
  verdict: DependencyVerdict;
  explanation: string;
  affectedRecordsEstimate: number | null;
  requiredPermission: string;
  confirmationText: string | null;
  warnings: string[];
};

type EvalInput = {
  changeType:
    | "disable_feature"
    | "enable_feature"
    | "change_lock_policy"
    | "change_base_currency"
    | "change_fy"
    | "change_tax"
    | "change_inventory_valuation"
    | "disable_approvals"
    | "downgrade_plan";
  featureKey?: string;
  context?: {
    foreignCurrencyBalances?: number;
    openFxDocuments?: number;
    openPurchaseOrders?: number;
    pendingApprovals?: number;
    hasPostedJournals?: boolean;
    dimensionAssignments?: number;
  };
};

/**
 * Pure rules engine — evaluates proposed settings changes.
 * Server functions enrich with live counts before calling this.
 */
export function evaluateSettingsChange(input: EvalInput): DependencyResult {
  const ctx = input.context ?? {};

  if (input.changeType === "change_base_currency") {
    if (ctx.hasPostedJournals) {
      return {
        verdict: "blocked",
        explanation: "Base currency cannot change after journals have been posted.",
        affectedRecordsEstimate: null,
        requiredPermission: "company.settings.edit",
        confirmationText: null,
        warnings: [],
      };
    }
    return allowed("Base currency can be set before the first posting.", "company.settings.edit");
  }

  if (input.changeType === "disable_feature" && input.featureKey === "multicurrency") {
    const fx = (ctx.foreignCurrencyBalances ?? 0) + (ctx.openFxDocuments ?? 0);
    if (fx > 0) {
      return {
        verdict: "blocked",
        explanation:
          "Multicurrency cannot be disabled while foreign-currency balances or open FX documents exist.",
        affectedRecordsEstimate: fx,
        requiredPermission: "company.settings.edit",
        confirmationText: null,
        warnings: [],
      };
    }
    return {
      verdict: "allowed_with_warnings",
      explanation: "Disabling multicurrency hides foreign currency selectors on new documents.",
      affectedRecordsEstimate: 0,
      requiredPermission: "company.settings.edit",
      confirmationText: "Disable multicurrency for new transactions?",
      warnings: ["Historical foreign-currency journals remain unchanged."],
    };
  }

  if (
    input.changeType === "disable_feature" &&
    ["classes", "locations", "projects", "departments", "cost_centres", "branches", "custom_dimensions"].includes(
      input.featureKey ?? "",
    )
  ) {
    return {
      verdict: "allowed_with_warnings",
      explanation:
        "Disabling this dimension hides it on new forms. Historical assignments and reports are preserved.",
      affectedRecordsEstimate: ctx.dimensionAssignments ?? null,
      requiredPermission: "company.settings.edit",
      confirmationText: `Disable ${input.featureKey}? Historical data will be kept.`,
      warnings: ["Existing reports that filter by this dimension remain valid."],
    };
  }

  if (input.changeType === "disable_feature" && input.featureKey === "purchase_orders") {
    const open = ctx.openPurchaseOrders ?? 0;
    if (open > 0) {
      return {
        verdict: "allowed_with_warnings",
        explanation: "Open purchase order commitments are preserved; new POs will be blocked.",
        affectedRecordsEstimate: open,
        requiredPermission: "company.settings.edit",
        confirmationText: `Disable purchase orders? ${open} open PO(s) will remain.`,
        warnings: ["Complete or cancel open POs when ready."],
      };
    }
    return allowed("Purchase orders can be disabled.", "company.settings.edit");
  }

  if (input.changeType === "disable_approvals") {
    const pending = ctx.pendingApprovals ?? 0;
    if (pending > 0) {
      return {
        verdict: "allowed_with_warnings",
        explanation:
          "Disabling approvals does not auto-approve pending documents. Route or complete them explicitly.",
        affectedRecordsEstimate: pending,
        requiredPermission: "company.settings.edit",
        confirmationText: `Disable approvals with ${pending} pending item(s)?`,
        warnings: ["Pending items stay in their current status."],
      };
    }
    return allowed("Approvals can be disabled.", "company.settings.edit");
  }

  if (input.changeType === "change_inventory_valuation") {
    return {
      verdict: "allowed_with_warnings",
      explanation: "Valuation method applies to future movements only. Historical COGS is not rewritten.",
      affectedRecordsEstimate: null,
      requiredPermission: "company.settings.edit",
      confirmationText: "Change inventory valuation for future movements?",
      warnings: ["Posted COGS journals remain immutable."],
    };
  }

  if (input.changeType === "change_tax") {
    return {
      verdict: "allowed_with_warnings",
      explanation: "Tax rate changes are effective-dated. Posted tax entries are never rewritten.",
      affectedRecordsEstimate: null,
      requiredPermission: "company.settings.edit",
      confirmationText: "Save tax configuration changes?",
      warnings: ["Use effective dates for rate changes."],
    };
  }

  if (input.changeType === "change_lock_policy") {
    return {
      verdict: "allowed_with_warnings",
      explanation: "Lock dates block posting in UI, API, import, AI and automation paths equally.",
      affectedRecordsEstimate: null,
      requiredPermission: "periods.lock",
      confirmationText: "Update lock dates? This is audited and requires a reason.",
      warnings: ["Adviser exception lock still blocks non-advisers."],
    };
  }

  if (input.changeType === "change_fy") {
    return {
      verdict: "allowed_with_warnings",
      explanation: "Changing the financial year does not alter finalised reports or posted journals.",
      affectedRecordsEstimate: null,
      requiredPermission: "company.settings.edit",
      confirmationText: "Update financial year end?",
      warnings: ["Regenerate open periods carefully after changing FY."],
    };
  }

  if (input.changeType === "downgrade_plan") {
    return {
      verdict: "allowed_with_warnings",
      explanation: "Downgrade will make some features read-only. Review the impact list before confirming.",
      affectedRecordsEstimate: null,
      requiredPermission: "company.settings.edit",
      confirmationText: "Confirm plan downgrade?",
      warnings: ["Posted accounting data is never deleted by a downgrade."],
    };
  }

  return allowed("Change is permitted.", "company.settings.edit");
}

function allowed(explanation: string, permission: string): DependencyResult {
  return {
    verdict: "allowed",
    explanation,
    affectedRecordsEstimate: 0,
    requiredPermission: permission,
    confirmationText: null,
    warnings: [],
  };
}
