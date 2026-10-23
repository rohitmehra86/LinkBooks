import {
  LayoutDashboard,
  Landmark,
  ReceiptText,
  ShoppingCart,
  Users,
  Package,
  BookOpen,
  BarChart3,
  Sparkles,
  Settings,
  LifeBuoy,
  Briefcase,
  Building2,
  Percent,
  type LucideIcon,
} from "lucide-react";

export type NavGroup =
  "overview" | "money" | "records" | "accounting" | "practice" | "tools" | "footer";

export type NavItem = {
  label: string;
  to: string;
  icon: LucideIcon;
  description: string;
  /** Sidebar section. Presentation only; the flat `navItems` order still drives search. */
  group: NavGroup;
};

/** Sidebar sections in display order. `overview` and `footer` render without a heading. */
export const NAV_GROUPS: { id: NavGroup; label: string | null }[] = [
  { id: "overview", label: null },
  { id: "money", label: "Money" },
  { id: "records", label: "Records" },
  { id: "accounting", label: "Accounting" },
  { id: "practice", label: "Practice" },
  { id: "tools", label: "Tools" },
  { id: "footer", label: null },
];

export const navItems: NavItem[] = [
  {
    label: "Dashboard",
    to: "/",
    icon: LayoutDashboard,
    group: "overview",
    description: "Financial position at a glance",
  },
  {
    label: "Banking",
    to: "/banking",
    icon: Landmark,
    group: "money",
    description: "Accounts and reconciliation",
  },
  {
    label: "Sales",
    to: "/sales",
    icon: ReceiptText,
    group: "money",
    description: "Invoices and customer payments",
  },
  {
    label: "Purchases",
    to: "/purchases",
    icon: ShoppingCart,
    group: "money",
    description: "Bills, expenses and suppliers",
  },
  {
    label: "Contacts",
    to: "/contacts",
    icon: Users,
    group: "records",
    description: "Customers and suppliers",
  },
  {
    label: "Products & Services",
    to: "/products-services",
    icon: Package,
    group: "records",
    description: "Items you sell and buy",
  },
  {
    label: "Accounting",
    to: "/accounting",
    icon: BookOpen,
    group: "accounting",
    description: "Chart of accounts, journals, ledger",
  },
  {
    label: "Reports",
    to: "/reports",
    icon: BarChart3,
    group: "accounting",
    description: "Reports Centre and financial statements",
  },
  {
    label: "Accountant",
    to: "/accountant",
    icon: Briefcase,
    group: "practice",
    description: "Period-end checklist and review",
  },
  {
    label: "Firm",
    to: "/firm",
    icon: Building2,
    group: "practice",
    description: "Practice and client access",
  },
  {
    label: "AI Assistant",
    to: "/ai-assistant",
    icon: Sparkles,
    group: "tools",
    description: "Accounting guidance and review",
  },
  {
    label: "Tax",
    to: "/tax",
    icon: Percent,
    group: "accounting",
    description: "Rates, codes and tax accounts",
  },
  {
    label: "Settings",
    to: "/settings",
    icon: Settings,
    group: "footer",
    description: "Organisation and preferences",
  },
  {
    label: "Help",
    to: "/help",
    icon: LifeBuoy,
    group: "footer",
    description: "Guides and support",
  },
];
