import type { DuplicateMatch, LookupOption } from "@/lib/lookup/types";

function normalise(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Exact code or name matches are duplicates. A query of 3+ characters that is contained in a
 * name is a potential duplicate. The server remains the authority when the record is saved.
 */
export function findLookupDuplicates(options: LookupOption[], query: string): DuplicateMatch[] {
  const q = normalise(query);
  if (q.length < 2) return [];
  const matches: DuplicateMatch[] = [];
  for (const option of options) {
    if (option.disabled) continue;
    const code = normalise(option.code);
    const name = normalise(option.name ?? option.label);
    const exact = (code !== "" && code === q) || name === q;
    const potential =
      !exact && q.length >= 3 && (name.includes(q) || (code !== "" && code.includes(q)));
    if (exact || potential) matches.push({ option, exact });
  }
  matches.sort((a, b) => Number(b.exact) - Number(a.exact));
  return matches.slice(0, 5);
}
