"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Download, Loader2 } from "lucide-react";
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
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <Input
        className="w-64"
        placeholder={searchPlaceholder}
        value={state.q}
        onChange={(e) => onChange({ q: e.target.value, page: 0 })}
        aria-label="Search"
      />
      <Select value={state.status} onValueChange={(v) => onChange({ status: v, page: 0 })}>
        <SelectTrigger className="w-44">
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
      <label className="text-xs text-muted-foreground">
        From
        <Input
          type="date"
          className="mt-1 w-40"
          value={state.from}
          onChange={(e) => onChange({ from: e.target.value, page: 0 })}
        />
      </label>
      <label className="text-xs text-muted-foreground">
        To
        <Input
          type="date"
          className="mt-1 w-40"
          value={state.to}
          onChange={(e) => onChange({ to: e.target.value, page: 0 })}
        />
      </label>
      {extra}
      <Button variant="outline" size="sm" onClick={onExport} disabled={exporting}>
        {exporting ? (
          <Loader2 className="mr-1 size-4 animate-spin" />
        ) : (
          <Download className="mr-1 size-4" />
        )}
        Export CSV
      </Button>
    </div>
  );
}

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
  return (
    <TableHead className={className}>
      <button
        type="button"
        className="inline-flex items-center gap-1 font-medium hover:underline"
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
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          )
        ) : null}
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
    <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
      <span className="text-muted-foreground">
        {first}–{last} of {total}
      </span>
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
      <Select
        value={String(state.pageSize)}
        onValueChange={(v) => onChange({ pageSize: Number(v), page: 0 })}
      >
        <SelectTrigger className="w-28">
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
    </div>
  );
}
