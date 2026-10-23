import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useFormat } from "@/hooks/use-format";
import { csvMoney } from "@/lib/reports/csv";
import {
  getBalanceSheet,
  getCashFlow,
  getEquityChanges,
  getProfitAndLoss,
  getTrialBalance,
} from "@/lib/reports/report.functions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AccountLink, ReportPane, ReportShell, Stat, type ReportCtx } from "./ReportShell";

type StatementRow = {
  kind: "heading" | "account" | "subtotal" | "total";
  label: string;
  code?: string;
  accountId?: string;
  amounts: number[];
};

function StatementTable({
  rows,
  columns,
  ctx,
  drillFrom,
}: {
  rows: StatementRow[];
  columns: Array<{ label: string; from?: string; to?: string }>;
  ctx: ReportCtx;
  /** Period start used for drill-down links (balance sheet drills from the financial year start). */
  drillFrom: string;
}) {
  const fmt = useFormat();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Account</TableHead>
          {columns.map((c) => (
            <TableHead key={c.label} className="text-right" aria-sort="none">
              {c.label}
              {c.from && c.to ? (
                <span className="block text-xs font-normal text-muted-foreground">
                  {fmt.date(c.from)} – {fmt.date(c.to)}
                </span>
              ) : c.to ? (
                <span className="block text-xs font-normal text-muted-foreground">
                  {fmt.date(c.to)}
                </span>
              ) : null}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, i) => {
          if (r.kind === "heading") {
            return (
              <TableRow key={`${r.label}-${i}`} className="bg-muted/40">
                <TableCell
                  colSpan={columns.length + 1}
                  className="text-xs font-semibold uppercase tracking-wide"
                >
                  {r.label}
                </TableCell>
              </TableRow>
            );
          }
          const bold = r.kind !== "account";
          return (
            <TableRow
              key={`${r.accountId ?? r.label}-${i}`}
              className={r.kind === "total" ? "border-t-2" : undefined}
            >
              <TableCell className={`${bold ? "font-semibold" : "pl-6"}`}>
                {r.accountId ? (
                  <AccountLink accountId={r.accountId} from={drillFrom} to={ctx.to}>
                    {r.code ? <span className="mr-2 text-muted-foreground">{r.code}</span> : null}
                    {r.label}
                  </AccountLink>
                ) : (
                  r.label
                )}
              </TableCell>
              {r.amounts.map((a, j) => (
                <TableCell
                  key={j}
                  className={`text-right tabular-nums ${bold ? "font-semibold" : ""}`}
                >
                  {fmt.amount(a, ctx.currency)}
                </TableCell>
              ))}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function statementCsv(rows: StatementRow[], columns: Array<{ label: string }>, currency: string) {
  return {
    headers: ["Code", "Account", ...columns.map((c) => c.label)],
    rows: rows
      .filter((r) => r.kind !== "heading" || true)
      .map((r) => [
        r.code ?? "",
        r.kind === "heading" ? r.label.toUpperCase() : r.label,
        ...(r.kind === "heading"
          ? columns.map(() => "")
          : r.amounts.map((a) => csvMoney(a, currency))),
      ]),
  };
}

export function TrialBalanceView({ ctx }: { ctx: ReportCtx }) {
  const fmt = useFormat();
  const fetchTb = useServerFn(getTrialBalance);
  const q = useQuery({
    queryKey: ["report-tb", ctx.companyId, ctx.to],
    queryFn: () => fetchTb({ data: { companyId: ctx.companyId, to: ctx.to } }),
  });
  const d = q.data;
  return (
    <ReportShell
      title="Trial Balance"
      ctx={ctx}
      mode="asof"
      basis={d?.basis}
      getCsv={() =>
        d
          ? {
              headers: ["Code", "Account", "Debit", "Credit"],
              rows: [
                ...d.rows.map((r) => [
                  r.code,
                  r.name,
                  csvMoney(r.debit_minor, ctx.currency),
                  csvMoney(r.credit_minor, ctx.currency),
                ]),
                [
                  "",
                  "Total",
                  csvMoney(d.totalDebit, ctx.currency),
                  csvMoney(d.totalCredit, ctx.currency),
                ],
              ],
              basis: d.basis,
            }
          : null
      }
    >
      <ReportPane
        query={q}
        isEmpty={Boolean(d) && d!.rows.length === 0}
        emptyTitle="No posted activity"
        emptyDescription="Authorise documents or post journals to populate the trial balance."
      >
        {d ? (
          <>
            <p className="mb-2 text-sm">
              Totals {fmt.amount(d.totalDebit, ctx.currency)} /{" "}
              {fmt.amount(d.totalCredit, ctx.currency)}{" "}
              <Badge variant={d.balances ? "secondary" : "destructive"}>
                {d.balances ? "Balances" : "Out of balance"}
              </Badge>
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.rows.map((r) => (
                  <TableRow key={r.account_id}>
                    <TableCell>{r.code}</TableCell>
                    <TableCell>
                      <AccountLink
                        accountId={r.account_id}
                        from={d.fyStart ?? ctx.from}
                        to={ctx.to}
                      >
                        {r.name}
                      </AccountLink>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmt.amount(r.debit_minor, ctx.currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmt.amount(r.credit_minor, ctx.currency)}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="border-t-2 font-semibold">
                  <TableCell colSpan={2}>Total</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmt.amount(d.totalDebit, ctx.currency)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmt.amount(d.totalCredit, ctx.currency)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </>
        ) : null}
      </ReportPane>
    </ReportShell>
  );
}

export function ProfitLossView({ ctx }: { ctx: ReportCtx }) {
  const fmt = useFormat();
  const fetchPl = useServerFn(getProfitAndLoss);
  const columnsMode = ctx.search.columns ?? "none";
  const q = useQuery({
    queryKey: ["report-pl", ctx.companyId, ctx.from, ctx.to, columnsMode],
    queryFn: () =>
      fetchPl({
        data: { companyId: ctx.companyId, from: ctx.from, to: ctx.to, columns: columnsMode },
      }),
  });
  const d = q.data;
  const rows = (d?.statement ?? []) as StatementRow[];
  const cols = d?.columns ?? [];
  return (
    <ReportShell
      title="Profit and Loss"
      ctx={ctx}
      mode="range"
      showColumns="pl"
      basis={d?.basis}
      getCsv={() => (d ? { ...statementCsv(rows, cols, ctx.currency), basis: d.basis } : null)}
    >
      <ReportPane
        query={q}
        isEmpty={
          Boolean(d) && rows.every((r) => r.kind === "heading" || r.amounts.every((a) => a === 0))
        }
        emptyTitle="No income or expense in range"
        emptyDescription="Post revenue or expense journals in this period."
      >
        {d ? (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-4 print:hidden">
              <Stat label="Revenue" value={fmt.money(d.revenue, ctx.currency)} />
              <Stat label="Gross profit" value={fmt.money(d.grossProfit, ctx.currency)} />
              <Stat
                label="Operating expenses"
                value={fmt.money(d.operatingExpense, ctx.currency)}
              />
              <Stat label="Net profit" value={fmt.money(d.net, ctx.currency)} />
            </div>
            <StatementTable rows={rows} columns={cols} ctx={ctx} drillFrom={ctx.from} />
          </>
        ) : null}
      </ReportPane>
    </ReportShell>
  );
}

export function BalanceSheetView({ ctx }: { ctx: ReportCtx }) {
  const fmt = useFormat();
  const fetchBs = useServerFn(getBalanceSheet);
  const compare = ctx.search.compare ?? "none";
  const q = useQuery({
    queryKey: ["report-bs", ctx.companyId, ctx.to, compare],
    queryFn: () => fetchBs({ data: { companyId: ctx.companyId, asOf: ctx.to, compare } }),
  });
  const d = q.data;
  const rows = (d?.statement ?? []) as StatementRow[];
  const cols = (d?.columns ?? []).map((c) => ({ label: fmt.date(c.label), to: c.asOf }));
  return (
    <ReportShell
      title="Balance Sheet"
      ctx={ctx}
      mode="asof"
      showColumns="bs"
      basis={d?.basis}
      getCsv={() => (d ? { ...statementCsv(rows, cols, ctx.currency), basis: d.basis } : null)}
    >
      <ReportPane
        query={q}
        isEmpty={
          Boolean(d) && rows.every((r) => r.kind === "heading" || r.amounts.every((a) => a === 0))
        }
        emptyTitle="No balance sheet balances"
        emptyDescription="Post assets, liabilities or equity."
      >
        {d ? (
          <>
            {!d.equationHolds ? (
              <Alert variant="destructive" className="mb-3">
                <AlertDescription>
                  Accounting equation does not hold (assets ≠ liabilities + equity). Investigate
                  journals.
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="mb-4 grid gap-3 sm:grid-cols-4 print:hidden">
              <Stat label="Assets" value={fmt.money(d.assets, ctx.currency)} />
              <Stat label="Liabilities" value={fmt.money(d.liabilities, ctx.currency)} />
              <Stat label="Equity" value={fmt.money(d.equity, ctx.currency)} />
              <Stat
                label="Current year earnings"
                value={fmt.money(d.currentYearEarningsMinor, ctx.currency)}
              />
            </div>
            <StatementTable
              rows={rows}
              columns={cols}
              ctx={ctx}
              drillFrom={d.fyStart ?? ctx.from}
            />
          </>
        ) : null}
      </ReportPane>
    </ReportShell>
  );
}

export function CashFlowView({ ctx }: { ctx: ReportCtx }) {
  const fmt = useFormat();
  const fetchCf = useServerFn(getCashFlow);
  const q = useQuery({
    queryKey: ["report-cf", ctx.companyId, ctx.from, ctx.to],
    queryFn: () => fetchCf({ data: { companyId: ctx.companyId, from: ctx.from, to: ctx.to } }),
  });
  const d = q.data;
  return (
    <ReportShell
      title="Cash Flow"
      ctx={ctx}
      mode="range"
      basis="Bank ledger movements classified by the counterpart account"
      getCsv={() =>
        d
          ? {
              headers: ["Section", "Line", "Amount"],
              rows: [
                ["", "Opening cash", csvMoney(d.opening_cash, ctx.currency)],
                ...d.detail.map((x) => [
                  x.section,
                  x.label,
                  csvMoney(x.amount_minor, ctx.currency),
                ]),
                ...d.rows.map((x) => ["Total", x.category, csvMoney(x.amount_minor, ctx.currency)]),
                ["", "Closing cash (bank ledger)", csvMoney(d.closing_cash_ledger, ctx.currency)],
              ],
            }
          : null
      }
    >
      <ReportPane
        query={q}
        isEmpty={Boolean(d) && d!.bankAccountCount === 0}
        emptyTitle="No bank accounts"
        emptyDescription="Add a bank account to see cash movements."
      >
        {d ? (
          <>
            <Alert className="mb-3">
              <AlertDescription>{d.limitation}</AlertDescription>
            </Alert>
            <div className="mb-4 grid gap-3 sm:grid-cols-4 print:hidden">
              <Stat label="Opening cash" value={fmt.money(d.opening_cash, ctx.currency)} />
              <Stat label="Net change" value={fmt.money(d.net_change, ctx.currency)} />
              <Stat label="Closing (movements)" value={fmt.money(d.closing_cash, ctx.currency)} />
              <Stat
                label="Closing (bank ledger)"
                value={fmt.money(d.closing_cash_ledger, ctx.currency)}
              />
            </div>
            <p className="mb-3 text-sm">
              <Badge variant={d.reconciles ? "secondary" : "destructive"}>
                {d.reconciles
                  ? "Opening + movements = bank ledger"
                  : "Movements do not equal the bank ledger, investigate"}
              </Badge>
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Line</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(["operating", "investing", "financing"] as const).map((section) => {
                  const lines = d.detail.filter((x) => x.section === section);
                  const total = d.rows.find((r) => r.category.toLowerCase().startsWith(section));
                  return (
                    <SectionRows
                      key={section}
                      title={section[0]!.toUpperCase() + section.slice(1)}
                      lines={lines.map((l) => ({ label: l.label, amount: l.amount_minor }))}
                      total={total?.amount_minor ?? lines.reduce((n, l) => n + l.amount_minor, 0)}
                      currency={ctx.currency}
                    />
                  );
                })}
                <TableRow className="border-t-2 font-semibold">
                  <TableCell>Net change in cash</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmt.amount(d.net_change, ctx.currency)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </>
        ) : null}
      </ReportPane>
    </ReportShell>
  );
}

function SectionRows({
  title,
  lines,
  total,
  currency,
}: {
  title: string;
  lines: Array<{ label: string; amount: number }>;
  total: number;
  currency: string;
}) {
  const fmt = useFormat();
  return (
    <>
      <TableRow className="bg-muted/40">
        <TableCell colSpan={2} className="text-xs font-semibold uppercase tracking-wide">
          {title} activities
        </TableCell>
      </TableRow>
      {lines.map((l) => (
        <TableRow key={l.label}>
          <TableCell className="pl-6">{l.label}</TableCell>
          <TableCell className="text-right tabular-nums">
            {fmt.amount(l.amount, currency)}
          </TableCell>
        </TableRow>
      ))}
      <TableRow>
        <TableCell className="font-semibold">Net cash from {title.toLowerCase()}</TableCell>
        <TableCell className="text-right font-semibold tabular-nums">
          {fmt.amount(total, currency)}
        </TableCell>
      </TableRow>
    </>
  );
}

export function EquityView({ ctx }: { ctx: ReportCtx }) {
  const fmt = useFormat();
  const fetchEq = useServerFn(getEquityChanges);
  const q = useQuery({
    queryKey: ["report-equity", ctx.companyId, ctx.from, ctx.to],
    queryFn: () => fetchEq({ data: { companyId: ctx.companyId, from: ctx.from, to: ctx.to } }),
  });
  const d = q.data;
  return (
    <ReportShell
      title="Statement of Changes in Equity"
      ctx={ctx}
      mode="range"
      basis={d?.basis}
      getCsv={() =>
        d
          ? {
              headers: ["Account", "Opening", "Movement", "Closing"],
              rows: [
                ...d.movements.map((m) => [
                  `${m.code} ${m.name}`,
                  csvMoney(m.opening, ctx.currency),
                  csvMoney(m.movement, ctx.currency),
                  csvMoney(m.closing, ctx.currency),
                ]),
                ["Net profit for the period", "", csvMoney(d.netProfit, ctx.currency), ""],
                [
                  "Total equity",
                  csvMoney(d.openingEquity, ctx.currency),
                  "",
                  csvMoney(d.closingEquity, ctx.currency),
                ],
              ],
            }
          : null
      }
    >
      <ReportPane query={q} emptyTitle="No equity activity" emptyDescription="Nothing to show.">
        {d ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Opening</TableHead>
                <TableHead className="text-right">Movement</TableHead>
                <TableHead className="text-right">Closing</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.movements.map((m) => (
                <TableRow key={m.code}>
                  <TableCell>
                    {m.code} {m.name}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmt.amount(m.opening, ctx.currency)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmt.amount(m.movement, ctx.currency)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmt.amount(m.closing, ctx.currency)}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell>Net profit for the period</TableCell>
                <TableCell />
                <TableCell className="text-right tabular-nums">
                  {fmt.amount(d.netProfit, ctx.currency)}
                </TableCell>
                <TableCell />
              </TableRow>
              {d.otherMovement !== 0 ? (
                <TableRow>
                  <TableCell>Other (prior-year earnings roll)</TableCell>
                  <TableCell />
                  <TableCell className="text-right tabular-nums">
                    {fmt.amount(d.otherMovement, ctx.currency)}
                  </TableCell>
                  <TableCell />
                </TableRow>
              ) : null}
              <TableRow className="border-t-2 font-semibold">
                <TableCell>Total equity</TableCell>
                <TableCell className="text-right tabular-nums">
                  {fmt.amount(d.openingEquity, ctx.currency)}
                </TableCell>
                <TableCell />
                <TableCell className="text-right tabular-nums">
                  {fmt.amount(d.closingEquity, ctx.currency)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        ) : null}
      </ReportPane>
    </ReportShell>
  );
}
