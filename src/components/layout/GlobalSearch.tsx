import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Search } from "lucide-react";
import { useActiveCompany } from "@/hooks/use-active-company";
import { useFormat } from "@/hooks/use-format";
import { globalSearch, type GlobalSearchHit } from "@/lib/search/global-search.functions";
import {
  buildPaletteActions,
  filterPaletteActions,
  type PaletteAction,
} from "@/lib/search/palette-items";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const ENTITY_LABEL: Record<GlobalSearchHit["entity"], string> = {
  contact: "Contacts",
  invoice: "Invoices",
  bill: "Bills",
  account: "Accounts",
  product: "Products & services",
  journal: "Journals",
};

/**
 * Ctrl/Cmd+K command palette: jump to pages, reports and create screens, or find records
 * (invoices, bills by supplier invoice number, contacts, accounts, journals). Arrow keys and
 * Enter work through cmdk; the same palette opens from the button on small screens.
 */
export function GlobalSearch({ className }: { className?: string }) {
  const { company } = useActiveCompany();
  const fmt = useFormat();
  const companyId = company?.id;
  const navigate = useNavigate();
  const runSearch = useServerFn(globalSearch);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const searchQ = useQuery({
    queryKey: ["global-search", companyId, debounced],
    enabled: Boolean(companyId) && debounced.length >= 2 && open,
    queryFn: () => runSearch({ data: { companyId: companyId!, q: debounced } }),
    staleTime: 15_000,
  });

  const allActions = useMemo(() => buildPaletteActions(), []);
  const actions = useMemo(() => filterPaletteActions(allActions, q), [allActions, q]);
  const hits = searchQ.data ?? [];

  function close() {
    setOpen(false);
    setQ("");
    setDebounced("");
  }

  function goAction(a: PaletteAction) {
    close();
    void navigate({ to: a.href as never, ...(a.search ? { search: a.search as never } : {}) });
  }

  function goHit(h: GlobalSearchHit) {
    close();
    void navigate({ to: h.href as never, ...(h.search ? { search: h.search as never } : {}) });
  }

  const groups = (["Create", "Go to", "Reports"] as const)
    .map((g) => ({ name: g, items: actions.filter((a) => a.group === g).slice(0, 6) }))
    .filter((g) => g.items.length > 0);
  const hitGroups = (Object.keys(ENTITY_LABEL) as GlobalSearchHit["entity"][])
    .map((e) => ({ entity: e, items: hits.filter((h) => h.entity === e) }))
    .filter((g) => g.items.length > 0);
  const typed = q.trim().length >= 2;
  const nothing = typed && groups.length === 0 && hitGroups.length === 0 && !searchQ.isFetching;

  return (
    <>
      {/* Desktop: looks like the old search box, opens the palette */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search (Ctrl K)"
        aria-keyshortcuts="Control+K Meta+K"
        className={cn(
          "hidden h-10 w-full max-w-sm items-center gap-2 rounded-md border border-input bg-background px-3 text-left text-sm text-muted-foreground hover:bg-accent md:flex",
          className,
        )}
      >
        <Search className="size-4" />
        <span className="flex-1 truncate">Search invoices, bills, contacts…</span>
        <kbd className="rounded border bg-muted px-1.5 text-[10px] font-medium">Ctrl K</kbd>
      </button>
      {/* Mobile: icon button */}
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        aria-label="Search"
        onClick={() => setOpen(true)}
      >
        <Search className="size-5" />
      </Button>

      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : close())}>
        <DialogContent className="overflow-hidden p-0">
          <DialogTitle className="sr-only">Search</DialogTitle>
          <DialogDescription className="sr-only">
            Search records, pages and reports. Use the arrow keys and Enter.
          </DialogDescription>
          <Command shouldFilter={false} label="Search">
            <CommandInput
              value={q}
              onValueChange={setQ}
              placeholder="Type to search — e.g. an invoice number, a supplier or “new bill”"
            />
            <CommandList>
              {searchQ.isFetching ? (
                <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Searching…
                </div>
              ) : null}
              {searchQ.isError ? (
                <div role="alert" className="px-3 py-2 text-sm text-destructive">
                  {searchQ.error instanceof Error ? searchQ.error.message : "Search failed"}
                </div>
              ) : null}
              {!typed ? (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  Type at least 2 characters. Try “new invoice”, “aged payables” or a supplier
                  invoice number.
                </div>
              ) : null}
              {nothing ? <CommandEmpty>No matches in this organisation.</CommandEmpty> : null}
              {groups.map((g) => (
                <CommandGroup key={g.name} heading={g.name}>
                  {g.items.map((a) => (
                    <CommandItem key={a.id} value={a.id} onSelect={() => goAction(a)}>
                      {a.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
              {hitGroups.map((g) => (
                <CommandGroup key={g.entity} heading={ENTITY_LABEL[g.entity]}>
                  {g.items.map((h) => (
                    <CommandItem
                      key={`${h.entity}-${h.id}`}
                      value={`${h.entity}-${h.id}`}
                      onSelect={() => goHit(h)}
                      className="flex-col items-start gap-0.5"
                    >
                      <span className="flex w-full justify-between gap-2">
                        <span className="font-medium">{h.title}</span>
                        {h.amount_minor !== undefined && h.currency ? (
                          <span className="tabular-nums text-muted-foreground">
                            {fmt.money(h.amount_minor, h.currency)}
                          </span>
                        ) : null}
                      </span>
                      <span className="text-xs text-muted-foreground">{h.subtitle}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
