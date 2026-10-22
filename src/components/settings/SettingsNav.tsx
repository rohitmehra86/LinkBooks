import { cn } from "@/lib/utils";
import { categoryMeta, type SettingsCategory } from "@/lib/settings/registry";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";

const GROUPS: Array<{ label: string; ids: SettingsCategory[] }> = [
  { label: "Start", ids: ["overview", "features"] },
  {
    label: "Organisation",
    ids: ["organisation", "accounting", "currencies", "tax", "documents"],
  },
  {
    label: "Operations",
    ids: ["sales", "purchases", "banking", "dimensions", "products", "contacts", "expenses", "reports"],
  },
  {
    label: "Platform",
    ids: [
      "users",
      "automation",
      "integrations",
      "notifications",
      "audit",
      "import_migration",
      "portals",
      "fixed_assets",
    ],
  },
  { label: "Firm & plan", ids: ["accountant", "subscription", "demo"] },
];

const NAV_KEY = "linkbooks.settings.nav.open";

type Props = {
  section: string;
  onSelect: (id: string) => void;
  showDemo: boolean;
  filter?: string;
};

export function SettingsNav({ section, onSelect, showDemo, filter }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    try {
      const raw = localStorage.getItem(NAV_KEY);
      if (raw) setOpen(JSON.parse(raw) as Record<string, boolean>);
      else {
        const init: Record<string, boolean> = {};
        GROUPS.forEach((g) => {
          init[g.label] = true;
        });
        setOpen(init);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const persist = (next: Record<string, boolean>) => {
    setOpen(next);
    try {
      localStorage.setItem(NAV_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const q = (filter ?? "").trim().toLowerCase();

  return (
    <nav className="space-y-2" aria-label="Settings categories">
      {GROUPS.map((group) => {
        const items = categoryMeta.filter((c) => {
          if (!group.ids.includes(c.id)) return false;
          if (c.id === "demo" && !showDemo) return false;
          if (!q) return true;
          return (
            c.label.toLowerCase().includes(q) ||
            c.synonyms.some((s) => s.includes(q)) ||
            c.description.toLowerCase().includes(q)
          );
        });
        if (items.length === 0) return null;
        const isOpen = open[group.label] !== false;
        return (
          <Collapsible
            key={group.label}
            open={isOpen}
            onOpenChange={(v) => persist({ ...open, [group.label]: v })}
          >
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                className="flex h-8 w-full items-center justify-between px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {group.label}
                <ChevronDown className={cn("size-3.5 transition", isOpen ? "rotate-180" : "")} />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-0.5 pb-2">
              {items.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onSelect(c.id)}
                  className={cn(
                    "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                    section === c.id
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground/90 hover:bg-muted",
                  )}
                >
                  <span className="truncate">{c.label}</span>
                  {c.availability === "unavailable" ? (
                    <Badge variant="outline" className="ml-1 shrink-0 text-[10px]">
                      Soon
                    </Badge>
                  ) : c.availability === "partial" ? (
                    <Badge variant="secondary" className="ml-1 shrink-0 text-[10px]">
                      Partial
                    </Badge>
                  ) : null}
                </button>
              ))}
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </nav>
  );
}
