"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Check, ChevronsUpDown, Loader2, X } from "lucide-react";
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
} from "@/components/ui/command";

export type EntityOption = {
  value: string;
  label: string;
  description?: string;
  keywords?: string;
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
      const hay = `${o.label} ${o.description ?? ""} ${o.keywords ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [options, search, clientFilter]);

  useEffect(() => {
    if (!open) setInternalSearch("");
  }, [open]);

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
            className="w-full justify-between font-normal"
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
              <Loader2 className="ml-2 size-4 shrink-0 animate-spin opacity-60" />
            ) : (
              <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder={searchPlaceholder}
              value={search}
              onValueChange={setSearch}
            />
            <CommandList id={listId}>
              <CommandEmpty>{loading ? "Loading…" : emptyText}</CommandEmpty>
              <CommandGroup>
                {filtered.map((o) => (
                  <CommandItem
                    key={o.value}
                    value={o.value}
                    onSelect={() => {
                      onChange(o.value);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn("mr-2 size-4", value === o.value ? "opacity-100" : "opacity-0")}
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{o.label}</span>
                      {o.description ? (
                        <span className="truncate text-xs text-muted-foreground">{o.description}</span>
                      ) : null}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {allowClear && value ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="shrink-0"
          aria-label="Clear selection"
          disabled={disabled}
          onClick={() => onChange("")}
        >
          <X className="size-4" />
        </Button>
      ) : null}
    </div>
  );
}
