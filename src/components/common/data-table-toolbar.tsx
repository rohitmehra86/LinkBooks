import type { ReactNode } from "react";
import { Columns3, Download, Loader2, Rows3, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Density } from "@/lib/table-prefs";

export type ToolbarColumn = { id: string; label: string; visible: boolean };

/**
 * Toolbar that sits above a data table: search, filter controls (any nodes), column chooser,
 * density, export. When rows are selected it swaps to a bulk-action bar with the count and a
 * "clear" control, so bulk actions never hide among filters.
 *
 * It is presentational: pass state in, handle changes out. Omit a prop to omit that control.
 */
export function DataTableToolbar({
  search,
  onSearchChange,
  searchPlaceholder = "Search",
  filters,
  columns,
  onToggleColumn,
  density,
  onDensityChange,
  onExport,
  exporting,
  selectedCount = 0,
  onClearSelection,
  bulkActions,
}: {
  search?: string;
  onSearchChange?: (q: string) => void;
  searchPlaceholder?: string;
  filters?: ReactNode;
  columns?: ToolbarColumn[];
  onToggleColumn?: (id: string) => void;
  density?: Density;
  onDensityChange?: (d: Density) => void;
  onExport?: () => void;
  exporting?: boolean;
  selectedCount?: number;
  onClearSelection?: () => void;
  bulkActions?: ReactNode;
}) {
  if (selectedCount > 0) {
    return (
      <div
        role="region"
        aria-label="Bulk actions"
        className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-info-soft px-3 py-2 print:hidden"
      >
        <span className="text-sm font-medium text-info-ink" aria-live="polite">
          {selectedCount} selected
        </span>
        <div className="flex flex-wrap items-center gap-2">{bulkActions}</div>
        {onClearSelection ? (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onClearSelection}>
            <X />
            Clear
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 print:hidden" role="search">
      {onSearchChange ? (
        <div className="relative w-full sm:w-72">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            className="pl-8"
            type="search"
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            value={search ?? ""}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
      ) : null}
      {filters}
      <div className="ml-auto flex items-center gap-2">
        {columns && onToggleColumn ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Columns3 />
                Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel>Show columns</DropdownMenuLabel>
              {columns.map((c) => (
                <DropdownMenuCheckboxItem
                  key={c.id}
                  checked={c.visible}
                  onCheckedChange={() => onToggleColumn(c.id)}
                  onSelect={(e) => e.preventDefault()}
                >
                  {c.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {density && onDensityChange ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" aria-label="Row density">
                <Rows3 />
                Density
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Row density</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup
                value={density}
                onValueChange={(v) => onDensityChange(v as Density)}
              >
                <DropdownMenuRadioItem value="comfortable">Comfortable</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="compact">Compact</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {onExport ? (
          <Button variant="outline" size="sm" onClick={onExport} disabled={exporting}>
            {exporting ? <Loader2 className="animate-spin" /> : <Download />}
            Export CSV
          </Button>
        ) : null}
      </div>
    </div>
  );
}
