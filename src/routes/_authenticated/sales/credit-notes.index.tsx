import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { useFormat } from "@/hooks/use-format";
import { exportCreditNotesCsv, listCreditNotes } from "@/lib/sales/sales-credits.functions";
import { creditNoteStatusLabel } from "@/lib/sales/allocation-rules";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, ListSkeleton, ErrorState, EmptyState } from "@/components/common/states";
import { StatusBadge } from "@/components/common/stat-card";
import {
  ListToolbar,
  Pager,
  TableCard,
  SortHead,
  downloadCsv,
  initialListState,
  useDebounced,
  type ListState,
} from "@/components/sales/ListKit";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/sales/credit-notes/")({
  head: () => ({ meta: [{ title: "Credit notes — LinkBooks" }] }),
  component: CreditNotesList,
});

const STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "authorised", label: "Awaiting allocation" },
  { value: "partly_paid", label: "Partly applied" },
  { value: "paid", label: "Fully applied" },
  { value: "void", label: "Void" },
];

function CreditNotesList() {
  const { company } = useActiveCompany();
  const fmt = useFormat();
  const companyId = company?.id;
  const fetchCredits = useServerFn(listCreditNotes);
  const exportCsv = useServerFn(exportCreditNotesCsv);
  const [state, setState] = useState<ListState>(initialListState("credit_date"));
  const patch = (p: Partial<ListState>) => setState((s) => ({ ...s, ...p }));
  const q = useDebounced(state.q);

  const filters = () => ({
    companyId: companyId!,
    q,
    ...(state.status !== "all" ? { status: state.status } : {}),
    ...(state.from ? { from: state.from } : {}),
    ...(state.to ? { to: state.to } : {}),
    sort: state.sort,
    dir: state.dir,
  });
  const query = useQuery({
    queryKey: ["sales-credits", companyId, q, state],
    enabled: Boolean(companyId),
    placeholderData: keepPreviousData,
    queryFn: () =>
      fetchCredits({ data: { ...filters(), page: state.page, pageSize: state.pageSize } }),
  });
  const exporter = useMutation({
    mutationFn: () => exportCsv({ data: filters() }),
    onSuccess: (r) => {
      downloadCsv(r.filename, r.csv);
      toast.success(`Exported ${r.rowCount} credit notes`);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  const rows = query.data?.rows ?? [];

  return (
    <>
      <PageHeader
        title="Credit notes"
        description="Authorising posts a reversing AR journal. Apply the credit to invoices without a second posting."
        actions={
          <Button size="sm" asChild>
            <Link to="/sales/credit-notes/new">New credit note</Link>
          </Button>
        }
      />
      <ListToolbar
        state={state}
        onChange={patch}
        statuses={STATUSES}
        searchPlaceholder="Search number, memo or customer"
        onExport={() => exporter.mutate()}
        exporting={exporter.isPending}
      />
      {query.isPending ? (
        <ListSkeleton />
      ) : query.isError ? (
        <ErrorState
          title="Could not load credit notes"
          description={friendlyAuthError(query.error)}
          onRetry={() => query.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No credit notes"
          description="No credit notes match — create one for a customer."
          action={
            <Button size="sm" asChild>
              <Link to="/sales/credit-notes/new">New credit note</Link>
            </Button>
          }
        />
      ) : (
        <>
          <TableCard>
            <Table>
              <TableHeader>
                <TableRow>
                  <SortHead label="Number" column="credit_number" state={state} onChange={patch} />
                  <SortHead label="Date" column="credit_date" state={state} onChange={patch} />
                  <TableHead>Customer</TableHead>
                  <SortHead label="Status" column="status" state={state} onChange={patch} />
                  <SortHead
                    label="Total"
                    column="total_minor"
                    state={state}
                    onChange={patch}
                    className="text-right"
                  />
                  <TableHead className="text-right">Applied</TableHead>
                  <TableHead className="text-right">Remaining credit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => {
                  const live = ["authorised", "partly_paid"].includes(c.status);
                  return (
                    <TableRow key={c.id}>
                      <TableCell>
                        <Link
                          className="underline-offset-2 hover:underline"
                          to="/sales/credit-notes/$creditNoteId"
                          params={{ creditNoteId: c.id }}
                        >
                          {c.credit_number ?? c.id.slice(0, 8)}
                        </Link>
                      </TableCell>
                      <TableCell>{fmt.date(c.credit_date)}</TableCell>
                      <TableCell>{c.contacts?.name ?? "—"}</TableCell>
                      <TableCell>
                        <StatusBadge status={c.status} label={creditNoteStatusLabel(c.status)} />
                      </TableCell>
                      <TableCell className="money">
                        {fmt.money(c.total_minor, c.currency_code)}
                      </TableCell>
                      <TableCell className="money">
                        {fmt.money(c.amount_allocated_minor, c.currency_code)}
                      </TableCell>
                      <TableCell className="money">
                        {fmt.money(
                          live ? c.total_minor - c.amount_allocated_minor : 0,
                          c.currency_code,
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableCard>
          <Pager total={query.data?.total ?? 0} state={state} onChange={patch} />
        </>
      )}
    </>
  );
}
