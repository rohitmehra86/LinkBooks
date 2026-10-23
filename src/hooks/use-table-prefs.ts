import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_TABLE_PREFS,
  parseTablePrefs,
  toggleColumn,
  type Density,
  type TablePrefs,
} from "@/lib/table-prefs";

/** Persisted column visibility + density for one table (`storageKey` e.g. "invoices"). */
export function useTablePrefs(storageKey: string, columnIds: string[]) {
  const key = `linkbooks-table:${storageKey}`;
  const [prefs, setPrefs] = useState<TablePrefs>(DEFAULT_TABLE_PREFS);
  const idsKey = columnIds.join("|");

  // Read after mount so server and first client render match (no hydration mismatch).
  useEffect(() => {
    try {
      setPrefs(parseTablePrefs(window.localStorage.getItem(key), idsKey.split("|")));
    } catch {
      /* storage unavailable */
    }
  }, [key, idsKey]);

  const update = useCallback(
    (next: TablePrefs) => {
      setPrefs(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
    },
    [key],
  );

  return {
    density: prefs.density,
    hidden: prefs.hidden,
    isVisible: (id: string) => !prefs.hidden.includes(id),
    setDensity: (density: Density) => update({ ...prefs, density }),
    toggle: (id: string) => update({ ...prefs, hidden: toggleColumn(prefs.hidden, id) }),
  };
}
