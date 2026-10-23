import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { useFormat } from "@/hooks/use-format";
import { csvMoney } from "@/lib/reports/csv";
import { listBudgets, getBudgetVsActual } from "@/lib/budgets/budgets.functions";
import {
  getDepreciationSchedule,
  getFixedAssetRegister,
} from "@/lib/fixed-assets/fixed-assets.functions";
import { DEPRECIATION_METHODS } from "@/lib/fixed-assets/depreciation";
import type { VarianceCell, VarianceRow, VarianceSection } from "@/lib/budgets/budget-report";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AccountLink, ReportPane, ReportShell, Stat, type ReportCtx } from "./ReportShell";

const selectCls = "flex h-10 rounded-md border border-input bg-background px-3 text-sm";

function toneClass(status: VarianceCell["status"]): string {
  if (status === "favourable") return "text-emerald-600";
  if (status === "unfavourable") return "text-destructive";
  return "";
}

/* ------------------------------------------------------------------ */
/* Budget vs Actual                                                    */
/* ------------------------------------------------------------------ */

export function BudgetVsActualView({ ctx }: { ctx: ReportCtx }) {
  const fmt = useFormat();
  const listFn = useServerFn(listBudgets);
  const reportFn = useServerFn(getBudgetVsActual);
  const view = ctx.search.view ?? "month";

  const budgets = useQuery({
    queryKey: ["budgets", ctx.companyId],
    queryFn: () => listFn({ data: { companyId: ctx.companyId } }),
  });
  const list = budgets.data?.budgets ?? [];
  const budgetId =
    ctx.search.budget && list.some((b) => b.id === ctx.search.budget)
      ? ctx.search.budget
      : (list[0]?.id ?? null);

  const q = useQuery({
    queryKey: ["report-budget-vs-actual", ctx.companyId, budgetId, view, ctx.to],
    enabled: Boolean(budgetId),
    queryFn: () =>
      reportFn({ data: { companyId: ctx.companyId, budgetId: budgetId!, view, to: ctx.to } }),
  });
  const d = q.data;

  const controls = (
    <>
      <div className="space-y-1">
        <Label htmlFor="bva-budget">Budget</Label>
        <select
          id="bva-budget"
          className={selectCls}
          value={budgetId ?? ""}
          onChange={(e) => ctx.setSearch({ budget: e.target.value || undefined })}
        >
          {list.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} ({b.fiscal_year_start.slice(0, 4)})
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="bva-view">Columns</Label>
        <select
          id="bva-view"
          className={selectCls}
          value={view}
          onChange={(e) =>
            ctx.setSearch({ view: e.target.value === "month" ? undefined : e.target.value })
          }
        >
          <option value="month">Monthly</option>
          <option value="quarter">Quarterly</option>
          <option value="ytd">Year to date only</option>
        </select>
      </div>
    </>
  );

  const money = (v: number) => fmt.amount(v, ctx.currency);
  const pct = (v: number | null) => (v === null ? "–" : fmt.percentBps(v));

  const csv = () => {
    if (!d) return null;
    const cols = d.report.columns;
    const headers = [
      "Code",
      "Account",
      ...cols.flatMap((c) => [
        `${c.label} budget`,
        `${c.label} actual`,
        `${c.label} variance`,
        `${c.label} variance %`,
      ]),
    ];
    const cells = (cs: VarianceCell[]) =>
      cs.flatMap((c) => [
        csvMoney(c.budgetMinor, ctx.currency),
        csvMoney(c.actualMinor, ctx.currency),
        csvMoney(c.varianceMinor, ctx.currency),
        c.variancePctBps === null ? "" : (c.variancePctBps / 100).toFixed(2),
      ]);
    const section = (title: string, s: VarianceSection) => [
      [title, "", ...cols.flatMap(() => ["", "", "", ""])],
      ...s.rows.map((r) => [r.code, r.name, ...cells(r.cells)]),
      ["", `Total ${title.toLowerCase()}`, ...cells(s.totals)],
    ];
    return {
      headers,
      rows: [
        ...section("Income", d.report.income),
        ...section("Expenses", d.report.expense),
        ["", "Net profit", ...cells(d.report.net)],
      ],
      basis: `${d.budget.name}; variance: favourable is positive`,
    };
  };

  return (
    <ReportShell
      title="Budget versus Actual"
      ctx={ctx}
      mode="asof"
      basis={
        d
          ? `${d.budget.name}, financial year from ${fmt.date(d.budget.fiscal_year_start)}`
          : undefined
      }
      extraControls={controls}
      getCsv={csv}
    >
      {budgets.isPending ? null : budgets.data && !budgets.data.available ? (
        <Alert>
          <AlertDescription>
            Budgets are not available yet: the database update that adds them has not been applied.
          </AlertDescription>
        </Alert>
      ) : list.length === 0 ? (
        <div className="space-y-3">
          <Alert>
            <AlertDescription>
              There are no budgets yet. Create one to compare it with your posted actuals.
            </AlertDescription>
          </Alert>
          <Button asChild>
            <Link to="/budgets">Create a budget</Link>
          </Button>
        </div>
      ) : (
        <ReportPane query={q} emptyTitle="Nothing to show" emptyDescription="Choose a budget.">
          {d ? (
            d.notStarted ? (
              <Alert>
                <AlertDescription>
                  The selected date is before this budget's financial year starts (
                  {fmt.date(d.budget.fiscal_year_start)}). Pick a later date.
                </AlertDescription>
              </Alert>
            ) : (
              <>
                {d.unbudgetedActualsMinor !== 0 ? (
                  <Alert className="mb-3">
                    <AlertDescription>
                      {fmt.money(d.unbudgetedActualsMinor, ctx.currency)} of actuals sit on accounts
                      that are archived or not postable and are not shown. Profit and Loss includes
                      them.
                    </AlertDescription>
                  </Alert>
                ) : null}
                <p className="mb-2 text-xs text-muted-foreground print:hidden">
                  Actuals run from the start of the budget year to {fmt.date(d.through)}. Variance
                  is actual minus budget for income and budget minus actual for expenses, so{" "}
                  <span className="text-emerald-600">favourable is positive</span> and{" "}
                  <span className="text-destructive">unfavourable is negative</span>.
                </p>
                <div className="overflow-x-auto">
                  <BvaTable
                    report={d.report}
                    ctx={ctx}
                    from={d.budget.fiscal_year_start}
                    to={d.through}
                    money={money}
                    pct={pct}
                  />
                </div>
              </>
            )
          ) : null}
        </ReportPane>
      )}
    </ReportShell>
  );
}

function BvaTable({
  report,
  ctx,
  from,
  to,
  money,
  pct,
}: {
  report: NonNullable<Awaited<ReturnType<typeof getBudgetVsActual>>>["report"];
  ctx: ReportCtx;
  from: string;
  to: string;
  money: (v: number) => string;
  pct: (v: number | null) => string;
}) {
  const cols = report.columns;
  const cellsFor = (cells: VarianceCell[], bold: boolean) =>
    cells.flatMap((c, i) => {
      const cls = `text-right tabular-nums ${bold ? "font-semibold" : ""}`;
      return [
        <TableCell key={`b${i}`} className={cls}>
          {money(c.budgetMinor)}
        </TableCell>,
        <TableCell key={`a${i}`} className={cls}>
          {money(c.actualMinor)}
        </TableCell>,
        <TableCell key={`v${i}`} className={`${cls} ${toneClass(c.status)}`}>
          {money(c.varianceMinor)}
        </TableCell>,
        <TableCell key={`p${i}`} className={`${cls} ${toneClass(c.status)}`}>
          {pct(c.variancePctBps)}
        </TableCell>,
      ];
    });
  const sectionRows = (title: string, s: VarianceSection) => (
    <>
      <TableRow className="bg-muted/40">
        <TableCell
          colSpan={cols.length * 4 + 1}
          className="text-xs font-semibold uppercase tracking-wide"
        >
          {title}
        </TableCell>
      </TableRow>
      {s.rows.map((r: VarianceRow) => (
        <TableRow key={r.accountId}>
          <TableCell className="pl-6">
            <AccountLink accountId={r.accountId} from={from} to={to}>
              <span className="mr-2 text-muted-foreground">{r.code}</span>
              {r.name}
            </AccountLink>
          </TableCell>
          {cellsFor(r.cells, false)}
        </TableRow>
      ))}
      <TableRow>
        <TableCell className="font-semibold">Total {title.toLowerCase()}</TableCell>
        {cellsFor(s.totals, true)}
      </TableRow>
    </>
  );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead rowSpan={2}>Account</TableHead>
          {cols.map((c) => (
            <TableHead key={c.key} colSpan={4} className="border-l text-center">
              {c.label}
            </TableHead>
          ))}
        </TableRow>
        <TableRow>
          {cols.flatMap((c) =>
            ["Budget", "Actual", "Variance", "Var %"].map((h) => (
              <TableHead
                key={`${c.key}-${h}`}
                className={`text-right ${h === "Budget" ? "border-l" : ""}`}
              >
                {h}
              </TableHead>
            )),
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sectionRows("Income", report.income)}
        {sectionRows("Expenses", report.expense)}
        <TableRow className="border-t-2">
          <TableCell className="font-semibold">Net profit</TableCell>
          {cellsFor(report.net, true)}
        </TableRow>
      </TableBody>
    </Table>
  );
}

/* ------------------------------------------------------------------ */
/* Fixed asset register                                                */
/* ------------------------------------------------------------------ */

const METHOD_LABEL = new Map(DEPRECIATION_METHODS.map((m) => [m.value, m.label]));

export function FixedAssetRegisterView({ ctx }: { ctx: ReportCtx }) {
  const fmt = useFormat();
  const fetchFn = useServerFn(getFixedAssetRegister);
  const q = useQuery({
    queryKey: ["report-fa-register", ctx.companyId, ctx.to],
    queryFn: () => fetchFn({ data: { companyId: ctx.companyId, asOf: ctx.to } }),
  });
  const d = q.data;
  const rows = d?.rows ?? [];
  const m = (v: number) => fmt.amount(v, ctx.currency);
  const total = (pick: (r: (typeof rows)[number]) => number) =>
    rows.reduce((n, r) => n + (r.disposal_date ? 0 : pick(r)), 0);
  return (
    <ReportShell
      title="Fixed Asset Register"
      ctx={ctx}
      mode="asof"
      basis="Cost less accumulated depreciation posted to the date. Disposed assets are listed but excluded from the totals."
      extraControls={
        <Button size="sm" variant="outline" asChild className="print:hidden">
          <Link to="/fixed-assets">Manage assets</Link>
        </Button>
      }
      getCsv={() =>
        d
          ? {
              headers: [
                "Number",
                "Asset",
                "Type",
                "Purchase date",
                "Method",
                "Cost",
                "Accumulated depreciation",
                "Net book value",
                "Disposed",
                "Proceeds",
              ],
              rows: d.rows.map((r) => [
                r.asset_number,
                r.asset_name,
                r.asset_type_name ?? "",
                r.purchase_date,
                METHOD_LABEL.get(r.depreciation_method) ?? r.depreciation_method,
                csvMoney(r.cost_minor, ctx.currency),
                csvMoney(r.accumulated_minor, ctx.currency),
                csvMoney(r.cost_minor - r.accumulated_minor, ctx.currency),
                r.disposal_date ?? "",
                r.disposal_proceeds_minor === null
                  ? ""
                  : csvMoney(r.disposal_proceeds_minor, ctx.currency),
              ]),
            }
          : null
      }
    >
      <ReportPane
        query={q}
        isEmpty={Boolean(d) && rows.length === 0}
        emptyTitle="No fixed assets"
        emptyDescription="Register assets under Fixed assets to see them here."
      >
        {d ? (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-3 print:hidden">
              <Stat
                label="Cost"
                value={fmt.money(
                  total((r) => r.cost_minor),
                  ctx.currency,
                )}
              />
              <Stat
                label="Accumulated depreciation"
                value={fmt.money(
                  total((r) => r.accumulated_minor),
                  ctx.currency,
                )}
              />
              <Stat
                label="Net book value"
                value={fmt.money(
                  total((r) => r.cost_minor - r.accumulated_minor),
                  ctx.currency,
                )}
              />
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Asset</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Purchased</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Accumulated</TableHead>
                  <TableHead className="text-right">Net book value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.asset_id}>
                    <TableCell>
                      <AccountLink
                        accountId={r.asset_account_id}
                        from={r.purchase_date}
                        to={ctx.to}
                      >
                        <span className="mr-2 font-mono text-xs text-muted-foreground">
                          {r.asset_number}
                        </span>
                        {r.asset_name}
                      </AccountLink>
                      {r.disposal_date ? (
                        <span className="ml-2 text-xs text-muted-foreground">
                          disposed {fmt.date(r.disposal_date)}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>{r.asset_type_name ?? "–"}</TableCell>
                    <TableCell>{fmt.date(r.purchase_date)}</TableCell>
                    <TableCell>{METHOD_LABEL.get(r.depreciation_method)}</TableCell>
                    <TableCell className="text-right tabular-nums">{m(r.cost_minor)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {m(r.accumulated_minor)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.disposal_date ? "–" : m(r.cost_minor - r.accumulated_minor)}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="border-t-2 font-semibold">
                  <TableCell colSpan={4}>Total (active assets)</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m(total((r) => r.cost_minor))}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m(total((r) => r.accumulated_minor))}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m(total((r) => r.cost_minor - r.accumulated_minor))}
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

/* ------------------------------------------------------------------ */
/* Depreciation schedule                                               */
/* ------------------------------------------------------------------ */

export function DepreciationScheduleView({ ctx }: { ctx: ReportCtx }) {
  const fmt = useFormat();
  const fetchFn = useServerFn(getDepreciationSchedule);
  const q = useQuery({
    queryKey: ["report-depreciation", ctx.companyId, ctx.from, ctx.to],
    queryFn: () => fetchFn({ data: { companyId: ctx.companyId, from: ctx.from, to: ctx.to } }),
  });
  const d = q.data;
  const rows = d?.rows ?? [];
  const m = (v: number) => fmt.amount(v, ctx.currency);
  const sum = (pick: (r: (typeof rows)[number]) => number) => rows.reduce((n, r) => n + pick(r), 0);
  return (
    <ReportShell
      title="Depreciation Schedule"
      ctx={ctx}
      mode="range"
      basis="Opening accumulated depreciation, charge posted in the period and closing balance, per asset"
      getCsv={() =>
        d
          ? {
              headers: [
                "Number",
                "Asset",
                "Cost",
                "Opening",
                "Charge",
                "Closing",
                "Net book value",
              ],
              rows: [
                ...d.rows.map((r) => [
                  r.asset_number,
                  r.asset_name,
                  csvMoney(r.cost_minor, ctx.currency),
                  csvMoney(r.opening_accumulated_minor, ctx.currency),
                  csvMoney(r.charge_minor, ctx.currency),
                  csvMoney(r.closing_accumulated_minor, ctx.currency),
                  csvMoney(r.cost_minor - r.closing_accumulated_minor, ctx.currency),
                ]),
                [
                  "",
                  "Total",
                  csvMoney(
                    sum((r) => r.cost_minor),
                    ctx.currency,
                  ),
                  csvMoney(
                    sum((r) => r.opening_accumulated_minor),
                    ctx.currency,
                  ),
                  csvMoney(
                    sum((r) => r.charge_minor),
                    ctx.currency,
                  ),
                  csvMoney(
                    sum((r) => r.closing_accumulated_minor),
                    ctx.currency,
                  ),
                  csvMoney(
                    sum((r) => r.cost_minor - r.closing_accumulated_minor),
                    ctx.currency,
                  ),
                ],
              ],
            }
          : null
      }
    >
      <ReportPane
        query={q}
        isEmpty={Boolean(d) && rows.length === 0}
        emptyTitle="No depreciating assets"
        emptyDescription="No assets that depreciate were held in this period."
      >
        {d ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Asset</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Opening</TableHead>
                <TableHead className="text-right">Charge</TableHead>
                <TableHead className="text-right">Closing</TableHead>
                <TableHead className="text-right">Net book value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.asset_id}>
                  <TableCell>
                    <span className="mr-2 font-mono text-xs text-muted-foreground">
                      {r.asset_number}
                    </span>
                    {r.asset_name}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{m(r.cost_minor)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m(r.opening_accumulated_minor)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{m(r.charge_minor)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m(r.closing_accumulated_minor)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m(r.cost_minor - r.closing_accumulated_minor)}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="border-t-2 font-semibold">
                <TableCell>Total</TableCell>
                <TableCell className="text-right tabular-nums">
                  {m(sum((r) => r.cost_minor))}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {m(sum((r) => r.opening_accumulated_minor))}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {m(sum((r) => r.charge_minor))}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {m(sum((r) => r.closing_accumulated_minor))}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {m(sum((r) => r.cost_minor - r.closing_accumulated_minor))}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        ) : null}
      </ReportPane>
    </ReportShell>
  );
}
