export type SortDir = "asc" | "desc";
export type SortState<K extends string> = { key: K; dir: SortDir };

/** Click a new column: ascending. Click the active column: flip direction. */
export function nextSort<K extends string>(current: SortState<K> | null, key: K): SortState<K> {
  if (current && current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: "asc" };
}

export function ariaSortValue(active: boolean, dir: SortDir): "ascending" | "descending" | "none" {
  if (!active) return "none";
  return dir === "asc" ? "ascending" : "descending";
}

/** Stable sort that compares numbers numerically and strings with the locale collator. */
export function sortRows<T>(
  rows: T[],
  get: (row: T) => string | number | null | undefined,
  dir: SortDir,
): T[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const sign = dir === "asc" ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i, v: get(row) }))
    .sort((a, b) => {
      const av = a.v;
      const bv = b.v;
      if (av == null && bv == null) return a.i - b.i;
      if (av == null) return 1;
      if (bv == null) return -1;
      const c =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : collator.compare(String(av), String(bv));
      return c !== 0 ? c * sign : a.i - b.i;
    })
    .map((x) => x.row);
}
