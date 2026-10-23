import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { TableHead } from "@/components/ui/table";
import { ariaSortValue, type SortDir } from "@/lib/sort";
import { cn } from "@/lib/utils";

/**
 * Column header that sorts. A real <button> inside the <th>, so Tab reaches it and Enter or
 * Space activates it; `aria-sort` tells screen readers which column is sorted (U-13 / U-14).
 */
export function SortableHead({
  label,
  active,
  dir,
  onSort,
  align = "left",
  className,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onSort: () => void;
  align?: "left" | "right";
  className?: string;
}) {
  const Icon = !active ? ArrowUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead
      aria-sort={ariaSortValue(active, dir)}
      className={cn(align === "right" && "text-right", className)}
    >
      <button
        type="button"
        onClick={onSort}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm font-medium outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
          align === "right" && "flex-row-reverse",
        )}
      >
        {label}
        <Icon aria-hidden className="size-3.5 opacity-70" />
      </button>
    </TableHead>
  );
}
