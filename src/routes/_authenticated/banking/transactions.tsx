import { Fragment, useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  bulkCategoriseTransactions,
  excludeBankTransaction,
  listBankAccounts,
  listBankTransactions,
  restoreBankTransaction,
  suggestBankCoding,
  type BankTxnListRow,
} from "@/lib/banking/banking.functions";
import { bulkCodeByFilter, listCodingOptions } from "@/lib/banking/coding.functions";
import { unmatchBankTransaction } from "@/lib/banking/matching.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { BankCodingPanel } from "@/components/banking/BankCodingPanel";
import { BankMatchPanel } from "@/components/banking/BankMatchPanel";
import { ConfirmButton } from "@/components/banking/ConfirmButton";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Search = {
  status?: string;
  statusGroup?: string;
  q?: string;
  bankAccountId?: string;
  dateFrom?: string;
  dateTo?: string;
  direction?: string;
  page?: number;
  pageSize?: number;
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const ALL = "all";
const NONE = "none";

export const Route = createFileRoute("/_authenticated/banking/transactions")({
  validateSearch: (s: Record<string, unknown>): Search => {
    const out: Search = {};
    const str = (k: keyof Search) =>
      typeof s[k] === "string" && s[k] !== "" ? (s[k] as string) : undefined;
    const status = str("status");
    if (status) out.status = status;
    const statusGroup = str("statusGroup");
    if (statusGroup) out.statusGroup = statusGroup;
    const q = str("q");
    if (q) out.q = q;
    const bankAccountId = str("bankAccountId");
    if (bankAccountId) out.bankAccountId = bankAccountId;
    const dateFrom = str("dateFrom");
    if (dateFrom && ISO.test(dateFrom)) out.dateFrom = dateFrom;
    const dateTo = str("dateTo");
    if (dateTo && ISO.test(dateTo)) out.dateTo = dateTo;
    const direction = str("direction");
    if (direction === "in" || direction === "out") out.direction = direction;
    const page = Number(s["page"]);
    if (Number.isInteger(page) && page > 0) out.page = page;
    const pageSize = Number(s["pageSize"]);
    if ([25, 50, 100, 200].includes(pageSize) && pageSize !== 50) out.pageSize = pageSize;
    return out;
  },
  head: () => ({ meta: [{ title: "Bank transactions — LinkBooks" }] }),
  component: BankTransactions,
});

type Expanded = { id: string; mode: "code" | "match"; initialAccountId?: string } | null;

function BankTransactions() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const qc = useQueryClient();

  const fetchTxns = useServerFn(listBankTransactions);
  const fetchAccounts = useServerFn(listBankAccounts);
  const fetchOptions = useServerFn(listCodingOptions);
  const fetchSuggest = useServerFn(suggestBankCoding);
  const doExclude = useServerFn(excludeBankTransaction);
  const doRestore = useServerFn(restoreBankTransaction);
  const doUnmatch = useServerFn(unmatchBankTransaction);
  const doBulk = useServerFn(bulkCategoriseTransactions);
  const doBulkFilter = useServerFn(bulkCodeByFilter);

  const status = search.statusGroup ? "" : (search.status ?? "uncategorised");
  const statusGroup = search.statusGroup ?? "";
  const page = search.page ?? 0;
  const pageSize = search.pageSize ?? 50;

  const setSearch = (patch: { [K in keyof Search]?: Search[K] | undefined }, keepPage = false) =>
    void navigate({
      search: ((prev: Search) => {
        const next: Record<string, unknown> = { ...prev, ...patch };
        if (!keepPage && !("page" in patch)) delete next["page"];
        for (const k of Object.keys(next))
          if (next[k] === undefined || next[k] === "") delete next[k];
        return next;
      }) as never,
    });

  const [qText, setQText] = useState(search.q ?? "");
  useEffect(() => setQText(search.q ?? ""), [search.q]);
  const [expanded, setExpanded] = useState<Expanded>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAccountId, setBulkAccountId] = useState("");
  const [bulkTaxCodeId, setBulkTaxCodeId] = useState(NONE);
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);

  const filterKey = [
    search.bankAccountId,
    status,
    statusGroup,
    search.q,
    search.dateFrom,
    search.dateTo,
    search.direction,
    page,
    pageSize,
  ];
  useEffect(() => {
    setSelected(new Set());
    setExpanded(null);
  }, [filterKey.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  const accountsQ = useQuery({
    queryKey: ["bank-accounts", companyId, "all"],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId!, includeInactive: true } }),
  });
  const currencyByAccount = useMemo(
    () => new Map((accountsQ.data ?? []).map((a) => [a.id, a.currency_code])),
    [accountsQ.data],
  );
  const nameByAccount = useMemo(
    () => new Map((accountsQ.data ?? []).map((a) => [a.id, a.name])),
    [accountsQ.data],
  );

  const txnsQ = useQuery({
    queryKey: ["bank-transactions", companyId, ...filterKey],
    enabled: Boolean(companyId),
    placeholderData: (prev) => prev,
    queryFn: () =>
      fetchTxns({
        data: {
          companyId: companyId!,
          ...(search.bankAccountId ? { bankAccountId: search.bankAccountId } : {}),
          ...(statusGroup ? { statusGroup } : status && status !== ALL ? { status } : {}),
          ...(search.q ? { q: search.q } : {}),
          ...(search.dateFrom ? { dateFrom: search.dateFrom } : {}),
          ...(search.dateTo ? { dateTo: search.dateTo } : {}),
          ...(search.direction ? { direction: search.direction } : {}),
          page,
          pageSize,
        },
      }),
  });

  const optionsQ = useQuery({
    queryKey: ["bank-coding-options", companyId],
    enabled: Boolean(companyId),
    staleTime: 60_000,
    queryFn: () => fetchOptions({ data: { companyId: companyId! } }),
  });

  const suggestQ = useQuery({
    queryKey: ["bank-suggest", companyId, expanded?.id],
    enabled: Boolean(companyId && expanded?.mode === "code"),
    queryFn: () =>
      fetchSuggest({ data: { companyId: companyId!, bankTransactionId: expanded!.id } }),
  });

  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ["bank-transactions", companyId] });
    await qc.invalidateQueries({ queryKey: ["banking-counts", companyId] });
    await qc.invalidateQueries({ queryKey: ["bank-account-summaries", companyId] });
  };

  const excludeM = useMutation({
    mutationFn: (txnId: string) =>
      doExclude({ data: { companyId: companyId!, bankTransactionId: txnId } }),
    onSuccess: async () => {
      await invalidate();
      toast.success("Excluded. No journal was created.");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });
  const restoreM = useMutation({
    mutationFn: (txnId: string) =>
      doRestore({ data: { companyId: companyId!, bankTransactionId: txnId } }),
    onSuccess: async () => {
      await invalidate();
      toast.success("Restored to For review");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });
  const unmatchM = useMutation({
    mutationFn: (vars: { txnId: string; redo: boolean }) =>
      doUnmatch({ data: { companyId: companyId!, bankTransactionId: vars.txnId } }).then((r) => ({
        ...r,
        ...vars,
      })),
    onSuccess: async (r) => {
      await invalidate();
      toast.success(
        r.reversedJournalCount > 0
          ? `Undone. ${r.reversedJournalCount} reversing journal(s) posted; the line is back in For review.`
          : "Unmatched. The line is back in For review.",
      );
      if (r.redo) setExpanded({ id: r.txnId, mode: "code" });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const bulkSelectedM = useMutation({
    mutationFn: () =>
      doBulk({
        data: {
          companyId: companyId!,
          bankTransactionIds: [...selected],
          offsetAccountId: bulkAccountId,
          taxCodeId: bulkTaxCodeId === NONE ? null : bulkTaxCodeId,
        },
      }),
    onSuccess: async (r) => {
      await invalidate();
      setSelected(new Set());
      if (r.failed > 0) {
        const first = r.results.find((x) => !x.ok);
        toast.warning(`${r.succeeded} coded, ${r.failed} failed. ${first?.error ?? ""}`);
      } else toast.success(`${r.succeeded} transactions coded`);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const bulkAllM = useMutation({
    mutationFn: async () => {
      let coded = 0;
      let failed = 0;
      let lastErrors: string[] = [];
      for (let guard = 0; guard < 200; guard++) {
        const r = await doBulkFilter({
          data: {
            companyId: companyId!,
            ...(search.bankAccountId ? { bankAccountId: search.bankAccountId } : {}),
            ...(search.q ? { q: search.q } : {}),
            ...(search.dateFrom ? { dateFrom: search.dateFrom } : {}),
            ...(search.dateTo ? { dateTo: search.dateTo } : {}),
            ...(search.direction ? { direction: search.direction } : {}),
            accountId: bulkAccountId,
            taxCodeId: bulkTaxCodeId === NONE ? null : bulkTaxCodeId,
          },
        });
        coded += r.coded;
        failed += r.failed;
        lastErrors = r.errors;
        setBulkProgress(`${coded} coded… ${r.remaining} remaining`);
        if (r.remaining === 0 || r.stuck || r.coded === 0) break;
      }
      return { coded, failed, errors: lastErrors };
    },
    onSuccess: async (r) => {
      setBulkProgress(null);
      await invalidate();
      if (r.failed > 0)
        toast.warning(`${r.coded} coded, ${r.failed} could not be coded. ${r.errors[0] ?? ""}`);
      else toast.success(`${r.coded} transactions coded`);
    },
    onError: async (e) => {
      setBulkProgress(null);
      await invalidate();
      toast.error(friendlyAuthError(e));
    },
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  const rows = (txnsQ.data?.rows ?? []) as BankTxnListRow[];
  const total = txnsQ.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const reviewing = status === "uncategorised";
  const uncategorisedRows = rows.filter((r) => r.status === "uncategorised");
  const allPageSelected =
    uncategorisedRows.length > 0 && uncategorisedRows.every((r) => selected.has(r.id));

  const title =
    statusGroup === "unreconciled"
      ? "Unreconciled"
      : statusGroup === "posted"
        ? "Posted / categorised"
        : status === "excluded"
          ? "Excluded"
          : status === "reconciled"
            ? "Reconciled"
            : status === "matched"
              ? "Matched"
              : status === ALL
                ? "All bank transactions"
                : "For review";

  const bulkReady = Boolean(bulkAccountId);
  const taxChoices = (optionsQ.data?.taxCodes ?? []).filter(
    (t) => t.rateActive && t.treatment !== "reverse_charge",
  );

  return (
    <>
      <PageHeader
        title={title}
        description="Code a line (one balanced journal), match it to existing ledger activity, or exclude it. Unmatch undoes a coding by posting a reversing journal."
        actions={
          <>
            <Button size="sm" variant="outline" asChild>
              <Link to="/banking/rules" search={{ review: "1" } as never}>
                Review rule suggestions
              </Link>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link to="/banking/cash-coding">Open cash coding</Link>
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-2">
        <Select
          value={search.bankAccountId ?? ALL}
          onValueChange={(v) => setSearch({ bankAccountId: v === ALL ? undefined : v })}
        >
          <SelectTrigger className="w-48" aria-label="Bank account">
            <SelectValue placeholder="Account" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All accounts</SelectItem>
            {(accountsQ.data ?? []).map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
                {a.is_active ? "" : " (archived)"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={statusGroup || status || ALL}
          onValueChange={(v) =>
            v === "unreconciled" || v === "posted"
              ? setSearch({ statusGroup: v, status: undefined })
              : setSearch({ statusGroup: undefined, status: v })
          }
        >
          <SelectTrigger className="w-48" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="uncategorised">For review</SelectItem>
            <SelectItem value="matched">Matched (posted)</SelectItem>
            <SelectItem value="reconciled">Reconciled</SelectItem>
            <SelectItem value="unreconciled">Unreconciled</SelectItem>
            <SelectItem value="posted">Posted (matched + reconciled)</SelectItem>
            <SelectItem value="excluded">Excluded</SelectItem>
            <SelectItem value={ALL}>All</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={search.direction ?? ALL}
          onValueChange={(v) => setSearch({ direction: v === ALL ? undefined : v })}
        >
          <SelectTrigger className="w-36" aria-label="Money in or out">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>In and out</SelectItem>
            <SelectItem value="in">Money in</SelectItem>
            <SelectItem value="out">Money out</SelectItem>
          </SelectContent>
        </Select>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          From
          <Input
            type="date"
            className="h-9 w-40"
            value={search.dateFrom ?? ""}
            onChange={(e) => setSearch({ dateFrom: e.target.value || undefined })}
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          To
          <Input
            type="date"
            className="h-9 w-40"
            value={search.dateTo ?? ""}
            onChange={(e) => setSearch({ dateTo: e.target.value || undefined })}
          />
        </label>
        <Input
          className="max-w-xs"
          placeholder="Search description, reference, payee…"
          value={qText}
          onChange={(e) => setQText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") setSearch({ q: qText.trim() || undefined });
          }}
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setSearch({ q: qText.trim() || undefined })}
        >
          Search
        </Button>
      </div>

      {reviewing && uncategorisedRows.length > 0 ? (
        <div className="mb-3 space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">
              {selected.size > 0 ? `${selected.size} selected` : "Bulk coding"}
            </span>
            <Select value={bulkAccountId} onValueChange={setBulkAccountId}>
              <SelectTrigger className="h-8 w-56" aria-label="Account for bulk coding">
                <SelectValue placeholder="Account" />
              </SelectTrigger>
              <SelectContent>
                {(optionsQ.data?.accounts ?? []).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={bulkTaxCodeId} onValueChange={setBulkTaxCodeId}>
              <SelectTrigger className="h-8 w-40" aria-label="Tax code for bulk coding">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No tax</SelectItem>
                {taxChoices.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={selected.size === 0 || !bulkReady || bulkSelectedM.isPending}
              onClick={() => bulkSelectedM.mutate()}
            >
              Code selected
            </Button>
          </div>
          {allPageSelected && total > uncategorisedRows.length ? (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span>
                All {uncategorisedRows.length} on this page are selected. {total} lines match this
                filter.
              </span>
              <ConfirmButton
                title={`Code all ${total} matching lines?`}
                description={`Every uncategorised line matching the current filters will be coded to the chosen account${
                  bulkTaxCodeId === NONE ? "" : " and tax code"
                }, one journal each. Lines that cannot be coded are skipped and reported.`}
                confirmLabel={`Code all ${total}`}
                disabled={!bulkReady || bulkAllM.isPending}
                onConfirm={() => bulkAllM.mutate()}
              >
                Code all {total} matching
              </ConfirmButton>
              {!bulkReady ? (
                <span className="text-muted-foreground">Choose an account first.</span>
              ) : null}
            </div>
          ) : null}
          {bulkProgress ? <p className="text-xs text-muted-foreground">{bulkProgress}</p> : null}
        </div>
      ) : null}

      {txnsQ.isPending ? (
        <LoadingState />
      ) : txnsQ.isError ? (
        <ErrorState title="Could not load" description={friendlyAuthError(txnsQ.error)} />
      ) : rows.length === 0 ? (
        <EmptyState title="No transactions" description="Import a CSV or change filters." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                {reviewing ? (
                  <Checkbox
                    aria-label="Select all on this page"
                    checked={allPageSelected}
                    onCheckedChange={(v) =>
                      setSelected(
                        v === true ? new Set(uncategorisedRows.map((r) => r.id)) : new Set(),
                      )
                    }
                  />
                ) : null}
              </TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Description</TableHead>
              {search.bankAccountId ? null : <TableHead>Account</TableHead>}
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Journal</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((t) => {
              const currency =
                currencyByAccount.get(t.bank_account_id) ?? company?.base_currency ?? "GBP";
              const bankJournals = t.links.filter(
                (l) => l.sourceType === "bank_transaction" && !l.reversed,
              );
              const canRedo = t.status === "matched" && bankJournals.length > 0;
              const open = expanded?.id === t.id ? expanded : null;
              return (
                <Fragment key={t.id}>
                  <TableRow>
                    <TableCell>
                      {t.status === "uncategorised" ? (
                        <Checkbox
                          aria-label={`Select ${t.description ?? "transaction"}`}
                          checked={selected.has(t.id)}
                          onCheckedChange={(v) =>
                            setSelected((s) => {
                              const next = new Set(s);
                              if (v === true) next.add(t.id);
                              else next.delete(t.id);
                              return next;
                            })
                          }
                        />
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{t.txn_date}</TableCell>
                    <TableCell>
                      <div>{t.description ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">
                        {[t.payee, t.reference ? `Ref ${t.reference}` : null, t.contact_name]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                      {t.exclude_reason ? (
                        <div className="text-xs text-muted-foreground">
                          Excluded: {t.exclude_reason}
                        </div>
                      ) : null}
                    </TableCell>
                    {search.bankAccountId ? null : (
                      <TableCell className="whitespace-nowrap text-sm">
                        {nameByAccount.get(t.bank_account_id) ?? "—"}
                      </TableCell>
                    )}
                    <TableCell className="whitespace-nowrap text-right font-mono text-sm">
                      {fromMinorUnits(t.amount_minor, currency)}{" "}
                      <span className="text-xs">{currency}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{t.status}</Badge>
                    </TableCell>
                    <TableCell>
                      {t.links.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <div className="flex flex-col">
                          {t.links.map((l) =>
                            l.journalId ? (
                              <Link
                                key={l.journalLineId}
                                to="/banking/journal/$journalId"
                                params={{ journalId: l.journalId }}
                                className="text-sm underline-offset-4 hover:underline"
                              >
                                Journal #{l.journalNumber}
                                {l.reversed ? " (reversed)" : ""}
                              </Link>
                            ) : null,
                          )}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        {t.status === "uncategorised" ? (
                          <>
                            <Button
                              size="sm"
                              variant={open?.mode === "code" ? "secondary" : "default"}
                              onClick={() =>
                                setExpanded(
                                  open?.mode === "code" ? null : { id: t.id, mode: "code" },
                                )
                              }
                            >
                              Code
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                setExpanded(
                                  open?.mode === "match" ? null : { id: t.id, mode: "match" },
                                )
                              }
                            >
                              Match
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={excludeM.isPending}
                              onClick={() => excludeM.mutate(t.id)}
                            >
                              Exclude
                            </Button>
                          </>
                        ) : null}
                        {t.status === "matched" ? (
                          canRedo ? (
                            <>
                              <ConfirmButton
                                title="Remove & redo this coding?"
                                description="A reversing journal is posted for the journal that coded this line, the link is removed, and the line returns to For review so you can code it again. Nothing is deleted."
                                confirmLabel="Remove & redo"
                                disabled={unmatchM.isPending}
                                onConfirm={() => unmatchM.mutate({ txnId: t.id, redo: true })}
                              >
                                Remove &amp; redo
                              </ConfirmButton>
                              <ConfirmButton
                                title="Unmatch this line?"
                                description="A reversing journal is posted and the line returns to For review."
                                confirmLabel="Unmatch"
                                disabled={unmatchM.isPending}
                                onConfirm={() => unmatchM.mutate({ txnId: t.id, redo: false })}
                              >
                                Unmatch
                              </ConfirmButton>
                            </>
                          ) : (
                            <ConfirmButton
                              title="Unmatch this line?"
                              description="The link to the ledger line is removed and the line returns to For review. The journal it was matched to is not changed."
                              confirmLabel="Unmatch"
                              disabled={unmatchM.isPending}
                              onConfirm={() => unmatchM.mutate({ txnId: t.id, redo: false })}
                            >
                              Unmatch
                            </ConfirmButton>
                          )
                        ) : null}
                        {t.status === "reconciled" ? (
                          <span className="text-xs text-muted-foreground">
                            Reconciled. Reopen the reconciliation to change.
                          </span>
                        ) : null}
                        {t.status === "excluded" ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={restoreM.isPending}
                            onClick={() => restoreM.mutate(t.id)}
                          >
                            Restore
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                  {open ? (
                    <TableRow>
                      <TableCell colSpan={search.bankAccountId ? 7 : 8} className="bg-muted/10">
                        {open.mode === "code" ? (
                          <div className="space-y-2">
                            {suggestQ.data && suggestQ.data.suggestions.length > 0 ? (
                              <div className="flex flex-wrap items-center gap-1 text-xs">
                                <span className="text-muted-foreground">Suggested:</span>
                                {suggestQ.data.suggestions.slice(0, 4).map((s) => (
                                  <Button
                                    key={`${s.offsetAccountId}-${s.reason}`}
                                    size="sm"
                                    variant="outline"
                                    className="h-6 px-2 text-xs"
                                    title={s.reason}
                                    onClick={() =>
                                      setExpanded({
                                        id: t.id,
                                        mode: "code",
                                        initialAccountId: s.offsetAccountId,
                                      })
                                    }
                                  >
                                    {[s.accountCode, s.accountName].filter(Boolean).join(" ") ||
                                      "Account"}{" "}
                                    · {Math.round(s.confidence * 100)}%
                                  </Button>
                                ))}
                              </div>
                            ) : suggestQ.data ? (
                              <Alert>
                                <AlertDescription>
                                  {suggestQ.data.externalResearchNote}
                                </AlertDescription>
                              </Alert>
                            ) : null}
                            {optionsQ.data ? (
                              <BankCodingPanel
                                key={`${t.id}-${open.initialAccountId ?? ""}`}
                                companyId={companyId}
                                txn={{
                                  id: t.id,
                                  amountMinor: t.amount_minor,
                                  description: t.description,
                                }}
                                currency={currency}
                                options={optionsQ.data}
                                {...(open.initialAccountId
                                  ? { initialAccountId: open.initialAccountId }
                                  : {})}
                                onCancel={() => setExpanded(null)}
                                onDone={() => {
                                  setExpanded(null);
                                  void invalidate();
                                }}
                              />
                            ) : optionsQ.isError ? (
                              <p className="text-sm text-destructive">
                                {friendlyAuthError(optionsQ.error)}
                              </p>
                            ) : (
                              <LoadingState rows={2} />
                            )}
                          </div>
                        ) : (
                          <BankMatchPanel
                            companyId={companyId}
                            txn={{
                              id: t.id,
                              amountMinor: t.amount_minor,
                              description: t.description,
                              bankAccountId: t.bank_account_id,
                            }}
                            currency={currency}
                            onCancel={() => setExpanded(null)}
                            onDone={() => {
                              setExpanded(null);
                              void invalidate();
                            }}
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      )}

      {txnsQ.data ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            Showing {total === 0 ? 0 : page * pageSize + 1}–{page * pageSize + rows.length} of{" "}
            {total}
          </span>
          <div className="flex items-center gap-2">
            <Select
              value={String(pageSize)}
              onValueChange={(v) =>
                setSearch({ pageSize: Number(v) === 50 ? undefined : Number(v) })
              }
            >
              <SelectTrigger className="h-8 w-28" aria-label="Rows per page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[25, 50, 100, 200].map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} / page
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              disabled={page === 0}
              onClick={() => setSearch({ page: page - 1 || undefined }, true)}
            >
              Previous
            </Button>
            <span>
              Page {page + 1} of {pageCount}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={page + 1 >= pageCount}
              onClick={() => setSearch({ page: page + 1 }, true)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
