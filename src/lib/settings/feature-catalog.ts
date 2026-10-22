/** Universal Feature Manager catalogue — implementation status is honest. */

export type FeatureImplStatus = "unavailable" | "available" | "beta";

export type FeatureDefinition = {
  key: string;
  label: string;
  description: string;
  /** Product implementation readiness (not org enablement) */
  implementation: FeatureImplStatus;
  /** Config category required when enabled */
  requiresConfigCategory?: string;
  dependencies?: string[];
  consumerModules: string[];
  /** Historical data preserved when disabled */
  preservesHistory: boolean;
};

export const FEATURE_CATALOG: FeatureDefinition[] = [
  {
    key: "classes",
    label: "Classes",
    description: "Track income and expenses by class / tracking category.",
    implementation: "available",
    consumerModules: ["sales", "purchases", "reports"],
    preservesHistory: true,
  },
  {
    key: "locations",
    label: "Locations",
    description: "Track by location on documents and lines.",
    implementation: "available",
    consumerModules: ["sales", "purchases", "reports"],
    preservesHistory: true,
  },
  {
    key: "projects",
    label: "Projects",
    description: "Project allocation on transactions.",
    implementation: "available",
    consumerModules: ["purchases", "sales", "reports"],
    preservesHistory: true,
  },
  {
    key: "departments",
    label: "Departments",
    description: "Department dimension.",
    implementation: "available",
    consumerModules: ["purchases", "sales", "reports"],
    preservesHistory: true,
  },
  {
    key: "cost_centres",
    label: "Cost centres",
    description: "Cost centre dimension.",
    implementation: "available",
    consumerModules: ["purchases", "sales", "reports"],
    preservesHistory: true,
  },
  {
    key: "branches",
    label: "Branches",
    description: "Branch dimension.",
    implementation: "available",
    consumerModules: ["purchases", "sales", "reports"],
    preservesHistory: true,
  },
  {
    key: "custom_dimensions",
    label: "Custom dimensions",
    description: "Additional custom tracking dimensions.",
    implementation: "available",
    consumerModules: ["purchases", "sales", "reports"],
    preservesHistory: true,
  },
  {
    key: "purchase_orders",
    label: "Purchase orders",
    description: "Raise and convert purchase orders.",
    implementation: "available",
    consumerModules: ["purchases"],
    preservesHistory: true,
  },
  {
    key: "sales_orders",
    label: "Sales orders",
    description: "Sales order workflow.",
    implementation: "unavailable",
    consumerModules: ["sales"],
    preservesHistory: true,
  },
  {
    key: "billable_expenses",
    label: "Billable expenses",
    description: "Mark purchase lines billable to customers.",
    implementation: "available",
    consumerModules: ["purchases", "sales"],
    preservesHistory: true,
  },
  {
    key: "discounts",
    label: "Discounts",
    description: "Document and line discounts.",
    implementation: "available",
    consumerModules: ["sales", "purchases"],
    preservesHistory: true,
  },
  {
    key: "inventory",
    label: "Inventory",
    description: "Stock tracking and valuation.",
    implementation: "beta",
    requiresConfigCategory: "products",
    consumerModules: ["products"],
    preservesHistory: true,
  },
  {
    key: "recurring_transactions",
    label: "Recurring transactions",
    description: "Recurring invoices and bills.",
    implementation: "available",
    consumerModules: ["sales", "purchases"],
    preservesHistory: true,
  },
  {
    key: "multicurrency",
    label: "Multicurrency",
    description: "Foreign currencies and FX rates.",
    implementation: "available",
    consumerModules: ["sales", "purchases", "accounting"],
    preservesHistory: true,
  },
  {
    key: "voice_commands",
    label: "Voice commands",
    description: "Voice input for common actions.",
    implementation: "unavailable",
    consumerModules: ["automation"],
    preservesHistory: true,
  },
  {
    key: "ai_assistant",
    label: "AI Assistant",
    description: "AI guidance with permission-scoped actions.",
    implementation: "beta",
    requiresConfigCategory: "automation",
    consumerModules: ["automation"],
    preservesHistory: true,
  },
  {
    key: "advanced_approvals",
    label: "Advanced approvals",
    description: "Bill and document approval workflows.",
    implementation: "available",
    consumerModules: ["purchases"],
    preservesHistory: true,
  },
  {
    key: "time_tracking",
    label: "Time tracking",
    description: "Timesheets and billable rates.",
    implementation: "unavailable",
    consumerModules: ["expenses"],
    preservesHistory: true,
  },
  {
    key: "fixed_assets",
    label: "Fixed assets",
    description: "Asset register and depreciation.",
    implementation: "unavailable",
    consumerModules: ["fixed_assets"],
    preservesHistory: true,
  },
  {
    key: "portals",
    label: "Portals",
    description: "Customer and supplier portals.",
    implementation: "unavailable",
    consumerModules: ["portals"],
    preservesHistory: true,
  },
  {
    key: "late_fees",
    label: "Late fees",
    description: "Automatic late fee invoices after grace period.",
    implementation: "beta",
    requiresConfigCategory: "sales",
    consumerModules: ["sales"],
    preservesHistory: true,
  },
  {
    key: "retainers",
    label: "Retainers",
    description: "Retainer invoices and draw-downs.",
    implementation: "unavailable",
    consumerModules: ["sales"],
    preservesHistory: true,
  },
  {
    key: "price_lists",
    label: "Price lists",
    description: "Customer-specific and volume pricing.",
    implementation: "unavailable",
    consumerModules: ["products"],
    preservesHistory: true,
  },
];

export type FeatureStateCode =
  | "unavailable"
  | "available_disabled"
  | "enabled_needs_config"
  | "enabled_operational"
  | "restricted";

export type ComputedFeatureState = {
  key: string;
  label: string;
  description: string;
  state: FeatureStateCode;
  enabled: boolean;
  implementation: FeatureImplStatus;
  reason?: string;
  consumerModules: string[];
  preservesHistory: boolean;
};

export function computeFeatureState(
  def: FeatureDefinition,
  opts: {
    enabled: boolean;
    canEdit: boolean;
    configComplete?: boolean;
    entitlementBlocked?: boolean;
  },
): ComputedFeatureState {
  if (def.implementation === "unavailable") {
    return {
      key: def.key,
      label: def.label,
      description: def.description,
      state: "unavailable",
      enabled: false,
      implementation: def.implementation,
      reason: "Not implemented in LinkBooks yet",
      consumerModules: def.consumerModules,
      preservesHistory: def.preservesHistory,
    };
  }
  if (opts.entitlementBlocked) {
    return {
      key: def.key,
      label: def.label,
      description: def.description,
      state: "restricted",
      enabled: false,
      implementation: def.implementation,
      reason: "Restricted by plan entitlement",
      consumerModules: def.consumerModules,
      preservesHistory: def.preservesHistory,
    };
  }
  if (!opts.canEdit && !opts.enabled) {
    return {
      key: def.key,
      label: def.label,
      description: def.description,
      state: "restricted",
      enabled: false,
      implementation: def.implementation,
      reason: "You do not have permission to enable this feature",
      consumerModules: def.consumerModules,
      preservesHistory: def.preservesHistory,
    };
  }
  if (!opts.enabled) {
    return {
      key: def.key,
      label: def.label,
      description: def.description,
      state: "available_disabled",
      enabled: false,
      implementation: def.implementation,
      consumerModules: def.consumerModules,
      preservesHistory: def.preservesHistory,
    };
  }
  if (def.requiresConfigCategory && opts.configComplete === false) {
    return {
      key: def.key,
      label: def.label,
      description: def.description,
      state: "enabled_needs_config",
      enabled: true,
      implementation: def.implementation,
      reason: `Configuration required in ${def.requiresConfigCategory}`,
      consumerModules: def.consumerModules,
      preservesHistory: def.preservesHistory,
    };
  }
  return {
    key: def.key,
    label: def.label,
    description: def.description,
    state: "enabled_operational",
    enabled: true,
    implementation: def.implementation,
    consumerModules: def.consumerModules,
    preservesHistory: def.preservesHistory,
  };
}
