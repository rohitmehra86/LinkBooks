"use client";

import { useEffect, useId, useMemo, useReducer, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Check, ChevronsUpDown, Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { LookupCreateFlyover } from "@/components/lookup/LookupCreateFlyover";
import { findLookupDuplicates } from "@/lib/lookup/duplicates";
import {
  filterLookupOptions,
  formatLookupLabel,
  groupLookupOptions,
  lookupPopupMaxHeight,
} from "@/lib/lookup/search";
import {
  activationTarget,
  canOfferCreate,
  initialLookupUi,
  lookupKeyAction,
  reduceLookupUi,
  withResultCount,
  type LookupUiEvent,
} from "@/lib/lookup/session";
import type { LookupOption } from "@/lib/lookup/types";
import { cn } from "@/lib/utils";

export type LookupCreateContext = {
  initialQuery: string;
  close: () => void;
  complete: (option: LookupOption) => void;
};

export type LookupSelectProps = {
  options: LookupOption[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string | undefined;
  searchPlaceholder?: string | undefined;
  emptyText?: string | undefined;
  disabled?: boolean | undefined;
  loading?: boolean | undefined;
  error?: string | null | undefined;
  onRetry?: (() => void) | undefined;
  allowClear?: boolean | undefined;
  required?: boolean | undefined;
  invalid?: boolean | undefined;
  id?: string | undefined;
  ariaLabel?: string | undefined;
  describedBy?: string | undefined;
  className?: string | undefined;
  /** When false, options are already filtered (server search). Grouping still applies. */
  clientFilter?: boolean | undefined;
  search?: string | undefined;
  onSearchChange?: ((query: string) => void) | undefined;
  /** Active organisation. Options tagged with another company are hidden. */
  companyId?: string | null | undefined;
  onCreate?: (() => void) | undefined;
  createLabel?: string | undefined;
  canCreate?: boolean | undefined;
  createTitle?: string | undefined;
  createStack?: number | undefined;
  renderCreate?: ((ctx: LookupCreateContext) => ReactNode) | undefined;
  onCreated?: ((option: LookupOption) => void) | undefined;
  maxHeight?: number | undefined;
  onLoadMore?: (() => void) | undefined;
  hasMore?: boolean | undefined;
  loadingMore?: boolean | undefined;
};

export function LookupSelect({
  options,
  value,
  onChange,
  placeholder = "Select…",
  searchPlaceholder = "Search code, name or description",
  emptyText = "No matching records",
  disabled,
  loading,
  error,
  onRetry,
  allowClear = true,
  required,
  invalid,
  id,
  ariaLabel,
  describedBy,
  className,
  clientFilter = true,
  search: controlledSearch,
  onSearchChange,
  companyId,
  onCreate,
  createLabel = "+ Create new",
  canCreate,
  createTitle = "New record",
  createStack = 1,
  renderCreate,
  onCreated,
  maxHeight,
  onLoadMore,
  hasMore,
  loadingMore,
}: LookupSelectProps) {
  const [ui, dispatch] = useReducer(reduceLookupUi, undefined, initialLookupUi);
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pinnedRef = useRef<LookupOption | null>(null);
  const keyboardNav = useRef(false);
  const suppressOpen = useRef(false);
  const query = controlledSearch ?? ui.query;
  const showCreate = canOfferCreate(canCreate, Boolean(onCreate || renderCreate));

  const prepared = useMemo(() => {
    const pinnedId = ui.pinnedId;
    const extra =
      pinnedRef.current &&
      pinnedRef.current.id === pinnedId &&
      !options.some((option) => option.id === pinnedId)
        ? [pinnedRef.current]
        : [];
    return filterLookupOptions([...extra, ...options], clientFilter ? query : "", companyId);
  }, [options, query, clientFilter, companyId, ui.pinnedId]);

  const groups = useMemo(() => groupLookupOptions(prepared), [prepared]);
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const rows = useMemo(() => {
    const items: Array<{ kind: "create" } | { kind: "option"; option: LookupOption }> = [];
    if (showCreate) items.push({ kind: "create" });
    for (const option of flat) items.push({ kind: "option", option });
    return items;
  }, [flat, showCreate]);

  const highlight = rows.length === 0 ? -1 : Math.min(ui.highlight, rows.length - 1);
  const activeRow = highlight >= 0 ? rows[highlight] : undefined;
  const activeId = !activeRow
    ? undefined
    : activeRow.kind === "create"
      ? `${listId}-create`
      : `${listId}-opt-${activeRow.option.id}`;

  const selected =
    options.find((option) => option.id === value) ??
    (pinnedRef.current?.id === value ? pinnedRef.current : null);
  const popupHeight =
    maxHeight ?? (typeof window === "undefined" ? 320 : lookupPopupMaxHeight(window.innerWidth));
  const duplicates = useMemo(
    () => (ui.createOpen ? findLookupDuplicates(options, query) : []),
    [ui.createOpen, options, query],
  );

  useEffect(() => {
    if (!ui.open) return;
    const handle = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(handle);
  }, [ui.open]);

  useEffect(() => {
    if (!ui.open || !activeId || !keyboardNav.current) return;
    keyboardNav.current = false;
    document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [ui.open, activeId]);

  const returnFocus = () => {
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  const apply = (event: LookupUiEvent) => {
    dispatch(withResultCount(event, rows.length));
  };

  const commit = (option: LookupOption) => {
    if (activationTarget(option) === null) return;
    onChange(option.id);
    // Close after this click finishes. Closing immediately lets the same click
    // hit the trigger and open the list again on the first row.
    suppressOpen.current = true;
    const trigger = triggerRef.current;
    if (trigger) trigger.style.pointerEvents = "none";
    window.setTimeout(() => {
      dispatch({ type: "activate" });
      window.setTimeout(() => {
        suppressOpen.current = false;
        if (triggerRef.current) triggerRef.current.style.pointerEvents = "";
      }, 250);
    }, 0);
  };

  const startCreate = () => {
    dispatch({ type: "start-create" });
    if (renderCreate) return;
    onCreate?.();
    returnFocus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const action = lookupKeyAction(event.key, ui.open);
    if (!action) return;
    if (action === "activate-highlight") {
      event.preventDefault();
      const row = highlight >= 0 ? rows[highlight] : null;
      if (!row) return;
      const target = activationTarget(row.kind === "create" ? "create" : row.option);
      if (target === "create") startCreate();
      else if (typeof target === "string") {
        const option = flat.find((item) => item.id === target);
        if (option) commit(option);
      }
      return;
    }
    if (event.key !== "Tab") event.preventDefault();
    if (action.type === "move" || action.type === "home" || action.type === "end") {
      keyboardNav.current = true;
      apply(action);
    } else if (action.type === "open") dispatch({ type: "open" });
    else dispatch(action);
  };

  return (
    <div className={cn("flex gap-1", className)}>
      <Popover
        open={ui.open}
        onOpenChange={(next) => {
          if (next && suppressOpen.current) return;
          dispatch(next ? { type: "open" } : { type: "dismiss" });
        }}
      >
        <PopoverTrigger asChild>
          <Button
            ref={triggerRef}
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={ui.open}
            aria-controls={listId}
            aria-haspopup="listbox"
            aria-autocomplete="list"
            aria-activedescendant={ui.open ? activeId : undefined}
            aria-label={ariaLabel ?? placeholder}
            aria-required={required || undefined}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            disabled={disabled}
            onKeyDown={onKeyDown}
            className="h-9 w-full justify-between bg-background px-2.5 text-sm font-normal"
          >
            <span className={cn("truncate text-left", !selected && "text-muted-foreground")}>
              {selected ? formatLookupLabel(selected) : placeholder}
            </span>
            {loading ? (
              <Loader2 className="ml-2 size-3.5 shrink-0 animate-spin opacity-60" />
            ) : (
              <ChevronsUpDown className="ml-2 size-3.5 shrink-0 opacity-50" />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[var(--radix-popover-trigger-width)] min-w-[16rem] p-0"
          align="start"
          sideOffset={4}
          collisionPadding={8}
        >
          <div className="border-b bg-background p-2">
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              aria-controls={listId}
              autoComplete="off"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => {
                const next = event.target.value;
                onSearchChange?.(next);
                dispatch({ type: "query", query: next });
              }}
              onKeyDown={onKeyDown}
            />
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label={ariaLabel ?? placeholder}
            className="overflow-y-scroll overscroll-contain p-1"
            style={{ maxHeight: popupHeight }}
          >
            <p className="sr-only" aria-live="polite">
              {loading ? "Loading records" : `${flat.length} results`}
            </p>
            {showCreate ? (
              <div
                id={`${listId}-create`}
                role="option"
                aria-selected={highlight === 0}
                className={cn(
                  "sticky top-0 z-10 flex cursor-pointer items-center gap-2 rounded-sm bg-popover px-2 py-1.5 text-sm font-medium",
                  highlight === 0
                    ? "bg-primary text-primary-foreground"
                    : "text-primary hover:bg-accent",
                )}
                onMouseEnter={() => dispatch({ type: "highlight", index: 0, count: rows.length })}
                onMouseDown={(event) => event.preventDefault()}
                onClick={startCreate}
              >
                <Plus className="size-3.5" />
                {createLabel}
              </div>
            ) : null}
            {error ? (
              <div role="alert" className="space-y-2 px-2 py-4 text-center text-sm">
                <p>{error}</p>
                {onRetry ? (
                  <Button type="button" size="sm" variant="outline" onClick={onRetry}>
                    Retry
                  </Button>
                ) : null}
              </div>
            ) : loading && flat.length === 0 ? (
              <p className="px-2 py-4 text-center text-sm text-muted-foreground">Loading…</p>
            ) : flat.length === 0 ? (
              <p className="px-2 py-4 text-center text-sm text-muted-foreground">{emptyText}</p>
            ) : (
              groups.map((group) => (
                <div
                  key={group.heading ?? "__all"}
                  role="group"
                  aria-label={group.heading ?? undefined}
                >
                  {group.heading ? (
                    <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                      {group.heading}
                    </p>
                  ) : null}
                  {group.items.map((option) => {
                    const rowIndex = rows.findIndex(
                      (row) => row.kind === "option" && row.option.id === option.id,
                    );
                    const active = rowIndex === highlight;
                    const chosen = option.id === value;
                    return (
                      <div
                        key={option.id}
                        id={`${listId}-opt-${option.id}`}
                        role="option"
                        aria-selected={chosen}
                        aria-disabled={option.disabled || undefined}
                        className={cn(
                          "flex cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-sm",
                          active && "bg-primary text-primary-foreground",
                          option.disabled && "cursor-not-allowed opacity-50",
                        )}
                        onMouseEnter={() =>
                          dispatch({ type: "highlight", index: rowIndex, count: rows.length })
                        }
                        onMouseDown={(event) => {
                          // Keep focus in the popup so the press is not lost when the list closes.
                          event.preventDefault();
                        }}
                        onClick={() => commit(option)}
                      >
                        <Check
                          className={cn(
                            "mt-0.5 size-4 shrink-0",
                            chosen ? "opacity-100" : "opacity-0",
                          )}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-2">
                            <span className="truncate">{formatLookupLabel(option)}</span>
                            {option.meta ? (
                              <span
                                className={cn(
                                  "shrink-0 text-xs",
                                  active ? "text-primary-foreground/80" : "text-muted-foreground",
                                )}
                              >
                                {option.meta}
                              </span>
                            ) : null}
                          </span>
                          {option.description ? (
                            <span
                              className={cn(
                                "block truncate text-xs",
                                active ? "text-primary-foreground/80" : "text-muted-foreground",
                              )}
                            >
                              {option.description}
                            </span>
                          ) : null}
                          {option.status ? (
                            <span
                              className={cn(
                                "block truncate text-xs",
                                active ? "text-primary-foreground/80" : "text-muted-foreground",
                              )}
                            >
                              {option.status}
                            </span>
                          ) : null}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))
            )}
            {hasMore ? (
              <Button
                type="button"
                variant="ghost"
                className="mt-1 w-full"
                disabled={loadingMore}
                onClick={onLoadMore}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
      {allowClear && value && !required ? (
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
      {renderCreate ? (
        <LookupCreateFlyover
          open={ui.createOpen}
          title={createTitle}
          description="The form you were filling in stays as you left it."
          duplicates={duplicates}
          stack={createStack}
          onOpenChange={(next) => {
            if (!next) {
              dispatch({ type: "cancel-create" });
              returnFocus();
            }
          }}
        >
          {renderCreate({
            initialQuery: query,
            close: () => {
              dispatch({ type: "cancel-create" });
              returnFocus();
            },
            complete: (option) => {
              pinnedRef.current = option;
              dispatch({ type: "complete-create", id: option.id });
              onChange(option.id);
              onCreated?.(option);
              returnFocus();
            },
          })}
        </LookupCreateFlyover>
      ) : null}
    </div>
  );
}
