import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { useFormat } from "@/hooks/use-format";
import { csvMoney, type CsvCell } from "@/lib/reports/csv";
import {
  getBankReconSummary,
  getCashFlowIndirect,
  getCashSummary,
  getExecutiveSummary,
  getGlSummary,
  getPurchasesBySupplier,
  getSalesByContact,
  getSalesByItem,
} from "@/lib/reports/analysis.functions";
import type { SummaryRow } from "@/lib/reports/executive-summary";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AccountLink, ReportPane, ReportShell, Stat, type ReportCtx } from "./ReportShell";

type Col<T> = {
  header: string;
  cell: (row: T) => ReactNode;
  csv: (row: T) => CsvCell;
  right?: boolean;
  total?: (rows: T[]) => { node: ReactNode; csv: CsvCell };
};

/** Plain table with an optional totals row; the same columns drive the CSV export. */
function RowsTable<T>({
  rows,
  cols,
  rowKey,
}: {
  rows: T[];
  cols: Col<T>[];
  rowKey: (r: T) => string;
}) {
  const hasTotals = cols.some((c) => c.total);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {cols.map((c) => (
            <TableHead key={c.header} className={c.right ? "text-right" : undefined}>
              {c.header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={rowKey(r)}>
            {cols.map((c) => (
              <TableCell key={c.header} className={c.right ? "text-right tabular-nums" : undefined}>
                {c.cell(r)}
              </TableCell>
            ))}
          </TableRow>
        ))}
        {hasTotals ? (
          <TableRow className="border-t-2 font-semibold">
            {cols.map((c, i) => (
              <TableCell key={c.header} className={c.right ? "text-right tabular-nums" : undefined}>
                {c.total ? c.total(rows).node : i === 0 ? "Total" : ""}
              </TableCell>
            ))}
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  );
}

function csvFor<T>(rows: T[], cols: Col<T>[]) {
  const hasTotals = cols.some((c) => c.total);
  return {
    headers: cols.map((c) => c.header),
    rows: [
      ...rows.map((r) => cols.map((c) => c.csv(r))),
      ...(hasTotals
        ? [cols.map((c, i) => (c.total ? c.total(rows).csv : i === 0 ? "Total" : ""))]
        : []),
    ],
  };
}

const sumBy = <T,>(rows: T[], pick: (r: T) => number) => rows.reduce((n, r) => n + pick(r), 0);

/* ------------------------------------------------------------------ */
/* Executive summary                                                   */
/* ------------------------------------------------------------------ */

const GROUPS: Array<{ id: SummaryRow["group"]; label: string }> = [
  { id: "cash", label: "Cash" },
  { id: "profitability", label: "Profitability" },
  { id: "position", label: "Position" },
  { id: "performance", label: "Performance" },
];

function summaryValue(
  fmt: ReturnType<typeof useFormat>,
  row: SummaryRow,
  v: number | null,
  currency: string,
): string {
  if (v === null) return "n/a";
  if (row.format === "bps") return fmt.percentBps(v);
  if (row.format === "days") return `${fmt.number(v)} days`;
  return fmt.money(v, currency);
}

function changeTone(row: SummaryRow): string {
  if (row.changeBps === null || row.changeBps === 0 || row.better === "neutral") return "";
  const good = row.better === "higher" ? row.changeBps > 0 : row.changeBps < 0;
  return good ? "text-emerald-600" : "text-destructive";
}

export function ExecutiveSummaryView({ ctx }: { ctx: ReportCtx }) {
  const fmt = useFormat();
  const fetchFn = useServerFn(getExecutiveSummary);
  const q = useQuery({
    queryKey: ["report-exec", ctx.companyId, ctx.from, ctx.to],
    queryFn: () => fetchFn({ data: { companyId: ctx.companyId, from: ctx.from, to: ctx.to } }),
  });
  const d = q.data;
  return (
    <ReportShell
      title="Executive Summary"
      ctx={ctx}
      mode="range"
      basis="Accrual basis, posted ledger. Compared with the previous period of the same length."
      getCsv={() =>
        d
          ? {
              headers: ["Group", "Measure", "This period", "Prior period", "Change %"],
              rows: d.rows.map((r) => [
                r.group,
                r.label,
                r.current === null
                  ? ""
                  : r.format === "money"
                    ? csvMoney(r.current, ctx.currency)
                    : r.current,
                r.prior === null
                  ? ""
                  : r.format === "money"
                    ? csvMoney(r.prior, ctx.currency)
                    : r.prior,
                r.changeBps === null ? "" : (r.changeBps / 100).toFixed(2),
              ]),
            }
          : null
      }
    >
      <ReportPane
        query={q}
        emptyTitle="Nothing to summarise"
        emptyDescription="Post transactions to see headline figures."
      >
        {d ? (
          <div className="space-y-6">
            <p className="text-sm text-muted-foreground">
              This period {fmt.date(d.from)} – {fmt.date(d.to)}; prior period{" "}
              {fmt.date(d.priorFrom)} – {fmt.date(d.priorTo)}.
            </p>
            {GROUPS.map((g) => (
              <section key={g.id}>
                <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {g.label}
                </h2>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Measure</TableHead>
                      <TableHead className="text-right">This period</TableHead>
                      <TableHead className="text-right">Prior period</TableHead>
                      <TableHead className="text-right">Change</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {d.rows
                      .filter((r) => r.group === g.id)
                      .map((r) => (
                        <TableRow key={r.key}>
                          <TableCell>
                            {r.label}
                            {r.note ? (
                              <span className="block text-xs text-muted-foreground">{r.note}</span>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {summaryValue(fmt, r, r.current, d.currency)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {summaryValue(fmt, r, r.prior, d.currency)}
                          </TableCell>
                          <TableCell className={`text-right tabular-nums ${changeTone(r)}`}>
                            {r.changeBps === null ? "–" : fmt.percentBps(r.changeBps)}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </section>
            ))}
            <p className="text-sm print:hidden">
              Drill down:{" "}
              <Link
                to="/reports/$reportId"
                params={{ reportId: "profit-and-loss" }}
                search={{ from: d.from, to: d.to }}
                className="underline-offset-2 hover:underline"
              >
                Profit and Loss
              </Link>
              {" · "}
              <Link
                to="/reports/$reportId"
                params={{ reportId: "balance-sheet" }}
                search={{ to: d.to }}
                className="underline-offset-2 hover:underline"
              >
                Balance Sheet
              </Link>
              {" · "}
              <Link
                to="/reports/$reportId"
                params={{ reportId: "cash-summary" }}
                search={{ from: d.from, to: d.to }}
                className="underline-offset-2 hover:underline"
              >
                Cash Summary
              </Link>
            </p>
          </div>
        ) : null}
      </ReportPane>
    </ReportShell>
  );
}

/* ------------------------------------------------------------------ */
/* Cash summary                                                        */
/* ------------------------------------------------------------------ */

export function CashSummaryView({ ctx }: { ctx: ReportCtx }) {
  const fmt = useFormat();
  const fetchFn = useServerFn(getCashSummary);
  const q = useQuery({
    queryKey: ["report-cash-summary", ctx.companyId, ctx.from, ctx.to],
    queryFn: () => fetchFn({ data: { companyId: ctx.companyId, from: ctx.from, to: ctx.to } }),
  });
  const d = q.data;
  type Row = NonNullable<typeof d>["rows"][number];
  const m = (v: number) => fmt.amount(v, ctx.currency);
  const cols: Col<Row>[] = [
    {
      header: "Bank account",
      cell: (r) => (
        <AccountLink accountId={r.gl_account_id} from={ctx.from} to={ctx.to}>
          {r.bank_account_name}
        </AccountLink>
      ),
      csv: (r) => r.bank_account_name,
    },
    ...(
      [
        ["Opening balance", "opening_minor"],
        ["Cash received", "received_minor"],
        ["Cash spent", "spent_minor"],
        ["Transfers in", "transfers_in_minor"],
        ["Transfers out", "transfers_out_minor"],
        ["Closing balance", "closing_minor"],
      ] as const
    ).map(([header, key]): Col<Row> => ({
      header,
      right: true,
      cell: (r) => m(r[key]),
      csv: (r) => csvMoney(r[key], ctx.currency),
      total: (rows) => {
        const t = sumBy(rows, (r) => r[key]);
        return { node: m(t), csv: csvMoney(t, ctx.currency) };
      },
    })),
  ];
  return (
    <ReportShell
      title="Cash Summary"
      ctx={ctx}
      mode="range"
      basis="Posted ledger movements on each bank account. Transfers between your own accounts are shown separately."
      getCsv={() => (d ? csvFor(d.rows, cols) : null)}
    >
      <ReportPane
        query={q}
        isEmpty={Boolean(d) && d!.rows.length === 0}
        emptyTitle="No bank accounts"
        emptyDescription="Add a bank account to see its cash movements."
      >
        {d ? <RowsTable rows={d.rows} cols={cols} rowKey={(r) => r.bank_account_id} /> : null}
      </ReportPane>
    </ReportShell>
  );
}

/* ------------------------------------------------------------------ */
/* General ledger summary                                              */
/* ------------------------------------------------------------------ */

export function GlSummaryView({ ctx }: { ctx: ReportCtx }) {
  const fmt = useFormat();
  const fetchFn = useServerFn(getGlSummary);
  const q = useQuery({
    queryKey: ["report-gl-summary", ctx.companyId, ctx.from, ctx.to],
    queryFn: () => fetchFn({ data: { companyId: ctx.companyId, from: ctx.from, to: ctx.to } }),
  });
  const d = q.data;
  type Row = NonNullable<typeof d>["rows"][number];
  const m = (v: number) => fmt.amount(v, ctx.currency);
  const money = (
    header: string,
    key: "opening_minor" | "debit_minor" | "credit_minor" | "closing_minor",
    total: boolean,
  ): Col<Row> => ({
    header,
    right: true,
    cell: (r) => m(r[key]),
    csv: (r) => csvMoney(r[key], ctx.currency),
    ...(total
      ? {
          total: (rows: Row[]) => {
            const t = sumBy(rows, (r) => r[key]);
            return { node: m(t), csv: csvMoney(t, ctx.currency) };
          },
        }
      : {}),
  });
  const cols: Col<Row>[] = [
    {
      header: "Account",
      cell: (r) => (
        <AccountLink accountId={r.account_id} from={ctx.from} to={ctx.to}>
          <span className="mr-2 text-muted-foreground">{r.account_code}</span>
          {r.account_name}
        </AccountLink>
      ),
      csv: (r) => `${r.account_code} ${r.account_name}`,
    },
    { header: "Type", cell: (r) => r.account_type, csv: (r) => r.account_type },
    money("Opening", "opening_minor", false),
    money("Debits", "debit_minor", true),
    money("Credits", "credit_minor", true),
    money("Closing", "closing_minor", false),
    {
      header: "Lines",
      right: true,
      cell: (r) => fmt.number(r.line_count),
      csv: (r) => r.line_count,
    },
  ];
  return (
    <ReportShell
      title="General Ledger Summary"
      ctx={ctx}
      mode="range"
      basis="Debits and credits per account from posted journals. Opening and closing are signed debit minus credit."
      getCsv={() => (d ? csvFor(d.rows, cols) : null)}
    >
      <ReportPane
        query={q}
        isEmpty={Boolean(d) && d!.rows.length === 0}
        emptyTitle="No ledger activity"
        emptyDescription="No posted journals fall in this period."
      >
        {d ? <RowsTable rows={d.rows} cols={cols} rowKey={(r) => r.account_id} /> : null}
      </ReportPane>
    </ReportShell>
  );
}

/* ------------------------------------------------------------------ */
/* Sales by contact / item, purchases by supplier                      */
/* ------------------------------------------------------------------ */

export function SalesByContactView({ ctx }: { ctx: ReportCtx }) {
  const fmt = useFormat();
  const fetchFn = useServerFn(getSalesByContact);
  const q = useQuery({
    queryKey: ["report-sales-contact", ctx.companyId, ctx.from, ctx.to],
    queryFn: () => fetchFn({ data: { companyId: ctx.companyId, from: ctx.from, to: ctx.to } }),
  });
  const d = q.data;
  type Row = NonNullable<typeof d>["rows"][number];
  const m = (v: number) => fmt.amount(v, ctx.currency);
  const cols: Col<Row>[] = [
    { header: "Customer", cell: (r) => r.contact_name, csv: (r) => r.contact_name },
    {
      header: "Invoices",
      right: true,
      cell: (r) => fmt.number(r.invoice_count),
      csv: (r) => r.invoice_count,
      total: (rows) => {
        const t = sumBy(rows, (r) => r.invoice_count);
        return { node: fmt.number(t), csv: t };
      },
    },
    {
      header: "Credit notes",
      right: true,
      cell: (r) => fmt.number(r.credit_note_count),
      csv: (r) => r.credit_note_count,
      total: (rows) => {
        const t = sumBy(rows, (r) => r.credit_note_count);
        return { node: fmt.number(t), csv: t };
      },
    },
    ...(
      [
        ["Net sales", "net_minor"],
        ["Tax", "tax_minor"],
        ["Gross", "gross_minor"],
      ] as const
    ).map(([header, key]): Col<Row> => ({
      header,
      right: true,
      cell: (r) => m(r[key]),
      csv: (r) => csvMoney(r[key], ctx.currency),
      total: (rows) => {
        const t = sumBy(rows, (r) => r[key]);
        return { node: m(t), csv: csvMoney(t, ctx.currency) };
      },
    })),
  ];
  return (
    <ReportShell
      title="Sales by Contact"
      ctx={ctx}
      mode="range"
      basis="Posted invoices less credit notes, in base currency by invoice date"
      getCsv={() => (d ? csvFor(d.rows, cols) : null)}
    >
      <ReportPane
        query={q}
        isEmpty={Boolean(d) && d!.rows.length === 0}
        emptyTitle="No sales"
        emptyDescription="No posted invoices fall in this period."
      >
        {d ? <RowsTable rows={d.rows} cols={cols} rowKey={(r) => r.contact_id} /> : null}
      </ReportPane>
    </ReportShell>
  );
}

export function SalesByItemView({ ctx }: { ctx: ReportCtx }) {
  const fmt = useFormat();
  const fetchFn = useServerFn(getSalesByItem);
  const q = useQuery({
    queryKey: ["report-sales-item", ctx.companyId, ctx.from, ctx.to],
    queryFn: () => fetchFn({ data: { companyId: ctx.companyId, from: ctx.from, to: ctx.to } }),
  });
  const d = q.data;
  type Row = NonNullable<typeof d>["rows"][number];
  const m = (v: number) => fmt.amount(v, ctx.currency);
  const cols: Col<Row>[] = [
    { header: "Code", cell: (r) => r.item_code ?? "", csv: (r) => r.item_code ?? "" },
    {
      header: "Item",
      cell: (r) =>
        r.item_name ?? <span className="text-muted-foreground">No item (free-text lines)</span>,
      csv: (r) => r.item_name ?? "No item",
    },
    {
      header: "Quantity",
      right: true,
      cell: (r) => fmt.number(r.quantity),
      csv: (r) => r.quantity,
    },
    {
      header: "Lines",
      right: true,
      cell: (r) => fmt.number(r.line_count),
      csv: (r) => r.line_count,
    },
    ...(
      [
        ["Net sales", "net_minor"],
        ["Tax", "tax_minor"],
      ] as const
    ).map(([header, key]): Col<Row> => ({
      header,
      right: true,
      cell: (r) => m(r[key]),
      csv: (r) => csvMoney(r[key], ctx.currency),
      total: (rows) => {
        const t = sumBy(rows, (r) => r[key]);
        return { node: m(t), csv: csvMoney(t, ctx.currency) };
      },
    })),
  ];
  return (
    <ReportShell
      title="Sales by Item"
      ctx={ctx}
      mode="range"
      basis="Posted invoice lines less credit-note lines, in base currency. Quantities are summed as entered."
      getCsv={() => (d ? csvFor(d.rows, cols) : null)}
    >
      <ReportPane
        query={q}
        isEmpty={Boolean(d) && d!.rows.length === 0}
        emptyTitle="No sales"
        emptyDescription="No posted invoice lines fall in this period."
      >
        {d ? <RowsTable rows={d.rows} cols={cols} rowKey={(r) => r.product_id ?? "none"} /> : null}
      </ReportPane>
    </ReportShell>
  );
}

export function PurchasesBySupplierView({ ctx }: { ctx: ReportCtx }) {
  const fmt = useFormat();
  const fetchFn = useServerFn(getPurchasesBySupplier);
  const q = useQuery({
    queryKey: ["report-purchases-supplier", ctx.companyId, ctx.from, ctx.to],
    queryFn: () => fetchFn({ data: { companyId: ctx.companyId, from: ctx.from, to: ctx.to } }),
  });
  const d = q.data;
  type Row = NonNullable<typeof d>["rows"][number];
  const m = (v: number) => fmt.amount(v, ctx.currency);
  const cols: Col<Row>[] = [
    { header: "Supplier", cell: (r) => r.contact_name, csv: (r) => r.contact_name },
    {
      header: "Bills",
      right: true,
      cell: (r) => fmt.number(r.bill_count),
      csv: (r) => r.bill_count,
      total: (rows) => {
        const t = sumBy(rows, (r) => r.bill_count);
        return { node: fmt.number(t), csv: t };
      },
    },
    {
      header: "Credit notes",
      right: true,
      cell: (r) => fmt.number(r.credit_note_count),
      csv: (r) => r.credit_note_count,
      total: (rows) => {
        const t = sumBy(rows, (r) => r.credit_note_count);
        return { node: fmt.number(t), csv: t };
      },
    },
    ...(
      [
        ["Net purchases", "net_minor"],
        ["Tax", "tax_minor"],
        ["Gross", "gross_minor"],
      ] as const
    ).map(([header, key]): Col<Row> => ({
      header,
      right: true,
      cell: (r) => m(r[key]),
      csv: (r) => csvMoney(r[key], ctx.currency),
      total: (rows) => {
        const t = sumBy(rows, (r) => r[key]);
        return { node: m(t), csv: csvMoney(t, ctx.currency) };
      },
    })),
  ];
  return (
    <ReportShell
      title="Purchases by Supplier"
      ctx={ctx}
      mode="range"
      basis="Posted bills less credit notes, in base currency by bill date. Direct expenses are not included."
      getCsv={() => (d ? csvFor(d.rows, cols) : null)}
    >
      <ReportPane
        query={q}
        isEmpty={Boolean(d) && d!.rows.length === 0}
        emptyTitle="No purchases"
        emptyDescription="No posted bills fall in this period."
      >
        {d ? <RowsTable rows={d.rows} cols={cols} rowKey={(r) => r.contact_id} /> : null}
      </ReportPane>
    </ReportShell>
  );
}

/* ------------------------------------------------------------------ */
/* Bank reconciliation summary                                         */
/* ------------------------------------------------------------------ */

export function BankReconSummaryView({ ctx }: { ctx: ReportCtx }) {
  const fmt = useFormat();
  const fetchFn = useServerFn(getBankReconSummary);
  const q = useQuery({
    queryKey: ["report-bank-recon-summary", ctx.companyId, ctx.to],
    queryFn: () => fetchFn({ data: { companyId: ctx.companyId, asOf: ctx.to } }),
  });
  const d = q.data;
  type Row = NonNullable<typeof d>["rows"][number];
  // Balances are in each bank account's own currency; amounts are shown with that currency's decimals.
  const cols: Col<Row>[] = [
    {
      header: "Bank account",
      cell: (r) => (
        <AccountLink accountId={r.gl_account_id} from={ctx.from} to={ctx.to}>
          {r.bank_account_name}
        </AccountLink>
      ),
      csv: (r) => r.bank_account_name,
    },
    { header: "Currency", cell: (r) => r.currency_code, csv: (r) => r.currency_code },
    {
      header: "Book balance",
      right: true,
      cell: (r) => fmt.amount(r.book_balance_minor, ctx.currency),
      csv: (r) => csvMoney(r.book_balance_minor, ctx.currency),
    },
    {
      header: "Last reconciled",
      cell: (r) => (r.last_reconciled_date ? fmt.date(r.last_reconciled_date) : "Never"),
      csv: (r) => r.last_reconciled_date ?? "",
    },
    {
      header: "Statement balance",
      right: true,
      cell: (r) =>
        r.last_statement_balance_minor === null
          ? "–"
          : fmt.amount(r.last_statement_balance_minor, r.currency_code),
      csv: (r) =>
        r.last_statement_balance_minor === null
          ? ""
          : csvMoney(r.last_statement_balance_minor, r.currency_code),
    },
    {
      header: "Uncleared lines",
      right: true,
      cell: (r) => fmt.number(r.uncleared_line_count),
      csv: (r) => r.uncleared_line_count,
    },
    {
      header: "Uncleared net",
      right: true,
      cell: (r) => fmt.amount(r.uncleared_net_minor, ctx.currency),
      csv: (r) => csvMoney(r.uncleared_net_minor, ctx.currency),
    },
    {
      header: "Uncoded statement lines",
      right: true,
      cell: (r) => fmt.number(r.uncoded_statement_count),
      csv: (r) => r.uncoded_statement_count,
    },
    {
      header: "Difference",
      right: true,
      cell: (r) =>
        r.difference_minor === null ? "–" : fmt.amount(r.difference_minor, ctx.currency),
      csv: (r) => (r.difference_minor === null ? "" : csvMoney(r.difference_minor, ctx.currency)),
    },
  ];
  return (
    <ReportShell
      title="Bank Reconciliation Summary"
      ctx={ctx}
      mode="asof"
      basis="Book balance against the last completed reconciliation and what is still uncleared"
      getCsv={() => (d ? csvFor(d.rows, cols) : null)}
      extraControls={
        <Button size="sm" variant="outline" asChild className="print:hidden">
          <Link to="/banking/reconcile">Open reconciliation</Link>
        </Button>
      }
    >
      <ReportPane
        query={q}
        isEmpty={Boolean(d) && d!.rows.length === 0}
        emptyTitle="No bank accounts"
        emptyDescription="Add a bank account to see its reconciliation status."
      >
        {d ? (
          <>
            <Alert className="mb-3">
              <AlertDescription>
                Reconciliations completed before this feature are treated as uncleared, so a bank
                account with an older reconciliation can show more uncleared lines than expected.
                Book balance and uncleared net are in {ctx.currency}.
              </AlertDescription>
            </Alert>
            <RowsTable rows={d.rows} cols={cols} rowKey={(r) => r.bank_account_id} />
          </>
        ) : null}
      </ReportPane>
    </ReportShell>
  );
}

/* ------------------------------------------------------------------ */
/* Cash flow, indirect                                                 */
/* ------------------------------------------------------------------ */

export function CashFlowIndirectView({ ctx }: { ctx: ReportCtx }) {
  const fmt = useFormat();
  const fetchFn = useServerFn(getCashFlowIndirect);
  const q = useQuery({
    queryKey: ["report-cf-indirect", ctx.companyId, ctx.from, ctx.to],
    queryFn: () => fetchFn({ data: { companyId: ctx.companyId, from: ctx.from, to: ctx.to } }),
  });
  const d = q.data;
  const sections = d
    ? ([
        ["Operating activities", d.operating, d.operatingMinor],
        ["Investing activities", d.investing, d.investingMinor],
        ["Financing activities", d.financing, d.financingMinor],
      ] as const)
    : [];
  return (
    <ReportShell
      title="Cash Flow (indirect)"
      ctx={ctx}
      mode="range"
      basis={d?.basis}
      getCsv={() =>
        d
          ? {
              headers: ["Section", "Line", "Amount"],
              rows: [
                ["", "Opening cash", csvMoney(d.openingCashMinor, ctx.currency)],
                ...sections.flatMap(([title, rows, total]) => [
                  ...rows.map((r) => [title, r.label, csvMoney(r.amountMinor, ctx.currency)]),
                  [title, "Net cash", csvMoney(total, ctx.currency)],
                ]),
                ["", "Net change in cash", csvMoney(d.netChangeMinor, ctx.currency)],
                ["", "Closing cash", csvMoney(d.closingCashMinor, ctx.currency)],
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
            <div className="mb-4 grid gap-3 sm:grid-cols-4 print:hidden">
              <Stat label="Opening cash" value={fmt.money(d.openingCashMinor, ctx.currency)} />
              <Stat label="Net change" value={fmt.money(d.netChangeMinor, ctx.currency)} />
              <Stat
                label="Closing (statement)"
                value={fmt.money(d.closingCashMinor, ctx.currency)}
              />
              <Stat
                label="Closing (bank ledger)"
                value={fmt.money(d.closingCashLedgerMinor, ctx.currency)}
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
                {sections.map(([title, rows, total]) => (
                  <FlowSection key={title} title={title} rows={rows} total={total} ctx={ctx} />
                ))}
                <TableRow className="border-t-2 font-semibold">
                  <TableCell>Net change in cash</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmt.amount(d.netChangeMinor, ctx.currency)}
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

function FlowSection({
  title,
  rows,
  total,
  ctx,
}: {
  title: string;
  rows: Array<{ label: string; amountMinor: number; accountId: string | null }>;
  total: number;
  ctx: ReportCtx;
}) {
  const fmt = useFormat();
  return (
    <>
      <TableRow className="bg-muted/40">
        <TableCell colSpan={2} className="text-xs font-semibold uppercase tracking-wide">
          {title}
        </TableCell>
      </TableRow>
      {rows.map((r, i) => (
        <TableRow key={`${r.accountId ?? r.label}-${i}`}>
          <TableCell className="pl-6">
            {r.accountId ? (
              <AccountLink accountId={r.accountId} from={ctx.from} to={ctx.to}>
                {r.label}
              </AccountLink>
            ) : (
              r.label
            )}
          </TableCell>
          <TableCell className="text-right tabular-nums">
            {fmt.amount(r.amountMinor, ctx.currency)}
          </TableCell>
        </TableRow>
      ))}
      <TableRow>
        <TableCell className="font-semibold">Net cash from {title.toLowerCase()}</TableCell>
        <TableCell className="text-right font-semibold tabular-nums">
          {fmt.amount(total, ctx.currency)}
        </TableCell>
      </TableRow>
    </>
  );
}
