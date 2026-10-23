import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { useFormat } from "@/hooks/use-format";
import { decimalPlacesFor } from "@/lib/accounting/money";
import type { getDashboardSnapshot } from "@/lib/dashboard/dashboard.functions";
import { EmptyState } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

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
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function QuickActions() {
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" asChild>
        <Link to="/sales/invoices/new">New invoice</Link>
      </Button>
      <Button size="sm" variant="secondary" asChild>
        <Link to="/purchases/bills/new">New bill</Link>
      </Button>
      <Button size="sm" variant="secondary" asChild>
        <Link to="/purchases/expenses/new">New expense</Link>
      </Button>
    </div>
  );
}

export function BankAccountsWidget({ data }: { data: DashboardData }) {
  const fmt = useFormat();
  return (
    <WidgetCard
      title="Bank accounts"
      description="Ledger balance and lines still to reconcile"
      action={
        <Button size="sm" variant="outline" asChild>
          <Link to="/banking">Banking</Link>
        </Button>
      }
    >
      {data.banks.length === 0 ? (
        <EmptyState
          title="No bank accounts"
          description="Add a bank account in Banking to see balances here."
        />
      ) : (
        <ul className="divide-y text-sm">
          {data.banks.map((b) => (
            <li key={b.id} className="flex items-center justify-between gap-3 py-2">
              <div>
                <Link to="/banking" className="font-medium underline-offset-2 hover:underline">
                  {b.name}
                </Link>
                <div className="text-xs text-muted-foreground">
                  {b.unreconciledCount > 0 ? (
                    <Link to="/banking/reconcile" className="underline-offset-2 hover:underline">
                      {fmt.number(b.unreconciledCount)} to reconcile
                    </Link>
                  ) : (
                    "Nothing to reconcile"
                  )}
                </div>
              </div>
              <span className="tabular-nums font-semibold">
                {fmt.money(b.ledgerBalanceMinor, data.currency)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </WidgetCard>
  );
}

const BUCKETS = [
  ["current", "Current"],
  ["b_1_30", "1–30"],
  ["b_31_60", "31–60"],
  ["b_61_90", "61–90"],
  ["b_90_plus", "90+"],
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
      description="Outstanding by days overdue, per currency"
      action={
        <Button size="sm" variant="outline" asChild>
          <Link to="/reports/$reportId" params={{ reportId: report }}>
            Report
          </Link>
        </Button>
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          title={kind === "receivables" ? "No open invoices" : "No open bills"}
          description="Nothing outstanding right now."
        />
      ) : (
        <div className="space-y-4">
          {rows.map((r) => (
            <div key={r.currency}>
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="font-semibold tabular-nums">{fmt.money(r.total, r.currency)}</span>
                <span className="text-xs text-muted-foreground">
                  {fmt.number(r.count)} {r.count === 1 ? "document" : "documents"}
                </span>
                {r.overdue > 0 ? (
                  <Badge variant="destructive">{fmt.money(r.overdue, r.currency)} overdue</Badge>
                ) : (
                  <Badge variant="secondary">None overdue</Badge>
                )}
              </div>
              <dl className="grid grid-cols-5 gap-1 text-center text-xs">
                {BUCKETS.map(([key, label]) => (
                  <div key={key} className="rounded border p-1">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="tabular-nums">{fmt.amount(r[key], r.currency)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}
    </WidgetCard>
  );
}

const cashConfig = {
  in: { label: "Cash in", color: "var(--color-chart-2, hsl(142 60% 40%))" },
  out: { label: "Cash out", color: "var(--color-chart-5, hsl(0 70% 50%))" },
} satisfies ChartConfig;

export function CashFlowWidget({ data }: { data: DashboardData }) {
  const fmt = useFormat();
  const places = decimalPlacesFor(data.currency);
  const scale = 10 ** places;
  const rows = data.cash.map((m) => ({
    month: m.month,
    in: m.in_minor / scale,
    out: m.out_minor / scale,
  }));
  const any = data.cash.some((m) => m.in_minor !== 0 || m.out_minor !== 0);
  return (
    <WidgetCard
      className="lg:col-span-2"
      title="Cash in and out"
      description="Last 12 months, bank accounts (transfers between your own accounts excluded)"
      action={
        <Button size="sm" variant="outline" asChild>
          <Link to="/reports/$reportId" params={{ reportId: "cash-flow" }}>
            Report
          </Link>
        </Button>
      }
    >
      {!any ? (
        <EmptyState
          title="No bank movements"
          description="Cash in and out appears once bank activity is posted."
        />
      ) : (
        <ChartContainer config={cashConfig} className="h-64 w-full">
          <BarChart data={rows} margin={{ left: 4, right: 4 }}>
            <CartesianGrid vertical={false} />
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
                    <span className="tabular-nums">
                      {String(name) === "in" ? "Cash in" : "Cash out"}:{" "}
                      {fmt.money(Math.round(Number(value) * scale), data.currency)}
                    </span>
                  )}
                />
              }
            />
            <Bar dataKey="in" fill="var(--color-in)" radius={2} />
            <Bar dataKey="out" fill="var(--color-out)" radius={2} />
          </BarChart>
        </ChartContainer>
      )}
    </WidgetCard>
  );
}

export function ProfitWidget({ data }: { data: DashboardData }) {
  const fmt = useFormat();
  const { thisYearMinor, lastYearMinor } = data.profit;
  const delta = thisYearMinor - lastYearMinor;
  return (
    <WidgetCard
      title="Net profit"
      description={`This financial year (from ${fmt.date(data.financialYear.start)}) vs last`}
      action={
        <Button size="sm" variant="outline" asChild>
          <Link to="/reports/$reportId" params={{ reportId: "profit-and-loss" }}>
            Report
          </Link>
        </Button>
      }
    >
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">This year to date</dt>
          <dd className="text-xl font-semibold tabular-nums">
            {fmt.money(thisYearMinor, data.currency)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Last financial year</dt>
          <dd className="text-xl font-semibold tabular-nums">
            {fmt.money(lastYearMinor, data.currency)}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">
        Difference {fmt.money(delta, data.currency)}. Last year is the full year{" "}
        {fmt.date(data.financialYear.previousStart)} to {fmt.date(data.financialYear.previousEnd)}.
      </p>
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
          title="Nothing waiting"
          description="Approvals will appear here when someone submits."
        />
      ) : (
        <ul className="space-y-2 text-sm">
          {bills.map((b) => (
            <li key={`b-${b.currency}`} className="flex justify-between">
              <Link to="/purchases/bills" className="underline-offset-2 hover:underline">
                {fmt.number(b.count)} {b.count === 1 ? "bill" : "bills"}
              </Link>
              <span className="tabular-nums">{fmt.money(b.total, b.currency)}</span>
            </li>
          ))}
          {expenseClaims.map((c) => (
            <li key={`c-${c.currency}`} className="flex justify-between">
              <Link
                to="/purchases/employee-expenses"
                className="underline-offset-2 hover:underline"
              >
                {fmt.number(c.count)} expense {c.count === 1 ? "claim" : "claims"}
              </Link>
              <span className="tabular-nums">{fmt.money(c.total, c.currency)}</span>
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
                className="underline-offset-2 hover:underline"
              >
                <span className="text-muted-foreground">{a.code}</span> {a.name}
              </Link>
              <span className="text-right tabular-nums">
                {fmt.money(a.balanceMinor, data.currency)}
                <span className="block text-[10px] text-muted-foreground">
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
      <ul className="space-y-2 text-sm">
        {items.map((i) => (
          <li key={i.key} className="flex items-center justify-between">
            <span>
              {i.label}: <strong className="tabular-nums">{fmt.number(i.count)}</strong>
            </span>
            {i.count > 0 ? (
              <Button size="sm" variant="ghost" asChild>
                {i.to}
              </Button>
            ) : null}
          </li>
        ))}
        <li className="flex items-center justify-between border-t pt-2">
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
