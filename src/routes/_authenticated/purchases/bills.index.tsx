import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Columns3,
  Download,
  Eye,
  FileText,
  HelpCircle,
  Loader2,
  Paperclip,
  Plus,
  Search,
  Settings2,
} from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  authoriseBill,
  exportBillsCsv,
  getBillsWorkspaceSummary,
  listBills,
  listRecurringBills,
  setRecurringBillActive,
  submitBillForApproval,
  type BillsWorkspaceTab,
} from "@/lib/purchases/purchases.functions";
import {
  DEFAULT_BILLS_LIST_PREFS,
  getBillsListPrefs,
  saveBillsListPrefs,
  type BillsListColumnId,
  type BillsListWorkspacePrefs,
} from "@/lib/settings/ui-preferences.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { useCan } from "@/hooks/use-can";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { cn } from "@/lib/utils";
import { LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type BillsSearch = {
  tab?: BillsWorkspaceTab;
  q?: string;
  from?: string;
  to?: string;
  dateField?: "bill_date" | "due_date";
  includeVoid?: boolean;
  overdueOnly?: boolean;
  status?: string;
  page?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
};

const TABS: Array<{ id: BillsWorkspaceTab; label: string; countKey: keyof Counts }> = [
  { id: "all", label: "All Bills", countKey: "all" },
  { id: "drafts", label: "Drafts", countKey: "drafts" },
  { id: "for_approval", label: "For Approval", countKey: "for_approval" },
  { id: "to_pay", label: "To Pay", countKey: "to_pay" },
  { id: "paid", label: "Paid", countKey: "paid" },
  { id: "recurring", label: "Recurring", countKey: "recurring" },
];

type Counts = {
  all: number;
  drafts: number;
  for_approval: number;
  to_pay: number;
  paid: number;
  recurring: number;
};

type BillRow = {
  id: string;
  bill_number: string | null;
  supplier_invoice_number: string | null;
  display_reference: string | null;
  bill_date: string;
  due_date: string;
  status: string;
  total_minor: number;
  tax_minor: number;
  amount_paid_minor: number;
  amount_credited_minor: number;
  balance_due_minor: number;
  document_total_minor: number;
  currency_code: string;
  contact_id: string;
  memo: string | null;
  posted_journal_id: string | null;
  fx_rate_to_base: number | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  contacts: { id: string; name: string; account_number: string | null } | null;
  attachment_count: number;
  days_overdue: number;
};

const COLUMN_LABELS: Record<BillsListColumnId, string> = {
  select: "Select",
  supplier: "Supplier",
  reference: "Bill / invoice #",
  bill_date: "Bill date",
  due_date: "Due date",
  status: "Status",
  total: "Total",
  paid: "Paid",
  balance: "Balance due",
  attachments: "Attachments",
  actions: "Actions",
  account_number: "Supplier account #",
  bill_number: "Internal bill #",
  supplier_invoice: "Supplier invoice #",
  approval_status: "Approval status",
  payment_status: "Payment status",
  days_overdue: "Days overdue",
  currency: "Currency",
  exchange_rate: "Exchange rate",
  tax: "Tax",
  credited: "Credited",
  created_at: "Created",
  updated_at: "Last modified",
};

const OPTIONAL_COLUMNS: BillsListColumnId[] = [
  "account_number",
  "bill_number",
  "supplier_invoice",
  "approval_status",
  "payment_status",
  "days_overdue",
  "currency",
  "exchange_rate",
  "tax",
  "credited",
  "created_at",
  "updated_at",
];

const PAGE_SIZE = 50;

export const Route = createFileRoute("/_authenticated/purchases/bills/")({
  validateSearch: (s: Record<string, unknown>): BillsSearch => {
    const tabRaw = typeof s["tab"] === "string" ? s["tab"] : "all";
    const tab = (
      ["all", "drafts", "for_approval", "to_pay", "paid", "recurring"].includes(tabRaw)
        ? tabRaw
        : "all"
    ) as BillsWorkspaceTab;
    const out: BillsSearch = { tab };
    if (typeof s["q"] === "string" && s["q"]) out.q = s["q"];
    if (typeof s["from"] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s["from"])) out.from = s["from"];
    if (typeof s["to"] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s["to"])) out.to = s["to"];
    if (s["dateField"] === "due_date" || s["dateField"] === "bill_date") out.dateField = s["dateField"];
    if (s["includeVoid"] === true || s["includeVoid"] === "1" || s["includeVoid"] === "true") {
      out.includeVoid = true;
    }
    if (s["overdueOnly"] === true || s["overdueOnly"] === "1" || s["overdueOnly"] === "true") {
      out.overdueOnly = true;
    }
    if (typeof s["status"] === "string" && s["status"]) out.status = s["status"];
    if (typeof s["page"] === "number" && Number.isFinite(s["page"])) out.page = Math.max(0, s["page"]);
    if (typeof s["page"] === "string" && /^\d+$/.test(s["page"])) out.page = Math.max(0, Number(s["page"]));
    if (typeof s["sortBy"] === "string" && s["sortBy"]) out.sortBy = s["sortBy"];
    if (s["sortDir"] === "asc" || s["sortDir"] === "desc") out.sortDir = s["sortDir"];
    return out;
  },
  head: () => ({ meta: [{ title: "Bills — LinkBooks" }] }),
  component: BillsWorkspace,
});

function statusLabel(status: string) {
  return status.replace(/_/g, " ");
}

function paymentStatusOf(b: BillRow) {
  if (b.status === "draft" || b.status === "awaiting_approval") return "Unposted";
  if (b.status === "paid") return "Paid";
  if (b.status === "partly_paid") return "Partly paid";
  if (b.status === "void") return "Void";
  if (b.balance_due_minor > 0) return "Outstanding";
  return "Settled";
}

function approvalStatusOf(b: BillRow) {
  if (b.status === "awaiting_approval") return "Awaiting approval";
  if (b.status === "draft") return "Not submitted";
  if (b.status === "void") return "—";
  return "Approved / authorised";
}

function BillsWorkspace() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const baseCurrency = company?.base_currency ?? "GBP";
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const qc = useQueryClient();

  const tab = search.tab ?? "all";
  const page = search.page ?? 0;
  const q = search.q ?? "";
  const fromDate = search.from ?? "";
  const toDate = search.to ?? "";
  const dateField = search.dateField ?? "bill_date";
  const includeVoid = Boolean(search.includeVoid);
  const overdueOnly = Boolean(search.overdueOnly);
  const statusFilter = search.status ?? "";
  const sortBy = search.sortBy ?? "bill_date";
  const sortDir = search.sortDir ?? "desc";

  const [searchDraft, setSearchDraft] = useState(q);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [prefs, setPrefs] = useState<BillsListWorkspacePrefs>(DEFAULT_BILLS_LIST_PREFS);

  const fetchBills = useServerFn(listBills);
  const fetchSummary = useServerFn(getBillsWorkspaceSummary);
  const fetchRecurring = useServerFn(listRecurringBills);
  const fetchPrefs = useServerFn(getBillsListPrefs);
  const persistPrefs = useServerFn(saveBillsListPrefs);
  const doAuthorise = useServerFn(authoriseBill);
  const doExport = useServerFn(exportBillsCsv);
  const { can } = useCan();
  const doSubmit = useServerFn(submitBillForApproval);
  const doSetRecurring = useServerFn(setRecurringBillActive);

  useEffect(() => {
    setSearchDraft(q);
  }, [q]);

  // A selection must never survive a change of tab / filter / page, or bulk actions would hit
  // bills the user can no longer see (P-20).
  const filterKey = [
    tab,
    q,
    fromDate,
    toDate,
    dateField,
    includeVoid,
    overdueOnly,
    statusFilter,
    page,
  ].join("|");
  const lastFilterKey = useRef(filterKey);
  useEffect(() => {
    if (lastFilterKey.current !== filterKey) {
      lastFilterKey.current = filterKey;
      setSelected(new Set());
    }
  }, [filterKey]);

  const prefsQ = useQuery({
    queryKey: ["bills-list-prefs", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchPrefs({ data: { companyId: companyId! } }),
  });
  useEffect(() => {
    if (prefsQ.data) setPrefs(prefsQ.data);
  }, [prefsQ.data]);

  const summaryQ = useQuery({
    queryKey: ["bills-workspace-summary", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchSummary({ data: { companyId: companyId! } }),
  });

  const billsQ = useQuery({
    queryKey: [
      "bills",
      companyId,
      tab,
      q,
      fromDate,
      toDate,
      dateField,
      includeVoid,
      overdueOnly,
      statusFilter,
      page,
      sortBy,
      sortDir,
    ],
    enabled: Boolean(companyId) && tab !== "recurring",
    queryFn: () =>
      fetchBills({
        data: {
          companyId: companyId!,
          tab,
          ...(q ? { q } : {}),
          ...(fromDate ? { fromDate } : {}),
          ...(toDate ? { toDate } : {}),
          dateField,
          includeVoid,
          overdueOnly,
          ...(statusFilter ? { status: statusFilter } : {}),
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
          sortBy,
          sortDir,
        },
      }),
  });

  const recurringQ = useQuery({
    queryKey: ["recurring", companyId],
    enabled: Boolean(companyId) && tab === "recurring",
    queryFn: () => fetchRecurring({ data: { companyId: companyId! } }),
  });

  const patchSearch = (patch: Record<string, string | number | boolean | undefined>) => {
    void navigate({
      search: (prev) => {
        const next: BillsSearch = { ...prev };
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) {
            delete (next as Record<string, unknown>)[key];
          } else {
            (next as Record<string, unknown>)[key] = value;
          }
        }
        if (patch["tab"] !== undefined && patch["page"] === undefined) next.page = 0;
        return next;
      },
    });
  };

  const savePrefsM = useMutation({
    mutationFn: (partial: Partial<BillsListWorkspacePrefs>) =>
      persistPrefs({ data: { companyId: companyId!, prefs: partial } }),
    onSuccess: (next) => {
      setPrefs(next);
      void qc.invalidateQueries({ queryKey: ["bills-list-prefs", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const invalidateBills = async () => {
    await qc.invalidateQueries({ queryKey: ["bills", companyId] });
    await qc.invalidateQueries({ queryKey: ["bills-workspace-summary", companyId] });
  };

  /** Run an action per bill; one failure does not stop the others and each result is reported. */
  const runBulk = async (
    ids: string[],
    action: (billId: string) => Promise<unknown>,
    verb: string,
  ) => {
    const failed: Array<{ id: string; message: string }> = [];
    let ok = 0;
    for (const billId of ids) {
      try {
        await action(billId);
        ok += 1;
      } catch (e) {
        failed.push({ id: billId, message: friendlyAuthError(e) });
      }
    }
    await invalidateBills();
    // Keep only the bills that failed selected so they can be retried.
    setSelected(new Set(failed.map((f) => f.id)));
    const label = (id: string) => {
      const row = rows.find((r) => r.id === id);
      return row?.display_reference || row?.contacts?.name || id.slice(0, 8);
    };
    if (ok > 0) toast.success(`${ok} bill${ok === 1 ? "" : "s"} ${verb}`);
    for (const f of failed.slice(0, 5)) toast.error(`${label(f.id)}: ${f.message}`);
    if (failed.length > 5) toast.error(`${failed.length - 5} more bills failed`);
  };

  const bulkAuthoriseM = useMutation({
    mutationFn: (ids: string[]) =>
      runBulk(
        ids,
        (billId) => doAuthorise({ data: { companyId: companyId!, billId } }),
        "authorised",
      ),
  });

  const bulkSubmitM = useMutation({
    mutationFn: (ids: string[]) =>
      runBulk(
        ids,
        (billId) => doSubmit({ data: { companyId: companyId!, billId } }),
        "submitted for approval",
      ),
  });

  const rows = (billsQ.data?.rows ?? []) as BillRow[];
  const totalCount = billsQ.data?.totalCount ?? 0;
  const counts: Counts = summaryQ.data?.counts ?? {
    all: 0,
    drafts: 0,
    for_approval: 0,
    to_pay: 0,
    paid: 0,
    recurring: 0,
  };

  const visibleCols = useMemo(() => {
    const order = prefs.columnOrder.length ? prefs.columnOrder : DEFAULT_BILLS_LIST_PREFS.columnOrder;
    const visible = new Set(prefs.visibleColumns.filter((c) => c !== "actions"));
    return order.filter((c) => c !== "actions" && visible.has(c));
  }, [prefs]);

  const openBill = (b: BillRow, opts?: { files?: boolean }) => {
    void navigate({
      to: "/purchases/bills/$billId",
      params: { billId: b.id },
      search: {
        ...(tab !== "all" ? { fromTab: tab } : {}),
        ...(opts?.files ? { files: true } : {}),
      },
    });
  };

  // Page totals per currency - different currencies are never added together (P-21).
  const pageTotals = useMemo(() => {
    const byCurrency = new Map<string, { total: number; balance: number }>();
    for (const b of rows) {
      const cur = (b.currency_code || baseCurrency).toUpperCase();
      const entry = byCurrency.get(cur) ?? { total: 0, balance: 0 };
      entry.total += b.document_total_minor;
      entry.balance += b.balance_due_minor;
      byCurrency.set(cur, entry);
    }
    return [...byCurrency.entries()].map(([currency, v]) => ({ currency, ...v }));
  }, [rows, baseCurrency]);

  const toggleColumn = (col: BillsListColumnId) => {
    const essential: BillsListColumnId[] = ["supplier", "reference", "status"];
    if (essential.includes(col) && prefs.visibleColumns.includes(col)) {
      toast.message("Keep essential columns visible");
      return;
    }
    const next = prefs.visibleColumns.includes(col)
      ? prefs.visibleColumns.filter((c) => c !== col)
      : [...prefs.visibleColumns, col];
    setPrefs((p) => ({ ...p, visibleColumns: next }));
    savePrefsM.mutate({ visibleColumns: next });
  };

  // Export every bill that matches the current filters, not just the visible page (P-23).
  const exportM = useMutation({
    mutationFn: () =>
      doExport({
        data: {
          companyId: companyId!,
          tab,
          ...(q ? { q } : {}),
          ...(fromDate ? { fromDate } : {}),
          ...(toDate ? { toDate } : {}),
          dateField,
          includeVoid,
          overdueOnly,
          ...(statusFilter ? { status: statusFilter } : {}),
          sortBy,
          sortDir,
        },
      }),
    onSuccess: (result) => {
      const blob = new Blob([result.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `bills-${tab}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(
        result.truncated
          ? `Exported the first ${result.rowCount} of ${result.totalCount} bills - narrow the filters to export the rest`
          : `Exported ${result.rowCount} bill${result.rowCount === 1 ? "" : "s"}`,
      );
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) {
    return <EmptyState title="No organisation" description="Select a company to manage bills." />;
  }

  const densityClass = prefs.density === "compact" ? "text-xs [&_td]:py-1.5 [&_th]:py-1.5" : "";

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* A. Workspace header */}
        <header className="rounded-xl border border-border/80 bg-gradient-to-br from-background via-background to-muted/40 p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2">
                <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">
                  Bills
                </h1>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground"
                      aria-label="Bills help"
                      onClick={() => setShowHelp((v) => !v)}
                    >
                      <HelpCircle className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Workspace help</TooltipContent>
                </Tooltip>
              </div>
              <p className="max-w-xl text-sm text-muted-foreground">
                Manage supplier bills from draft through payment. Authorising posts Accounts Payable
                through the shared ledger — drafts never inflate posted AP.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" disabled title="Document capture is not configured">
                Capture
              </Button>
              <Button variant="outline" size="sm" disabled title="CSV import for bills is not configured">
                Import
              </Button>
              <Button size="sm" asChild>
                <Link to="/purchases/bills/new">
                  <Plus className="mr-1 size-4" />
                  New Bill
                </Link>
              </Button>
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <SummaryChip
              label="Outstanding AP"
              value={fromMinorUnits(BigInt(summaryQ.data?.outstandingMinor ?? 0), baseCurrency)}
              hint={otherCurrencyHint(summaryQ.data?.totalsByCurrency, summaryQ.data?.baseCurrency ?? baseCurrency, "outstandingMinor", "Authorised & partly paid balances")}
            />
            <SummaryChip
              label="Overdue"
              value={fromMinorUnits(BigInt(summaryQ.data?.overdueMinor ?? 0), baseCurrency)}
              hint={otherCurrencyHint(summaryQ.data?.totalsByCurrency, summaryQ.data?.baseCurrency ?? baseCurrency, "overdueMinor", "Past due with remaining balance")}
              tone="warn"
            />
            <SummaryChip
              label="Approval queue"
              value={String(summaryQ.data?.approvalQueue ?? 0)}
              hint="Bills awaiting approval"
            />
          </div>

          {showHelp ? (
            <Alert className="mt-4">
              <AlertTitle>How this workspace works</AlertTitle>
              <AlertDescription className="space-y-1 text-sm">
                <p>
                  Tabs filter by workflow. Click a supplier name or bill reference to open the full
                  document at <code className="text-xs">/purchases/bills/[id]</code>.
                </p>
                <p>
                  Invoice # shows the supplier invoice number when present; otherwise the internal
                  bill number. Empty supplier invoice numbers are not invented.
                </p>
              </AlertDescription>
            </Alert>
          ) : null}
        </header>

        {/* B. Workflow tabs */}
        <nav
          className="flex gap-1 overflow-x-auto rounded-lg border border-border bg-muted/30 p-1"
          aria-label="Bill workflow"
        >
          {TABS.map((t) => {
            const active = tab === t.id;
            const count = counts[t.countKey];
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => patchSearch({ tab: t.id, page: 0 })}
                className={cn(
                  "inline-flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                )}
                aria-current={active ? "page" : undefined}
              >
                {t.label}
                <span
                  className={cn(
                    "rounded-md px-1.5 py-0.5 text-xs tabular-nums",
                    active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </nav>

        {/* C. Filters + table (or recurring) */}
        {tab === "recurring" ? (
          <RecurringPane
            loading={recurringQ.isPending}
            error={recurringQ.error}
            onRetry={() => recurringQ.refetch()}
            rows={(recurringQ.data ?? []) as RecurringRow[]}
            currency={baseCurrency}
            onToggleActive={(id, isActive) =>
              doSetRecurring({ data: { companyId, recurringId: id, isActive } }).then(async () => {
                await qc.invalidateQueries({ queryKey: ["recurring", companyId] });
                await qc.invalidateQueries({ queryKey: ["bills-workspace-summary", companyId] });
                toast.success(isActive ? "Resumed" : "Paused");
              })
            }
          />
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border/70 bg-background p-3">
              <div className="min-w-[12rem] flex-1 space-y-1">
                <Label htmlFor="bills-search" className="text-xs text-muted-foreground">
                  Search
                </Label>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                  <Input
                    id="bills-search"
                    className="pl-8"
                    placeholder="Supplier invoice #, bill #, memo…"
                    value={searchDraft}
                    onChange={(e) => setSearchDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        patchSearch(searchDraft ? { q: searchDraft, page: 0 } : { page: 0, q: undefined });
                      }
                    }}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Date type</Label>
                <Select
                  value={dateField}
                  onValueChange={(v) =>
                    patchSearch({ dateField: v as "bill_date" | "due_date", page: 0 })
                  }
                >
                  <SelectTrigger className="w-[140px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bill_date">Bill date</SelectItem>
                    <SelectItem value="due_date">Due date</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">From</Label>
                <Input
                  type="date"
                  className="w-[140px]"
                  value={fromDate}
                  onChange={(e) =>
                    patchSearch(
                      e.target.value ? { from: e.target.value, page: 0 } : { page: 0, from: undefined },
                    )
                  }
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">To</Label>
                <Input
                  type="date"
                  className="w-[140px]"
                  value={toDate}
                  onChange={(e) =>
                    patchSearch(
                      e.target.value ? { to: e.target.value, page: 0 } : { page: 0, to: undefined },
                    )
                  }
                />
              </div>
              {tab === "all" ? (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Status</Label>
                  <Select
                    value={statusFilter || "all"}
                    onValueChange={(v) =>
                      patchSearch(
                        v === "all" ? { page: 0, status: undefined } : { status: v, page: 0 },
                      )
                    }
                  >
                    <SelectTrigger className="w-[150px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="draft">Draft</SelectItem>
                      <SelectItem value="awaiting_approval">Awaiting approval</SelectItem>
                      <SelectItem value="authorised">Authorised</SelectItem>
                      <SelectItem value="partly_paid">Partly paid</SelectItem>
                      <SelectItem value="paid">Paid</SelectItem>
                      <SelectItem value="void">Void</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-2 pb-0.5">
                <Button
                  size="sm"
                  onClick={() =>
                    patchSearch(searchDraft ? { q: searchDraft, page: 0 } : { page: 0, q: undefined })
                  }
                >
                  Apply
                </Button>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox
                    checked={includeVoid}
                    onCheckedChange={(c) =>
                      patchSearch(
                        c === true
                          ? { includeVoid: true, page: 0 }
                          : { page: 0, includeVoid: undefined },
                      )
                    }
                  />
                  Include voided
                </label>
                {(tab === "to_pay" || tab === "all") && (
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={overdueOnly}
                      onCheckedChange={(c) =>
                        patchSearch(
                          c === true
                            ? { overdueOnly: true, page: 0 }
                            : { page: 0, overdueOnly: undefined },
                        )
                      }
                    />
                    Overdue only
                  </label>
                )}
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-1">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm">
                      <Columns3 className="mr-1 size-4" />
                      Columns
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuLabel>Show columns</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {OPTIONAL_COLUMNS.map((col) => (
                      <DropdownMenuCheckboxItem
                        key={col}
                        checked={prefs.visibleColumns.includes(col)}
                        onCheckedChange={() => toggleColumn(col)}
                      >
                        {COLUMN_LABELS[col]}
                      </DropdownMenuCheckboxItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => {
                        setPrefs(DEFAULT_BILLS_LIST_PREFS);
                        savePrefsM.mutate(DEFAULT_BILLS_LIST_PREFS);
                      }}
                    >
                      Reset defaults
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm">
                      <Settings2 className="mr-1 size-4" />
                      Density
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => {
                        setPrefs((p) => ({ ...p, density: "comfortable" }));
                        savePrefsM.mutate({ density: "comfortable" });
                      }}
                    >
                      Comfortable
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        setPrefs((p) => ({ ...p, density: "compact" }));
                        savePrefsM.mutate({ density: "compact" });
                      }}
                    >
                      Compact
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => exportM.mutate()}
                  disabled={!rows.length || exportM.isPending}
                >
                  <Download className="mr-1 size-4" />
                  Export
                </Button>
              </div>
            </div>

            {selected.size > 0 ? (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm">
                <span className="font-medium">{selected.size} selected</span>
                {tab === "drafts" || tab === "all" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={bulkSubmitM.isPending || !can("purchases.draft")}
                    onClick={() => bulkSubmitM.mutate([...selected])}
                  >
                    Submit for approval
                  </Button>
                ) : null}
                {(tab === "drafts" || tab === "for_approval" || tab === "all") && (
                  <Button
                    size="sm"
                    disabled={bulkAuthoriseM.isPending || !can("purchases.authorise")}
                    title={
                      can("purchases.authorise")
                        ? undefined
                        : "You do not have permission to authorise bills"
                    }
                    onClick={() => bulkAuthoriseM.mutate([...selected])}
                  >
                    {bulkAuthoriseM.isPending ? (
                      <Loader2 className="mr-1 size-4 animate-spin" />
                    ) : null}
                    Authorise
                  </Button>
                )}
                {tab === "to_pay" ? (
                  <Button size="sm" variant="outline" asChild>
                    <Link to="/purchases/payments/new">Prepare payment</Link>
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
              <span>
                {billsQ.isPending
                  ? "Loading…"
                  : `${totalCount} bill${totalCount === 1 ? "" : "s"}`}
                {!billsQ.isPending && rows.length > 0 ? (
                  <>
                    {" · "}
                    {pageTotals.map((t, i) => (
                      <span key={t.currency}>
                        {i > 0 ? " · " : ""}
                        Page total {fromMinorUnits(BigInt(t.total), t.currency)} {t.currency}
                        {" · "}
                        Balance {fromMinorUnits(BigInt(t.balance), t.currency)} {t.currency}
                      </span>
                    ))}
                  </>
                ) : null}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 0}
                  onClick={() => patchSearch({ page: Math.max(0, page - 1) })}
                >
                  Previous
                </Button>
                <span className="tabular-nums">
                  Page {page + 1}
                  {totalCount ? ` / ${Math.max(1, Math.ceil(totalCount / PAGE_SIZE))}` : ""}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={(page + 1) * PAGE_SIZE >= totalCount}
                  onClick={() => patchSearch({ page: page + 1 })}
                >
                  Next
                </Button>
              </div>
            </div>

            {billsQ.isPending ? (
              <LoadingState />
            ) : billsQ.isError ? (
              <ErrorState
                title="Could not load bills"
                description={friendlyAuthError(billsQ.error)}
                onRetry={() => billsQ.refetch()}
              />
            ) : rows.length === 0 ? (
              <EmptyState
                title="No bills in this view"
                description="Adjust filters or create a new supplier bill."
                actionLabel="New bill"
              />
            ) : (
              <div className={cn("overflow-x-auto rounded-lg border border-border", densityClass)}>
                <Table>
                  <TableHeader>
                    <TableRow>
                      {visibleCols.map((col) => (
                        <TableHead
                          key={col}
                          className={cn(
                            ["total", "paid", "balance", "tax", "credited"].includes(col) &&
                              "text-right",
                            col === "select" && "w-10",
                            col === "actions" && "w-[1%] whitespace-nowrap",
                          )}
                        >
                          {col === "select" ? (
                            <Checkbox
                              aria-label="Select all on page"
                              checked={rows.length > 0 && rows.every((r) => selected.has(r.id))}
                              onCheckedChange={(c) => {
                                if (c === true) setSelected(new Set(rows.map((r) => r.id)));
                                else setSelected(new Set());
                              }}
                            />
                          ) : col === "bill_date" || col === "due_date" || col === "total" || col === "status" ? (
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 hover:underline"
                              onClick={() => {
                                const key =
                                  col === "total" ? "total_minor" : col === "status" ? "status" : col;
                                patchSearch({
                                  sortBy: key,
                                  sortDir: sortBy === key && sortDir === "desc" ? "asc" : "desc",
                                });
                              }}
                            >
                              {COLUMN_LABELS[col]}
                            </button>
                          ) : (
                            COLUMN_LABELS[col]
                          )}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((b) => {
                      const cur = b.currency_code || baseCurrency;
                      return (
                        <TableRow
                          key={b.id}
                          role="link"
                          tabIndex={0}
                          className={cn(
                            selected.has(b.id) && "bg-muted/40",
                            "group cursor-pointer hover:bg-muted/50",
                          )}
                          data-state={selected.has(b.id) ? "selected" : undefined}
                          onClick={() => openBill(b)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              openBill(b);
                            }
                          }}
                        >
                          {visibleCols.map((col) => {
                            switch (col) {
                              case "select":
                                return (
                                  <TableCell
                                    key={col}
                                    onClick={(e) => e.stopPropagation()}
                                    onKeyDown={(e) => e.stopPropagation()}
                                  >
                                    <div className="flex items-center gap-1">
                                      <Checkbox
                                        aria-label={`Select bill ${b.display_reference ?? b.id}`}
                                        checked={selected.has(b.id)}
                                        onCheckedChange={(c) => {
                                          setSelected((prev) => {
                                            const next = new Set(prev);
                                            if (c === true) next.add(b.id);
                                            else next.delete(b.id);
                                            return next;
                                          });
                                        }}
                                      />
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="size-7 opacity-0 group-hover:opacity-100 focus:opacity-100"
                                        aria-label="Quick preview"
                                        onClick={() => setPreviewId(b.id)}
                                      >
                                        <Eye className="size-3.5" />
                                      </Button>
                                    </div>
                                  </TableCell>
                                );
                              case "supplier":
                                return (
                                  <TableCell key={col}>
                                    <span className="font-medium text-foreground underline-offset-2 group-hover:underline">
                                      {b.contacts?.name ?? "—"}
                                    </span>
                                  </TableCell>
                                );
                              case "reference":
                                return (
                                  <TableCell key={col}>
                                    <span className="font-mono text-sm underline-offset-2 group-hover:underline">
                                      {b.display_reference ?? "—"}
                                    </span>
                                    {!b.supplier_invoice_number && b.bill_number ? (
                                      <span className="mt-0.5 block text-[11px] text-muted-foreground">
                                        Internal · no supplier invoice #
                                      </span>
                                    ) : null}
                                  </TableCell>
                                );
                              case "bill_date":
                                return <TableCell key={col}>{b.bill_date}</TableCell>;
                              case "due_date":
                                return (
                                  <TableCell key={col}>
                                    <span
                                      className={cn(
                                        b.days_overdue > 0 && "font-medium text-amber-700 dark:text-amber-400",
                                      )}
                                    >
                                      {b.due_date || "—"}
                                    </span>
                                  </TableCell>
                                );
                              case "status":
                                return (
                                  <TableCell key={col}>
                                    <Badge variant="outline" className="capitalize">
                                      {statusLabel(b.status)}
                                    </Badge>
                                  </TableCell>
                                );
                              case "total":
                                return (
                                  <TableCell key={col} className="text-right tabular-nums">
                                    {fromMinorUnits(BigInt(b.document_total_minor), cur)}
                                  </TableCell>
                                );
                              case "paid":
                                return (
                                  <TableCell key={col} className="text-right tabular-nums">
                                    {fromMinorUnits(BigInt(b.amount_paid_minor), cur)}
                                  </TableCell>
                                );
                              case "balance":
                                return (
                                  <TableCell key={col} className="text-right tabular-nums">
                                    {b.status === "draft" || b.status === "awaiting_approval" ? (
                                      <span className="text-muted-foreground" title="Unposted — not AP">
                                        —
                                      </span>
                                    ) : (
                                      fromMinorUnits(BigInt(b.balance_due_minor), cur)
                                    )}
                                  </TableCell>
                                );
                              case "attachments":
                                return (
                                  <TableCell
                                    key={col}
                                    onClick={(e) => {
                                      if (b.attachment_count > 0) {
                                        e.stopPropagation();
                                        openBill(b, { files: true });
                                      }
                                    }}
                                  >
                                    {b.attachment_count > 0 ? (
                                      <span className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline">
                                        <Paperclip className="size-3.5" />
                                        {b.attachment_count}
                                      </span>
                                    ) : (
                                      "—"
                                    )}
                                  </TableCell>
                                );
                              case "account_number":
                                return (
                                  <TableCell key={col}>{b.contacts?.account_number ?? "—"}</TableCell>
                                );
                              case "bill_number":
                                return (
                                  <TableCell key={col} className="font-mono text-xs">
                                    {b.bill_number ?? "—"}
                                  </TableCell>
                                );
                              case "supplier_invoice":
                                return (
                                  <TableCell key={col}>{b.supplier_invoice_number ?? "—"}</TableCell>
                                );
                              case "approval_status":
                                return <TableCell key={col}>{approvalStatusOf(b)}</TableCell>;
                              case "payment_status":
                                return <TableCell key={col}>{paymentStatusOf(b)}</TableCell>;
                              case "days_overdue":
                                return (
                                  <TableCell key={col} className="tabular-nums">
                                    {b.days_overdue || "—"}
                                  </TableCell>
                                );
                              case "currency":
                                return <TableCell key={col}>{cur}</TableCell>;
                              case "exchange_rate":
                                return (
                                  <TableCell key={col} className="tabular-nums">
                                    {b.fx_rate_to_base != null ? Number(b.fx_rate_to_base).toFixed(6) : "—"}
                                  </TableCell>
                                );
                              case "tax":
                                return (
                                  <TableCell key={col} className="text-right tabular-nums">
                                    {fromMinorUnits(BigInt(b.tax_minor), cur)}
                                  </TableCell>
                                );
                              case "credited":
                                return (
                                  <TableCell key={col} className="text-right tabular-nums">
                                    {fromMinorUnits(BigInt(b.amount_credited_minor), cur)}
                                  </TableCell>
                                );
                              case "created_at":
                                return (
                                  <TableCell key={col}>{b.created_at?.slice(0, 10) ?? "—"}</TableCell>
                                );
                              case "updated_at":
                                return (
                                  <TableCell key={col}>{b.updated_at?.slice(0, 10) ?? "—"}</TableCell>
                                );
                              default:
                                return <TableCell key={col}>—</TableCell>;
                            }
                          })}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}

        <Sheet open={Boolean(previewId)} onOpenChange={(o) => !o && setPreviewId(null)}>
          <SheetContent className="sm:max-w-md">
            <SheetHeader>
              <SheetTitle>Quick preview</SheetTitle>
              <SheetDescription>
                Summary only — open the full document for editing and history.
              </SheetDescription>
            </SheetHeader>
            {previewId ? (
              <PreviewBody
                bill={rows.find((r) => r.id === previewId) ?? null}
                currency={baseCurrency}
                tab={tab}
              />
            ) : null}
          </SheetContent>
        </Sheet>
      </div>
    </TooltipProvider>
  );
}

/** "Base currency only" hint plus any other-currency balances, never summed together. */
function otherCurrencyHint(
  totals: Array<{ currency: string; outstandingMinor: number; overdueMinor: number }> | undefined,
  base: string,
  field: "outstandingMinor" | "overdueMinor",
  fallback: string,
): string {
  const others = (totals ?? []).filter((t) => t.currency !== base.toUpperCase() && t[field] > 0);
  if (!others.length) return `${fallback} (${base})`;
  return `${fallback} (${base}). Also ${others
    .map((t) => `${fromMinorUnits(BigInt(t[field]), t.currency)} ${t.currency}`)
    .join(", ")}`;
}

function csv(v: string) {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function SummaryChip({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "warn";
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/80 px-3 py-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-0.5 text-lg font-semibold tabular-nums",
          tone === "warn" && "text-amber-700 dark:text-amber-400",
        )}
      >
        {value}
      </p>
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}

function PreviewBody({
  bill,
  currency,
  tab,
}: {
  bill: BillRow | null;
  currency: string;
  tab: BillsWorkspaceTab;
}) {
  if (!bill) {
    return <p className="mt-4 text-sm text-muted-foreground">Bill not on this page — open the full document.</p>;
  }
  const cur = bill.currency_code || currency;
  return (
    <div className="mt-4 space-y-3 text-sm">
      <div className="flex items-start gap-2">
        <FileText className="mt-0.5 size-4 text-muted-foreground" />
        <div>
          <p className="font-medium">{bill.contacts?.name ?? "Supplier"}</p>
          <p className="text-muted-foreground">
            {bill.display_reference ?? "No reference"} · {bill.bill_date}
          </p>
        </div>
      </div>
      <Badge variant="outline" className="capitalize">
        {statusLabel(bill.status)}
      </Badge>
      <dl className="grid grid-cols-2 gap-2">
        <div>
          <dt className="text-xs text-muted-foreground">Total</dt>
          <dd className="font-medium tabular-nums">
            {fromMinorUnits(BigInt(bill.document_total_minor), cur)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Balance due</dt>
          <dd className="font-medium tabular-nums">
            {bill.status === "draft" || bill.status === "awaiting_approval"
              ? "— (unposted)"
              : fromMinorUnits(BigInt(bill.balance_due_minor), cur)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Due</dt>
          <dd>{bill.due_date || "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Attachments</dt>
          <dd>{bill.attachment_count}</dd>
        </div>
      </dl>
      <Button
        className="w-full"
        onClick={() => {
          window.location.href = `/purchases/bills/${bill.id}${tab !== "all" ? `?fromTab=${tab}` : ""}`;
        }}
      >
        {bill.status === "draft" || bill.status === "awaiting_approval"
          ? "Open & edit"
          : "Open full document"}
      </Button>
    </div>
  );
}

type RecurringRow = {
  id: string;
  name: string;
  frequency: string;
  next_due_date: string;
  is_active: boolean;
  last_generated_on: string | null;
  contacts: { name: string } | null;
  template?: { total_minor?: number };
};

function RecurringPane({
  loading,
  error,
  onRetry,
  rows,
  currency,
  onToggleActive,
}: {
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  rows: RecurringRow[];
  currency: string;
  onToggleActive: (id: string, isActive: boolean) => Promise<unknown>;
}) {
  if (loading) return <LoadingState />;
  if (error) {
    return (
      <ErrorState
        title="Could not load recurring bills"
        description={friendlyAuthError(error)}
        onRetry={onRetry}
      />
    );
  }
  return (
    <div className="space-y-3">
      <Alert>
        <AlertTitle>Same recurring engine</AlertTitle>
        <AlertDescription>
          Templates below come from Purchases → Recurring. Manage schedules there for full create
          forms; pause/resume and open the module from this tab.
        </AlertDescription>
      </Alert>
      <div className="flex justify-end">
        <Button size="sm" variant="outline" asChild>
          <Link to="/purchases/recurring">Open Recurring module</Link>
        </Button>
      </div>
      {rows.length === 0 ? (
        <EmptyState
          title="No recurring templates"
          description="Create a recurring bill schedule in the Recurring module."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Supplier</TableHead>
                <TableHead>Template</TableHead>
                <TableHead>Frequency</TableHead>
                <TableHead>Next</TableHead>
                <TableHead>Last generated</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[1%]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.contacts?.name ?? "—"}</TableCell>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell className="capitalize">{r.frequency}</TableCell>
                  <TableCell>{r.next_due_date}</TableCell>
                  <TableCell>{r.last_generated_on ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{r.is_active ? "Active" : "Paused"}</Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void onToggleActive(r.id, !r.is_active).catch((e) =>
                          toast.error(friendlyAuthError(e)),
                        )
                      }
                    >
                      {r.is_active ? "Pause" : "Resume"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">Amounts use organisation currency ({currency}).</p>
    </div>
  );
}
