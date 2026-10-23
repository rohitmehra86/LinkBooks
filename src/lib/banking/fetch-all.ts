/**
 * PostgREST caps every response at 1000 rows by default (BK-04). Anything that SUMS or lists
 * "everything" must page with `.range()`. This helper pages until a short page is returned.
 *
 * The query MUST have a deterministic `.order(...)` (ideally ending in the primary key),
 * otherwise rows can repeat or be skipped across pages.
 */
export type PageResult<T> = {
  data: T[] | null;
  error: { message: string } | null;
};

export const POSTGREST_PAGE_SIZE = 1000;

export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  opts: { pageSize?: number; maxRows?: number } = {},
): Promise<T[]> {
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? POSTGREST_PAGE_SIZE, POSTGREST_PAGE_SIZE));
  const maxRows = opts.maxRows ?? 500_000;
  const out: T[] = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) return out;
  }
  throw new Error(`Too many rows (more than ${maxRows}); narrow the date range`);
}

/** Split an array into chunks (used for `.in()` filters and batched inserts). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk size must be positive");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Sum signed minor-unit values with bigint (never floats). */
export function sumBigint(values: Iterable<number | bigint | string>): bigint {
  let total = 0n;
  for (const v of values) total += BigInt(v);
  return total;
}
