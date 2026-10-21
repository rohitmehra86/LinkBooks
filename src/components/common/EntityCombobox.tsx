"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Check, ChevronsUpDown, Loader2, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";

export type EntityOption = {
  value: string;
  label: string;
  description?: string;
  keywords?: string;
  group?: string;
};

type Props = {
  options: EntityOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  loading?: boolean;
  allowClear?: boolean;
  className?: string;
  /** When true, filter options client-side by the search box. */
  clientFilter?: boolean;
  /** External search string sync (for server-side search). */
  search?: string;
  onSearchChange?: (q: string) => void;
  "aria-label"?: string;
  /**
   * Sticky “+ Add new…” action inside the expanded dropdown.
   * Do not place separate + icons beside the field when this is set.
   */
  onAddNew?: (() => void) | undefined;
  addNewLabel?: string | undefined;
  /** When false, hide Add New even if onAddNew is provided (permission gate). */
  canAddNew?: boolean | undefined;
};

export function EntityCombobox({
  options,
  value,
  onChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No results",
  disabled,
  loading,
  allowClear = true,
  className,
  clientFilter = true,
  search: controlledSearch,
  onSearchChange,
  "aria-label": ariaLabel,
  onAddNew,
  addNewLabel = "Add new…",
  canAddNew = true,
}: Props) {
  const [open, setOpen] = useState(false);
  const [internalSearch, setInternalSearch] = useState("");
  const listId = useId();
  const search = controlledSearch ?? internalSearch;
  const setSearch = onSearchChange ?? setInternalSearch;

  const selected = useMemo(
    () => options.find((o) => o.value === value) ?? null,
    [options, value],
  );

  const filtered = useMemo(() => {
    if (!clientFilter) return options;
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => {
      const hay = `${o.label} ${o.description ?? ""} ${o.keywords ?? ""} ${o.group ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [options, search, clientFilter]);

  const grouped = useMemo(() => {
    const map = new Map<string, EntityOption[]>();
    for (const o of filtered) {
      const g = o.group?.trim() || "";
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(o);
    }
    return map;
  }, [filtered]);

  useEffect(() => {
    if (!open) setInternalSearch("");
  }, [open]);

  const showAddNew = Boolean(onAddNew) && canAddNew;

  return (
    <div className={cn("flex gap-1", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-label={ariaLabel ?? placeholder}
            disabled={disabled}
            className="h-9 w-full justify-between px-2.5 font-normal text-sm"
          >
            <span className={cn("truncate text-left", !selected && "text-muted-foreground")}>
              {selected ? (
                <>
                  {selected.label}
                  {selected.description ? (
                    <span className="ml-1 text-muted-foreground">· {selected.description}</span>
                  ) : null}
                </>
              ) : (
                placeholder
              )}
            </span>
            {loading ? (
              <Loader2 className="ml-2 size-3.5 shrink-0 animate-spin opacity-60" />
            ) : (
              <ChevronsUpDown className="ml-2 size-3.5 shrink-0 opacity-50" />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[var(--radix-popover-trigger-width)] min-w-[240px] p-0"
          align="start"
          sideOffset={4}
        >
          <Command shouldFilter={false}>
            <CommandInput
              placeholder={searchPlaceholder}
              value={search}
              onValueChange={setSearch}
            />
            {showAddNew ? (
              <>
                <div className="sticky top-0 z-10 border-b bg-popover p-1">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm font-medium text-primary hover:bg-accent"
                    onClick={() => {
                      setOpen(false);
                      onAddNew?.();
                    }}
                  >
                    <Plus className="size-3.5" />
                    {addNewLabel}
                  </button>
                </div>
                <CommandSeparator />
              </>
            ) : null}
            <CommandList id={listId} className="max-h-64">
              <CommandEmpty>{loading ? "Loading…" : emptyText}</CommandEmpty>
              {Array.from(grouped.entries()).map(([groupName, items]) => (
                <CommandGroup key={groupName || "__all"} heading={groupName || undefined}>
                  {items.map((o) => (
                    <CommandItem
                      key={o.value}
                      value={o.value}
                      onSelect={() => {
                        onChange(o.value);
                        setOpen(false);
                      }}
                    >
                      <Check
                        className={cn(
                          "mr-2 size-4 shrink-0",
                          value === o.value ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{o.label}</span>
                        {o.description ? (
                          <span className="truncate text-xs text-muted-foreground">
                            {o.description}
                          </span>
                        ) : null}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {allowClear && value ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-9 shrink-0"
          aria-label="Clear selection"
          disabled={disabled}
          onClick={() => onChange("")}
        >
          <X className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}
