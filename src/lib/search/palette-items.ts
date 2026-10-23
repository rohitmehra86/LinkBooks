import { REPORT_CATALOG } from "@/lib/reports/catalog";
import { navItems } from "@/lib/nav";

export type PaletteAction = {
  id: string;
  group: "Create" | "Go to" | "Reports";
  label: string;
  keywords: string;
  href: string;
  search?: Record<string, string>;
};

const CREATE: PaletteAction[] = [
  {
    id: "new-invoice",
    group: "Create",
    label: "New invoice",
    keywords: "sales customer",
    href: "/sales/invoices/new",
  },
  {
    id: "new-bill",
    group: "Create",
    label: "New bill",
    keywords: "purchase supplier",
    href: "/purchases/bills/new",
  },
  {
    id: "new-expense",
    group: "Create",
    label: "New expense",
    keywords: "spend receipt",
    href: "/purchases/expenses/new",
  },
  {
    id: "new-quote",
    group: "Create",
    label: "New quote",
    keywords: "sales customer estimate",
    href: "/sales/quotes/new",
  },
  {
    id: "new-sales-credit-note",
    group: "Create",
    label: "New sales credit note",
    keywords: "customer refund credit",
    href: "/sales/credit-notes/new",
  },
  {
    id: "new-sales-receipt",
    group: "Create",
    label: "New sales receipt",
    keywords: "customer payment received",
    href: "/sales/receipts/new",
  },
  {
    id: "new-purchase-order",
    group: "Create",
    label: "New purchase order",
    keywords: "supplier order",
    href: "/purchases/orders/new",
  },
  {
    id: "new-supplier-payment",
    group: "Create",
    label: "New supplier payment",
    keywords: "pay bill payment",
    href: "/purchases/payments/new",
  },
];

export function buildPaletteActions(): PaletteAction[] {
  return [
    ...CREATE,
    ...navItems.map<PaletteAction>((n) => ({
      id: `nav-${n.to}`,
      group: "Go to",
      label: n.label,
      keywords: n.description,
      href: n.to,
      ...(n.to === "/settings" ? { search: { section: "overview" } } : {}),
    })),
    ...REPORT_CATALOG.filter((r) => r.status === "ready" && r.runner !== "link").map<PaletteAction>(
      (r) => ({
        id: `report-${r.id}`,
        group: "Reports",
        label: r.title,
        keywords: r.tags.join(" "),
        href: `/reports/${r.id}`,
      }),
    ),
  ];
}

/** Case-insensitive match on label and keywords; all words must appear. Empty query returns nothing. */
export function filterPaletteActions(actions: PaletteAction[], query: string): PaletteAction[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return actions.filter((a) => {
    const hay = `${a.label} ${a.keywords}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** What to show before the user types: the create shortcuts, then the main pages. */
export function suggestedPaletteActions(actions: PaletteAction[]): PaletteAction[] {
  return [
    ...actions.filter((a) => a.group === "Create").slice(0, 5),
    ...actions.filter((a) => a.group === "Go to").slice(0, 6),
  ];
}
