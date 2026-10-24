import type { LookupGroup, LookupOption } from "@/lib/lookup/types";

export function formatLookupLabel(option: Pick<LookupOption, "label" | "code" | "name">): string {
  const code = option.code?.trim();
  const name = option.name?.trim();
  if (code && name) return `${code} — ${name}`;
  return option.label;
}

export function lookupSearchText(option: LookupOption): string {
  return [
    option.code,
    option.name,
    option.label,
    option.description,
    option.keywords,
    option.meta,
    option.status,
    option.group,
    option.id,
  ]
    .filter((part) => part && part.trim())
    .join(" ")
    .toLowerCase();
}

/** Records explicitly tagged with another organisation are never shown. */
export function belongsToOrganisation(
  recordCompanyId: string | null | undefined,
  activeCompanyId: string | null | undefined,
): boolean {
  if (!activeCompanyId) return false;
  if (!recordCompanyId) return true;
  return recordCompanyId === activeCompanyId;
}

export function filterLookupOptions(
  options: LookupOption[],
  query: string,
  companyId?: string | null,
): LookupOption[] {
  const scoped = companyId
    ? options.filter((option) => belongsToOrganisation(option.companyId, companyId))
    : options;
  const q = query.trim().toLowerCase();
  if (!q) return scoped;
  return scoped.filter((option) => lookupSearchText(option).includes(q));
}

/** Ungrouped rows stay first. Groups keep the order their first record appeared in. */
export function groupLookupOptions(options: LookupOption[]): LookupGroup[] {
  const groups: LookupGroup[] = [];
  const index = new Map<string, LookupGroup>();
  for (const option of options) {
    const heading = option.group?.trim() || null;
    const key = heading ?? "";
    let group = index.get(key);
    if (!group) {
      group = { heading, items: [] };
      index.set(key, group);
      groups.push(group);
    }
    group.items.push(option);
  }
  groups.sort((a, b) => {
    if (a.heading === null) return -1;
    if (b.heading === null) return 1;
    return 0;
  });
  return groups;
}

export function sliceLookupPage<T>(
  rows: readonly T[],
  page: number,
  pageSize: number,
): { items: T[]; hasMore: boolean; page: number } {
  const size = Math.max(1, pageSize);
  const safePage = Math.max(0, page);
  const start = safePage * size;
  return {
    items: rows.slice(start, start + size),
    hasMore: start + size < rows.length,
    page: safePage,
  };
}

export function lookupPopupMaxHeight(viewportWidth: number, preferred = 320): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return preferred;
  if (viewportWidth < 640) return Math.min(240, preferred);
  return preferred;
}

export function lookupCacheKey(
  companyId: string,
  kind: string,
  query: string,
  page: number,
): string {
  return `${companyId}\u0000${kind}\u0000${query.trim().toLowerCase()}\u0000${page}`;
}

export function isCurrentRequest(requestId: number, latestId: number): boolean {
  return requestId === latestId;
}
