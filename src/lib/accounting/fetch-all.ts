/**
 * Reusable pager for PostgREST reads (RP-01 / BK-04 / U-03).
 *
 * PostgREST caps every response at `max-rows` (1000 by default), so a bare `.select()` silently
 * returns a prefix of the data. `fetchAllPages` walks `.range(from, to)` windows until the server
 * returns an empty page. It advances by the number of rows actually received (not the requested
 * page size) so a server configured with a smaller cap still yields every row.
 *
 * Callers MUST order by a unique, stable column (normally `id`) so offsets never skip or repeat.
 */

export const DEFAULT_PAGE_SIZE = 1000;
/** Hard stop so a runaway loop fails loudly instead of hanging a request. */
export const DEFAULT_MAX_ROWS = 2_000_000;

export type PageResult<T> = {
  data: T[] | null;
  error: { message: string; code?: string } | null;
};

export type PageFetcher<T> = (from: number, to: number) => PromiseLike<PageResult<T>>;

export async function fetchAllPages<T>(
  fetchPage: PageFetcher<T>,
  opts: { pageSize?: number; maxRows?: number } = {},
): Promise<T[]> {
  const pageSize = Math.max(1, Math.floor(opts.pageSize ?? DEFAULT_PAGE_SIZE));
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const all: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    if (rows.length === 0) break;
    for (const row of rows) all.push(row);
    from += rows.length;
    if (all.length > maxRows) {
      throw new Error(
        `Too many rows to load safely (more than ${maxRows}). Narrow the date range.`,
      );
    }
  }
  return all;
}

/** True when an RPC failed only because the function has not been deployed yet. */
export function isMissingRpc(
  error: { code?: string | undefined; message?: string | undefined } | null | undefined,
): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  const message = (error.message ?? "").toLowerCase();
  return (
    code === "PGRST202" ||
    code === "42883" ||
    message.includes("could not find the function") ||
    (message.includes("function") && message.includes("does not exist"))
  );
}
