export type CreatePrefs = {
  favourites: string[];
  recent: string[];
};

const EMPTY: CreatePrefs = { favourites: [], recent: [] };

function key(userId: string) {
  return `linkbooks.create-new.${userId}`;
}

export function readCreatePrefs(storage: Pick<Storage, "getItem">, userId: string): CreatePrefs {
  try {
    const raw = storage.getItem(key(userId));
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<CreatePrefs>;
    return {
      favourites: Array.isArray(parsed.favourites) ? parsed.favourites.filter((id) => typeof id === "string") : [],
      recent: Array.isArray(parsed.recent) ? parsed.recent.filter((id) => typeof id === "string").slice(0, 5) : [],
    };
  } catch {
    return EMPTY;
  }
}

export function writeCreatePrefs(
  storage: Pick<Storage, "setItem">,
  userId: string,
  prefs: CreatePrefs,
): void {
  storage.setItem(key(userId), JSON.stringify(prefs));
}

export function toggleFavourite(prefs: CreatePrefs, actionId: string): CreatePrefs {
  const favourites = prefs.favourites.includes(actionId)
    ? prefs.favourites.filter((id) => id !== actionId)
    : [...prefs.favourites, actionId];
  return { ...prefs, favourites };
}

export function rememberAction(prefs: CreatePrefs, actionId: string): CreatePrefs {
  return {
    ...prefs,
    recent: [actionId, ...prefs.recent.filter((id) => id !== actionId)].slice(0, 5),
  };
}
