import { navItems } from "@/lib/nav";

export type Breadcrumb = { label: string; to: string; current: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SEGMENT_LABEL: Record<string, string> = {
  "credit-notes": "Credit notes",
  "employee-expenses": "Employee expenses",
  "money-documents": "Money documents",
  "cash-coding": "Cash coding",
  "profit-and-loss": "Profit and loss",
  new: "New",
  edit: "Edit",
};

function humanize(segment: string): string {
  const known = SEGMENT_LABEL[segment];
  if (known) return known;
  if (UUID.test(segment) || /^\d+$/.test(segment)) return "Details";
  const s = decodeURIComponent(segment).replace(/[-_]+/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Breadcrumb trail for a pathname: the module (from the nav) then each nested segment.
 * Record ids become "Details". The dashboard has no trail. The last crumb is always `current`;
 * the caller decides which of the others are linkable (only paths that are real routes).
 */
export function buildBreadcrumbs(pathname: string): Breadcrumb[] {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return [];
  const crumbs: Breadcrumb[] = [];
  let acc = "";
  segments.forEach((seg, i) => {
    acc += `/${seg}`;
    const nav = i === 0 ? navItems.find((n) => n.to === acc) : undefined;
    crumbs.push({
      label: nav?.label ?? humanize(seg),
      to: acc,
      current: i === segments.length - 1,
    });
  });
  return crumbs;
}
