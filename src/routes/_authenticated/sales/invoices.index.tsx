import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { exportInvoicesCsv, listInvoices } from "@/lib/sales/sales.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import {
  ListToolbar,
  Pager,
  SortHead,
  downloadCsv,
  initialListState,
  useDebounced,
  type ListState,
} from "@/components/sales/ListKit";
import { money } from "@/components/sales/sales-form-utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/sales/invoices/")({
  head: () => ({ meta: [{ title: "Invoices — LinkBooks" }] }),
  component: InvoicesList,
});

const STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "authorised", label: "Authorised" },
  { value: "partly_paid", label: "Partly paid" },
  { value: "paid", label: "Paid" },
  { value: "void", label: "Void" },
];

function InvoicesList() {
  const { company } = useActiveCompany();
  const fetchInvoices = useServerFn(listInvoices);
  const exportCsv = useServerFn(exportInvoicesCsv);
  const companyId = company?.id;
  const [state, setState] = useState<ListState>(initialListState("invoice_date"));
  const [overdue, setOverdue] = useState(false);
  const patch = (p: Partial<ListState>) => setState((s) => ({ ...s, ...p }));
  const q = useDebounced(state.q);

  const filters = () => ({
    companyId: companyId!,
    q,
    ...(state.status !== "all" ? { status: state.status } : {}),
    ...(overdue ? { overdue: true } : {}),
    ...(state.from ? { from: state.from } : {}),
    ...(state.to ? { to: state.to } : {}),
    sort: state.sort,
    dir: state.dir,
  });

  const query = useQuery({
    queryKey: ["sales-invoices", companyId, q, state, overdue],
    enabled: Boolean(companyId),
    placeholderData: keepPreviousData,
    queryFn: () =>
      fetchInvoices({ data: { ...filters(), page: state.page, pageSize: state.pageSize } }),
  });
  const exporter = useMutation({
    mutationFn: () => exportCsv({ data: filters() }),
    onSuccess: (r) => {
      downloadCsv(r.filename, r.csv);
      toast.success(`Exported ${r.rowCount} invoices`);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  const rows = query.data?.rows ?? [];
  const today = query.data?.today ?? "";

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Customer invoices. Authorising posts Accounts Receivable via the shared ledger."
        actions={
          <Button size="sm" asChild>
            <Link to="/sales/invoices/new">New invoice</Link>
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
        extra={
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input
              type="checkbox"
              checked={overdue}
              onChange={(e) => {
                setOverdue(e.target.checked);
                patch({ page: 0 });
              }}
            />
            Overdue only
          </label>
        }
      />
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState
          title="Could not load invoices"
          description={friendlyAuthError(query.error)}
          onRetry={() => query.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No invoices"
          description={
            q || state.status !== "all" || overdue || state.from || state.to
              ? "No invoices match these filters."
              : "Create a customer invoice to start."
          }
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <SortHead label="Number" column="invoice_number" state={state} onChange={patch} />
                <SortHead label="Date" column="invoice_date" state={state} onChange={patch} />
                <SortHead label="Due" column="due_date" state={state} onChange={patch} />
                <TableHead>Customer</TableHead>
                <SortHead label="Status" column="status" state={state} onChange={patch} />
                <SortHead
                  label="Total"
                  column="total_minor"
                  state={state}
                  onChange={patch}
                  className="text-right"
                />
                <TableHead className="text-right">Outstanding</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((inv) => {
                const live = ["authorised", "partly_paid"].includes(inv.status);
                const out = live
                  ? inv.total_minor - inv.amount_paid_minor - inv.amount_credited_minor
                  : 0;
                const isOverdue = live && out > 0 && inv.due_date < today;
                return (
                  <TableRow key={inv.id}>
                    <TableCell>
                      <Link
                        to="/sales/invoices/$invoiceId"
                        params={{ invoiceId: inv.id }}
                        className="underline-offset-2 hover:underline"
                      >
                        {inv.invoice_number ?? inv.id.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell>{inv.invoice_date}</TableCell>
                    <TableCell>{inv.due_date}</TableCell>
                    <TableCell>{inv.contacts?.name ?? "—"}</TableCell>
                    <TableCell className="space-x-1">
                      <Badge variant="secondary">{inv.status.replace("_", " ")}</Badge>
                      {isOverdue ? <Badge variant="destructive">overdue</Badge> : null}
                    </TableCell>
                    <TableCell className="text-right">
                      {money(inv.total_minor, inv.currency_code)}
                    </TableCell>
                    <TableCell className="text-right">{money(out, inv.currency_code)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <Pager total={query.data?.total ?? 0} state={state} onChange={patch} />
        </>
      )}
    </>
  );
}
