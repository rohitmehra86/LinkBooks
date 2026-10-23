/**
 * Helpers for building PostgREST `.or(...)` / `.ilike(...)` filters from user text.
 * A raw term containing `,` `(` `)` `"` or `\` breaks the `.or()` grammar, and `%` / `_`
 * act as LIKE wildcards. Use these helpers for every free-text search.
 */

/** Escape LIKE wildcards so the term is matched literally. */
export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * A value safe to embed in a PostgREST `or=(col.ilike.<value>,...)` filter.
 * The value is LIKE-escaped, wrapped in `%...%`, then double-quoted so commas and
 * parentheses are data, not syntax.
 */
export function ilikeContainsValue(term: string): string {
  const pattern = `%${escapeLikeTerm(term.trim())}%`;
  return `"${pattern.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Build `col.ilike.<value>,col2.ilike.<value>` for `.or()`. Returns null for blank terms. */
export function buildIlikeOr(columns: string[], term: string): string | null {
  const trimmed = term.trim();
  if (!trimmed || columns.length === 0) return null;
  const value = ilikeContainsValue(trimmed);
  return columns.map((c) => `${c}.ilike.${value}`).join(",");
}

/** `%term%` pattern for direct `.ilike(col, pattern)` calls (no quoting needed there). */
export function ilikePattern(term: string): string {
  return `%${escapeLikeTerm(term.trim())}%`;
}
