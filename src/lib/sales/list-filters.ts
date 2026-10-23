/**
 * Helpers for server-side searchable lists (AR-27). Pure.
 */

/** Escape `%`, `_` and `\` so user input matches literally inside an ILIKE pattern. */
export function escapeLikeLiteral(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Build a PostgREST `.or()` clause value for `column ilike %term%`. The pattern is double-quoted
 * (with `"` and `\` escaped) so commas, parentheses and dots typed by users can never alter the
 * filter structure (PostgREST filter injection).
 */
export function orIlike(column: string, term: string): string {
  const pattern = `%${escapeLikeLiteral(term)}%`;
  const quoted = pattern.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${column}.ilike."${quoted}"`;
}

/** `col.in.(a,b,c)` for UUID lists (UUIDs are validated, never user text). */
export function orIn(column: string, uuids: string[]): string | null {
  const ok = uuids.filter((u) => /^[0-9a-fA-F-]{36}$/.test(u));
  return ok.length ? `${column}.in.(${ok.join(",")})` : null;
}

export function buildSearchOr(
  term: string,
  columns: string[],
  extraContactIds: string[] = [],
  contactColumn = "contact_id",
): string | null {
  const t = term.trim().slice(0, 100);
  if (!t) return null;
  const parts = columns.map((c) => orIlike(c, t));
  const inClause = orIn(contactColumn, extraContactIds);
  if (inClause) parts.push(inClause);
  return parts.join(",");
}

export const LIST_PAGE_SIZES = [25, 50, 100] as const;

export function clampPageSize(n: unknown, fallback = 50): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v < 1) return fallback;
  return Math.min(v, 200);
}

export function clampPage(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v > 0 ? Math.min(v, 100000) : 0;
}

export function isIsoDateString(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

/** Pick a sort column from an allow-list; never pass user text to `.order()`. */
export function pickSort<T extends string>(
  requested: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(requested as T) ? (requested as T) : fallback;
}

export function hasNextPage(total: number, page: number, pageSize: number): boolean {
  return (page + 1) * pageSize < total;
}
