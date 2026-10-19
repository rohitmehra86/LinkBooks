import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Search, Loader2 } from "lucide-react";
import { useActiveCompany } from "@/hooks/use-active-company";
import { globalSearch, type GlobalSearchHit } from "@/lib/search/global-search.functions";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function GlobalSearch({ className }: { className?: string }) {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const navigate = useNavigate();
  const runSearch = useServerFn(globalSearch);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const searchQ = useQuery({
    queryKey: ["global-search", companyId, debounced],
    enabled: Boolean(companyId) && debounced.length >= 2 && open,
    queryFn: () => runSearch({ data: { companyId: companyId!, q: debounced } }),
  });

  const hits = (searchQ.data ?? []) as GlobalSearchHit[];

  function go(hit: GlobalSearchHit) {
    setOpen(false);
    setQ("");
    void navigate({ to: hit.href as never });
  }

  return (
    <div className={cn("relative hidden max-w-sm md:block", className)}>
      <Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground" />
      <Input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Allow click on results
          setTimeout(() => setOpen(false), 150);
        }}
        placeholder="Search invoices, contacts, accounts…"
        className="pl-9"
        aria-label="Global search"
        autoComplete="off"
      />
      {open && debounced.length >= 2 ? (
        <div
          role="listbox"
          className="absolute z-50 mt-1 max-h-80 w-full overflow-auto rounded-md border bg-popover p-1 shadow-md"
        >
          {searchQ.isFetching ? (
            <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Searching…
            </div>
          ) : searchQ.isError ? (
            <div className="px-3 py-2 text-sm text-destructive">
              {(searchQ.error as Error)?.message ?? "Search failed"}
            </div>
          ) : hits.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">No matches in this organisation</div>
          ) : (
            hits.map((h) => (
              <button
                key={`${h.entity}-${h.id}`}
                type="button"
                role="option"
                className="flex w-full flex-col items-start rounded-sm px-3 py-2 text-left hover:bg-accent"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(h)}
              >
                <span className="text-sm font-medium">{h.title}</span>
                <span className="text-xs text-muted-foreground capitalize">
                  {h.entity} · {h.subtitle}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
