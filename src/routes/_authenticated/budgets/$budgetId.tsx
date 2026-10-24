import { useMemo, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowRight, Download, Loader2, Plus, Save, Upload } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { useCanDo } from "@/hooks/use-can";
import { useFormat } from "@/hooks/use-format";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { addMonthsIso, monthStart } from "@/lib/accounting/fiscal-year";
import { fromMinorUnits } from "@/lib/accounting/money";
import {
  getBudget,
  getYearActuals,
  saveBudget,
  saveBudgetLines,
} from "@/lib/budgets/budgets.functions";
import { applyUpliftBps, fillRight, monthLabel, spreadEvenly } from "@/lib/budgets/budget-math";
import {
  budgetCsvHeaders,
  budgetToCsvRows,
  parseAmountCell,
  parseBudgetCsv,
} from "@/lib/budgets/budget-csv";
import { csvFilename, downloadCsv, toCsv } from "@/lib/reports/csv";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/common/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AccountLookup } from "@/components/lookup";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/budgets/$budgetId")({
  head: () => ({ meta: [{ title: "Budget — LinkBooks" }] }),
  component: BudgetEditorPage,
});

type BudgetData = Awaited<ReturnType<typeof getBudget>>;

function BudgetEditorPage() {
  const { budgetId } = Route.useParams();
  const { company } = useActiveCompany();
  const fetchFn = useServerFn(getBudget);
  const companyId = company?.id;
  const query = useQuery({
    queryKey: ["budget", companyId, budgetId],
    enabled: Boolean(companyId),
    queryFn: () => fetchFn({ data: { companyId: companyId!, budgetId } }),
  });
  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (query.isPending) return <LoadingState />;
  if (query.isError) {
    return (
      <ErrorState
        title="Could not load budget"
        description={friendlyAuthError(query.error)}
        onRetry={() => void query.refetch()}
      />
    );
  }
  // Re-mount after every save so the grid always reflects what is stored.
  return (
    <BudgetEditor
      key={`${query.data.budget.id}-${query.data.budget.updated_at}`}
      companyId={companyId}
      data={query.data}
    />
  );
}

/** Text typed in the grid per account; converted to minor units only when needed. */
type Cells = Record<string, string[]>;

function toText(minor: number, currency: string): string {
  return minor === 0 ? "" : fromMinorUnits(minor, currency);
}

function parseCell(text: string, currency: string): number | null {
  try {
    return parseAmountCell(text, currency);
  } catch {
    return null;
  }
}

function BudgetEditor({ companyId, data }: { companyId: string; data: BudgetData }) {
  const { company } = useActiveCompany();
  const fmt = useFormat();
  const queryClient = useQueryClient();
  const canManage = useCanDo("accounts.manage");
  const currency = data.currency;
  const saveLinesFn = useServerFn(saveBudgetLines);
  const saveHeadFn = useServerFn(saveBudget);
  const actualsFn = useServerFn(getYearActuals);
  const fileRef = useRef<HTMLInputElement>(null);

  const initial = useMemo(() => {
    const idx = new Map(data.months.map((m, i) => [m, i]));
    const out: Cells = {};
    for (const l of data.lines) {
      const i = idx.get(l.month);
      if (i === undefined) continue;
      const row = (out[l.accountId] ??= Array.from({ length: 12 }, () => ""));
      row[i] = toText(l.amountMinor, currency);
    }
    return out;
  }, [data, currency]);

  const [cells, setCells] = useState<Cells>(initial);
  const [dirty, setDirty] = useState(false);
  const [name, setName] = useState(data.budget.name);
  const [uplift, setUplift] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const [addId, setAddId] = useState("");
  const focus = useRef<Record<string, number>>({});

  const accounts = data.accounts;
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const rowIds = Object.keys(cells).filter((id) => byId.has(id));
  const rows = accounts.filter((a) => rowIds.includes(a.id));
  const available = accounts.filter((a) => !rowIds.includes(a.id));

  const minor = (id: string): Array<number | null> =>
    (cells[id] ?? []).map((t) => parseCell(t, currency));
  const invalidCount = rows.reduce((n, a) => n + minor(a.id).filter((v) => v === null).length, 0);

  const update = (next: Cells) => {
    setCells(next);
    setDirty(true);
  };
  const setRow = (id: string, row: string[]) => update({ ...cells, [id]: row });
  const rowOf = (id: string) => cells[id] ?? Array.from({ length: 12 }, () => "");

  const totals = (kind: "income" | "expense") =>
    data.months.map((_, i) =>
      rows
        .filter((a) => a.kind === kind)
        .reduce((n, a) => n + (parseCell(rowOf(a.id)[i] ?? "", currency) ?? 0), 0),
    );
  const incomeTotals = totals("income");
  const expenseTotals = totals("expense");
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  const applyMinor = (fn: (id: string, v: number[]) => number[]) => {
    const next: Cells = {};
    for (const a of rows) {
      const parsed = minor(a.id).map((v) => v ?? 0);
      next[a.id] = fn(a.id, parsed).map((v) => toText(v, currency));
    }
    update(next);
  };

  const onUplift = () => {
    const pct = Number(uplift);
    if (!uplift.trim() || !Number.isFinite(pct) || pct <= -100 || pct > 10000) {
      toast.error("Enter an uplift percentage, e.g. 5 or -2.5");
      return;
    }
    const bps = Math.round(pct * 100);
    applyMinor((_, v) => v.map((x) => applyUpliftBps(x, bps)));
    toast.success(`Applied ${pct}% to every row (not saved yet)`);
  };

  const onCopyActuals = async () => {
    if (dirty && !window.confirm("Replace the amounts on screen with last year's actuals?")) return;
    try {
      const prior = addMonthsIso(monthStart(data.budget.fiscal_year_start), -12);
      const res = await actualsFn({ data: { companyId, fiscalYearStart: prior } });
      if (res.rows.length === 0) {
        toast.info("There are no posted actuals for the previous year.");
        return;
      }
      const next: Cells = {};
      for (const r of res.rows) next[r.accountId] = r.months.map((v) => toText(v, currency));
      update(next);
      toast.success("Copied last year's actuals (not saved yet). Apply an uplift if you want one.");
    } catch (e) {
      toast.error(friendlyAuthError(e));
    }
  };

  const onExport = () => {
    const values = new Map(rows.map((a) => [a.id, minor(a.id).map((v) => v ?? 0)]));
    const text = toCsv(
      {
        company: company?.name ?? "",
        report: `Budget ${data.budget.name}`,
        period: `Financial year from ${data.budget.fiscal_year_start}`,
        currency,
      },
      budgetCsvHeaders(data.months),
      budgetToCsvRows(accounts, values, currency),
    );
    downloadCsv(csvFilename(`budget-${data.budget.name}`, data.budget.fiscal_year_start), text);
  };

  const onImport = async (file: File) => {
    const text = await file.text();
    const res = parseBudgetCsv(text, accounts, currency);
    if (res.issues.length > 0) {
      setIssues(res.issues.slice(0, 20).map((i) => `Row ${i.row}: ${i.message}`));
      toast.error("The file has problems, nothing was imported.");
      return;
    }
    setIssues([]);
    const next: Cells = { ...cells };
    for (const [id, vals] of res.values) next[id] = vals.map((v) => toText(v, currency));
    update(next);
    toast.success(`Imported ${res.values.size} account rows (not saved yet)`);
  };

  const save = useMutation({
    mutationFn: async () => {
      if (invalidCount > 0) throw new Error("Fix the highlighted amounts first.");
      await saveLinesWithHead();
    },
    onSuccess: async () => {
      setDirty(false);
      await queryClient.invalidateQueries({ queryKey: ["budget", companyId, data.budget.id] });
      await queryClient.invalidateQueries({ queryKey: ["budgets", companyId] });
      toast.success("Budget saved");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  async function saveLinesWithHead() {
    if (name.trim() !== data.budget.name) {
      if (!name.trim()) throw new Error("Enter a budget name.");
      await saveHeadFn({
        data: {
          companyId,
          budgetId: data.budget.id,
          name: name.trim(),
          fiscalYearStart: data.budget.fiscal_year_start,
          notes: data.budget.notes,
        },
      });
    }
    await saveLinesFn({
      data: {
        companyId,
        budgetId: data.budget.id,
        mode: "replace",
        rows: rows.map((a) => ({ accountId: a.id, months: minor(a.id).map((v) => v ?? 0) })),
      },
    });
  }

  const income = rows.filter((a) => a.kind === "income");
  const expense = rows.filter((a) => a.kind === "expense");

  const renderRow = (a: (typeof rows)[number]) => {
    const row = rowOf(a.id);
    const vals = minor(a.id);
    const total = vals.reduce<number>((n, v) => n + (v ?? 0), 0);
    return (
      <TableRow key={a.id}>
        <TableCell className="sticky left-0 z-10 min-w-48 bg-background">
          <span className="mr-2 text-muted-foreground">{a.code}</span>
          {a.name}
        </TableCell>
        {data.months.map((m, i) => (
          <TableCell key={m} className="p-1">
            <Input
              aria-label={`${a.name} ${monthLabel(m)}`}
              className="h-8 w-24 text-right tabular-nums"
              inputMode="decimal"
              value={row[i] ?? ""}
              aria-invalid={vals[i] === null}
              disabled={!canManage}
              onFocus={() => {
                focus.current[a.id] = i;
              }}
              onChange={(e) => {
                const r = [...row];
                r[i] = e.target.value;
                setRow(a.id, r);
              }}
            />
          </TableCell>
        ))}
        <TableCell className="p-1">
          <Input
            aria-label={`${a.name} annual total (spreads evenly)`}
            className="h-8 w-28 text-right font-medium tabular-nums"
            inputMode="decimal"
            disabled={!canManage}
            value={total === 0 ? "" : fromMinorUnits(total, currency)}
            onChange={(e) => {
              const v = parseCell(e.target.value, currency);
              if (v === null) return;
              setRow(
                a.id,
                spreadEvenly(v, 12).map((x) => toText(x, currency)),
              );
            }}
            title="Type an annual total to spread it evenly over twelve months"
          />
        </TableCell>
        <TableCell className="whitespace-nowrap p-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={!canManage}
            title="Copy the amount in the cell you last edited into every later month"
            onClick={() => {
              const from = focus.current[a.id] ?? 0;
              const filled = fillRight(
                vals.map((v) => v ?? 0),
                from,
              );
              setRow(
                a.id,
                filled.map((x) => toText(x, currency)),
              );
            }}
          >
            <ArrowRight className="mr-1 size-4" /> Fill right
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!canManage}
            onClick={() => {
              const next = { ...cells };
              delete next[a.id];
              update(next);
            }}
          >
            Remove
          </Button>
        </TableCell>
      </TableRow>
    );
  };

  const totalRow = (label: string, values: number[], tone?: boolean) => (
    <TableRow className="border-t-2 font-semibold">
      <TableCell className="sticky left-0 z-10 bg-background">{label}</TableCell>
      {values.map((v, i) => (
        <TableCell
          key={i}
          className={`text-right tabular-nums ${tone && v < 0 ? "text-destructive" : ""}`}
        >
          {fmt.amount(v, currency)}
        </TableCell>
      ))}
      <TableCell className="text-right tabular-nums">{fmt.amount(sum(values), currency)}</TableCell>
      <TableCell />
    </TableRow>
  );

  const section = (title: string, list: typeof rows) => (
    <>
      <TableRow className="bg-muted/40">
        <TableCell
          colSpan={data.months.length + 3}
          className="sticky left-0 text-xs font-semibold uppercase tracking-wide"
        >
          {title}
        </TableCell>
      </TableRow>
      {list.length === 0 ? (
        <TableRow>
          <TableCell colSpan={data.months.length + 3} className="text-sm text-muted-foreground">
            No {title.toLowerCase()} accounts in this budget yet.
          </TableCell>
        </TableRow>
      ) : (
        list.map(renderRow)
      )}
    </>
  );

  return (
    <>
      <PageHeader
        title={data.budget.name}
        description={`Budget for the financial year from ${fmt.date(data.budget.fiscal_year_start)}, in ${currency}. Amounts are for the account's natural direction: income and expenses as positive numbers.`}
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link to="/budgets">All budgets</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link
                to="/reports/$reportId"
                params={{ reportId: "budget-vs-actual" }}
                search={{ budget: data.budget.id }}
              >
                Budget versus Actual
              </Link>
            </Button>
          </>
        }
      />

      {!canManage ? (
        <Alert className="mb-4">
          <AlertDescription>
            You can view this budget but not change it. Budgets are managed by owners,
            administrators and accountants.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="budget-title">Name</Label>
          <Input
            id="budget-title"
            className="w-56"
            value={name}
            maxLength={120}
            disabled={!canManage}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="budget-add">Add account</Label>
          <div className="flex gap-2">
            <AccountLookup
              id="budget-add"
              className="w-64"
              ariaLabel="Add account"
              accounts={available.map((a) => ({
                id: a.id,
                code: a.code,
                name: a.name,
                account_type: a.kind,
                is_active: true,
                is_postable: true,
              }))}
              value={addId}
              onChange={setAddId}
              companyId={companyId}
              purpose="posting"
              placeholder="Choose an income or expense account"
              allowClear
              disabled={!canManage}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!addId || !canManage}
              onClick={() => {
                update({ ...cells, [addId]: Array.from({ length: 12 }, () => "") });
                setAddId("");
              }}
            >
              <Plus className="mr-1 size-4" /> Add
            </Button>
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="budget-uplift">Uplift %</Label>
          <div className="flex gap-2">
            <Input
              id="budget-uplift"
              className="w-24"
              inputMode="decimal"
              placeholder="5"
              value={uplift}
              disabled={!canManage}
              onChange={(e) => setUplift(e.target.value)}
            />
            <Button size="sm" variant="outline" disabled={!canManage} onClick={onUplift}>
              Apply to all
            </Button>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={!canManage}
          onClick={() => void onCopyActuals()}
        >
          Copy last year's actuals
        </Button>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={onExport}>
            <Download className="mr-1 size-4" /> Export CSV
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canManage}
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="mr-1 size-4" /> Import CSV
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void onImport(f);
            }}
          />
          <Button
            size="sm"
            disabled={!canManage || !dirty || save.isPending || invalidCount > 0}
            onClick={() => save.mutate()}
          >
            {save.isPending ? (
              <Loader2 className="mr-1 size-4 animate-spin" />
            ) : (
              <Save className="mr-1 size-4" />
            )}
            Save budget
          </Button>
        </div>
      </div>

      {invalidCount > 0 ? (
        <Alert variant="destructive" className="mb-3">
          <AlertDescription>
            {invalidCount} amount{invalidCount === 1 ? " is" : "s are"} not a valid number. Fix the
            highlighted cells before saving.
          </AlertDescription>
        </Alert>
      ) : null}
      {issues.length > 0 ? (
        <Alert variant="destructive" className="mb-3">
          <AlertDescription>
            <p className="font-medium">Import problems</p>
            <ul className="list-disc pl-5">
              {issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {dirty ? (
        <p className="mb-2 text-xs text-muted-foreground">You have unsaved changes.</p>
      ) : null}

      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 bg-background">Account</TableHead>
              {data.months.map((m) => (
                <TableHead key={m} className="text-right">
                  {monthLabel(m)}
                </TableHead>
              ))}
              <TableHead className="text-right">Year</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {section("Income", income)}
            {totalRow("Total income", incomeTotals)}
            {section("Expenses", expense)}
            {totalRow("Total expenses", expenseTotals)}
            {totalRow(
              "Budgeted net profit",
              incomeTotals.map((v, i) => v - (expenseTotals[i] ?? 0)),
              true,
            )}
          </TableBody>
        </Table>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Tip: type in a month, then press “Fill right” to repeat it in later months. Editing the Year
        total spreads it evenly (any rounding remainder goes into the last month). Importing a CSV
        replaces the rows it contains; accounts not in the file keep their amounts.
      </p>
    </>
  );
}
