"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { DataTableToolbar } from "@/components/common/data-table-toolbar";
import { TableCard } from "@/components/common/table-card";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TableHead } from "@/components/ui/table";

/** Debounce a fast-changing value (search box) before it hits the server. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export type ListState = {
  q: string;
  status: string;
  from: string;
  to: string;
  sort: string;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
};

export const initialListState = (sort: string): ListState => ({
  q: "",
  status: "all",
  from: "",
  to: "",
  sort,
  dir: "desc",
  page: 0,
  pageSize: 50,
});

type ToolbarProps = {
  state: ListState;
  onChange: (patch: Partial<ListState>) => void;
  statuses: Array<{ value: string; label: string }>;
  searchPlaceholder: string;
  onExport: () => void;
  exporting?: boolean;
  extra?: ReactNode;
};

/** Search, status, date range, optional extra filters and CSV export, in one consistent bar. */
export function ListToolbar({
  state,
  onChange,
  statuses,
  searchPlaceholder,
  onExport,
  exporting,
  extra,
}: ToolbarProps) {
  return (
    <DataTableToolbar
      search={state.q}
      onSearchChange={(q) => onChange({ q, page: 0 })}
      searchPlaceholder={searchPlaceholder}
      onExport={onExport}
      {...(exporting !== undefined ? { exporting } : {})}
      filters={
        <>
          <Select value={state.status} onValueChange={(v) => onChange({ status: v, page: 0 })}>
            <SelectTrigger className="w-full sm:w-44" aria-label="Status">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {statuses.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1.5">
            <Input
              type="date"
              aria-label="From date"
              className="w-36"
              value={state.from}
              onChange={(e) => onChange({ from: e.target.value, page: 0 })}
            />
            <span className="text-xs text-muted-foreground" aria-hidden>
              to
            </span>
            <Input
              type="date"
              aria-label="To date"
              className="w-36"
              value={state.to}
              onChange={(e) => onChange({ to: e.target.value, page: 0 })}
            />
          </div>
          {extra}
        </>
      }
    />
  );
}

export { TableCard };

export function SortHead({
  label,
  column,
  state,
  onChange,
  className,
}: {
  label: string;
  column: string;
  state: ListState;
  onChange: (patch: Partial<ListState>) => void;
  className?: string;
}) {
  const active = state.sort === column;
  const right = className?.includes("text-right");
  return (
    <TableHead
      className={className}
      aria-sort={active ? (state.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        className={cn(
          "inline-flex items-center gap-1 rounded-sm uppercase tracking-wide hover:text-foreground",
          right && "flex-row-reverse",
          active && "text-foreground",
        )}
        onClick={() =>
          onChange({
            sort: column,
            dir: active && state.dir === "desc" ? "asc" : "desc",
            page: 0,
          })
        }
      >
        {label}
        {active ? (
          state.dir === "asc" ? (
            <ArrowUp className="size-3" aria-hidden />
          ) : (
            <ArrowDown className="size-3" aria-hidden />
          )
        ) : (
          <ArrowUpDown className="size-3 opacity-40" aria-hidden />
        )}
      </button>
    </TableHead>
  );
}

export function Pager({
  total,
  state,
  onChange,
}: {
  total: number;
  state: ListState;
  onChange: (patch: Partial<ListState>) => void;
}) {
  const first = total === 0 ? 0 : state.page * state.pageSize + 1;
  const last = Math.min(total, (state.page + 1) * state.pageSize);
  return (
    <nav
      aria-label="Pagination"
      className="mt-4 flex flex-wrap items-center gap-3 text-sm print:hidden"
    >
      <span className="numeric text-muted-foreground" aria-live="polite">
        {first}–{last} of {total}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <Select
          value={String(state.pageSize)}
          onValueChange={(v) => onChange({ pageSize: Number(v), page: 0 })}
        >
          <SelectTrigger className="w-28" aria-label="Rows per page">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[25, 50, 100].map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n} / page
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          disabled={state.page === 0}
          onClick={() => onChange({ page: Math.max(0, state.page - 1) })}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={(state.page + 1) * state.pageSize >= total}
          onClick={() => onChange({ page: state.page + 1 })}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}
