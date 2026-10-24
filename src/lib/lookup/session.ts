/**
 * UI session for a lookup field. The selected record id stays in the parent form;
 * this state only tracks the popup, the search text, keyboard highlight, and create flyover.
 */

export type LookupUi = {
  open: boolean;
  query: string;
  highlight: number;
  createOpen: boolean;
  pinnedId: string | null;
};

export type LookupUiEvent =
  | { type: "open" }
  | { type: "dismiss" }
  | { type: "query"; query: string }
  | { type: "move"; delta: number; count: number }
  | { type: "highlight"; index: number; count: number }
  | { type: "home" }
  | { type: "end"; count: number }
  | { type: "activate" }
  | { type: "start-create" }
  | { type: "cancel-create" }
  | { type: "complete-create"; id: string };

export const initialLookupUi = (): LookupUi => ({
  open: false,
  query: "",
  highlight: 0,
  createOpen: false,
  pinnedId: null,
});

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function reduceLookupUi(state: LookupUi, event: LookupUiEvent): LookupUi {
  switch (event.type) {
    case "open":
      return { ...state, open: true, highlight: 0 };
    case "dismiss":
      return { ...state, open: false, highlight: 0 };
    case "query":
      return { ...state, open: true, query: event.query, highlight: 0 };
    case "move": {
      if (!state.open || event.count <= 0) return state;
      return { ...state, highlight: clamp(state.highlight + event.delta, 0, event.count - 1) };
    }
    case "highlight":
      if (event.count <= 0) return { ...state, highlight: 0 };
      return { ...state, highlight: clamp(event.index, 0, event.count - 1) };
    case "home":
      return state.open ? { ...state, highlight: 0 } : state;
    case "end":
      return state.open && event.count > 0 ? { ...state, highlight: event.count - 1 } : state;
    case "activate":
      return { ...state, open: false, query: "", highlight: 0 };
    case "start-create":
      return { ...state, open: false, createOpen: true };
    case "cancel-create":
      return { ...state, createOpen: false };
    case "complete-create":
      return {
        ...state,
        createOpen: false,
        open: false,
        query: "",
        highlight: 0,
        pinnedId: event.id,
      };
    default:
      return state;
  }
}

/** Maps a keypress to a session event. `null` means the browser should handle the key. */
export function lookupKeyAction(
  key: string,
  open: boolean,
): LookupUiEvent | "activate-highlight" | null {
  if (key === "Escape") return open ? { type: "dismiss" } : null;
  if (key === "Tab") return open ? { type: "dismiss" } : null;
  if (key === "ArrowDown") return open ? { type: "move", delta: 1, count: 0 } : { type: "open" };
  if (key === "ArrowUp") return open ? { type: "move", delta: -1, count: 0 } : { type: "open" };
  if (key === "Home") return open ? { type: "home" } : null;
  if (key === "End") return open ? { type: "end", count: 0 } : null;
  if (key === "Enter") return open ? "activate-highlight" : { type: "open" };
  return null;
}

/** Fills in the live result count for arrow and End events. */
export function withResultCount(event: LookupUiEvent, count: number): LookupUiEvent {
  if (event.type === "move" || event.type === "end" || event.type === "highlight") {
    return { ...event, count };
  }
  return event;
}

export function canOfferCreate(permitted: boolean | undefined, hasAction: boolean): boolean {
  return hasAction && permitted !== false;
}

/** Id to commit when the highlighted row is activated. Disabled rows commit nothing. */
export function activationTarget(
  row: { id: string; disabled?: boolean | undefined } | "create" | null,
): string | "create" | null {
  if (row === null) return null;
  if (row === "create") return "create";
  if (row.disabled) return null;
  return row.id;
}
