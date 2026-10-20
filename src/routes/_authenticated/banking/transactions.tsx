import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import {
  applyRulesToUncategorised,
  categoriseTransaction,
  excludeBankTransaction,
  listBankAccounts,
  listBankTransactions,
  restoreBankTransaction,
  suggestBankCoding,
} from "@/lib/banking/banking.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

type Search = {
  status?: string;
  statusGroup?: string;
  q?: string;
};

export const Route = createFileRoute("/_authenticated/banking/transactions")({
  validateSearch: (s: Record<string, unknown>): Search => {
    const out: Search = {};
    if (typeof s["status"] === "string") out.status = s["status"];
    if (typeof s["statusGroup"] === "string") out.statusGroup = s["statusGroup"];
    if (typeof s["q"] === "string") out.q = s["q"];
    return out;
  },
  head: () => ({ meta: [{ title: "Bank transactions — LinkBooks" }] }),
  component: BankTransactions,
});

function BankTransactions() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const qc = useQueryClient();

  const fetchTxns = useServerFn(listBankTransactions);
  const fetchAccounts = useServerFn(listBankAccounts);
  const fetchGl = useServerFn(listAccounts);
  const categorise = useServerFn(categoriseTransaction);
  const applyRules = useServerFn(applyRulesToUncategorised);
  const doExclude = useServerFn(excludeBankTransaction);
  const doRestore = useServerFn(restoreBankTransaction);
  const fetchSuggest = useServerFn(suggestBankCoding);

  const [bankAccountId, setBankAccountId] = useState("all");
  const [status, setStatus] = useState(search.status ?? "uncategorised");
  const [statusGroup, setStatusGroup] = useState(search.statusGroup ?? "");
  const [q, setQ] = useState(search.q ?? "");
  const [offsetByTxn, setOffsetByTxn] = useState<Record<string, string>>({});
  const [suggestFor, setSuggestFor] = useState<string | null>(null);

  useEffect(() => {
    if (search.status !== undefined) setStatus(search.status);
    if (search.statusGroup !== undefined) setStatusGroup(search.statusGroup);
    if (search.q !== undefined) setQ(search.q);
  }, [search.status, search.statusGroup, search.q]);

  const accountsQ = useQuery({
    queryKey: ["bank-accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });
  const txnsQ = useQuery({
    queryKey: ["bank-transactions", companyId, bankAccountId, status, statusGroup, q],
    enabled: Boolean(companyId),
    queryFn: () =>
      fetchTxns({
        data: {
          companyId: companyId!,
          ...(bankAccountId !== "all" ? { bankAccountId } : {}),
          ...(statusGroup
            ? { statusGroup }
            : status && status !== "all"
              ? { status }
              : {}),
          ...(q.trim() ? { q: q.trim() } : {}),
        },
      }),
  });
  const glQ = useQuery({
    queryKey: ["accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchGl({ data: { companyId: companyId! } }),
  });
  const suggestQ = useQuery({
    queryKey: ["bank-suggest", companyId, suggestFor],
    enabled: Boolean(companyId && suggestFor),
    queryFn: () =>
      fetchSuggest({ data: { companyId: companyId!, bankTransactionId: suggestFor! } }),
  });

  const offsets = (
    (glQ.data ?? []) as Array<{
      id: string;
      code: string;
      name: string;
      is_postable: boolean;
      is_active: boolean;
    }>
  ).filter((a) => a.is_active && a.is_postable);

  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ["bank-transactions", companyId] });
    await qc.invalidateQueries({ queryKey: ["banking-counts", companyId] });
  };

  const catM = useMutation({
    mutationFn: (txnId: string) => {
      const offset = offsetByTxn[txnId];
      if (!offset) throw new Error("Choose an offset account");
      return categorise({
        data: { companyId: companyId!, bankTransactionId: txnId, offsetAccountId: offset },
      });
    },
    onSuccess: async () => {
      await invalidate();
      toast.success("Categorised — one journal posted and linked");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const rulesM = useMutation({
    mutationFn: () =>
      applyRules({
        data: {
          companyId: companyId!,
          ...(bankAccountId !== "all" ? { bankAccountId } : {}),
        },
      }),
    onSuccess: async (r) => {
      await invalidate();
      toast.success(`Rules applied: ${r.applied}; skipped: ${r.skipped}`);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const excludeM = useMutation({
    mutationFn: (txnId: string) =>
      doExclude({ data: { companyId: companyId!, bankTransactionId: txnId } }),
    onSuccess: async () => {
      await invalidate();
      toast.success("Excluded — no journal created");
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

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

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
              : status === "all"
                ? "All bank transactions"
                : "For review";

  return (
    <>
      <PageHeader
        title={title}
        description="Processing status (uncategorised / matched / excluded) is independent of reconciliation status. Categorising posts one balanced journal via the shared engine."
        actions={
          <Button size="sm" variant="outline" disabled={rulesM.isPending} onClick={() => rulesM.mutate()}>
            Apply bank rules
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <Select
          value={bankAccountId}
          onValueChange={setBankAccountId}
        >
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Account" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All accounts</SelectItem>
            {((accountsQ.data ?? []) as Array<{ id: string; name: string }>).map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={statusGroup || status || "all"}
          onValueChange={(v) => {
            if (v === "unreconciled" || v === "posted") {
              setStatusGroup(v);
              setStatus("all");
              void navigate({ search: { statusGroup: v } });
            } else {
              setStatusGroup("");
              setStatus(v);
              void navigate({ search: { status: v } });
            }
          }}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="uncategorised">For review</SelectItem>
            <SelectItem value="matched">Matched (posted)</SelectItem>
            <SelectItem value="reconciled">Reconciled</SelectItem>
            <SelectItem value="unreconciled">Unreconciled</SelectItem>
            <SelectItem value="posted">Posted (matched+reconciled)</SelectItem>
            <SelectItem value="excluded">Excluded</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
        <Input
          className="max-w-xs"
          placeholder="Search description…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void navigate({ search: { ...(statusGroup ? { statusGroup } : { status }), q } });
          }}
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void navigate({ search: { ...(statusGroup ? { statusGroup } : { status }), q } })
          }
        >
          Search
        </Button>
        <Button size="sm" variant="outline" asChild>
          <Link to="/banking/cash-coding">Open cash coding</Link>
        </Button>
      </div>

      {txnsQ.isPending ? (
        <LoadingState />
      ) : txnsQ.isError ? (
        <ErrorState title="Could not load" description={friendlyAuthError(txnsQ.error)} />
      ) : (txnsQ.data?.rows ?? []).length === 0 ? (
        <EmptyState title="No transactions" description="Import a CSV or change filters." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Journal</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(
              txnsQ.data!.rows as Array<{
                id: string;
                txn_date: string;
                description: string | null;
                amount_minor: number;
                status: string;
                exclude_reason: string | null;
                link: { journal_id: string | null; journal_number: number | null } | null;
              }>
            ).map((t) => (
              <TableRow key={t.id}>
                <TableCell className="whitespace-nowrap">{t.txn_date}</TableCell>
                <TableCell>
                  <div>{t.description ?? "—"}</div>
                  {t.exclude_reason ? (
                    <div className="text-xs text-muted-foreground">Excluded: {t.exclude_reason}</div>
                  ) : null}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {fromMinorUnits(t.amount_minor, currency)}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{t.status}</Badge>
                </TableCell>
                <TableCell>
                  {t.link?.journal_number != null ? (
                    <Link
                      to="/accounting"
                      className="text-sm underline-offset-4 hover:underline"
                    >
                      Journal #{t.link.journal_number}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1">
                    {t.status === "uncategorised" ? (
                      <>
                        <Select
                          value={offsetByTxn[t.id] ?? ""}
                          onValueChange={(v) => setOffsetByTxn((m) => ({ ...m, [t.id]: v }))}
                        >
                          <SelectTrigger className="h-8 w-40">
                            <SelectValue placeholder="GL account" />
                          </SelectTrigger>
                          <SelectContent>
                            {offsets.map((a) => (
                              <SelectItem key={a.id} value={a.id}>
                                {a.code} {a.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          size="sm"
                          disabled={catM.isPending}
                          onClick={() => catM.mutate(t.id)}
                        >
                          Post
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setSuggestFor(suggestFor === t.id ? null : t.id)}
                        >
                          Suggest
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
                  {suggestFor === t.id && suggestQ.data ? (
                    <div className="mt-2 max-w-md space-y-1 rounded border p-2 text-xs">
                      <Alert>
                        <AlertDescription>{suggestQ.data.externalResearchNote}</AlertDescription>
                      </Alert>
                      {suggestQ.data.suggestions.length === 0 ? (
                        <p className="text-muted-foreground">No local suggestions yet.</p>
                      ) : (
                        suggestQ.data.suggestions.map((s) => (
                          <button
                            key={`${s.offsetAccountId}-${s.reason}`}
                            type="button"
                            className="block w-full rounded px-2 py-1 text-left hover:bg-muted"
                            onClick={() =>
                              setOffsetByTxn((m) => ({ ...m, [t.id]: s.offsetAccountId }))
                            }
                          >
                            <span className="font-medium">
                              {[s.accountCode, s.accountName].filter(Boolean).join(" ") || "Account"}
                            </span>{" "}
                            · {Math.round(s.confidence * 100)}% — {s.reason}
                          </button>
                        ))
                      )}
                    </div>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {txnsQ.data ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Showing {txnsQ.data.rows.length} of {txnsQ.data.total}
        </p>
      ) : null}
    </>
  );
}
