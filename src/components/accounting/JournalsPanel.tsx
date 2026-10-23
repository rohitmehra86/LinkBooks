"use client";

import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import {
  getJournalDetail,
  listJournals,
  reversePostedJournal,
  type JournalListItem,
} from "@/lib/accounting/accounting.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { roleHasPermission } from "@/lib/permissions";
import { useFormat } from "@/hooks/use-format";
import { SortableHead } from "@/components/common/sortable-head";
import { nextSort, sortRows, type SortState } from "@/lib/sort";
import { useActiveCompany } from "@/hooks/use-active-company";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const SOURCE_LABEL: Record<string, string> = {
  manual: "Manual journal",
  opening_balance: "Opening balance",
  sales_invoice: "Sales invoice",
  sales_credit_note: "Sales credit note",
  customer_payment: "Customer payment",
  purchase_bill: "Bill",
  purchase_credit_note: "Supplier credit",
  supplier_payment: "Supplier payment",
  expense: "Expense",
  bank_transaction: "Bank transaction",
  bank_transfer: "Bank transfer",
  tax_adjustment: "Tax adjustment",
  reversal: "Reversal",
  other: "Bank document",
  fx_revaluation: "FX revaluation",
};

/** Only hand-made journals are reversed here. Documents are voided from their own page so the subledger stays in step. */
function canReverseHere(journal: JournalListItem): boolean {
  return (
    journal.status === "posted" &&
    !journal.reversed_by_journal_id &&
    (journal.source_type === "manual" || journal.source_type === "opening_balance")
  );
}

export function JournalsPanel({
  companyId,
  currency,
  initialOpenJournalId,
}: {
  companyId: string;
  currency: string;
  /** Opens this journal's lines on load (deep link from reports and search). */
  initialOpenJournalId?: string | undefined;
}) {
  const { company } = useActiveCompany();
  const fmt = useFormat();
  const qc = useQueryClient();
  const fetchJournals = useServerFn(listJournals);
  const fetchDetail = useServerFn(getJournalDetail);
  const reverse = useServerFn(reversePostedJournal);
  const canReverse = roleHasPermission(company?.role ?? "read_only", "journals.manual");

  const [search, setSearch] = useState("");
  const [source, setSource] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [limit, setLimit] = useState(100);
  const [open, setOpen] = useState<string | null>(initialOpenJournalId ?? null);
  const [sort, setSort] = useState<SortState<"number" | "date" | "source" | "amount"> | null>(null);

  const query = useQuery({
    queryKey: ["journals", companyId, search, source, from, to, limit],
    queryFn: () =>
      fetchJournals({
        data: {
          companyId,
          limit,
          ...(search ? { search } : {}),
          ...(source ? { source } : {}),
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
        },
      }),
  });

  const detail = useQuery({
    queryKey: ["journal-detail", companyId, open],
    enabled: Boolean(open),
    queryFn: () => fetchDetail({ data: { companyId, journalId: open! } }),
  });

  const reverseM = useMutation({
    mutationFn: (journalId: string) => reverse({ data: { journalId } }),
    onSuccess: async () => {
      toast.success("Reversing journal posted");
      await qc.invalidateQueries({ queryKey: ["journals", companyId] });
      await qc.invalidateQueries({ queryKey: ["journal-detail", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const fetched = query.data ?? [];
  const rows = !sort
    ? fetched
    : sortRows(
        fetched,
        (j) =>
          sort.key === "number"
            ? j.journal_number
            : sort.key === "date"
              ? j.journal_date
              : sort.key === "source"
                ? (SOURCE_LABEL[j.source_type] ?? j.source_type)
                : j.total_debit_minor,
        sort.dir,
      );
  const headProps = (key: "number" | "date" | "source" | "amount") => ({
    active: sort?.key === key,
    dir: sort?.dir ?? ("asc" as const),
    onSort: () => setSort((cur) => nextSort(cur, key)),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <Input
          aria-label="Search journals"
          className="h-9 w-56"
          placeholder="Search number or narration"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label="Journal source"
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        >
          <option value="">All sources</option>
          {Object.entries(SOURCE_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <Input
          aria-label="From date"
          type="date"
          className="h-9 w-40"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <Input
          aria-label="To date"
          type="date"
          className="h-9 w-40"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        {search || source || from || to ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setSearch("");
              setSource("");
              setFrom("");
              setTo("");
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </div>

      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState
          title="Could not load journals"
          description={friendlyAuthError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No journals found"
          description="Change the filters, or post a manual journal."
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <SortableHead label="#" {...headProps("number")} />
                <SortableHead label="Date" {...headProps("date")} />
                <SortableHead label="Source" {...headProps("source")} />
                <TableHead>Narration</TableHead>
                <SortableHead label="Amount" align="right" {...headProps("amount")} />
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((j) => {
                const expanded = open === j.id;
                return (
                  <Fragment key={j.id}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() => setOpen(expanded ? null : j.id)}
                    >
                      <TableCell>
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-label={`${expanded ? "Hide" : "Show"} lines of journal ${j.journal_number}`}
                          className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpen(expanded ? null : j.id);
                          }}
                        >
                          {expanded ? (
                            <ChevronDown className="size-4" />
                          ) : (
                            <ChevronRight className="size-4" />
                          )}
                        </button>
                      </TableCell>
                      <TableCell>{j.journal_number}</TableCell>
                      <TableCell>{fmt.date(j.journal_date)}</TableCell>
                      <TableCell>{SOURCE_LABEL[j.source_type] ?? j.source_type}</TableCell>
                      <TableCell className="max-w-[260px] truncate">{j.memo ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmt.amount(j.total_debit_minor, j.currency_code || currency)}
                      </TableCell>
                      <TableCell className="space-x-1">
                        <Badge variant="secondary" className="capitalize">
                          {j.status}
                        </Badge>
                        {j.reversed_by_journal_id ? (
                          <Badge variant="outline">reversed</Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        {canReverse && canReverseHere(j) ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={reverseM.isPending}
                            onClick={() => {
                              if (
                                confirm(
                                  `Reverse journal ${j.journal_number}? A new journal will post the opposite entries.`,
                                )
                              ) {
                                reverseM.mutate(j.id);
                              }
                            }}
                          >
                            Reverse
                          </Button>
                        ) : j.status === "posted" &&
                          !j.reversed_by_journal_id &&
                          j.source_type !== "reversal" ? (
                          <span className="text-xs text-muted-foreground">
                            Void the source document
                          </span>
                        ) : null}
                      </TableCell>
                    </TableRow>
                    {expanded ? (
                      <TableRow>
                        <TableCell />
                        <TableCell colSpan={7}>
                          {detail.isPending ? (
                            <p className="py-2 text-sm text-muted-foreground">Loading lines…</p>
                          ) : detail.isError ? (
                            <p className="py-2 text-sm text-destructive">
                              {friendlyAuthError(detail.error)}
                            </p>
                          ) : (
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Account</TableHead>
                                  <TableHead>Description</TableHead>
                                  <TableHead className="text-right">Debit</TableHead>
                                  <TableHead className="text-right">Credit</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {detail.data?.lines.map((line) => (
                                  <TableRow key={line.id}>
                                    <TableCell>
                                      {line.account_code} {line.account_name}
                                    </TableCell>
                                    <TableCell>{line.description ?? "—"}</TableCell>
                                    <TableCell className="text-right tabular-nums">
                                      {line.debit_minor
                                        ? fmt.amount(line.debit_minor, currency)
                                        : ""}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                      {line.credit_minor
                                        ? fmt.amount(line.credit_minor, currency)
                                        : ""}
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          )}
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
          {rows.length >= limit ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLimit((n) => Math.min(500, n + 100))}
            >
              Show more
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
