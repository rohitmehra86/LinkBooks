import { Link } from "@tanstack/react-router";
import { ArrowDownRight, ArrowUpRight, Minus, type LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { statusDisplay } from "@/lib/status-badge";

export type StatTone = "neutral" | "positive" | "negative" | "warning";

const TONE_CLASS: Record<StatTone, string> = {
  neutral: "text-foreground",
  positive: "text-money-in",
  negative: "text-money-out",
  warning: "text-warning-ink",
};

export type StatTrend = {
  /** Already-formatted change, e.g. "+12.4%" or "£1,200.00". Not computed here. */
  label: string;
  direction: "up" | "down" | "flat";
  /** Whether "up" is good news. Revenue up is good; bills overdue up is not. Default true. */
  upIsGood?: boolean;
  /** Short context, e.g. "vs last year". */
  context?: string;
};

function trendTone(t: StatTrend): "good" | "bad" | "flat" {
  if (t.direction === "flat") return "flat";
  const good = t.direction === "up" ? (t.upIsGood ?? true) : !(t.upIsGood ?? true);
  return good ? "good" : "bad";
}

/**
 * KPI tile: label, large tabular value, optional trend chip and hint. Pass `href` to make the
 * whole tile a link. Only show a `trend` when it is computed from real data.
 */
export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "neutral",
  trend,
  href,
  loading,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: LucideIcon;
  tone?: StatTone;
  trend?: StatTrend;
  href?: string;
  loading?: boolean;
}) {
  const t = trend ? trendTone(trend) : null;
  const TrendIcon =
    trend?.direction === "up" ? ArrowUpRight : trend?.direction === "down" ? ArrowDownRight : Minus;
  const body = (
    <CardContent className="p-5">
      <div className="flex items-start justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {Icon ? (
          <span className="grid size-7 place-items-center rounded-md bg-secondary text-muted-foreground">
            <Icon className="size-4" aria-hidden />
          </span>
        ) : null}
      </div>
      {loading ? (
        <Skeleton className="mt-3 h-8 w-32" />
      ) : (
        <div className={cn("numeric mt-2 text-2xl font-semibold tracking-tight", TONE_CLASS[tone])}>
          {value}
        </div>
      )}
      {trend || hint ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {trend ? (
            <span
              className={cn(
                "numeric inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 font-medium",
                t === "good" && "bg-success-soft text-success-ink",
                t === "bad" && "bg-destructive-soft text-destructive-ink",
                t === "flat" && "bg-neutral-soft text-neutral-ink",
              )}
            >
              <TrendIcon className="size-3" aria-hidden />
              {trend.label}
            </span>
          ) : null}
          {trend?.context ? <span>{trend.context}</span> : null}
          {hint ? <span>{hint}</span> : null}
        </div>
      ) : null}
    </CardContent>
  );
  return href ? (
    <Card className="transition-shadow hover:shadow-raised">
      <Link
        to={href as never}
        className="block rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {body}
      </Link>
    </Card>
  ) : (
    <Card>{body}</Card>
  );
}

/**
 * Status chip with consistent colours (draft / awaiting approval / awaiting payment / overdue /
 * paid / void …). Pass the raw status; `label` overrides the wording only (colour is unchanged).
 */
export function StatusBadge({
  status,
  label,
  className,
}: {
  status: string | null | undefined;
  label?: string;
  className?: string;
}) {
  const d = statusDisplay(status);
  return (
    <Badge
      variant={d.tone}
      className={cn("whitespace-nowrap", d.muted && "line-through", className)}
    >
      {label ?? d.label}
    </Badge>
  );
}

/**
 * A monetary figure: tabular, right-aligned by default, optionally coloured by direction.
 * Pass the already formatted string from `useFormat().money(...)`.
 */
export function Amount({
  children,
  tone = "neutral",
  className,
  align = "right",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "in" | "out" | "muted";
  className?: string;
  align?: "right" | "left";
}) {
  return (
    <span
      className={cn(
        "numeric inline-block whitespace-nowrap",
        align === "right" ? "text-right" : "text-left",
        tone === "in" && "text-money-in",
        tone === "out" && "text-money-out",
        tone === "muted" && "text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}
