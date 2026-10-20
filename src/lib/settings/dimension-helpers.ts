/** Pure helpers for reporting dimensions (classes, departments, …). */

export const DIMENSION_KINDS = [
  "class",
  "department",
  "location",
  "project",
  "cost_centre",
  "product_line",
  "property",
  "fund",
  "custom",
] as const;

export type DimensionKind = (typeof DIMENSION_KINDS)[number];

export function isDimensionKind(value: string): value is DimensionKind {
  return (DIMENSION_KINDS as readonly string[]).includes(value);
}

export function dimensionKindLabel(kind: string): string {
  const map: Record<string, string> = {
    class: "Class / business unit",
    department: "Department",
    location: "Location / branch",
    project: "Project",
    cost_centre: "Cost centre",
    product_line: "Product / service line",
    property: "Property / operating unit",
    fund: "Fund",
    custom: "Custom dimension",
  };
  return map[kind] ?? kind;
}

/** Max days in month; February allows 29 (leap-year FY ends). */
export function maxFiscalYearEndDay(month: number): number {
  const m = Math.floor(Number(month));
  if (!Number.isInteger(m) || m < 1 || m > 12) return 31;
  // Use leap year so 29 Feb is a valid FY-end choice.
  return new Date(2024, m, 0).getDate();
}

export function clampFiscalYearEndDay(month: number, day: number): number {
  const max = maxFiscalYearEndDay(month);
  const d = Math.floor(Number(day));
  if (!Number.isInteger(d) || d < 1) return 1;
  return Math.min(d, max);
}

export function formatDocumentNumberPreview(
  prefix: string,
  nextNumber: number,
  padding: number,
): string {
  const pad = Math.min(10, Math.max(1, Math.floor(padding) || 4));
  const n = Math.max(1, Math.floor(nextNumber) || 1);
  return `${prefix}${String(n).padStart(pad, "0")}`;
}

/** Detect parent-cycle if assigning parentId under optionId. */
export function wouldCreateOptionCycle(
  optionId: string,
  parentId: string | null,
  parentById: Map<string, string | null>,
): boolean {
  if (!parentId) return false;
  if (parentId === optionId) return true;
  let cur: string | null = parentId;
  const seen = new Set<string>();
  while (cur) {
    if (cur === optionId) return true;
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = parentById.get(cur) ?? null;
  }
  return false;
}
