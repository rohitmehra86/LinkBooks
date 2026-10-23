import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { useFormat } from "@/hooks/use-format";
import { exportReceiptsCsv, listReceipts } from "@/lib/sales/sales-receipts.functions";
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

export const Route = createFileRoute("/_authenticated/sales/receipts/")({
  head: () => ({ meta: [{ title: "Receipts — LinkBooks" }] }),
  component: ReceiptsList,
});

const STATUSES = [
  { value: "posted", label: "Posted" },
  { value: "void", label: "Void" },
];

function ReceiptsList() {
  const { company } = useActiveCompany();
  const fmt = useFormat();
  const companyId = company?.id;
  const fetchReceipts = useServerFn(listReceipts);
  const exportCsv = useServerFn(exportReceiptsCsv);
  const [state, setState] = useState<ListState>(initialListState("receipt_date"));
  const [unallocatedOnly, setUnallocatedOnly] = useState(false);
  const patch = (p: Partial<ListState>) => setState((s) => ({ ...s, ...p }));
  const q = useDebounced(state.q);

  const filters = () => ({
    companyId: companyId!,
    q,
    ...(state.status !== "all" ? { status: state.status } : {}),
    ...(unallocatedOnly ? { unallocatedOnly: true } : {}),
    ...(state.from ? { from: state.from } : {}),
    ...(state.to ? { to: state.to } : {}),
    sort: state.sort,
    dir: state.dir,
  });
  const query = useQuery({
    queryKey: ["sales-receipts", companyId, q, state, unallocatedOnly],
    enabled: Boolean(companyId),
    placeholderData: keepPreviousData,
    queryFn: () =>
      fetchReceipts({ data: { ...filters(), page: state.page, pageSize: state.pageSize } }),
  });
  const exporter = useMutation({
    mutationFn: () => exportCsv({ data: filters() }),
    onSuccess: (r) => {
      downloadCsv(r.filename, r.csv);
      toast.success(`Exported ${r.rowCount} receipts`);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  const rows = query.data?.rows ?? [];

  return (
    <>
      <PageHeader
        title="Receipts"
        description="Customer payments allocated to invoices. Overpayments stay unallocated until you apply them."
        actions={
          <Button size="sm" asChild>
            <Link to="/sales/receipts/new">Record receipt</Link>
          </Button>
        }
      />
      <ListToolbar
        state={state}
        onChange={patch}
        statuses={STATUSES}
        searchPlaceholder="Search reference, memo or customer"
        onExport={() => exporter.mutate()}
        exporting={exporter.isPending}
        extra={
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input
              type="checkbox"
              checked={unallocatedOnly}
              onChange={(e) => {
                setUnallocatedOnly(e.target.checked);
                patch({ page: 0 });
              }}
            />
            Unallocated only
          </label>
        }
      />
      {query.isPending ? (
        <ListSkeleton />
      ) : query.isError ? (
        <ErrorState
          title="Could not load receipts"
          description={friendlyAuthError(query.error)}
          onRetry={() => query.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No receipts"
          description="No receipts match — record a customer payment."
          action={
            <Button size="sm" asChild>
              <Link to="/sales/receipts/new">New receipt</Link>
            </Button>
          }
        />
      ) : (
        <>
          <TableCard>
            <Table>
              <TableHeader>
                <TableRow>
                  <SortHead label="Date" column="receipt_date" state={state} onChange={patch} />
                  <SortHead label="Reference" column="reference" state={state} onChange={patch} />
                  <TableHead>Customer</TableHead>
                  <SortHead label="Status" column="status" state={state} onChange={patch} />
                  <SortHead
                    label="Amount"
                    column="amount_minor"
                    state={state}
                    onChange={patch}
                    className="text-right"
                  />
                  <SortHead
                    label="Unallocated"
                    column="unallocated_minor"
                    state={state}
                    onChange={patch}
                    className="text-right"
                  />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link
                        className="underline-offset-2 hover:underline"
                        to="/sales/receipts/$receiptId"
                        params={{ receiptId: r.id }}
                      >
                        {fmt.date(r.receipt_date)}
                      </Link>
                    </TableCell>
                    <TableCell>{r.reference ?? "—"}</TableCell>
                    <TableCell>{r.contacts?.name ?? "—"}</TableCell>
                    <TableCell>
                      <StatusBadge status={r.status} />
                    </TableCell>
                    <TableCell className="money">
                      {fmt.money(r.amount_minor, r.currency_code)}
                    </TableCell>
                    <TableCell className="money">
                      {r.status === "void" ? "—" : fmt.money(r.unallocated_minor, r.currency_code)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableCard>
          <Pager total={query.data?.total ?? 0} state={state} onChange={patch} />
        </>
      )}
    </>
  );
}
