"use client";

import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  archiveChartAccount,
  copyChartAccounts,
  importChartAccounts,
  listChartAccounts,
  mergeChartAccounts,
  previewMergeChartAccounts,
  saveChartAccount,
  suggestChartAccount,
  type ChartAccount,
} from "@/lib/accounting/chart.functions";
import { kindSpec, type AccountKind } from "@/lib/accounting/account-kinds";
import {
  chartRowsToCsv,
  parseChartCsv,
  type ChartImportRow,
} from "@/lib/accounting/account-import";
import { saveAccountSchema } from "@/lib/accounting/account-schema";
import { signedBalance } from "@/lib/accounting/account-rules";
import { assessMergePlan } from "@/lib/accounting/account-merge";
import { fromMinorUnits } from "@/lib/accounting/money";
import { STARTER_CHARTS } from "@/lib/accounting/starter-charts";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { AccountForm } from "@/components/accounting/AccountForm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/states";

const ROW_HEIGHT = 44;

type ClassFilter = "all" | "asset" | "liability" | "equity" | "income" | "expense";

export function ChartAccountsPanel({
  companyId,
  currency,
}: {
  companyId: string;
  currency: string;
}) {
  const queryClient = useQueryClient();
  const { data: companies } = useActiveCompany();
  const fetchChart = useServerFn(listChartAccounts);
  const archive = useServerFn(archiveChartAccount);
  const merge = useServerFn(mergeChartAccounts);
  const previewMerge = useServerFn(previewMergeChartAccounts);
  const importRows = useServerFn(importChartAccounts);
  const copyChart = useServerFn(copyChartAccounts);
  const suggest = useServerFn(suggestChartAccount);
  const save = useServerFn(saveChartAccount);
  const chartQuery = useQuery({
    queryKey: ["chart-accounts", companyId],
    queryFn: () => fetchChart({ data: { companyId } }),
  });

  const [search, setSearch] = useState("");
  const [classFilter, setClassFilter] = useState<ClassFilter>("all");
  const [activeFilter, setActiveFilter] = useState<"active" | "archived" | "all">("active");
  const [balanceFilter, setBalanceFilter] = useState<"all" | "nonzero" | "zero">("all");
  const [mode, setMode] = useState<"tree" | "flat">("tree");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [editing, setEditing] = useState<ChartAccount | null>(null);
  const [creating, setCreating] = useState<{ kind?: AccountKind; name?: string } | null>(null);
  const [inline, setInline] = useState<{ id: string; name: string } | null>(null);
  const [mergeSource, setMergeSource] = useState<ChartAccount | null>(null);
  const [mergeTarget, setMergeTarget] = useState("");
  const [mergeLockedToday, setMergeLockedToday] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [parsedRows, setParsedRows] = useState<ChartImportRow[]>([]);
  const [parseIssues, setParseIssues] = useState<string[]>([]);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copySource, setCopySource] = useState("");
  const [suggestText, setSuggestText] = useState("");
  const [suggestions, setSuggestions] = useState<
    { kind: AccountKind; label: string; reason: string }[]
  >([]);
  const [showYtd, setShowYtd] = useState(true);

  const rows = useMemo(() => {
    const accounts = (chartQuery.data?.accounts ?? []).filter((account) => {
      const haystack = `${account.code} ${account.name} ${account.description}`.toLowerCase();
      if (search && !haystack.includes(search.toLowerCase())) return false;
      if (classFilter !== "all" && account.accountType !== classFilter) return false;
      if (activeFilter === "active" && !account.isActive) return false;
      if (activeFilter === "archived" && account.isActive) return false;
      const net = account.debitMinor - account.creditMinor;
      if (balanceFilter === "nonzero" && net === 0) return false;
      if (balanceFilter === "zero" && net !== 0) return false;
      return true;
    });
    return mode === "flat"
      ? accounts.map((account) => ({ account, depth: 0 }))
      : treeRows(accounts, collapsed);
  }, [
    activeFilter,
    balanceFilter,
    chartQuery.data?.accounts,
    classFilter,
    collapsed,
    mode,
    search,
  ]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 4);
  const visible = rows.slice(start, start + 24);
  const otherCompanies = (companies?.companies ?? []).filter((company) => company.id !== companyId);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["chart-accounts", companyId] });
    await queryClient.invalidateQueries({ queryKey: ["accounts", companyId] });
  };

  const archiveMutation = useMutation({
    mutationFn: (accountId: string) => archive({ data: { companyId, accountId } }),
    onSuccess: async () => {
      await refresh();
      toast.success("Account archived");
    },
    onError: (error) => toast.error(friendlyAuthError(error)),
  });

  const mergePreview = useQuery({
    queryKey: ["merge-preview", companyId, mergeSource?.id, mergeTarget],
    enabled: mergeSource !== null && mergeTarget !== "",
    retry: false,
    queryFn: () =>
      previewMerge({
        data: { companyId, sourceId: mergeSource!.id, targetId: mergeTarget },
      }),
  });
  const mergePlan = mergePreview.data && "periods" in mergePreview.data ? mergePreview.data : null;
  const mergeAssessment = mergePlan ? assessMergePlan(mergePlan, mergeLockedToday) : null;

  const mergeMutation = useMutation({
    mutationFn: () => {
      if (!mergeSource || !mergeTarget) throw new Error("Choose the account that should remain.");
      return merge({
        data: {
          companyId,
          sourceId: mergeSource.id,
          targetId: mergeTarget,
          postLockedPeriodsToday: mergeLockedToday,
        },
      });
    },
    onSuccess: async (result) => {
      await refresh();
      setMergeSource(null);
      setMergeLockedToday(false);
      toast.success(
        result.journalCount
          ? `Accounts merged: ${result.journalCount} journal${result.journalCount === 1 ? "" : "s"} posted`
          : "Accounts merged",
      );
      if (!result.archived) {
        toast.message(
          result.archiveBlockedReason ??
            "The balance moved, but the old account could not be archived yet.",
        );
      }
    },
    onError: (error) => toast.error(friendlyAuthError(error)),
  });

  const importMutation = useMutation({
    mutationFn: (commit: boolean) => importRows({ data: { companyId, commit, rows: parsedRows } }),
    onSuccess: async (result, commit) => {
      if (!commit) {
        toast.success(
          `${result.preview.length} new accounts, ${result.skipped} already on the chart`,
        );
        return;
      }
      await refresh();
      setImportOpen(false);
      toast.success(`Imported ${result.imported} accounts`);
    },
    onError: (error) => toast.error(friendlyAuthError(error)),
  });

  const copyMutation = useMutation({
    mutationFn: () =>
      copyChart({ data: { sourceCompanyId: copySource, targetCompanyId: companyId } }),
    onSuccess: async (result) => {
      await refresh();
      setCopyOpen(false);
      toast.success(`Copied ${result.copied} accounts`);
    },
    onError: (error) => toast.error(friendlyAuthError(error)),
  });

  const suggestMutation = useMutation({
    mutationFn: () => suggest({ data: { description: suggestText } }),
    onSuccess: (result) => setSuggestions(result.suggestions),
    onError: (error) => toast.error(friendlyAuthError(error)),
  });

  const rename = async (account: ChartAccount, name: string) => {
    if (!account.accountKind || name.trim() === account.name) {
      setInline(null);
      return;
    }
    const parsed = saveAccountSchema.safeParse(
      draftFrom(account, companyId, { name: name.trim() }),
    );
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Check the account name.");
      return;
    }
    try {
      await save({ data: parsed.data });
      await refresh();
      setInline(null);
    } catch (error) {
      toast.error(friendlyAuthError(error));
    }
  };

  const reparent = async (account: ChartAccount, parentId: string) => {
    if (!account.accountKind || account.id === parentId) return;
    const parsed = saveAccountSchema.safeParse(draftFrom(account, companyId, { parentId }));
    if (!parsed.success) return;
    try {
      await save({ data: parsed.data });
      await refresh();
    } catch (error) {
      toast.error(friendlyAuthError(error));
    }
  };

  if (chartQuery.isPending) return <LoadingState />;
  if (chartQuery.isError) {
    return (
      <ErrorState
        title="Could not load the chart"
        description={friendlyAuthError(chartQuery.error)}
        onRetry={() => chartQuery.refetch()}
      />
    );
  }

  const review = chartQuery.data.review;
  const balanceLabel = chartQuery.data.balanceLabel;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-56 flex-1 space-y-1">
          <Label>Search</Label>
          <Input
            value={search}
            placeholder="Code, name, or description"
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Filter
          label="Class"
          value={classFilter}
          onChange={(value) => setClassFilter(value as ClassFilter)}
          options={["all", "asset", "liability", "equity", "income", "expense"]}
        />
        <Filter
          label="Status"
          value={activeFilter}
          onChange={(value) => setActiveFilter(value as "active" | "archived" | "all")}
          options={["active", "archived", "all"]}
        />
        <Filter
          label="Balance"
          value={balanceFilter}
          onChange={(value) => setBalanceFilter(value as "all" | "nonzero" | "zero")}
          options={["all", "nonzero", "zero"]}
        />
        <Filter
          label="Layout"
          value={mode}
          onChange={(value) => setMode(value as "tree" | "flat")}
          options={["tree", "flat"]}
        />
        <Button type="button" variant="outline" onClick={() => setShowYtd((current) => !current)}>
          {showYtd ? "Hide year to date" : "Show year to date"}
        </Button>
        <Button type="button" onClick={() => setCreating({})}>
          New account
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => setImportOpen(true)}>
          Import CSV
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => downloadCsv(chartQuery.data.accounts)}
        >
          Export CSV
        </Button>
        <Button type="button" variant="outline" onClick={() => setTemplateOpen(true)}>
          Starter charts
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setCopyOpen(true)}
          disabled={otherCompanies.length === 0}
        >
          Copy from organisation
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={selected.size === 0 || archiveMutation.isPending}
          onClick={async () => {
            for (const accountId of selected) {
              try {
                await archive({ data: { companyId, accountId } });
              } catch (error) {
                toast.error(friendlyAuthError(error));
              }
            }
            setSelected(new Set());
            await refresh();
          }}
        >
          Archive selected
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input
          className="max-w-md"
          value={suggestText}
          placeholder="Describe an account. A suggestion fills the form; it does not save."
          onChange={(event) => setSuggestText(event.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          disabled={suggestMutation.isPending}
          onClick={() => suggestMutation.mutate()}
        >
          Suggest type
        </Button>
        {suggestions.map((item) => (
          <Button
            key={item.kind}
            type="button"
            variant="secondary"
            onClick={() => setCreating({ kind: item.kind, name: suggestText })}
          >
            Use {item.label}
          </Button>
        ))}
      </div>
      {review.misclassified.length > 0 || review.duplicates.length > 0 ? (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          {review.misclassified.map((flag) => (
            <p key={flag.accountId}>{flag.message}</p>
          ))}
          {review.duplicates.map((pair) => (
            <p key={`${pair.leftId}-${pair.rightId}`}>{pair.message}</p>
          ))}
        </div>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState
          title="No accounts match"
          description="Change the filters or create an account."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="grid grid-cols-[2rem_7rem_1fr_10rem_8rem_5rem_2rem] gap-2 border-b border-border bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground">
            <span />
            <span>Code</span>
            <span>Name</span>
            <span>Type</span>
            <span>Balance</span>
            <span>{showYtd ? balanceLabel : "Transactions"}</span>
            <span />
          </div>
          <div
            className="max-h-[32rem] overflow-auto"
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          >
            <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
              {visible.map((row, index) => {
                const account = row.account;
                const kind = account.accountKind
                  ? kindSpec(account.accountKind).label
                  : account.accountType;
                return (
                  <div
                    key={account.id}
                    draggable={!!account.accountKind}
                    onDragStart={(event) => event.dataTransfer.setData("text/plain", account.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      const sourceId = event.dataTransfer.getData("text/plain");
                      const source = chartQuery.data.accounts.find((item) => item.id === sourceId);
                      if (source) void reparent(source, account.id);
                    }}
                    className="absolute grid w-full grid-cols-[2rem_7rem_1fr_10rem_8rem_5rem_2rem] items-center gap-2 px-3 text-sm"
                    style={{ top: (start + index) * ROW_HEIGHT, height: ROW_HEIGHT }}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(account.id)}
                      onChange={(event) => {
                        const next = new Set(selected);
                        if (event.target.checked) next.add(account.id);
                        else next.delete(account.id);
                        setSelected(next);
                      }}
                    />
                    <button
                      type="button"
                      className="truncate text-left font-mono text-xs"
                      onClick={() => {
                        const next = new Set(collapsed);
                        if (next.has(account.id)) next.delete(account.id);
                        else next.add(account.id);
                        setCollapsed(next);
                      }}
                    >
                      {account.code}
                    </button>
                    <div className="min-w-0" style={{ paddingLeft: row.depth * 16 }}>
                      {inline?.id === account.id ? (
                        <Input
                          autoFocus
                          value={inline.name}
                          onChange={(event) =>
                            setInline({ id: account.id, name: event.target.value })
                          }
                          onBlur={() => void rename(account, inline.name)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void rename(account, inline.name);
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className="truncate text-left"
                          onDoubleClick={() => setInline({ id: account.id, name: account.name })}
                        >
                          {account.name}
                        </button>
                      )}
                      {!account.isActive ? <Badge variant="secondary">Archived</Badge> : null}
                      {account.isSystem ? <Badge variant="outline">System</Badge> : null}
                    </div>
                    <span className="truncate text-muted-foreground">{kind}</span>
                    <Link
                      to="/reports/$reportId"
                      params={{ reportId: "general-ledger" }}
                      search={{ account: account.id } as never}
                      className="font-mono text-xs hover:underline"
                      title="Open account transactions"
                    >
                      {money(account, currency, "balance")}
                    </Link>
                    <span className="font-mono text-xs">
                      {showYtd ? money(account, currency, "ytd") : account.transactionCount}
                    </span>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label={`Actions for ${account.name}`}
                        >
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setEditing(account)}>
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() =>
                            setCreating({
                              kind: account.accountKind ?? "expense",
                              name: `Copy of ${account.name}`,
                            })
                          }
                        >
                          Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={account.isSystem || account.isLocked}
                          onClick={() => archiveMutation.mutate(account.id)}
                        >
                          Archive
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={account.isSystem || account.isLocked}
                          onClick={() => {
                            setMergeSource(account);
                            setMergeTarget("");
                          }}
                        >
                          Merge
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <Sheet
        open={creating !== null || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(null);
            setEditing(null);
          }
        }}
      >
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{editing ? "Edit account" : "New account"}</SheetTitle>
          </SheetHeader>
          {creating || editing ? (
            <div className="mt-4">
              <AccountForm
                companyId={companyId}
                currency={currency}
                account={editing}
                {...(creating?.kind ? { initialKind: creating.kind } : {})}
                {...(creating?.name ? { initialName: creating.name } : {})}
                onSaved={(another) => {
                  if (!another) {
                    setCreating(null);
                    setEditing(null);
                  }
                }}
                onCancel={() => {
                  setCreating(null);
                  setEditing(null);
                }}
              />
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      <Dialog
        open={mergeSource !== null}
        onOpenChange={(open) => {
          if (!open) setMergeSource(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Merge {mergeSource?.code} {mergeSource?.name}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            The balance moves period by period, with a journal dated inside each period, so earlier
            years keep their figures. Posted history stays on the original lines. Then this account
            is archived where the rules allow it.
          </p>
          <Select
            value={mergeTarget}
            onValueChange={(value) => {
              setMergeTarget(value);
              setMergeLockedToday(false);
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Account to keep" />
            </SelectTrigger>
            <SelectContent>
              {(chartQuery.data.accounts ?? [])
                .filter(
                  (account) =>
                    account.id !== mergeSource?.id &&
                    account.accountType === mergeSource?.accountType &&
                    account.isActive,
                )
                .map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.code} {account.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          {mergeTarget && mergePreview.isPending ? (
            <p className="text-sm text-muted-foreground">Checking what will be posted…</p>
          ) : null}
          {mergePreview.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {friendlyAuthError(mergePreview.error)}
            </p>
          ) : null}
          {mergePreview.data && "unavailable" in mergePreview.data ? (
            <p className="text-sm text-muted-foreground">{mergePreview.data.unavailable}</p>
          ) : null}
          {mergePlan && mergeAssessment ? (
            <div className="space-y-2 text-sm">
              {mergePlan.periods.length === 0 ? (
                <p>No balance to move. The account will just be archived.</p>
              ) : (
                <ul className="space-y-1">
                  {mergePlan.periods.map((p) => (
                    <li key={p.period_id} className="flex justify-between gap-2">
                      <span>
                        {p.period_name}: journal dated {p.journal_date}
                        {p.locked ? ` (locked: ${p.lock_reason ?? "locked"})` : ""}
                      </span>
                      <span className="tabular-nums">{fromMinorUnits(p.net_minor, currency)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {mergeAssessment.lockedPeriods.length > 0 ? (
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={mergeLockedToday}
                    onChange={(e) => setMergeLockedToday(e.target.checked)}
                  />
                  <span>
                    Post the locked periods&apos; share in one journal dated {mergePlan.today} (this
                    puts their amounts in today&apos;s period).
                  </span>
                </label>
              ) : null}
              {mergeAssessment.blockedReason ? (
                <p className="text-destructive">{mergeAssessment.blockedReason}</p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              disabled={
                !mergeTarget ||
                mergeMutation.isPending ||
                (mergeAssessment !== null && !mergeAssessment.canMerge)
              }
              onClick={() => mergeMutation.mutate()}
            >
              {mergeMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Merge
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import accounts</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            CSV columns: Code, Name, Account type, Description. Nothing is saved until you confirm
            the preview.
          </p>
          <Input
            type="file"
            accept=".csv,text/csv"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              const parsed = parseChartCsv(await file.text());
              setParsedRows(parsed.rows);
              setParseIssues(parsed.issues.map((issue) => `Row ${issue.row}: ${issue.message}`));
            }}
          />
          {parseIssues.map((issue) => (
            <p key={issue} className="text-sm text-destructive">
              {issue}
            </p>
          ))}
          {parsedRows.length > 0 && parseIssues.length === 0 ? (
            <p className="text-sm">
              {parsedRows.length} rows ready to check against this organisation.
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={
                parsedRows.length === 0 || parseIssues.length > 0 || importMutation.isPending
              }
              onClick={() => importMutation.mutate(false)}
            >
              Preview
            </Button>
            <Button
              type="button"
              disabled={
                parsedRows.length === 0 || parseIssues.length > 0 || importMutation.isPending
              }
              onClick={() => importMutation.mutate(true)}
            >
              Import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={templateOpen} onOpenChange={setTemplateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Starter charts</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {STARTER_CHARTS.map((chart) => (
              <div key={chart.id} className="rounded-md border border-border p-3">
                <p className="font-medium">{chart.label}</p>
                <p className="text-sm text-muted-foreground">{chart.detail}</p>
                <Button
                  type="button"
                  className="mt-2"
                  variant="outline"
                  onClick={() => {
                    setParsedRows(
                      chart.accounts.map((account) => ({
                        code: account.code,
                        name: account.name,
                        accountKind: account.accountKind,
                        description: account.description,
                        parentCode: "",
                        detailType: "",
                        isHeader: false,
                        currencyCode: "",
                      })),
                    );
                    setParseIssues([]);
                    setTemplateOpen(false);
                    setImportOpen(true);
                  }}
                >
                  Review {chart.accounts.length} accounts
                </Button>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={copyOpen} onOpenChange={setCopyOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy a chart</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Copies accounts you can manage. System accounts and matching codes or names are left as
            they are.
          </p>
          <Select value={copySource} onValueChange={setCopySource}>
            <SelectTrigger>
              <SelectValue placeholder="Source organisation" />
            </SelectTrigger>
            <SelectContent>
              {otherCompanies.map((company) => (
                <SelectItem key={company.id} value={company.id}>
                  {company.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button
              type="button"
              disabled={!copySource || copyMutation.isPending}
              onClick={() => copyMutation.mutate()}
            >
              Copy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Filter({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function treeRows(accounts: ChartAccount[], collapsed: Set<string>) {
  const byParent = new Map<string, ChartAccount[]>();
  for (const account of accounts) {
    const key = account.parentId ?? "";
    byParent.set(key, [...(byParent.get(key) ?? []), account]);
  }
  const rows: { account: ChartAccount; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string, depth: number) => {
    for (const account of byParent.get(parentId) ?? []) {
      if (seen.has(account.id)) continue;
      seen.add(account.id);
      rows.push({ account, depth });
      if (!collapsed.has(account.id)) walk(account.id, depth + 1);
    }
  };
  walk("", 0);
  for (const account of accounts) {
    if (!seen.has(account.id)) rows.push({ account, depth: 0 });
  }
  return rows;
}

function money(account: ChartAccount, currency: string, which: "balance" | "ytd"): string {
  const debit = which === "balance" ? account.debitMinor : account.ytdDebitMinor;
  const credit = which === "balance" ? account.creditMinor : account.ytdCreditMinor;
  const kind = account.accountKind;
  const signed = kind
    ? signedBalance(kind, debit, credit)
    : account.normalBalance === "debit"
      ? debit - credit
      : credit - debit;
  // Totals are converted to the company base currency by the ledger aggregates.
  return fromMinorUnits(signed, currency);
}

function draftFrom(
  account: ChartAccount,
  companyId: string,
  patch: { name?: string; parentId?: string },
) {
  return {
    companyId,
    id: account.id,
    code: account.code,
    name: patch.name ?? account.name,
    accountKind: account.accountKind ?? "expense",
    description: account.description,
    detailType: account.detailType,
    parentId: patch.parentId ?? account.parentId,
    defaultTaxCodeId: account.defaultTaxCodeId,
    currencyCode: account.currencyCode,
    isHeader: account.isHeader,
    isPaymentEnabled: account.isPaymentEnabled,
    showOnDashboardWatchlist: account.showOnDashboardWatchlist,
    showInExpenseClaims: account.showInExpenseClaims,
    bankName: account.bankName,
    accountNumberMasked: account.accountNumberMasked,
  };
}

function downloadCsv(accounts: ChartAccount[]) {
  const csv = chartRowsToCsv(
    accounts.map((account) => ({
      code: account.code,
      name: account.name,
      accountKind: account.accountKind ?? account.accountType,
      description: account.description,
    })),
  );
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "chart-of-accounts.csv";
  link.click();
  URL.revokeObjectURL(url);
}
