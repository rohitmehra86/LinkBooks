import { useEffect, useMemo, useState } from "react";
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
  type BankTxnListRow,
} from "@/lib/banking/banking.functions";
import { bulkCodeByFilter, listCodingOptions } from "@/lib/banking/coding.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { ConfirmButton } from "@/components/banking/ConfirmButton";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const ALL = "all";
const NONE = "none";
const PAGE_SIZE = 100;

type Search = { bankAccountId?: string; dateFrom?: string; dateTo?: string };

export const Route = createFileRoute("/_authenticated/banking/cash-coding")({
  validateSearch: (s: Record<string, unknown>): Search => {
    const out: Search = {};
    if (typeof s["bankAccountId"] === "string" && s["bankAccountId"])
      out.bankAccountId = s["bankAccountId"];
    if (typeof s["dateFrom"] === "string" && ISO.test(s["dateFrom"])) out.dateFrom = s["dateFrom"];
    if (typeof s["dateTo"] === "string" && ISO.test(s["dateTo"])) out.dateTo = s["dateTo"];
    return out;
  },
  head: () => ({
    meta: [
      { title: "Cash coding — LinkBooks" },
      { name: "description", content: "Bulk-code uncategorised bank statement lines." },
    ],
  }),
  component: CashCoding,
});

function CashCoding() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const qc = useQueryClient();
  const fetchTxns = useServerFn(listBankTransactions);
  const fetchAccounts = useServerFn(listBankAccounts);
  const fetchOptions = useServerFn(listCodingOptions);
  const bulkCat = useServerFn(bulkCategoriseTransactions);
  const bulkFilter = useServerFn(bulkCodeByFilter);
  const doExclude = useServerFn(excludeBankTransaction);

  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [offsetAccountId, setOffsetAccountId] = useState("");
  const [taxCodeId, setTaxCodeId] = useState(NONE);
  const [contactId, setContactId] = useState(NONE);
  const [progress, setProgress] = useState<string | null>(null);

  const setSearch = (patch: { [K in keyof Search]?: Search[K] | undefined }) =>
    void navigate({
      search: ((prev: Search) => {
        const next: Record<string, unknown> = { ...prev, ...patch };
        for (const k of Object.keys(next))
          if (next[k] === undefined || next[k] === "") delete next[k];
        return next;
      }) as never,
    });

  useEffect(() => {
    setPage(0);
    setSelected(new Set());
  }, [search.bankAccountId, search.dateFrom, search.dateTo]);

  const accountsQ = useQuery({
    queryKey: ["bank-accounts", companyId, "all"],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId!, includeInactive: true } }),
  });
  const optionsQ = useQuery({
    queryKey: ["bank-coding-options", companyId],
    enabled: Boolean(companyId),
    staleTime: 60_000,
    queryFn: () => fetchOptions({ data: { companyId: companyId! } }),
  });
  const txnsQ = useQuery({
    queryKey: [
      "bank-transactions",
      companyId,
      "cash",
      search.bankAccountId,
      search.dateFrom,
      search.dateTo,
      page,
    ],
    enabled: Boolean(companyId),
    placeholderData: (prev) => prev,
    queryFn: () =>
      fetchTxns({
        data: {
          companyId: companyId!,
          status: "uncategorised",
          pageSize: PAGE_SIZE,
          page,
          ...(search.bankAccountId ? { bankAccountId: search.bankAccountId } : {}),
          ...(search.dateFrom ? { dateFrom: search.dateFrom } : {}),
          ...(search.dateTo ? { dateTo: search.dateTo } : {}),
        },
      }),
  });

  const currencyByAccount = useMemo(
    () => new Map((accountsQ.data ?? []).map((a) => [a.id, a.currency_code])),
    [accountsQ.data],
  );
  const rows = useMemo(() => (txnsQ.data?.rows ?? []) as BankTxnListRow[], [txnsQ.data?.rows]);
  const total = txnsQ.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currencyOf = (r: BankTxnListRow) =>
    currencyByAccount.get(r.bank_account_id) ?? company?.base_currency ?? "GBP";

  // Totals per currency: lines from different bank accounts can be in different currencies.
  const summary = useMemo(() => {
    const byCcy = new Map<string, { moneyIn: bigint; moneyOut: bigint }>();
    for (const r of rows) {
      if (!selected.has(r.id)) continue;
      const ccy = currencyByAccount.get(r.bank_account_id) ?? company?.base_currency ?? "GBP";
      const e = byCcy.get(ccy) ?? { moneyIn: 0n, moneyOut: 0n };
      if (r.amount_minor >= 0) e.moneyIn += BigInt(r.amount_minor);
      else e.moneyOut += BigInt(r.amount_minor);
      byCcy.set(ccy, e);
    }
    return byCcy;
  }, [selected, rows, currencyByAccount, company?.base_currency]);

  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ["bank-transactions", companyId] });
    await qc.invalidateQueries({ queryKey: ["banking-counts", companyId] });
    await qc.invalidateQueries({ queryKey: ["bank-account-summaries", companyId] });
    setSelected(new Set());
  };

  const bulkM = useMutation({
    mutationFn: () =>
      bulkCat({
        data: {
          companyId: companyId!,
          bankTransactionIds: [...selected],
          offsetAccountId,
          taxCodeId: taxCodeId === NONE ? null : taxCodeId,
          contactId: contactId === NONE ? null : contactId,
        },
      }),
    onSuccess: async (r) => {
      await invalidate();
      toast.success(`Posted ${r.succeeded}; failed ${r.failed}`);
      const first = r.results.find((x) => !x.ok);
      if (first?.error) toast.error(first.error);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const allMatchingM = useMutation({
    mutationFn: async () => {
      let coded = 0;
      let failed = 0;
      let firstError = "";
      for (let guard = 0; guard < 200; guard++) {
        const r = await bulkFilter({
          data: {
            companyId: companyId!,
            ...(search.bankAccountId ? { bankAccountId: search.bankAccountId } : {}),
            ...(search.dateFrom ? { dateFrom: search.dateFrom } : {}),
            ...(search.dateTo ? { dateTo: search.dateTo } : {}),
            accountId: offsetAccountId,
            taxCodeId: taxCodeId === NONE ? null : taxCodeId,
            contactId: contactId === NONE ? null : contactId,
          },
        });
        coded += r.coded;
        failed += r.failed;
        if (!firstError && r.errors[0]) firstError = r.errors[0];
        setProgress(`${coded} coded… ${r.remaining} remaining`);
        if (r.remaining === 0 || r.stuck) break;
      }
      return { coded, failed, firstError };
    },
    onSuccess: async (r) => {
      setProgress(null);
      await invalidate();
      if (r.failed)
        toast.warning(`${r.coded} coded, ${r.failed} could not be coded. ${r.firstError}`);
      else toast.success(`${r.coded} lines coded`);
    },
    onError: async (e) => {
      setProgress(null);
      await invalidate();
      toast.error(friendlyAuthError(e));
    },
  });

  const excludeM = useMutation({
    mutationFn: async () => {
      let n = 0;
      for (const id of selected) {
        await doExclude({ data: { companyId: companyId!, bankTransactionId: id } });
        n += 1;
      }
      return n;
    },
    onSuccess: async (n) => {
      await invalidate();
      toast.success(`Excluded ${n}. No journals created.`);
    },
    onError: async (e) => {
      await invalidate();
      toast.error(friendlyAuthError(e));
    },
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  const allPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const taxChoices = (optionsQ.data?.taxCodes ?? []).filter(
    (t) => t.rateActive && t.treatment !== "reverse_charge",
  );

  return (
    <>
      <PageHeader
        title="Cash coding"
        description="Select uncategorised statement lines and apply one account (and optional tax code). Each line posts its own balanced journal through the shared posting engine."
        actions={
          <Button size="sm" variant="outline" asChild>
            <Link to="/banking/transactions" search={{ status: "uncategorised" }}>
              For review
            </Link>
          </Button>
        }
      />

      <Alert className="mb-4">
        <AlertTitle>Accountant workflow</AlertTitle>
        <AlertDescription>
          Money in a tax code applies to sales; money out to purchases. Lines the tax code does not
          fit are skipped and reported, never half-posted.
        </AlertDescription>
      </Alert>

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
              </SelectItem>
            ))}
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
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-2">
        <Select value={offsetAccountId} onValueChange={setOffsetAccountId}>
          <SelectTrigger className="w-56" aria-label="Account to code to">
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
        <Select value={taxCodeId} onValueChange={setTaxCodeId}>
          <SelectTrigger className="w-40" aria-label="Tax code">
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
        <Select value={contactId} onValueChange={setContactId}>
          <SelectTrigger className="w-48" aria-label="Contact">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>No contact</SelectItem>
            {(optionsQ.data?.contacts ?? []).map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          disabled={!selected.size || !offsetAccountId || bulkM.isPending}
          onClick={() => bulkM.mutate()}
        >
          Post selected ({selected.size})
        </Button>
        <ConfirmButton
          title={`Exclude ${selected.size} transaction(s)?`}
          description="Excluded lines are not posted anywhere. You can restore them later."
          confirmLabel="Exclude"
          disabled={!selected.size || excludeM.isPending}
          onConfirm={() => excludeM.mutate()}
        >
          Exclude selected
        </ConfirmButton>
        {allPageSelected && total > rows.length ? (
          <ConfirmButton
            variant="secondary"
            title={`Code all ${total} matching lines?`}
            description="Every uncategorised line matching the account and date filters above is coded to the chosen account, one journal each. Lines that cannot be coded are skipped and reported."
            confirmLabel={`Code all ${total}`}
            disabled={!offsetAccountId || allMatchingM.isPending}
            onConfirm={() => allMatchingM.mutate()}
          >
            Select all {total} matching and code
          </ConfirmButton>
        ) : null}
      </div>

      <p className="mb-3 text-sm text-muted-foreground">
        Selected {selected.size}
        {[...summary.entries()].map(([ccy, s]) => (
          <span key={ccy}>
            {" "}
            · {ccy}: in {fromMinorUnits(s.moneyIn, ccy)}, out {fromMinorUnits(s.moneyOut, ccy)}
          </span>
        ))}
        {progress ? ` · ${progress}` : ""}
      </p>

      {txnsQ.isPending ? (
        <LoadingState />
      ) : txnsQ.isError ? (
        <ErrorState title="Could not load" description={friendlyAuthError(txnsQ.error)} />
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing to code" description="No uncategorised transactions." />
      ) : (
        <>
          <div className="overflow-auto rounded-md border">
            <Table>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      aria-label="Select all on this page"
                      checked={allPageSelected}
                      onCheckedChange={(on) =>
                        setSelected(on === true ? new Set(rows.map((r) => r.id)) : new Set())
                      }
                    />
                  </TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>
                      <Checkbox
                        aria-label={`Select ${t.description ?? "transaction"}`}
                        checked={selected.has(t.id)}
                        onCheckedChange={(on) =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (on === true) next.add(t.id);
                            else next.delete(t.id);
                            return next;
                          })
                        }
                      />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{t.txn_date}</TableCell>
                    <TableCell>
                      {t.description ?? "—"}
                      {t.reference ? (
                        <span className="ml-2 text-xs text-muted-foreground">
                          Ref {t.reference}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono text-sm">
                      {fromMinorUnits(t.amount_minor, currencyOf(t))}{" "}
                      <span className="text-xs">{currencyOf(t)}</span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Showing {page * PAGE_SIZE + 1}–{page * PAGE_SIZE + rows.length} of {total}
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
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
                onClick={() => setPage(page + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
