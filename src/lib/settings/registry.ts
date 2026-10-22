import { z } from "zod";

/** Settings Centre category ids — information architecture. */
export const SETTINGS_CATEGORIES = [
  "overview",
  "features",
  "organisation",
  "accounting",
  "sales",
  "purchases",
  "banking",
  "dimensions",
  "tax",
  "products",
  "reports",
  "documents",
  "currencies",
  "contacts",
  "expenses",
  "automation",
  "users",
  "integrations",
  "audit",
  "accountant",
  "subscription",
  "demo",
  "notifications",
  "portals",
  "fixed_assets",
  "import_migration",
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export type CategoryMeta = {
  id: SettingsCategory;
  label: string;
  description: string;
  synonyms: string[];
  /** Existing route content reused where true */
  legacyTab?: string;
  moduleLinks?: Array<{ label: string; to: string }>;
  /** Honest availability of the category shell */
  availability: "live" | "partial" | "unavailable";
};

export const categoryMeta: CategoryMeta[] = [
  {
    id: "overview",
    label: "Overview",
    description: "Setup status, security warnings and quick access.",
    synonyms: ["home", "status", "dashboard", "completeness"],
    availability: "live",
  },
  {
    id: "features",
    label: "Feature Manager",
    description: "Enable optional modules with honest availability states.",
    synonyms: ["modules", "toggles", "capabilities", "entitlements"],
    availability: "live",
  },
  {
    id: "organisation",
    label: "Organisation & Branding",
    description: "Legal identity, locale, theme and document identity.",
    synonyms: ["company", "branding", "locale", "timezone", "language"],
    legacyTab: "organisation",
    availability: "partial",
  },
  {
    id: "accounting",
    label: "Accounting & Financial",
    description: "Financial year, lock dates, conversion date and posting warnings.",
    synonyms: ["fy", "financial year", "lock", "closing date", "period locks", "books start"],
    legacyTab: "financial",
    moduleLinks: [{ label: "Accounting periods", to: "/accounting" }],
    availability: "partial",
  },
  {
    id: "sales",
    label: "Sales & Receivables",
    description: "Invoices, quotes, reminders, late fees and receivables defaults.",
    synonyms: ["ar", "invoices", "quotes", "late fees", "reminders", "retainers"],
    moduleLinks: [{ label: "Sales settings", to: "/sales/settings" }],
    availability: "partial",
  },
  {
    id: "purchases",
    label: "Purchases & Payables",
    description: "Bills, purchase orders, approvals and supplier defaults.",
    synonyms: ["ap", "bills", "suppliers", "po", "1099", "inbox"],
    moduleLinks: [
      { label: "Purchases settings", to: "/purchases/settings" },
      { label: "New bill", to: "/purchases/bills/new" },
    ],
    availability: "partial",
  },
  {
    id: "banking",
    label: "Banking & Reconciliation",
    description: "Import formats, rules, tolerances and feed connection state.",
    synonyms: ["bank", "reconcile", "feeds", "csv", "ofx"],
    moduleLinks: [{ label: "Banking", to: "/banking" }],
    availability: "partial",
  },
  {
    id: "dimensions",
    label: "Dimensions & Projects",
    description: "Classes, locations, departments, projects and custom dimensions.",
    synonyms: ["tracking", "class", "location", "department", "cost centre", "project"],
    legacyTab: "dimensions",
    availability: "partial",
  },
  {
    id: "tax",
    label: "Tax & Compliance",
    description: "Tax regimes, rates and regional support matrix.",
    synonyms: ["vat", "gst", "sales tax", "mtd", "bas", "1099"],
    moduleLinks: [{ label: "Tax", to: "/tax" }],
    availability: "partial",
  },
  {
    id: "products",
    label: "Products & Inventory",
    description: "SKUs, pricing, stock and valuation policies.",
    synonyms: ["inventory", "sku", "stock", "cogs", "barcode"],
    moduleLinks: [{ label: "Products & Services", to: "/products-services" }],
    availability: "partial",
  },
  {
    id: "reports",
    label: "Reports & Dashboards",
    description: "Default basis, saved views, packs and schedules.",
    synonyms: ["pnl", "balance sheet", "kpi", "budget", "forecast"],
    moduleLinks: [{ label: "Reports", to: "/reports" }],
    availability: "partial",
  },
  {
    id: "documents",
    label: "Documents & Templates",
    description: "Numbering, branding, themes and PDF defaults.",
    synonyms: ["invoice theme", "pdf", "logo", "numbering", "templates"],
    legacyTab: "documents",
    availability: "partial",
  },
  {
    id: "currencies",
    label: "Currencies & FX",
    description: "Base currency, foreign currencies and exchange rates.",
    synonyms: ["fx", "exchange rate", "multicurrency", "revaluation"],
    legacyTab: "currencies",
    availability: "partial",
  },
  {
    id: "contacts",
    label: "Contacts & CRM",
    description: "Customer and supplier defaults, duplicates and privacy.",
    synonyms: ["customers", "suppliers", "crm", "merge"],
    moduleLinks: [{ label: "Contacts settings", to: "/contacts/settings" }],
    availability: "partial",
  },
  {
    id: "expenses",
    label: "Employee Expenses & Time",
    description: "Claims, mileage, timesheets and reimbursement posting.",
    synonyms: ["expenses", "mileage", "timesheet", "per diem"],
    moduleLinks: [{ label: "Employee expenses", to: "/purchases/employee-expenses" }],
    availability: "partial",
  },
  {
    id: "automation",
    label: "Automation & AI",
    description: "Workflow defaults, AI permissions and safe action controls.",
    synonyms: ["ai", "voice", "rules", "workflow", "recurring"],
    legacyTab: "automation",
    moduleLinks: [{ label: "AI Assistant", to: "/ai-assistant" }],
    availability: "partial",
  },
  {
    id: "users",
    label: "Users & Security",
    description: "Roles, invitations, MFA and access policies.",
    synonyms: ["roles", "mfa", "sso", "permissions", "invite", "privacy"],
    legacyTab: "users",
    availability: "partial",
  },
  {
    id: "integrations",
    label: "Integrations & API",
    description: "Catalogue of connections with honest status.",
    synonyms: ["api", "webhook", "oauth", "bank feed", "gateway"],
    legacyTab: "integrations",
    availability: "partial",
  },
  {
    id: "audit",
    label: "Audit & Data Management",
    description: "Configuration history, exports and retention.",
    synonyms: ["audit log", "export", "backup", "retention"],
    legacyTab: "audit",
    availability: "partial",
  },
  {
    id: "accountant",
    label: "Accountant & Firm",
    description: "Practice tools, client templates and adviser access.",
    synonyms: ["firm", "practice", "advisor", "pbc", "workpapers"],
    moduleLinks: [
      { label: "Accountant", to: "/accountant" },
      { label: "Firm", to: "/firm" },
    ],
    availability: "partial",
  },
  {
    id: "subscription",
    label: "Subscription & Usage",
    description: "Plan, seats and entitlements.",
    synonyms: ["billing", "plan", "seats", "quota"],
    availability: "unavailable",
  },
  {
    id: "demo",
    label: "Demo & Developer",
    description: "Demo company reset and diagnostics.",
    synonyms: ["sample data", "reset", "developer"],
    legacyTab: "demo",
    availability: "partial",
  },
  {
    id: "notifications",
    label: "Notifications & Communications",
    description: "Email identity, digests and channel preferences.",
    synonyms: ["email", "bcc", "dkim", "digest", "sms"],
    availability: "unavailable",
  },
  {
    id: "portals",
    label: "Customer & Supplier Portals",
    description: "Client and supplier self-service portals.",
    synonyms: ["portal", "client login", "pay online"],
    availability: "unavailable",
  },
  {
    id: "fixed_assets",
    label: "Fixed Assets & Depreciation",
    description: "Asset register, methods and depreciation runs.",
    synonyms: ["depreciation", "capex", "asset register"],
    availability: "unavailable",
  },
  {
    id: "import_migration",
    label: "Import & Migration",
    description: "Guided migration from other accounting systems.",
    synonyms: ["xero", "quickbooks", "zoho", "csv", "import"],
    availability: "partial",
  },
];

export const searchSynonyms: Record<string, SettingsCategory[]> = {
  vat: ["tax"],
  gst: ["tax"],
  "closing date": ["accounting"],
  "lock date": ["accounting"],
  "period lock": ["accounting"],
  mfa: ["users"],
  sso: ["users"],
  webhook: ["integrations"],
  class: ["dimensions", "features"],
  location: ["dimensions", "features"],
  project: ["dimensions", "features"],
};

export function searchSettings(query: string): CategoryMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return categoryMeta;
  const synonymHits = new Set<SettingsCategory>();
  for (const [syn, cats] of Object.entries(searchSynonyms)) {
    if (syn.includes(q) || q.includes(syn)) cats.forEach((c) => synonymHits.add(c));
  }
  return categoryMeta.filter((c) => {
    if (synonymHits.has(c.id)) return true;
    if (c.label.toLowerCase().includes(q)) return true;
    if (c.description.toLowerCase().includes(q)) return true;
    return c.synonyms.some((s) => s.toLowerCase().includes(q) || q.includes(s.toLowerCase()));
  });
}

/** Typed config documents stored in organisation_config */
export const accountingConfigSchema = z.object({
  reporting_basis: z.enum(["accrual", "cash"]).default("accrual"),
  warn_duplicate_document_numbers: z.boolean().default(true),
  warn_post_to_control_account: z.boolean().default(true),
  warn_bank_direct_posting: z.boolean().default(true),
  warn_backdated_days: z.number().int().min(0).max(3650).default(90),
  auto_apply_credits: z.boolean().default(false),
  account_code_padding: z.number().int().min(0).max(8).default(0),
});

export const salesConfigSchema = z.object({
  late_fees_enabled: z.boolean().default(false),
  late_fee_type: z.enum(["fixed", "percentage"]).default("percentage"),
  late_fee_amount: z.number().min(0).default(0),
  late_fee_grace_days: z.number().int().min(0).max(90).default(7),
  late_fee_compounding: z.boolean().default(false),
  reminders_enabled: z.boolean().default(false),
  reminder_days_before: z.array(z.number().int()).default([-7, -3]),
  reminder_days_after: z.array(z.number().int()).default([1, 7, 14]),
  allow_partial_payments: z.boolean().default(true),
  write_off_threshold_minor: z.number().int().min(0).default(0),
  retainers_enabled: z.boolean().default(false),
});

export const purchasesConfigSchema = z.object({
  show_supplier_summary_default: z.boolean().default(true),
  bills_inbox_enabled: z.boolean().default(false),
  approval_threshold_minor: z.number().int().min(0).nullable().default(null),
  duplicate_detection: z.boolean().default(true),
  three_way_matching: z.boolean().default(false),
  contractor_1099_tracking: z.boolean().default(false),
});

export const bankingConfigSchema = z.object({
  auto_apply_rules: z.boolean().default(false),
  rule_confidence_threshold: z.number().min(0).max(1).default(0.85),
  reconciliation_tolerance_minor: z.number().int().min(0).default(0),
  import_formats: z.array(z.enum(["csv", "ofx", "qif", "mt940", "camt"])).default(["csv"]),
});

export const notificationsConfigSchema = z.object({
  email_from_name: z.string().max(120).default(""),
  reply_to: z.string().email().or(z.literal("")).default(""),
  quiet_hours_enabled: z.boolean().default(false),
});

export const reportsConfigSchema = z.object({
  default_basis: z.enum(["accrual", "cash"]).default("accrual"),
  default_comparison: z.enum(["none", "prior_period", "prior_year"]).default("none"),
});

export const productsConfigSchema = z.object({
  track_inventory: z.boolean().default(false),
  allow_negative_stock: z.boolean().default(false),
  valuation_method: z.enum(["fifo", "average", "standard"]).default("average"),
});

export const automationConfigSchema = z.object({
  ai_mode: z.enum(["off", "read_only", "suggest", "draft", "execute_with_approval"]).default("off"),
  voice_commands: z.boolean().default(false),
});

export const usersSecurityConfigSchema = z.object({
  force_mfa_for_owners: z.boolean().default(false),
  session_idle_minutes: z.number().int().min(5).max(1440).default(480),
  support_access_consent: z.boolean().default(false),
});

export const CATEGORY_SCHEMAS: Partial<Record<SettingsCategory, z.ZodType>> = {
  accounting: accountingConfigSchema,
  sales: salesConfigSchema,
  purchases: purchasesConfigSchema,
  banking: bankingConfigSchema,
  notifications: notificationsConfigSchema,
  reports: reportsConfigSchema,
  products: productsConfigSchema,
  automation: automationConfigSchema,
  users: usersSecurityConfigSchema,
};

export function defaultDocumentFor(category: SettingsCategory): Record<string, unknown> {
  const schema = CATEGORY_SCHEMAS[category];
  if (!schema) return {};
  const parsed = schema.safeParse({});
  return (parsed.success ? parsed.data : {}) as Record<string, unknown>;
}
