import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { getSupplierPayment, reverseSupplierPayment } from "@/lib/purchases/purchases.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { formatHistoryDay } from "@/lib/purchases/bill-history";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/purchases/payments/$paymentId")({
  head: () => ({ meta: [{ title: "Supplier payment — LinkBooks" }] }),
  component: PaymentDocument,
});

function statusLabel(status: string) {
  if (status === "void") return "Voided";
  if (status === "paid") return "Posted";
  return status.replace(/_/g, " ");
}

function PaymentDocument() {
  const { paymentId } = Route.useParams();
  const { company } = useActiveCompany();
  const queryClient = useQueryClient();
  const fetchPayment = useServerFn(getSupplierPayment);
  const reversePayment = useServerFn(reverseSupplierPayment);
  const companyId = company?.id;

  const query = useQuery({
    queryKey: ["supplier-payment", companyId, paymentId],
    enabled: Boolean(companyId),
    queryFn: () => fetchPayment({ data: { companyId: companyId!, paymentId } }),
  });

  const reverseM = useMutation({
    mutationFn: () =>
      reversePayment({
        data: { companyId: companyId!, paymentId, reason: "Reversed from the payment screen" },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["supplier-payment", companyId, paymentId] });
      await queryClient.invalidateQueries({ queryKey: ["payments", companyId] });
      toast.success("Payment reversed. The bill balance was restored.");
    },
    onError: (error) => toast.error(friendlyAuthError(error)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (query.isPending) return <LoadingState />;
  if (query.isError || !query.data) {
    return (
      <ErrorState
        title="Payment not found"
        description={friendlyAuthError(query.error)}
        onRetry={() => query.refetch()}
      />
    );
  }

  const payment = query.data;
  const currency = payment.currency_code || company?.base_currency || "GBP";

  return (
    <div className="space-y-4">
      <PageHeader
        title={payment.supplier_name ?? "Supplier payment"}
        description={`${formatHistoryDay(payment.payment_date)} · ${fromMinorUnits(BigInt(payment.amount_minor), currency)} ${currency}`}
        actions={
          payment.status !== "void" && payment.posted_journal_id ? (
            <Button
              size="sm"
              variant="outline"
              className="text-destructive"
              disabled={reverseM.isPending}
              onClick={() => {
                if (
                  confirm(
                    "Reverse this payment? The bank and accounts payable journal will be voided and the bill balance restored.",
                  )
                ) {
                  reverseM.mutate();
                }
              }}
            >
              Reverse payment
            </Button>
          ) : null
        }
      />

      <section className="rounded-lg border border-border bg-background p-4">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="capitalize">
            {statusLabel(payment.status)}
          </Badge>
          {payment.reference ? (
            <span className="text-sm text-muted-foreground">Ref {payment.reference}</span>
          ) : null}
        </div>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Supplier</dt>
            <dd className="font-medium">{payment.supplier_name ?? "—"}</dd>
            {payment.supplier_email ? (
              <dd className="text-muted-foreground">{payment.supplier_email}</dd>
            ) : null}
          </div>
          <div>
            <dt className="text-muted-foreground">Paid from</dt>
            <dd>{payment.bank_label ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Amount</dt>
            <dd className="tabular-nums">
              {fromMinorUnits(BigInt(payment.amount_minor), currency)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Unallocated</dt>
            <dd className="tabular-nums">
              {fromMinorUnits(BigInt(payment.unallocated_minor), currency)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Recorded by</dt>
            <dd>{payment.recorded_by ?? "—"}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-muted-foreground">Notes</dt>
            <dd>{payment.memo ?? "—"}</dd>
          </div>
        </dl>
      </section>

      <section className="rounded-lg border border-border bg-background p-4">
        <h2 className="mb-3 text-sm font-semibold">Allocated to bills</h2>
        {payment.allocations.length === 0 ? (
          <p className="text-sm text-muted-foreground">No bills were allocated on this payment.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bill</TableHead>
                <TableHead>Bill date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Allocated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payment.allocations.map((allocation) => (
                <TableRow key={allocation.id}>
                  <TableCell>
                    <Link
                      to="/purchases/bills/$billId"
                      params={{ billId: allocation.bill_id }}
                      className="text-primary underline-offset-2 hover:underline"
                    >
                      {allocation.supplier_invoice_number || allocation.bill_number || "Bill"}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {allocation.bill_date ? formatHistoryDay(allocation.bill_date) : "—"}
                  </TableCell>
                  <TableCell className="capitalize">
                    {(allocation.bill_status ?? "—").replace(/_/g, " ")}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fromMinorUnits(BigInt(allocation.amount_minor), currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          This payment updated Accounts Payable and the bank account in LinkBooks. It did not
          transmit funds to a bank.
        </p>
      </section>
    </div>
  );
}
