/**
 * Per-table view preferences (hidden columns, row density) kept in localStorage.
 * Pure helpers so the parsing is testable; the React hook lives in `use-table-prefs.ts`.
 */
export type Density = "comfortable" | "compact";

export type TablePrefs = { density: Density; hidden: string[] };

export const DEFAULT_TABLE_PREFS: TablePrefs = { density: "comfortable", hidden: [] };

/** Parse stored JSON defensively; anything unexpected falls back to defaults. */
export function parseTablePrefs(raw: string | null, knownColumns: string[]): TablePrefs {
  if (!raw) return DEFAULT_TABLE_PREFS;
  try {
    const v = JSON.parse(raw) as { density?: unknown; hidden?: unknown };
    const density: Density = v.density === "compact" ? "compact" : "comfortable";
    const hidden = Array.isArray(v.hidden)
      ? v.hidden.filter((c): c is string => typeof c === "string" && knownColumns.includes(c))
      : [];
    return { density, hidden };
  } catch {
    return DEFAULT_TABLE_PREFS;
  }
}

export function toggleColumn(hidden: string[], id: string): string[] {
  return hidden.includes(id) ? hidden.filter((c) => c !== id) : [...hidden, id];
}
