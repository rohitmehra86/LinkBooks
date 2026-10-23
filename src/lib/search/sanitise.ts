/** Strip characters that would change the meaning of a PostgREST `or(...)` filter. */
export function sanitiseSearchTerm(raw: string): string {
  return raw
    .replace(/[%_,()"\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
