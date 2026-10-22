import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { categoryMeta, searchSettings } from "@/lib/settings/registry";
import { navItems } from "@/lib/nav";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectSection: (section: string) => void;
};

export function SettingsCommandPalette({ open, onOpenChange, onSelectSection }: Props) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  const matches = searchSettings(q);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search settings or jump to a module…" value={q} onValueChange={setQ} />
      <CommandList>
        <CommandEmpty>No matching settings.</CommandEmpty>
        <CommandGroup heading="Settings">
          {matches.map((c) => (
            <CommandItem
              key={c.id}
              value={`${c.label} ${c.synonyms.join(" ")}`}
              onSelect={() => {
                onSelectSection(c.id);
                onOpenChange(false);
              }}
            >
              <span className="font-medium">{c.label}</span>
              <span className="ml-2 text-xs text-muted-foreground">{c.availability}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Modules">
          {navItems
            .filter((n) => !q || n.label.toLowerCase().includes(q.toLowerCase()))
            .map((n) => (
              <CommandItem
                key={n.to}
                value={n.label}
                onSelect={() => {
                  if (n.to === "/settings") {
                    void navigate({ to: "/settings", search: { section: "overview" } });
                  } else {
                    void navigate({ to: n.to });
                  }
                  onOpenChange(false);
                }}
              >
                {n.label}
              </CommandItem>
            ))}
        </CommandGroup>
        {!q ? (
          <CommandGroup heading="All categories">
            {categoryMeta.slice(0, 8).map((c) => (
              <CommandItem
                key={`all-${c.id}`}
                value={`all ${c.label}`}
                onSelect={() => {
                  onSelectSection(c.id);
                  onOpenChange(false);
                }}
              >
                {c.label}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}
