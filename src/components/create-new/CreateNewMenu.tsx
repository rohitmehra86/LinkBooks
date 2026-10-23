import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useRouteContext } from "@tanstack/react-router";
import {
  Calculator,
  ChevronRight,
  Clock,
  FolderOpen,
  Landmark,
  Loader2,
  Plus,
  Receipt,
  Search,
  ShoppingCart,
  Star,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  CREATE_GROUP_LABEL,
  createActionById,
  type CreateAction,
  type CreateGroup,
} from "@/lib/create-new/registry";
import { actionIsRunnable, searchCreateActions } from "@/lib/create-new/menu";
import { permissionsForRole } from "@/lib/permissions";
import {
  readCreatePrefs,
  rememberAction,
  toggleFavourite,
  writeCreatePrefs,
  type CreatePrefs,
} from "@/lib/create-new/preferences";
import { loadCreatePanel } from "@/components/create-new/load-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const SECTIONS: { group: CreateGroup; icon: LucideIcon }[] = [
  { group: "sales", icon: Receipt },
  { group: "purchases", icon: ShoppingCart },
  { group: "banking", icon: Landmark },
  { group: "accounting", icon: Calculator },
  { group: "contacts", icon: Users },
  { group: "documents", icon: FolderOpen },
];

const MENU_ORDER = [
  "invoice",
  "recurring_invoice",
  "quote",
  "sales_receipt",
  "customer_credit",
  "receive_payment",
  "customer_refund",
  "customer_statement",
  "customer",
  "bill",
  "recurring_bill",
  "purchase_order",
  "supplier_credit",
  "pay_bill",
  "reimbursement",
  "supplier_refund",
  "supplier",
  "expense",
  "receive_money",
  "bank_transfer",
  "bank_deposit",
  "bank_adjustment",
  "card_payment",
  "manual_journal",
  "recurring_journal",
  "account",
  "product",
  "project",
  "document_upload",
];

export function CreateNewMenu() {
  const { user } = useRouteContext({ from: "/_authenticated" });
  const { company } = useActiveCompany();
  const role = company?.role;
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [prefs, setPrefs] = useState<CreatePrefs>({ favourites: [], recent: [] });
  const [flyoverId, setFlyoverId] = useState<string | null>(null);
  const [Panel, setPanel] = useState<ComponentType | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);

  useEffect(() => {
    setPrefs(readCreatePrefs(window.localStorage, user.id));
  }, [user.id]);

  useEffect(() => {
    if (!menuOpen) return;
    const t = window.setTimeout(() => searchRef.current?.focus(), 0);
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const results = useMemo(() => {
    const found = searchCreateActions(query, role);
    return [...found].sort((a, b) => MENU_ORDER.indexOf(a.id) - MENU_ORDER.indexOf(b.id));
  }, [query, role]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, menuOpen]);

  function persist(next: CreatePrefs) {
    setPrefs(next);
    writeCreatePrefs(window.localStorage, user.id, next);
  }

  function openAction(action: CreateAction) {
    if (!actionIsRunnable(action, role)) return;
    persist(rememberAction(prefs, action.id));
    setMenuOpen(false);
    setQuery("");
    setPanel(null);
    setPanelError(null);
    setFlyoverId(action.id);
    void loadCreatePanel(action.id)
      .then((Loaded) => setPanel(() => Loaded))
      .catch((error: unknown) => {
        setPanelError(error instanceof Error ? error.message : "Could not open the form");
      });
  }

  function closeFlyover() {
    if (!window.confirm("Close this form? Unsaved changes on this form will be lost.")) return;
    setFlyoverId(null);
    setPanel(null);
    setPanelError(null);
    buttonRef.current?.focus();
  }

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(results.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter" && results[activeIndex]) {
      event.preventDefault();
      openAction(results[activeIndex]);
    }
  }

  const flyover = flyoverId ? createActionById(flyoverId) : undefined;
  const favouriteActions = prefs.favourites
    .map((id) => createActionById(id))
    .filter((action): action is CreateAction => Boolean(action));
  const recentActions = prefs.recent
    .map((id) => createActionById(id))
    .filter((action): action is CreateAction => Boolean(action));

  return (
    <>
      <Button
        ref={buttonRef}
        size="sm"
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        aria-controls={menuId}
        className="rounded-full bg-neutral-950 px-4 text-white hover:bg-neutral-800"
        onClick={() => setMenuOpen((open) => !open)}
      >
        <Plus className="size-4" />
        Create
      </Button>

      {menuOpen ? (
        <>
          <button
            type="button"
            aria-label="Close create menu"
            className="fixed inset-0 z-40 cursor-default bg-transparent"
            onClick={() => setMenuOpen(false)}
          />
          <div
            id={menuId}
            role="dialog"
            aria-modal="true"
            aria-label="Create new"
            className="fixed left-1/2 top-16 z-50 flex max-h-[min(44rem,calc(100vh-5rem))] w-[min(58rem,calc(100vw-1.5rem))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-background text-foreground shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4 px-5 pt-5">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">Create new</h2>
                <p className="text-sm text-muted-foreground">Choose an action to open its flyover</p>
              </div>
              <button
                type="button"
                aria-label="Close"
                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => setMenuOpen(false)}
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="px-5 py-4">
              <div className="relative">
                <Input
                  ref={searchRef}
                  value={query}
                  aria-label="Search create actions"
                  aria-activedescendant={results[activeIndex] ? `${menuId}-${results[activeIndex].id}` : undefined}
                  placeholder="Search transactions and actions..."
                  className="h-11 rounded-xl pr-10"
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={onSearchKeyDown}
                />
                <Search className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2">
              {!query && (favouriteActions.length > 0 || recentActions.length > 0) ? (
                <div className="mb-3 grid gap-3 sm:grid-cols-2">
                  <ActionCard
                    title="Favourites"
                    icon={Star}
                    actions={favouriteActions}
                    role={role}
                    prefs={prefs}
                    onOpen={openAction}
                    onToggle={(id) => persist(toggleFavourite(prefs, id))}
                  />
                  <ActionCard
                    title="Recent"
                    icon={Clock}
                    actions={recentActions}
                    role={role}
                    prefs={prefs}
                    onOpen={openAction}
                    onToggle={(id) => persist(toggleFavourite(prefs, id))}
                  />
                </div>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                {SECTIONS.map(({ group, icon }) => (
                  <ActionCard
                    key={group}
                    title={CREATE_GROUP_LABEL[group]}
                    icon={icon}
                    actions={results.filter((action) => action.group === group)}
                    role={role}
                    prefs={prefs}
                    activeId={results[activeIndex]?.id}
                    menuId={menuId}
                    onOpen={openAction}
                    onToggle={(id) => persist(toggleFavourite(prefs, id))}
                  />
                ))}
              </div>
              {results.length === 0 ? (
                <p className="px-2 py-6 text-sm text-muted-foreground">No matching actions.</p>
              ) : null}
            </div>
            <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
              Search, favourites, recent actions, permissions and keyboard shortcuts.
            </p>
          </div>
        </>
      ) : null}

      <Sheet open={Boolean(flyoverId)} onOpenChange={(open) => !open && closeFlyover()}>
        <SheetContent
          side="right"
          className={cn(
            "flex h-full w-full max-w-none flex-col gap-0 overflow-hidden p-0",
            flyover?.width === "narrow"
              ? "sm:w-[28rem] sm:max-w-[32rem]"
              : "sm:w-[82vw] sm:min-w-[40rem] sm:max-w-[1200px]",
          )}
        >
          <SheetHeader className="shrink-0 border-b border-border px-6 py-4 pr-12 text-left">
            <SheetTitle>{flyover?.label ?? "Create"}</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {panelError ? <p className="text-sm text-destructive">{panelError}</p> : null}
            {!Panel && !panelError ? (
              <div className="flex justify-center py-12">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            ) : null}
            {Panel ? <Panel /> : null}
          </div>
          <div className="flex shrink-0 justify-end border-t border-border px-6 py-4">
            <Button type="button" variant="ghost" size="sm" onClick={closeFlyover}>
              Cancel
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function ActionCard({
  title,
  icon: Icon,
  actions,
  role,
  prefs,
  activeId,
  menuId,
  onOpen,
  onToggle,
}: {
  title: string;
  icon: LucideIcon;
  actions: CreateAction[];
  role: string | null | undefined;
  prefs: CreatePrefs;
  activeId?: string | undefined;
  menuId?: string;
  onOpen: (action: CreateAction) => void;
  onToggle: (id: string) => void;
}) {
  if (actions.length === 0) return null;
  return (
    <section className="rounded-xl border border-border p-3">
      <h3 className="mb-1 flex items-center gap-2 px-2 py-1 text-sm font-semibold">
        <Icon className="size-4 text-muted-foreground" />
        {title}
      </h3>
      <ul>
        {actions.map((action) => {
          const runnable = actionIsRunnable(action, role);
          const allowed = permissionsForRole(role).includes(action.permission);
          const reason = allowed
            ? (action.blocker ?? "This action is unavailable.")
            : "You do not have permission for this action.";
          return (
            <li key={`${title}-${action.id}`}>
              <div
                id={menuId ? `${menuId}-${action.id}` : undefined}
                className={cn(
                  "flex items-center rounded-lg",
                  activeId === action.id && "bg-muted",
                )}
              >
                <button
                  type="button"
                  disabled={!runnable}
                  title={runnable ? action.label : reason}
                  className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-lg px-2 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:text-muted-foreground"
                  onClick={() => onOpen(action)}
                >
                  <span className="truncate">{action.label}</span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  {!runnable ? <span className="sr-only">{reason}</span> : null}
                </button>
                <button
                  type="button"
                  aria-label={prefs.favourites.includes(action.id) ? `Unfavourite ${action.label}` : `Favourite ${action.label}`}
                  aria-pressed={prefs.favourites.includes(action.id)}
                  className="rounded-md p-2 text-muted-foreground hover:text-foreground"
                  onClick={() => onToggle(action.id)}
                >
                  <Star className={cn("size-3.5", prefs.favourites.includes(action.id) && "fill-current text-foreground")} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
