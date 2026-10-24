import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { getReceipt, unallocateReceipt, voidReceipt } from "@/lib/sales/sales-receipts.functions";
import { getSalesDocumentConfig } from "@/lib/sales/sales-config.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { ReasonDialog } from "@/components/sales/ReasonDialog";
import { money } from "@/components/sales/sales-form-utils";
import { StatusBadge } from "@/components/common/stat-card";
import { Button } from "@/components/ui/button";
import { DocumentActions } from "@/components/documents/DocumentActions";
import { DocumentRecordPanel } from "@/components/documents/DocumentRecordPanel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/sales/receipts/$receiptId")({
  head: () => ({ meta: [{ title: "Receipt — LinkBooks" }] }),
  component: ReceiptDetail,
});

type Dialog = { kind: "void" } | { kind: "unallocate"; invoiceId: string | null } | null;

function ReceiptDetail() {
  const { receiptId } = Route.useParams();
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const qc = useQueryClient();
  const fetchReceipt = useServerFn(getReceipt);
  const fetchConfig = useServerFn(getSalesDocumentConfig);
  const voidFn = useServerFn(voidReceipt);
  const unallocFn = useServerFn(unallocateReceipt);
  const [dialog, setDialog] = useState<Dialog>(null);

  const query = useQuery({
    queryKey: ["sales-receipt", companyId, receiptId],
    enabled: Boolean(companyId),
    queryFn: () => fetchReceipt({ data: { companyId: companyId!, receiptId } }),
  });
  const configQ = useQuery({
    queryKey: ["sales-doc-config", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchConfig({ data: { companyId: companyId! } }),
  });

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["sales-receipt", companyId, receiptId] });
    await qc.invalidateQueries({ queryKey: ["sales-receipts", companyId] });
    await qc.invalidateQueries({ queryKey: ["sales-invoices", companyId] });
    await qc.invalidateQueries({ queryKey: ["sales-invoice", companyId] });
    await qc.invalidateQueries({ queryKey: ["open-invoices", companyId] });
  };

  const voidM = useMutation({
    mutationFn: (v: { reason: string; date: string }) =>
      voidFn({ data: { companyId: companyId!, receiptId, reason: v.reason, voidDate: v.date } }),
    onSuccess: async () => {
      await refresh();
      setDialog(null);
      toast.success("Receipt voided and the journal reversed");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });
  const unallocM = useMutation({
    mutationFn: (v: { reason: string; date: string; invoiceId: string | null }) =>
      unallocFn({
        data: {
          companyId: companyId!,
          receiptId,
          ...(v.invoiceId ? { invoiceId: v.invoiceId } : {}),
          reason: v.reason,
          reversalDate: v.date,
        },
      }),
    onSuccess: async (r) => {
      await refresh();
      setDialog(null);
      toast.success(`Released ${r.removed} allocation${r.removed === 1 ? "" : "s"}`);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (query.isPending) return <LoadingState />;
  if (query.isError) {
    return (
      <ErrorState
        title="Could not load receipt"
        description={friendlyAuthError(query.error)}
        onRetry={() => query.refetch()}
      />
    );
  }
  const { receipt, allocations, reversedAllocations } = query.data;
  const cur = receipt.currency_code;
  const today = configQ.data?.today ?? receipt.receipt_date;
  const isPosted = receipt.status === "posted";
  const latestAllocation = allocations.reduce(
    (m, a) => ((a.allocated_on ?? "") > m ? (a.allocated_on ?? "") : m),
    receipt.receipt_date,
  );

  return (
    <>
      <PageHeader
        title={`Receipt ${receipt.reference ?? receipt.id.slice(0, 8)}`}
        description={receipt.contacts?.name ?? "Customer receipt"}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" asChild>
              <Link to="/sales/receipts">Back</Link>
            </Button>
            {isPosted && allocations.length > 0 ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDialog({ kind: "unallocate", invoiceId: null })}
              >
                Unallocate all
              </Button>
            ) : null}
            {isPosted ? (
              <Button size="sm" variant="destructive" onClick={() => setDialog({ kind: "void" })}>
                Void receipt
              </Button>
            ) : null}
          </div>
        }
      />
      <div className="grid max-w-4xl gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              {money(receipt.amount_minor, cur)}
              <StatusBadge status={receipt.status} />
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
            <div>Date: {receipt.receipt_date}</div>
            <div>
              Deposited to:{" "}
              {receipt.accounts ? `${receipt.accounts.code} — ${receipt.accounts.name}` : "—"}
            </div>
            <div>Reference: {receipt.reference ?? "—"}</div>
            <div>Memo: {receipt.memo ?? "—"}</div>
            <div>Unallocated: {isPosted ? money(receipt.unallocated_minor, cur) : "—"}</div>
            {receipt.status === "void" ? (
              <div className="sm:col-span-2 text-destructive">
                Voided {receipt.void_date ?? ""}
                {receipt.void_reason ? ` — ${receipt.void_reason}` : ""}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Allocated to invoices</CardTitle>
          </CardHeader>
          <CardContent>
            {allocations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No active allocations.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Allocated on</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {allocations.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>
                        <Link
                          className="underline-offset-2 hover:underline"
                          to="/sales/invoices/$invoiceId"
                          params={{ invoiceId: a.invoice_id }}
                        >
                          {a.sales_invoices?.invoice_number ?? a.invoice_id.slice(0, 8)}
                        </Link>
                      </TableCell>
                      <TableCell>{a.allocated_on ?? "—"}</TableCell>
                      <TableCell className="text-right">{money(a.amount_minor, cur)}</TableCell>
                      <TableCell className="text-right">
                        {isPosted ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setDialog({ kind: "unallocate", invoiceId: a.invoice_id })
                            }
                          >
                            Unallocate
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {reversedAllocations.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Reversed allocations</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Reversed on</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reversedAllocations.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>
                        {a.sales_invoices?.invoice_number ?? a.invoice_id.slice(0, 8)}
                      </TableCell>
                      <TableCell>{a.reversed_on}</TableCell>
                      <TableCell>{a.reverse_reason ?? "—"}</TableCell>
                      <TableCell className="text-right">{money(a.amount_minor, cur)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ) : null}
      </div>

      <ReasonDialog
        open={dialog?.kind === "void"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Void receipt"
        description="Reverses the bank / accounts receivable journal and releases every allocation. This cannot be undone."
        confirmLabel="Void receipt"
        dateLabel="Void date"
        minDate={latestAllocation}
        defaultDate={today < latestAllocation ? latestAllocation : today}
        pending={voidM.isPending}
        destructive
        onConfirm={(v) => voidM.mutate(v)}
      />
      <ReasonDialog
        open={dialog?.kind === "unallocate"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Unallocate receipt"
        description="Releases the allocation so the invoice shows as outstanding again. The receipt itself stays posted."
        confirmLabel="Unallocate"
        dateLabel="Reversal date"
        minDate={latestAllocation}
        defaultDate={today < latestAllocation ? latestAllocation : today}
        pending={unallocM.isPending}
        onConfirm={(v) =>
          unallocM.mutate({
            ...v,
            invoiceId: dialog?.kind === "unallocate" ? dialog.invoiceId : null,
          })
        }
      />
      <DocumentActions kind="sales_receipt" id={receiptId} />
      <DocumentRecordPanel entityType="sales_receipt" entityId={receiptId} audience="customer" />
    </>
  );
}
