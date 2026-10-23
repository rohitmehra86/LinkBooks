import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ChevronRight, Inbox, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type Crumb = { label: string; to?: string };

/**
 * Page title block used by every screen: optional breadcrumb trail, title, subtitle, and a
 * right-hand action area (put the single primary action last). Wraps on narrow screens.
 */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  meta,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  breadcrumbs?: Crumb[];
  /** Inline content beside the title, e.g. a StatusBadge. */
  meta?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {breadcrumbs && breadcrumbs.length > 0 ? (
          <nav aria-label="Breadcrumb" className="mb-1.5">
            <ol className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              {breadcrumbs.map((c, i) => (
                <li key={`${c.label}-${i}`} className="flex items-center gap-1">
                  {i > 0 ? <ChevronRight className="size-3" aria-hidden /> : null}
                  {c.to && i < breadcrumbs.length - 1 ? (
                    <Link
                      to={c.to as never}
                      className="rounded-sm hover:text-foreground hover:underline"
                    >
                      {c.label}
                    </Link>
                  ) : (
                    <span aria-current={i === breadcrumbs.length - 1 ? "page" : undefined}>
                      {c.label}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {meta}
        </div>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2 print:hidden">{actions}</div>
      ) : null}
    </div>
  );
}

/** Page section heading inside a screen (smaller than the page title). */
export function SectionHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * "Nothing here yet" with a clear next step. `actionLabel` + `onActionClick` for a button, or
 * pass `action` for any node (e.g. a Link-wrapped Button). Never show sample data here.
 */
export function EmptyState({
  title,
  description,
  actionLabel,
  onActionClick,
  action,
  icon: Icon = Inbox,
  compact,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  onActionClick?: () => void;
  action?: ReactNode;
  icon?: typeof Inbox;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card px-6 text-center",
        compact ? "py-8" : "py-14",
      )}
    >
      <div className="grid size-11 place-items-center rounded-full bg-secondary text-muted-foreground">
        <Icon className="size-5" aria-hidden />
      </div>
      <h3 className="mt-4 text-sm font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
      {!action && actionLabel ? (
        <Button className="mt-5" size="sm" type="button" onClick={onActionClick}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

/** Table-shaped skeleton. Announced to screen readers as "Loading". */
export function LoadingState({ rows = 4 }: { rows?: number }) {
  return (
    <Card role="status" aria-busy="true" aria-label="Loading">
      <CardContent className="space-y-3.5 pt-6">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-4">
            <Skeleton className="h-4 w-1/4" />
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="ml-auto h-4 w-20" />
          </div>
        ))}
        <span className="sr-only">Loading…</span>
      </CardContent>
    </Card>
  );
}

/** Row skeleton for list pages: header strip + rows, same footprint as the loaded table. */
export function ListSkeleton({ rows = 8, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <Card role="status" aria-busy="true" aria-label="Loading list" className="overflow-hidden">
      <div className="flex gap-4 border-b bg-muted/40 px-4 py-3">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className={cn("h-3", i === columns - 1 ? "ml-auto w-16" : "w-24")} />
        ))}
      </div>
      <div className="divide-y">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="flex items-center gap-4 px-4 py-3.5">
            {Array.from({ length: columns }).map((_, i) => (
              <Skeleton
                key={i}
                className={cn(
                  "h-4",
                  i === columns - 1 ? "ml-auto w-20" : i === 0 ? "w-28" : "w-32",
                )}
              />
            ))}
          </div>
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </Card>
  );
}

/** Grid of KPI-card skeletons. */
export function CardGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
    >
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i}>
          <CardContent className="space-y-3 p-5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-3 w-20" />
          </CardContent>
        </Card>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

/** Report-shaped skeleton: title, a few section headings with indented lines and totals. */
export function ReportSkeleton({ sections = 3 }: { sections?: number }) {
  return (
    <Card role="status" aria-busy="true" aria-label="Loading report">
      <CardContent className="space-y-6 pt-6">
        {Array.from({ length: sections }).map((_, s) => (
          <div key={s} className="space-y-2.5">
            <Skeleton className="h-4 w-40" />
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 pl-4">
                <Skeleton className="h-3.5 w-1/3" />
                <Skeleton className="ml-auto h-3.5 w-20" />
              </div>
            ))}
            <div className="flex items-center gap-4 border-t pt-2.5">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="ml-auto h-4 w-24" />
            </div>
          </div>
        ))}
        <span className="sr-only">Loading…</span>
      </CardContent>
    </Card>
  );
}

/**
 * Inline error with a retry action. Use `compact` inside a card/widget; the default is a
 * full-width panel for a page body. Announced as an alert.
 */
export function ErrorState({
  title = "Something went wrong",
  description = "This data could not be loaded. Try again in a moment.",
  onRetry,
  compact,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
  compact?: boolean;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-destructive/30 bg-destructive-soft px-6 text-center",
        compact ? "py-6" : "py-12",
      )}
    >
      <AlertTriangle className="size-6 text-destructive-ink" aria-hidden />
      <h3 className="mt-3 text-sm font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" className="mt-5 bg-background" onClick={onRetry}>
          <RotateCw className="size-3.5" />
          Try again
        </Button>
      ) : null}
    </div>
  );
}
