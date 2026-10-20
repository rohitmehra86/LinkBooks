/**
 * Authoritative industry CoA catalogue (Level B/C).
 * Level A remains `seed_default_chart_of_accounts` (system control accounts).
 * Codes avoid colliding with core 1000–3200 / 4000–6900 / 7700–7730 where possible;
 * shared roles (AR/AP) are matched by controlRole, not duplicated.
 */

import type { IndustryDef, LibraryAccount } from "./types";

function acc(
  partial: Omit<LibraryAccount, "normalBalance" | "cashFlowClass"> &
    Partial<Pick<LibraryAccount, "normalBalance" | "cashFlowClass">>,
): LibraryAccount {
  const nb =
    partial.normalBalance ??
    (partial.accountType === "asset" || partial.accountType === "expense" ? "debit" : "credit");
  const cf =
    partial.cashFlowClass ??
    (partial.fsLine === "current_assets" && partial.subtype.includes("bank")
      ? "cash"
      : partial.fsLine.startsWith("non_current") && partial.accountType === "asset"
        ? "investing"
        : partial.fsLine.includes("liabilit") || partial.fsLine === "equity"
          ? partial.accountType === "liability" && partial.subtype.includes("loan")
            ? "financing"
            : "none"
          : "operating");
  return { normalBalance: nb, cashFlowClass: cf, ...partial };
}

/** Shared optional / recommended accounts (deduped across industries). */
export const LIBRARY_ACCOUNTS: LibraryAccount[] = [
  // —— Revenue / contra ——
  acc({
    key: "rev_service",
    code: "4010",
    name: "Service Revenue",
    description: "Fees for professional or personal services.",
    accountType: "income",
    subtype: "income",
    fsLine: "revenue",
    recommendation: "recommended",
    whyRecommended: "Separates service income from product sales for clearer P&L.",
  }),
  acc({
    key: "rev_subscription",
    code: "4020",
    name: "Subscription Revenue",
    description: "Recurring SaaS or membership income.",
    accountType: "income",
    subtype: "income",
    fsLine: "revenue",
    recommendation: "recommended",
  }),
  acc({
    key: "rev_marketplace",
    code: "4030",
    name: "Marketplace Gross Sales",
    description: "Gross sales before marketplace fees (Amazon, Shopify, etc.).",
    accountType: "income",
    subtype: "income",
    fsLine: "revenue",
    recommendation: "recommended",
  }),
  acc({
    key: "rev_rental",
    code: "4040",
    name: "Rental Income",
    description: "Lease or short-term rental receipts.",
    accountType: "income",
    subtype: "income",
    fsLine: "revenue",
    recommendation: "recommended",
  }),
  acc({
    key: "rev_patient",
    code: "4050",
    name: "Patient / Clinical Revenue",
    description: "Healthcare service billings.",
    accountType: "income",
    subtype: "income",
    fsLine: "revenue",
    recommendation: "recommended",
  }),
  acc({
    key: "rev_project",
    code: "4060",
    name: "Contract / Project Revenue",
    description: "Construction or project milestone revenue.",
    accountType: "income",
    subtype: "income",
    fsLine: "revenue",
    recommendation: "recommended",
  }),
  acc({
    key: "rev_food",
    code: "4070",
    name: "Food & Beverage Sales",
    description: "Restaurant, cafe or catering sales.",
    accountType: "income",
    subtype: "income",
    fsLine: "revenue",
    recommendation: "recommended",
  }),
  acc({
    key: "rev_tuition",
    code: "4080",
    name: "Tuition & Course Fees",
    description: "Education and training fees.",
    accountType: "income",
    subtype: "income",
    fsLine: "revenue",
    recommendation: "recommended",
  }),
  acc({
    key: "rev_freight",
    code: "4090",
    name: "Freight & Logistics Revenue",
    description: "Transport, courier or warehousing charges.",
    accountType: "income",
    subtype: "income",
    fsLine: "revenue",
    recommendation: "recommended",
  }),
  acc({
    key: "contra_refunds",
    code: "4900",
    name: "Sales Returns & Refunds",
    description: "Contra-revenue for returns and refunds.",
    accountType: "income",
    normalBalance: "debit",
    subtype: "contra_revenue",
    fsLine: "contra_revenue",
    recommendation: "recommended",
  }),
  acc({
    key: "contra_discounts",
    code: "4910",
    name: "Sales Discounts",
    description: "Discounts given to customers.",
    accountType: "income",
    normalBalance: "debit",
    subtype: "contra_revenue",
    fsLine: "contra_revenue",
    recommendation: "optional",
  }),

  // —— COGS ——
  acc({
    key: "cogs_materials",
    code: "5010",
    name: "Materials & Inventory Cost",
    description: "Cost of goods sold — materials.",
    accountType: "expense",
    subtype: "cogs",
    fsLine: "cost_of_sales",
    recommendation: "recommended",
  }),
  acc({
    key: "cogs_marketplace_fees",
    code: "5020",
    name: "Marketplace Commissions & Fees",
    description: "Platform selling fees and commissions.",
    accountType: "expense",
    subtype: "cogs",
    fsLine: "cost_of_sales",
    recommendation: "recommended",
  }),
  acc({
    key: "cogs_fulfilment",
    code: "5030",
    name: "Fulfilment & Shipping Cost",
    description: "Outbound fulfilment and shipping.",
    accountType: "expense",
    subtype: "cogs",
    fsLine: "cost_of_sales",
    recommendation: "recommended",
  }),
  acc({
    key: "cogs_subcontract",
    code: "5040",
    name: "Subcontractor Costs",
    description: "Direct subcontract labour on projects.",
    accountType: "expense",
    subtype: "cogs",
    fsLine: "cost_of_sales",
    recommendation: "recommended",
  }),
  acc({
    key: "cogs_food",
    code: "5050",
    name: "Food & Beverage Cost",
    description: "Direct food cost of sales.",
    accountType: "expense",
    subtype: "cogs",
    fsLine: "cost_of_sales",
    recommendation: "recommended",
  }),
  acc({
    key: "cogs_landed",
    code: "5060",
    name: "Landed Cost & Import Duties",
    description: "Freight-in, customs and landed cost allocation.",
    accountType: "expense",
    subtype: "cogs",
    fsLine: "cost_of_sales",
    recommendation: "optional",
  }),

  // —— Operating expenses ——
  acc({
    key: "exp_wages",
    code: "6300",
    name: "Wages & Salaries",
    description: "Employee compensation.",
    accountType: "expense",
    subtype: "expense",
    fsLine: "operating_expense",
    recommendation: "recommended",
  }),
  acc({
    key: "exp_rent",
    code: "6310",
    name: "Rent & Occupancy",
    description: "Premises rent and occupancy costs.",
    accountType: "expense",
    subtype: "expense",
    fsLine: "operating_expense",
    recommendation: "recommended",
  }),
  acc({
    key: "exp_utilities",
    code: "6320",
    name: "Utilities",
    description: "Power, water, internet.",
    accountType: "expense",
    subtype: "expense",
    fsLine: "operating_expense",
    recommendation: "optional",
  }),
  acc({
    key: "exp_marketing",
    code: "6330",
    name: "Marketing & Advertising",
    description: "Paid ads, marketplace ads and campaigns.",
    accountType: "expense",
    subtype: "expense",
    fsLine: "operating_expense",
    recommendation: "recommended",
  }),
  acc({
    key: "exp_software",
    code: "6340",
    name: "Software & Subscriptions",
    description: "SaaS tools and software licences.",
    accountType: "expense",
    subtype: "expense",
    fsLine: "operating_expense",
    recommendation: "recommended",
  }),
  acc({
    key: "exp_insurance",
    code: "6350",
    name: "Insurance",
    description: "Business and professional insurance.",
    accountType: "expense",
    subtype: "expense",
    fsLine: "operating_expense",
    recommendation: "optional",
  }),
  acc({
    key: "exp_professional",
    code: "6360",
    name: "Professional Fees",
    description: "Legal, accounting and advisory fees.",
    accountType: "expense",
    subtype: "expense",
    fsLine: "operating_expense",
    recommendation: "recommended",
  }),
  acc({
    key: "exp_travel",
    code: "6370",
    name: "Travel & Entertainment",
    description: "Business travel and client entertainment.",
    accountType: "expense",
    subtype: "expense",
    fsLine: "operating_expense",
    recommendation: "optional",
  }),
  acc({
    key: "exp_vehicle",
    code: "6380",
    name: "Vehicle & Fuel",
    description: "Fleet and vehicle running costs.",
    accountType: "expense",
    subtype: "expense",
    fsLine: "operating_expense",
    recommendation: "optional",
  }),
  acc({
    key: "exp_repairs",
    code: "6390",
    name: "Repairs & Maintenance",
    description: "Property and equipment maintenance.",
    accountType: "expense",
    subtype: "expense",
    fsLine: "operating_expense",
    recommendation: "optional",
  }),
  acc({
    key: "exp_storage",
    code: "6400",
    name: "Storage & Warehouse Fees",
    description: "3PL storage and warehouse charges.",
    accountType: "expense",
    subtype: "expense",
    fsLine: "operating_expense",
    recommendation: "optional",
  }),
  acc({
    key: "exp_medical_supplies",
    code: "6410",
    name: "Medical Supplies",
    description: "Clinical consumables.",
    accountType: "expense",
    subtype: "expense",
    fsLine: "operating_expense",
    recommendation: "recommended",
  }),
  acc({
    key: "exp_interest",
    code: "6500",
    name: "Interest Expense",
    description: "Interest on borrowings.",
    accountType: "expense",
    subtype: "expense",
    fsLine: "finance_cost",
    recommendation: "optional",
  }),

  // —— Assets ——
  acc({
    key: "asset_clearing_marketplace",
    code: "1160",
    name: "Marketplace Settlement Clearing",
    description: "Amounts due from marketplaces pending payout.",
    accountType: "asset",
    subtype: "current_asset",
    fsLine: "current_assets",
    recommendation: "recommended",
    whyRecommended: "Tracks unsettled marketplace payouts without mixing into bank.",
  }),
  acc({
    key: "asset_deposits",
    code: "1170",
    name: "Security Deposits",
    description: "Refundable deposits held.",
    accountType: "asset",
    subtype: "current_asset",
    fsLine: "current_assets",
    recommendation: "optional",
  }),
  acc({
    key: "asset_wip",
    code: "1180",
    name: "Work in Progress",
    description: "Unbilled project or manufacturing WIP.",
    accountType: "asset",
    subtype: "current_asset",
    fsLine: "current_assets",
    recommendation: "recommended",
  }),
  acc({
    key: "asset_vehicles",
    code: "1520",
    name: "Vehicles",
    description: "Owned vehicles at cost.",
    accountType: "asset",
    subtype: "non_current_asset",
    fsLine: "non_current_assets",
    cashFlowClass: "investing",
    recommendation: "optional",
  }),
  acc({
    key: "asset_investment_property",
    code: "1530",
    name: "Investment Property",
    description: "Rental property held for investment.",
    accountType: "asset",
    subtype: "non_current_asset",
    fsLine: "non_current_assets",
    cashFlowClass: "investing",
    recommendation: "recommended",
  }),

  // —— Liabilities ——
  acc({
    key: "liab_deferred_revenue",
    code: "2320",
    name: "Deferred Revenue",
    description: "Unearned subscription or prepaid customer funds.",
    accountType: "liability",
    subtype: "current_liability",
    fsLine: "current_liabilities",
    recommendation: "recommended",
  }),
  acc({
    key: "liab_customer_deposits",
    code: "2330",
    name: "Customer Deposits",
    description: "Deposits held for customers or tenants.",
    accountType: "liability",
    subtype: "current_liability",
    fsLine: "current_liabilities",
    recommendation: "optional",
  }),
  acc({
    key: "liab_payroll",
    code: "2340",
    name: "Payroll Liabilities",
    description: "Wages and payroll taxes payable.",
    accountType: "liability",
    subtype: "current_liability",
    fsLine: "current_liabilities",
    recommendation: "feature_dependent",
  }),
  acc({
    key: "liab_lease",
    code: "2510",
    name: "Lease Liabilities",
    description: "Long-term lease obligations.",
    accountType: "liability",
    subtype: "non_current_liability",
    fsLine: "non_current_liabilities",
    cashFlowClass: "financing",
    recommendation: "optional",
  }),

  // —— Equity / net assets (incl. church) ——
  acc({
    key: "eq_drawings",
    code: "3300",
    name: "Owner Drawings",
    description: "Withdrawals by owners (sole trader / partnership).",
    accountType: "equity",
    normalBalance: "debit",
    subtype: "equity",
    fsLine: "equity",
    recommendation: "optional",
  }),
  acc({
    key: "eq_restricted",
    code: "3400",
    name: "Restricted Net Assets",
    description: "Donor-restricted fund balances (non-profit / church).",
    accountType: "equity",
    subtype: "restricted_net_assets",
    fsLine: "restricted_net_assets",
    recommendation: "recommended",
  }),
  acc({
    key: "eq_building_fund",
    code: "3410",
    name: "Building Fund",
    description: "Internally designated or restricted building campaign.",
    accountType: "equity",
    subtype: "restricted_net_assets",
    fsLine: "restricted_net_assets",
    recommendation: "recommended",
  }),
  acc({
    key: "eq_missions_fund",
    code: "3420",
    name: "Missions Fund",
    description: "Restricted or designated missions balances.",
    accountType: "equity",
    subtype: "restricted_net_assets",
    fsLine: "restricted_net_assets",
    recommendation: "recommended",
  }),

  // —— Church / nonprofit income & expense ——
  acc({
    key: "inc_tithes",
    code: "4200",
    name: "Tithes & General Offerings",
    description: "Undesignated congregational giving.",
    accountType: "income",
    subtype: "contribution_income",
    fsLine: "contribution_income",
    recommendation: "recommended",
  }),
  acc({
    key: "inc_online_giving",
    code: "4210",
    name: "Online & Recurring Donations",
    description: "Digital and recurring giving.",
    accountType: "income",
    subtype: "contribution_income",
    fsLine: "contribution_income",
    recommendation: "recommended",
  }),
  acc({
    key: "inc_designated",
    code: "4220",
    name: "Designated Contributions",
    description: "Donor-restricted contributions.",
    accountType: "income",
    subtype: "contribution_income",
    fsLine: "contribution_income",
    recommendation: "recommended",
  }),
  acc({
    key: "inc_missions",
    code: "4230",
    name: "Mission Donations",
    description: "Giving for domestic and international missions.",
    accountType: "income",
    subtype: "contribution_income",
    fsLine: "contribution_income",
    recommendation: "recommended",
  }),
  acc({
    key: "inc_grants",
    code: "4240",
    name: "Grants & Denominational Support",
    description: "Grants received from other organisations.",
    accountType: "income",
    subtype: "contribution_income",
    fsLine: "contribution_income",
    recommendation: "optional",
  }),
  acc({
    key: "exp_pastoral",
    code: "6600",
    name: "Pastoral Compensation & Benefits",
    description: "Pastoral salaries and benefits.",
    accountType: "expense",
    subtype: "program_expense",
    fsLine: "program_expense",
    recommendation: "recommended",
  }),
  acc({
    key: "exp_ministry",
    code: "6610",
    name: "Ministry & Programme Expenses",
    description: "Youth, worship, education and outreach spending.",
    accountType: "expense",
    subtype: "program_expense",
    fsLine: "program_expense",
    recommendation: "recommended",
  }),
  acc({
    key: "exp_missions_spend",
    code: "6620",
    name: "Missions & Missionary Support",
    description: "Missionary support and missions programme costs.",
    accountType: "expense",
    subtype: "program_expense",
    fsLine: "program_expense",
    recommendation: "recommended",
  }),
  acc({
    key: "exp_benevolence",
    code: "6630",
    name: "Benevolence & Community Assistance",
    description: "Aid to individuals and community programmes.",
    accountType: "expense",
    subtype: "program_expense",
    fsLine: "program_expense",
    recommendation: "recommended",
  }),
  acc({
    key: "exp_church_admin",
    code: "6640",
    name: "Church Administration",
    description: "Office and administrative costs.",
    accountType: "expense",
    subtype: "expense",
    fsLine: "operating_expense",
    recommendation: "recommended",
  }),
  acc({
    key: "exp_facilities",
    code: "6650",
    name: "Facilities & Property",
    description: "Church facilities, utilities and property costs.",
    accountType: "expense",
    subtype: "expense",
    fsLine: "operating_expense",
    recommendation: "recommended",
  }),
  acc({
    key: "asset_mission_advance",
    code: "1190",
    name: "Missionary Advances",
    description: "Advances to missionaries pending reconciliation.",
    accountType: "asset",
    subtype: "current_asset",
    fsLine: "current_assets",
    recommendation: "optional",
  }),
];

export const LIBRARY_BY_KEY = Object.fromEntries(
  LIBRARY_ACCOUNTS.map((a) => [a.key, a]),
) as Record<string, LibraryAccount>;

const svc = ["rev_service", "exp_wages", "exp_software", "exp_professional", "exp_marketing"];
const ecom = [
  "rev_marketplace",
  "contra_refunds",
  "cogs_materials",
  "cogs_marketplace_fees",
  "cogs_fulfilment",
  "asset_clearing_marketplace",
  "exp_marketing",
  "exp_storage",
];
const rental = [
  "rev_rental",
  "asset_investment_property",
  "exp_repairs",
  "exp_insurance",
  "exp_utilities",
  "liab_customer_deposits",
];
const health = ["rev_patient", "exp_medical_supplies", "exp_wages", "exp_insurance", "exp_rent"];
const retail = [
  "cogs_materials",
  "contra_refunds",
  "contra_discounts",
  "exp_marketing",
  "exp_wages",
  "exp_rent",
];
const construction = [
  "rev_project",
  "cogs_subcontract",
  "cogs_materials",
  "asset_wip",
  "liab_customer_deposits",
  "exp_wages",
];
const hospitality = ["rev_food", "cogs_food", "exp_wages", "exp_rent", "exp_utilities"];
const tech = [
  "rev_subscription",
  "liab_deferred_revenue",
  "exp_software",
  "exp_wages",
  "exp_marketing",
];
const mfg = ["cogs_materials", "asset_wip", "cogs_landed", "exp_wages", "exp_repairs"];
const transport = ["rev_freight", "exp_vehicle", "exp_wages", "asset_vehicles", "exp_insurance"];
const education = ["rev_tuition", "exp_wages", "exp_rent", "exp_software", "liab_deferred_revenue"];
const media = ["rev_service", "exp_marketing", "exp_software", "exp_travel"];
const wellness = ["rev_service", "exp_wages", "exp_rent", "exp_marketing", "liab_deferred_revenue"];
const agri = ["cogs_materials", "asset_vehicles", "exp_repairs", "exp_insurance", "exp_wages"];
const church = [
  "inc_tithes",
  "inc_online_giving",
  "inc_designated",
  "inc_missions",
  "eq_restricted",
  "eq_building_fund",
  "eq_missions_fund",
  "exp_pastoral",
  "exp_ministry",
  "exp_missions_spend",
  "exp_benevolence",
  "exp_church_admin",
  "exp_facilities",
];

function industry(
  code: string,
  name: string,
  family: IndustryDef["family"],
  description: string,
  base: string[],
  extraDetailed: string[] = [],
  trackingDefaults?: IndustryDef["trackingDefaults"],
): IndustryDef {
  const simple = base.slice(0, Math.min(4, base.length));
  const standard = base;
  const detailed = [...new Set([...base, ...extraDetailed])];
  return trackingDefaults
    ? { code, name, family, description, simple, standard, detailed, trackingDefaults }
    : { code, name, family, description, simple, standard, detailed };
}

/** Industry packs — multiple may be combined on one organisation. */
export const INDUSTRIES: IndustryDef[] = [
  industry(
    "general_professional",
    "General Professional Services",
    "professional_services",
    "Consultants, freelancers and professional firms.",
    svc,
    ["exp_travel", "exp_insurance", "eq_drawings"],
  ),
  industry(
    "accounting_bookkeeping",
    "Accounting & Bookkeeping",
    "professional_services",
    "Bookkeeping, accounting and CPA practices.",
    svc,
    ["exp_insurance", "exp_software", "liab_deferred_revenue"],
  ),
  industry(
    "legal_practice",
    "Legal Practice",
    "professional_services",
    "Law firms and legal practices.",
    [...svc, "liab_customer_deposits"],
    ["exp_insurance", "exp_travel"],
  ),
  industry(
    "consulting_advisory",
    "Consulting & Management Advisory",
    "professional_services",
    "Management consulting and advisory.",
    svc,
    ["exp_travel", "rev_subscription"],
  ),
  industry(
    "marketing_agency",
    "Marketing & Advertising Agency",
    "professional_services",
    "Agencies and media buyers.",
    [...svc, "exp_marketing"],
    ["liab_customer_deposits"],
  ),
  industry(
    "it_managed_services",
    "IT Consulting & Managed Services",
    "professional_services",
    "MSP and IT consulting.",
    [...svc, "rev_subscription", "exp_software"],
    ["liab_deferred_revenue"],
  ),
  industry(
    "amazon_fba",
    "Amazon FBA / FBM",
    "ecommerce",
    "Amazon marketplace sellers.",
    ecom,
    ["cogs_landed", "contra_discounts", "exp_insurance"],
  ),
  industry(
    "shopify_dtc",
    "Shopify / DTC Brand",
    "ecommerce",
    "Direct-to-consumer and Shopify stores.",
    ecom,
    ["contra_discounts", "exp_software", "rev_subscription"],
  ),
  industry(
    "multi_marketplace",
    "Multi-marketplace Seller",
    "ecommerce",
    "Sellers across Amazon, eBay, Etsy, Walmart, etc.",
    ecom,
    ["cogs_landed", "asset_clearing_marketplace"],
  ),
  industry(
    "dropshipping",
    "Dropshipping",
    "ecommerce",
    "Dropship and print-on-demand sellers.",
    ["rev_marketplace", "cogs_fulfilment", "cogs_marketplace_fees", "exp_marketing", "contra_refunds"],
    ["asset_clearing_marketplace"],
  ),
  industry(
    "residential_rental",
    "Long-term Residential Rental",
    "rental_property",
    "Buy-to-let and residential landlords.",
    rental,
    ["exp_interest", "liab_lease"],
  ),
  industry(
    "short_term_rental",
    "Short-Term / Vacation Rentals",
    "rental_property",
    "Airbnb, VRBO and holiday lets.",
    [...rental, "exp_marketing", "cogs_marketplace_fees"],
    ["exp_utilities"],
  ),
  industry(
    "property_management",
    "Property Management",
    "rental_property",
    "Property managers and agencies.",
    [...rental, "rev_service", "liab_customer_deposits"],
    ["exp_wages"],
  ),
  industry(
    "hotel_hospitality",
    "Hotels & Accommodation",
    "hospitality_food",
    "Hotels, motels and guest houses.",
    [...hospitality, "rev_rental", "liab_customer_deposits"],
    ["exp_insurance", "asset_investment_property"],
  ),
  industry(
    "medical_practice",
    "Medical / Specialist Practice",
    "healthcare",
    "GP and specialist medical practices.",
    health,
    ["exp_professional", "exp_software"],
  ),
  industry(
    "dental_practice",
    "Dental & Orthodontic Practice",
    "healthcare",
    "Dental clinics.",
    health,
    ["cogs_materials", "exp_software"],
  ),
  industry(
    "allied_health",
    "Allied Health & Therapy",
    "healthcare",
    "Physio, counselling, optometry and similar.",
    health,
    ["rev_service"],
  ),
  industry(
    "veterinary",
    "Veterinary Practice",
    "healthcare",
    "Veterinary clinics.",
    [...health, "cogs_materials"],
    ["exp_software"],
  ),
  industry(
    "general_retail",
    "General Retail",
    "retail_wholesale",
    "Brick-and-mortar and omnichannel retail.",
    retail,
    ["exp_utilities", "exp_insurance"],
  ),
  industry(
    "wholesale_distribution",
    "Wholesale & Distribution",
    "retail_wholesale",
    "Wholesale distributors.",
    [...retail, "cogs_landed", "exp_storage"],
    ["asset_wip"],
  ),
  industry(
    "general_contractor",
    "General Contractor / Construction",
    "construction",
    "Residential and commercial contractors.",
    construction,
    ["exp_vehicle", "exp_insurance", "liab_lease"],
  ),
  industry(
    "trades",
    "Trades (Electrical, Plumbing, HVAC)",
    "construction",
    "Trade subcontractors and specialists.",
    construction,
    ["exp_vehicle", "exp_insurance", "cogs_materials"],
  ),
  industry(
    "restaurant_cafe",
    "Restaurant & Cafe",
    "hospitality_food",
    "Restaurants, cafes and QSR.",
    hospitality,
    ["exp_marketing", "exp_insurance"],
  ),
  industry(
    "catering",
    "Catering & Food Trucks",
    "hospitality_food",
    "Catering and mobile food.",
    hospitality,
    ["exp_vehicle"],
  ),
  industry(
    "saas",
    "SaaS / Software",
    "technology",
    "Software-as-a-service and apps.",
    tech,
    ["exp_professional", "contra_refunds"],
  ),
  industry(
    "web_hosting_cloud",
    "Web Hosting & Cloud Services",
    "technology",
    "Hosting and cloud infrastructure services.",
    tech,
    ["cogs_fulfilment"],
  ),
  industry(
    "general_manufacturing",
    "General Manufacturing",
    "manufacturing",
    "Manufacturers and fabricators.",
    mfg,
    ["exp_utilities", "asset_vehicles"],
  ),
  industry(
    "freight_courier",
    "Freight, Courier & Logistics",
    "transport_logistics",
    "Freight, courier and warehousing.",
    transport,
    ["exp_storage", "liab_lease"],
  ),
  industry(
    "vehicle_workshop",
    "Vehicle Dealership & Repair",
    "transport_logistics",
    "Dealerships and repair workshops.",
    [...transport, "cogs_materials", "rev_service"],
    ["liab_customer_deposits"],
  ),
  industry(
    "tutoring_training",
    "Tutoring & Training",
    "education",
    "Tutors, institutes and corporate training.",
    education,
    ["exp_marketing"],
  ),
  industry(
    "online_education",
    "Online Education",
    "education",
    "Online courses and digital learning.",
    [...education, "rev_subscription", "exp_marketing"],
    ["exp_software"],
  ),
  industry(
    "photography_video",
    "Photography & Videography",
    "media_creative",
    "Creative production services.",
    media,
    ["asset_vehicles", "exp_insurance"],
  ),
  industry(
    "event_management",
    "Event Management",
    "media_creative",
    "Events and production.",
    [...media, "liab_customer_deposits", "cogs_subcontract"],
    ["exp_travel"],
  ),
  industry(
    "salon_spa",
    "Hair, Beauty & Spa",
    "personal_care",
    "Salons and spas.",
    wellness,
    ["cogs_materials", "exp_utilities"],
  ),
  industry(
    "gym_fitness",
    "Gym & Fitness",
    "personal_care",
    "Gyms, trainers and studios.",
    wellness,
    ["exp_insurance", "exp_utilities"],
  ),
  industry(
    "farming",
    "Farming & Agriculture",
    "agriculture",
    "Farms, livestock and horticulture.",
    agri,
    ["exp_utilities", "cogs_landed"],
  ),
  industry(
    "church_religious",
    "Church & Religious Organisation",
    "nonprofit_religious",
    "Churches, missions and religious organisations — fund accounting via tracking dimensions.",
    church,
    ["inc_grants", "asset_mission_advance", "exp_interest"],
    [
      {
        name: "Fund",
        options: ["General", "Building", "Missions", "Benevolence", "Youth"],
      },
      {
        name: "Mission",
        options: ["Domestic", "International", "Church Planting"],
      },
      {
        name: "Ministry",
        options: ["Worship", "Youth", "Children", "Outreach", "Pastoral Care"],
      },
      {
        name: "Campus / Location",
        options: ["Main Campus"],
      },
      {
        name: "Department",
        options: ["Administration", "Facilities", "Finance"],
      },
      {
        name: "Project / Campaign",
        options: ["Building Campaign", "Mission Trip"],
      },
    ],
  ),
  industry(
    "charity_nonprofit",
    "Charity & Non-profit",
    "nonprofit_religious",
    "Registered charities and community organisations.",
    [
      "inc_grants",
      "inc_designated",
      "eq_restricted",
      "exp_benevolence",
      "exp_church_admin",
      "exp_wages",
    ],
    ["inc_online_giving", "exp_facilities"],
    [
      { name: "Fund", options: ["Unrestricted", "Restricted", "Endowment"] },
      { name: "Programme", options: ["Core Programme", "Fundraising", "Admin"] },
    ],
  ),
  industry(
    "cleaning_facilities",
    "Cleaning & Facilities Management",
    "other",
    "Cleaning, security and facilities services.",
    [...svc, "exp_vehicle", "cogs_materials"],
    ["exp_insurance"],
  ),
  industry(
    "holding_company",
    "Holding / Management Company",
    "other",
    "Holding and management companies.",
    ["exp_professional", "exp_interest", "eq_drawings", "liab_lease"],
    ["asset_investment_property"],
  ),
];

export const INDUSTRIES_BY_CODE = Object.fromEntries(
  INDUSTRIES.map((i) => [i.code, i]),
) as Record<string, IndustryDef>;

export const CATALOG_VERSION = "2026.10.20.1";

export function accountsForIndustries(
  industryCodes: string[],
  level: "simple" | "standard" | "detailed",
): LibraryAccount[] {
  const keys = new Set<string>();
  for (const code of industryCodes) {
    const ind = INDUSTRIES_BY_CODE[code];
    if (!ind) continue;
    const list =
      level === "simple" ? ind.simple : level === "detailed" ? ind.detailed : ind.standard;
    for (const k of list) keys.add(k);
  }
  return [...keys]
    .map((k) => LIBRARY_BY_KEY[k])
    .filter((a): a is LibraryAccount => Boolean(a))
    .sort((a, b) => a.code.localeCompare(b.code));
}

export function catalogStats() {
  const byType: Record<string, number> = {};
  for (const a of LIBRARY_ACCOUNTS) {
    byType[a.accountType] = (byType[a.accountType] ?? 0) + 1;
  }
  const byRec: Record<string, number> = {};
  for (const a of LIBRARY_ACCOUNTS) {
    byRec[a.recommendation] = (byRec[a.recommendation] ?? 0) + 1;
  }
  return {
    version: CATALOG_VERSION,
    industries: INDUSTRIES.length,
    libraryAccounts: LIBRARY_ACCOUNTS.length,
    byType,
    byRecommendation: byRec,
    families: [...new Set(INDUSTRIES.map((i) => i.family))],
  };
}
