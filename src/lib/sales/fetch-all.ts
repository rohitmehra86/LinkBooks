/**
 * Fetch every row of a query in pages (AR-26). PostgREST silently caps a request at the project's
 * `max-rows` (1000 by default), so any total computed from a single request is understated for
 * larger companies. Use this wherever rows are aggregated in application code.
 *
 * The query MUST have a stable, unique ordering (e.g. `.order("id")`) or pages can overlap/skip.
 */
export const FETCH_PAGE_SIZE = 1000;

type PageResult<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

export async function fetchAllPages<T>(
  buildPage: (from: number, to: number) => PageResult<T>,
  opts: { pageSize?: number; maxRows?: number } = {},
): Promise<T[]> {
  const pageSize = Math.max(1, opts.pageSize ?? FETCH_PAGE_SIZE);
  const maxRows = opts.maxRows ?? 200_000;
  const all: T[] = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await buildPage(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) return all;
  }
  throw new Error(`Query returned more than ${maxRows} rows; narrow the filter`);
}
