import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  Landmark,
  Receipt,
  ShoppingCart,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { useFormat } from "@/hooks/use-format";
import { decimalPlacesFor } from "@/lib/accounting/money";
import type { getDashboardSnapshot } from "@/lib/dashboard/dashboard.functions";
import {
  bucketShares,
  buildChecklist,
  cashTotals,
  formatPercentChange,
  owedSummary,
  percentChange,
  shouldShowChecklist,
  totalCash,
  trendDirection,
} from "@/lib/dashboard/kpis";
import { EmptyState } from "@/components/common/states";
import { StatCard, type StatTrend } from "@/components/common/stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { cn } from "@/lib/utils";

export type DashboardData = Awaited<ReturnType<typeof getDashboardSnapshot>>;

function WidgetCard({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 p-5 pb-3">
        <div className="min-w-0">
          <CardTitle className="text-sm font-semibold">{title}</CardTitle>
          {description ? (
            <CardDescription className="mt-1 text-xs">{description}</CardDescription>
          ) : null}
        </div>
        {action}
      </CardHeader>
      <CardContent className="p-5 pt-0">{children}</CardContent>
    </Card>
  );
}

/** Primary create shortcuts; "New invoice" is the single primary action. */
export function QuickActions() {
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" asChild>
        <Link to="/purchases/bills/new">New bill</Link>
      </Button>
      <Button size="sm" variant="outline" asChild>
        <Link to="/purchases/expenses/new">New expense</Link>
      </Button>
      <Button size="sm" asChild>
        <Link to="/sales/invoices/new">New invoice</Link>
      </Button>
    </div>
  );
}

/** Link to the reconcile screen, labelled with the real count of lines still to reconcile. */
export function ReconcileAction({ data }: { data: DashboardData }) {
  const fmt = useFormat();
  const n = data.banks.reduce((s, b) => s + b.unreconciledCount, 0);
  return (
    <Button size="sm" variant="outline" asChild>
      <Link to="/banking/reconcile">
        <Landmark />
        {n > 0 ? `Reconcile ${fmt.number(n)} ${n === 1 ? "item" : "items"}` : "Reconcile"}
      </Link>
    </Button>
  );
}

function monthLabel(month: string, locale: string): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return month;
  return d.toLocaleDateString(locale, { month: "short", timeZone: "UTC" });
}

/** Four headline numbers. Trend appears only where a real prior figure exists. */
export function KpiRow({ data }: { data: DashboardData }) {
  const fmt = useFormat();
  const cash = totalCash(data.banks);
  const ar = owedSummary(data.receivables, data.currency);
  const ap = owedSummary(data.payables, data.currency);
  const pct = percentChange(data.profit.thisYearMinor, data.profit.lastYearMinor);
  const profitTrend: StatTrend | undefined =
    pct === null
      ? undefined
      : {
          label: formatPercentChange(pct),
          direction: trendDirection(pct),
          context: "vs last full year",
        };
  const mixed = (o: ReturnType<typeof owedSummary>) =>
    o.otherCurrencies.length > 0 ? ` · plus ${o.otherCurrencies.join(", ")} (see report)` : "";
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        label="Cash in bank"
        icon={Wallet}
        value={fmt.money(cash, data.currency)}
        tone={cash < 0 ? "negative" : "neutral"}
        hint={`${fmt.number(data.banks.length)} ${data.banks.length === 1 ? "account" : "accounts"}, ledger balance`}
        href="/banking"
      />
      <StatCard
        label="Owed to you"
        icon={Receipt}
        value={fmt.money(ar.total, data.currency)}
        hint={`${ar.overdue > 0 ? `${fmt.money(ar.overdue, data.currency)} overdue` : "None overdue"}${mixed(ar)}`}
        tone={ar.overdue > 0 ? "warning" : "neutral"}
        href="/sales/invoices"
      />
      <StatCard
        label="Bills to pay"
        icon={ShoppingCart}
        value={fmt.money(ap.total, data.currency)}
        hint={`${ap.overdue > 0 ? `${fmt.money(ap.overdue, data.currency)} overdue` : "None overdue"}${mixed(ap)}`}
        tone={ap.overdue > 0 ? "warning" : "neutral"}
        href="/purchases/bills"
      />
      <StatCard
        label="Net profit, year to date"
        icon={TrendingUp}
        value={fmt.money(data.profit.thisYearMinor, data.currency)}
        tone={data.profit.thisYearMinor < 0 ? "negative" : "positive"}
        {...(profitTrend ? { trend: profitTrend } : { hint: "No prior-year figure to compare" })}
        href="/reports/profit-and-loss"
      />
    </div>
  );
}

/** Getting-started checklist for a new company; every tick is read from real records. */
export function GettingStarted({ data }: { data: DashboardData }) {
  const items = buildChecklist({
    banks: data.banks.length,
    hasBankMovements:
      data.cash.some((m) => m.in_minor !== 0 || m.out_minor !== 0) ||
      data.banks.some((b) => b.unreconciledCount > 0),
    invoices: data.tasks.draftInvoices > 0 || data.receivables.length > 0,
    bills: data.tasks.draftBills > 0 || data.payables.length > 0 || data.approvals.bills.length > 0,
    hasLedgerActivity: data.hasLedgerActivity,
  });
  if (!shouldShowChecklist(items, data.hasLedgerActivity)) return null;
  const done = items.filter((i) => i.done).length;
  return (
    <Card className="border-primary/25 bg-info-soft/40">
      <CardHeader className="space-y-1 p-5 pb-3">
        <CardTitle className="text-sm font-semibold">Get started with LinkBooks</CardTitle>
        <CardDescription className="text-xs">
          {done} of {items.length} steps done. Steps tick off when the records exist.
        </CardDescription>
        <div
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={0}
          aria-valuemax={items.length}
          aria-valuenow={done}
        >
          <div className="h-full bg-primary" style={{ width: `${(done / items.length) * 100}%` }} />
        </div>
      </CardHeader>
      <CardContent className="p-5 pt-2">
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((i) => (
            <li key={i.id}>
              <Link
                to={i.to as never}
                className={cn(
                  "flex h-full items-start gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-accent",
                  i.done && "opacity-70",
                )}
              >
                {i.done ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-label="Done" />
                ) : (
                  <Circle
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    aria-label="Not done"
                  />
                )}
                <span className="min-w-0">
                  <span className={cn("block text-sm font-medium", i.done && "line-through")}>
                    {i.label}
                  </span>
                  <span className="block text-xs text-muted-foreground">{i.hint}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function BankAccountsWidget({ data }: { data: DashboardData }) {
  const fmt = useFormat();
  return (
    <WidgetCard
      title="Bank accounts"
      description="Ledger balance and lines still to reconcile"
      action={
        <Button size="sm" variant="ghost" asChild>
          <Link to="/banking">
            Banking <ArrowRight />
          </Link>
        </Button>
      }
    >
      {data.banks.length === 0 ? (
        <EmptyState
          compact
          title="No bank accounts"
          description="Add a bank account in Banking to see balances here."
          action={
            <Button size="sm" asChild>
              <Link to="/banking">Add bank account</Link>
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          {data.banks.map((b) => (
            <li key={b.id} className="rounded-lg border bg-background p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Landmark className="size-3.5" aria-hidden />
                <Link
                  to="/banking"
                  className="truncate font-medium text-foreground underline-offset-2 hover:underline"
                >
                  {b.name}
                </Link>
              </div>
              <div
                className={cn(
                  "numeric mt-1.5 text-lg font-semibold",
                  b.ledgerBalanceMinor < 0 && "text-money-out",
                )}
              >
                {fmt.money(b.ledgerBalanceMinor, data.currency)}
              </div>
              <div className="mt-1 text-xs">
                {b.unreconciledCount > 0 ? (
                  <Link
                    to="/banking/reconcile"
                    className="font-medium text-primary underline-offset-2 hover:underline"
                  >
                    Reconcile {fmt.number(b.unreconciledCount)}{" "}
                    {b.unreconciledCount === 1 ? "item" : "items"}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">Nothing to reconcile</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </WidgetCard>
  );
}

const BUCKETS = [
  ["current", "Current", "bg-success"],
  ["b_1_30", "1–30 days", "bg-warning"],
  ["b_31_60", "31–60 days", "bg-[oklch(0.68_0.16_50)]"],
  ["b_61_90", "61–90 days", "bg-destructive/60"],
  ["b_90_plus", "90+ days", "bg-destructive"],
] as const;

export function AgeingWidget({
  kind,
  data,
}: {
  kind: "receivables" | "payables";
  data: DashboardData;
}) {
  const fmt = useFormat();
  const rows = kind === "receivables" ? data.receivables : data.payables;
  const title = kind === "receivables" ? "Invoices owed to you" : "Bills to pay";
  const report = kind === "receivables" ? "aged-receivables" : "aged-payables";
  return (
    <WidgetCard
      title={title}
      description="Outstanding by how many days overdue"
      action={
        <Button size="sm" variant="ghost" asChild>
          <Link to="/reports/$reportId" params={{ reportId: report }}>
            Report <ArrowRight />
          </Link>
        </Button>
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          compact
          title={kind === "receivables" ? "No open invoices" : "No open bills"}
          description="Nothing outstanding right now."
        />
      ) : (
        <div className="space-y-6">
          {rows.map((r) => {
            const shares = bucketShares(BUCKETS.map(([key]) => r[key]));
            return (
              <div key={r.currency}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="numeric text-xl font-semibold">
                    {fmt.money(r.total, r.currency)}
                  </span>
                  {r.overdue > 0 ? (
                    <Badge variant="danger">{fmt.money(r.overdue, r.currency)} overdue</Badge>
                  ) : (
                    <Badge variant="success">None overdue</Badge>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {fmt.number(r.count)} {r.count === 1 ? "document" : "documents"} · {r.currency}
                </div>
                <div
                  className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-muted"
                  role="img"
                  aria-label={`Ageing of ${title.toLowerCase()}: ${BUCKETS.map(([key, label]) => `${label} ${fmt.amount(r[key], r.currency)}`).join(", ")}`}
                >
                  {BUCKETS.map(([key, label, bg], i) =>
                    shares[i]! > 0 ? (
                      <div
                        key={key}
                        title={`${label}: ${fmt.amount(r[key], r.currency)}`}
                        className={cn(bg, "h-full")}
                        style={{ width: `${shares[i]! * 100}%` }}
                      />
                    ) : null,
                  )}
                </div>
                <dl className="mt-3 grid grid-cols-5 gap-1 text-xs">
                  {BUCKETS.map(([key, label, bg]) => (
                    <div key={key} className="min-w-0">
                      <dt className="flex items-center gap-1 text-muted-foreground">
                        <span className={cn("size-2 shrink-0 rounded-full", bg)} aria-hidden />
                        <span className="truncate">{label.replace(" days", "")}</span>
                      </dt>
                      <dd className="numeric mt-0.5 truncate font-medium">
                        {fmt.amount(r[key], r.currency)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            );
          })}
        </div>
      )}
    </WidgetCard>
  );
}

const cashConfig = {
  in: { label: "Cash in", color: "var(--chart-2)" },
  out: { label: "Cash out", color: "var(--chart-4)" },
} satisfies ChartConfig;

export function CashFlowWidget({ data }: { data: DashboardData }) {
  const fmt = useFormat();
  const places = decimalPlacesFor(data.currency);
  const scale = 10 ** places;
  const rows = data.cash.map((m) => ({
    month: monthLabel(m.month, fmt.locale),
    in: m.in_minor / scale,
    out: m.out_minor / scale,
  }));
  const any = data.cash.some((m) => m.in_minor !== 0 || m.out_minor !== 0);
  const totals = cashTotals(data.cash);
  return (
    <WidgetCard
      className="lg:col-span-2"
      title="Cash in and out"
      description="Last 12 months, bank accounts (transfers between your own accounts excluded)"
      action={
        <Button size="sm" variant="ghost" asChild>
          <Link to="/reports/$reportId" params={{ reportId: "cash-flow" }}>
            Report <ArrowRight />
          </Link>
        </Button>
      }
    >
      {!any ? (
        <EmptyState
          compact
          title="No bank movements"
          description="Cash in and out appears once bank activity is posted."
        />
      ) : (
        <>
          <dl className="mb-4 grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Cash in</dt>
              <dd className="numeric font-semibold text-money-in">
                {fmt.money(totals.in, data.currency)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Cash out</dt>
              <dd className="numeric font-semibold text-money-out">
                {fmt.money(totals.out, data.currency)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Net movement</dt>
              <dd
                className={cn(
                  "numeric font-semibold",
                  totals.net < 0 ? "text-money-out" : "text-money-in",
                )}
              >
                {fmt.money(totals.net, data.currency)}
              </dd>
            </div>
          </dl>
          <ChartContainer config={cashConfig} className="h-64 w-full">
            <BarChart data={rows} margin={{ left: 4, right: 4 }} barGap={2}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={8} />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={64}
                tickFormatter={(v: number) => fmt.number(v)}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value, name) => (
                      <span className="numeric">
                        {String(name) === "in" ? "Cash in" : "Cash out"}:{" "}
                        {fmt.money(Math.round(Number(value) * scale), data.currency)}
                      </span>
                    )}
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar dataKey="in" fill="var(--color-in)" radius={[3, 3, 0, 0]} maxBarSize={22} />
              <Bar dataKey="out" fill="var(--color-out)" radius={[3, 3, 0, 0]} maxBarSize={22} />
            </BarChart>
          </ChartContainer>
        </>
      )}
    </WidgetCard>
  );
}

const profitConfig = {
  thisYear: { label: "This year to date", color: "var(--chart-1)" },
  lastYear: { label: "Last financial year", color: "var(--chart-5)" },
} satisfies ChartConfig;

export function ProfitWidget({ data }: { data: DashboardData }) {
  const fmt = useFormat();
  const scale = 10 ** decimalPlacesFor(data.currency);
  const { thisYearMinor, lastYearMinor, thisYearRevenueMinor, lastYearRevenueMinor } = data.profit;
  const delta = thisYearMinor - lastYearMinor;
  const rows = [
    {
      name: "Revenue",
      thisYear: thisYearRevenueMinor / scale,
      lastYear: lastYearRevenueMinor / scale,
    },
    { name: "Net profit", thisYear: thisYearMinor / scale, lastYear: lastYearMinor / scale },
  ];
  const any = [thisYearMinor, lastYearMinor, thisYearRevenueMinor, lastYearRevenueMinor].some(
    (v) => v !== 0,
  );
  return (
    <WidgetCard
      title="Profit and loss"
      description={`This financial year (from ${fmt.date(data.financialYear.start)}) vs last full year`}
      action={
        <Button size="sm" variant="ghost" asChild>
          <Link to="/reports/$reportId" params={{ reportId: "profit-and-loss" }}>
            Report <ArrowRight />
          </Link>
        </Button>
      }
    >
      {!any ? (
        <EmptyState
          compact
          title="No profit and loss yet"
          description="Income and expenses appear here once documents are posted."
        />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Net profit, this year</dt>
              <dd
                className={cn(
                  "numeric text-xl font-semibold",
                  thisYearMinor < 0 ? "text-money-out" : "text-foreground",
                )}
              >
                {fmt.money(thisYearMinor, data.currency)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Net profit, last year</dt>
              <dd className="numeric text-xl font-semibold">
                {fmt.money(lastYearMinor, data.currency)}
              </dd>
            </div>
          </dl>
          <ChartContainer config={profitConfig} className="mt-4 h-44 w-full">
            <BarChart data={rows} margin={{ left: 4, right: 4 }} barGap={4}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="name" tickLine={false} axisLine={false} tickMargin={8} />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={64}
                tickFormatter={(v: number) => fmt.number(v)}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value, name) => (
                      <span className="numeric">
                        {String(name) === "thisYear" ? "This year" : "Last year"}:{" "}
                        {fmt.money(Math.round(Number(value) * scale), data.currency)}
                      </span>
                    )}
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar
                dataKey="thisYear"
                fill="var(--color-thisYear)"
                radius={[3, 3, 0, 0]}
                maxBarSize={36}
              />
              <Bar
                dataKey="lastYear"
                fill="var(--color-lastYear)"
                radius={[3, 3, 0, 0]}
                maxBarSize={36}
              />
            </BarChart>
          </ChartContainer>
          <p className="mt-3 text-xs text-muted-foreground">
            Difference in net profit {fmt.money(delta, data.currency)}. Last year is the full year{" "}
            {fmt.date(data.financialYear.previousStart)} to{" "}
            {fmt.date(data.financialYear.previousEnd)}.
          </p>
        </>
      )}
    </WidgetCard>
  );
}

export function ApprovalsWidget({ data }: { data: DashboardData }) {
  const fmt = useFormat();
  const { expenseClaims, bills } = data.approvals;
  const empty = expenseClaims.length === 0 && bills.length === 0;
  return (
    <WidgetCard title="Awaiting approval" description="Submitted expense claims and bills">
      {empty ? (
        <EmptyState
          compact
          title="Nothing waiting"
          description="Approvals will appear here when someone submits."
        />
      ) : (
        <ul className="divide-y text-sm">
          {bills.map((b) => (
            <li key={`b-${b.currency}`} className="flex items-center justify-between py-2">
              <Link to="/purchases/bills" className="underline-offset-2 hover:underline">
                {fmt.number(b.count)} {b.count === 1 ? "bill" : "bills"}
              </Link>
              <span className="numeric font-medium">{fmt.money(b.total, b.currency)}</span>
            </li>
          ))}
          {expenseClaims.map((c) => (
            <li key={`c-${c.currency}`} className="flex items-center justify-between py-2">
              <Link
                to="/purchases/employee-expenses"
                className="underline-offset-2 hover:underline"
              >
                {fmt.number(c.count)} expense {c.count === 1 ? "claim" : "claims"}
              </Link>
              <span className="numeric font-medium">{fmt.money(c.total, c.currency)}</span>
            </li>
          ))}
        </ul>
      )}
    </WidgetCard>
  );
}

export function WatchlistWidget({ data }: { data: DashboardData }) {
  const fmt = useFormat();
  return (
    <WidgetCard
      title="Account watchlist"
      description="Accounts you chose to watch in the chart of accounts"
    >
      {data.watchlist.length === 0 ? (
        <EmptyState
          compact
          title="No watched accounts"
          description="Turn on “show on dashboard” for an account in Accounting → Chart of accounts."
        />
      ) : (
        <ul className="divide-y text-sm">
          {data.watchlist.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 py-2">
              <Link
                to="/reports/$reportId"
                params={{ reportId: "general-ledger" }}
                search={{ account: a.id }}
                className="min-w-0 truncate underline-offset-2 hover:underline"
              >
                <span className="text-muted-foreground">{a.code}</span> {a.name}
              </Link>
              <span className="numeric text-right font-medium">
                {fmt.money(a.balanceMinor, data.currency)}
                <span className="block text-[10px] font-normal text-muted-foreground">
                  {a.basis === "financial_year" ? "financial year to date" : "balance today"}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </WidgetCard>
  );
}

export function TasksWidget({ data }: { data: DashboardData }) {
  const fmt = useFormat();
  const t = data.tasks;
  const items: Array<{ key: string; label: string; count: number; to: ReactNode }> = [
    {
      key: "bank",
      label: "Bank lines to categorise",
      count: t.uncategorisedBankLines,
      to: <Link to="/banking/transactions">Review</Link>,
    },
    {
      key: "inv",
      label: "Draft invoices",
      count: t.draftInvoices,
      to: <Link to="/sales/invoices">Open</Link>,
    },
    {
      key: "bill",
      label: "Draft bills",
      count: t.draftBills,
      to: <Link to="/purchases/bills">Open</Link>,
    },
  ];
  return (
    <WidgetCard title="To do" description="Counted from your records">
      <ul className="divide-y text-sm">
        {items.map((i) => (
          <li key={i.key} className="flex items-center justify-between py-2">
            <span>
              {i.label}: <strong className="numeric">{fmt.number(i.count)}</strong>
            </span>
            {i.count > 0 ? (
              <Button size="sm" variant="ghost" asChild>
                {i.to}
              </Button>
            ) : null}
          </li>
        ))}
        <li className="flex items-center justify-between py-2">
          <span>
            Period:{" "}
            {t.currentPeriod ? (
              <strong>
                {t.currentPeriod.name} is {t.currentPeriod.status}
              </strong>
            ) : (
              <strong>no period record for today</strong>
            )}
            {t.lockedThrough ? (
              <span className="block text-xs text-muted-foreground">
                Locked through {fmt.date(t.lockedThrough)}
              </span>
            ) : (
              <span className="block text-xs text-muted-foreground">No period is locked yet</span>
            )}
          </span>
          <Button size="sm" variant="ghost" asChild>
            <Link to="/accounting" search={{ tab: "close" }}>
              Period close
            </Link>
          </Button>
        </li>
      </ul>
    </WidgetCard>
  );
}
