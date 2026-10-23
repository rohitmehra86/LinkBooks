import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Printer } from "lucide-react";
import { useFormat } from "@/hooks/use-format";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { csvFilename, downloadCsv, toCsv, type CsvCell } from "@/lib/reports/csv";
import { sourceLabel, sourceTarget } from "@/lib/reports/links";
import type { ReportSearch } from "@/lib/reports/search";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type ReportCtx = {
  companyId: string;
  companyName: string;
  currency: string;
  from: string;
  to: string;
  search: ReportSearch;
  setSearch: (patch: Partial<Record<keyof ReportSearch, unknown>>) => void;
};

export type CsvExport = { headers: string[]; rows: CsvCell[][]; basis?: string };

export function ReportShell({
  title,
  ctx,
  mode,
  showColumns,
  extraControls,
  getCsv,
  basis,
  children,
}: {
  title: string;
  ctx: ReportCtx;
  /** `range` shows From + To; `asof` shows a single "As at" date. */
  mode: "range" | "asof";
  showColumns?: "pl" | "bs";
  extraControls?: ReactNode;
  getCsv?: () => CsvExport | null;
  basis?: string | undefined;
  children: ReactNode;
}) {
  const fmt = useFormat();
  const period =
    mode === "asof" ? `As at ${fmt.date(ctx.to)}` : `${fmt.date(ctx.from)} to ${fmt.date(ctx.to)}`;

  const onExport = () => {
    const csv = getCsv?.();
    if (!csv) return;
    const text = toCsv(
      {
        company: ctx.companyName,
        report: title,
        period: mode === "asof" ? `As at ${ctx.to}` : `${ctx.from} to ${ctx.to}`,
        currency: ctx.currency,
        basis: csv.basis ?? basis ?? "",
      },
      csv.headers,
      csv.rows,
    );
    downloadCsv(csvFilename(title, mode === "asof" ? ctx.to : `${ctx.from}-to-${ctx.to}`), text);
  };

  return (
    <div className="report-shell space-y-4">
      {/* Shared report header: identical on screen, print and PDF */}
      <header className="text-center print:mb-4">
        <p className="text-sm text-muted-foreground">{ctx.companyName}</p>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">
          {period} · {ctx.currency}
        </p>
        {basis ? <p className="text-xs text-muted-foreground">{basis}</p> : null}
        <p className="hidden text-xs text-muted-foreground print:block">
          Generated {fmt.dateTime(new Date().toISOString())}
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3 print:hidden">
        {mode === "range" ? (
          <div className="space-y-1">
            <Label htmlFor="report-from">From</Label>
            <Input
              id="report-from"
              type="date"
              value={ctx.from}
              onChange={(e) => e.target.value && ctx.setSearch({ from: e.target.value })}
            />
          </div>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor="report-to">{mode === "asof" ? "As at" : "To"}</Label>
          <Input
            id="report-to"
            type="date"
            value={ctx.to}
            onChange={(e) => e.target.value && ctx.setSearch({ to: e.target.value })}
          />
        </div>
        {showColumns === "pl" ? (
          <div className="space-y-1">
            <Label htmlFor="report-columns">Columns</Label>
            <select
              id="report-columns"
              className="flex h-10 rounded-md border border-input bg-background px-3 text-sm"
              value={ctx.search.columns ?? "none"}
              onChange={(e) =>
                ctx.setSearch({ columns: e.target.value === "none" ? undefined : e.target.value })
              }
            >
              <option value="none">Selected period only</option>
              <option value="prior_period">Compare with prior period</option>
              <option value="prior_year">Compare with prior year</option>
              <option value="month">By month</option>
              <option value="quarter">By quarter</option>
            </select>
          </div>
        ) : null}
        {showColumns === "bs" ? (
          <div className="space-y-1">
            <Label htmlFor="report-compare">Compare</Label>
            <select
              id="report-compare"
              className="flex h-10 rounded-md border border-input bg-background px-3 text-sm"
              value={ctx.search.compare ?? "none"}
              onChange={(e) =>
                ctx.setSearch({ compare: e.target.value === "none" ? undefined : e.target.value })
              }
            >
              <option value="none">No comparison</option>
              <option value="prior_month">Prior month end</option>
              <option value="prior_year">Same date last year</option>
              <option value="months">Last 6 month ends</option>
            </select>
          </div>
        ) : null}
        {extraControls}
        <div className="ml-auto flex gap-2">
          {getCsv ? (
            <Button size="sm" variant="outline" onClick={onExport}>
              Export CSV
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => window.print()}>
            <Printer className="mr-1 size-4" /> Print / PDF
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <Link to="/reports">All reports</Link>
          </Button>
        </div>
      </div>

      {children}
    </div>
  );
}

export function ReportPane({
  query,
  isEmpty,
  emptyTitle,
  emptyDescription,
  children,
}: {
  query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  isEmpty?: boolean;
  emptyTitle: string;
  emptyDescription: string;
  children: ReactNode;
}) {
  if (query.isPending) return <LoadingState />;
  if (query.isError) {
    return (
      <ErrorState
        title="Could not load report"
        description={friendlyAuthError(query.error)}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (isEmpty) return <EmptyState title={emptyTitle} description={emptyDescription} />;
  return <>{children}</>;
}

export function Stat({ label, value, tone }: { label: string; value: string; tone?: "bad" }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent
        className={`text-lg font-semibold tabular-nums ${tone === "bad" ? "text-destructive" : ""}`}
      >
        {value}
      </CardContent>
    </Card>
  );
}

/** Link from a ledger line to the journal behind it. */
export function JournalLink({ journalId, number }: { journalId: string; number: number | string }) {
  if (!journalId) return <span className="font-mono text-xs">#{number}</span>;
  return (
    <Link
      to="/accounting"
      search={{ tab: "journals", journal: journalId }}
      className="font-mono text-xs underline-offset-2 hover:underline"
    >
      #{number}
    </Link>
  );
}

/** Link to the source document of a journal (invoice, bill, ...) when the app has a page for it. */
export function SourceLink({
  type,
  id,
}: {
  type: string | null | undefined;
  id: string | null | undefined;
}) {
  const target = sourceTarget(type, id);
  const label = sourceLabel(type);
  if (!target) return <span className="text-xs text-muted-foreground">{label}</span>;
  const cls = "text-xs underline-offset-2 hover:underline";
  switch (target.kind) {
    case "sales_invoice":
      return (
        <Link to="/sales/invoices/$invoiceId" params={{ invoiceId: target.id }} className={cls}>
          {label}
        </Link>
      );
    case "sales_credit_note":
      return (
        <Link
          to="/sales/credit-notes/$creditNoteId"
          params={{ creditNoteId: target.id }}
          className={cls}
        >
          {label}
        </Link>
      );
    case "purchase_bill":
      return (
        <Link to="/purchases/bills/$billId" params={{ billId: target.id }} className={cls}>
          {label}
        </Link>
      );
    case "purchase_credit_note":
      return (
        <Link
          to="/purchases/credit-notes/$creditNoteId"
          params={{ creditNoteId: target.id }}
          className={cls}
        >
          {label}
        </Link>
      );
    case "expense":
      return (
        <Link to="/purchases/expenses/$expenseId" params={{ expenseId: target.id }} className={cls}>
          {label}
        </Link>
      );
    case "supplier_payment":
      return (
        <Link to="/purchases/payments/$paymentId" params={{ paymentId: target.id }} className={cls}>
          {label}
        </Link>
      );
  }
}

/** Drill-down link to the account transactions report, carrying the period (RP-05). */
export function AccountLink({
  accountId,
  from,
  to,
  children,
}: {
  accountId: string;
  from: string;
  to: string;
  children: ReactNode;
}) {
  if (accountId.startsWith("__")) return <>{children}</>;
  return (
    <Link
      to="/reports/$reportId"
      params={{ reportId: "general-ledger" }}
      search={{ account: accountId, from, to }}
      className="underline-offset-2 hover:underline"
    >
      {children}
    </Link>
  );
}

export function PagerBar({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="mt-3 flex items-center justify-between text-sm print:hidden">
      <span className="text-muted-foreground">
        {total === 0
          ? "0 rows"
          : `${page * pageSize + 1}–${Math.min(total, (page + 1) * pageSize)} of ${total}`}
      </span>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={page <= 0} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={page + 1 >= pages}
          onClick={() => onPage(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
