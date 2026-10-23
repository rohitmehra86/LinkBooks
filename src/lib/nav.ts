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
  FolderOpen,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  label: string;
  to: string;
  icon: LucideIcon;
  description: string;
};

export const navItems: NavItem[] = [
  {
    label: "Dashboard",
    to: "/",
    icon: LayoutDashboard,
    description: "Financial position at a glance",
  },
  { label: "Banking", to: "/banking", icon: Landmark, description: "Accounts and reconciliation" },
  {
    label: "Sales",
    to: "/sales",
    icon: ReceiptText,
    description: "Invoices and customer payments",
  },
  {
    label: "Purchases",
    to: "/purchases",
    icon: ShoppingCart,
    description: "Bills, expenses and suppliers",
  },
  { label: "Contacts", to: "/contacts", icon: Users, description: "Customers and suppliers" },
  {
    label: "Products & Services",
    to: "/products-services",
    icon: Package,
    description: "Items you sell and buy",
  },
  {
    label: "Accounting",
    to: "/accounting",
    icon: BookOpen,
    description: "Chart of accounts, journals, ledger",
  },
  {
    label: "Files",
    to: "/files",
    icon: FolderOpen,
    description: "Attachments and uploaded documents",
  },
  {
    label: "Reports",
    to: "/reports",
    icon: BarChart3,
    description: "Reports Centre and financial statements",
  },
  {
    label: "Accountant",
    to: "/accountant",
    icon: Briefcase,
    description: "Period-end checklist and review",
  },
  {
    label: "Firm",
    to: "/firm",
    icon: Building2,
    description: "Practice and client access",
  },
  {
    label: "AI Assistant",
    to: "/ai-assistant",
    icon: Sparkles,
    description: "Accounting guidance and review",
  },
  {
    label: "Tax",
    to: "/tax",
    icon: ReceiptText,
    description: "Rates, codes and tax accounts",
  },
  {
    label: "Settings",
    to: "/settings",
    icon: Settings,
    description: "Organisation and preferences",
  },
  { label: "Help", to: "/help", icon: LifeBuoy, description: "Guides and support" },
];
