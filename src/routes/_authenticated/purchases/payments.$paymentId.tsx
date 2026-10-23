import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  allocateSupplierPayment,
  getSupplierPayment,
  listBills,
  reverseSupplierPayment,
} from "@/lib/purchases/purchases.functions";
import { useCan } from "@/hooks/use-can";
import { minorOrZero, parseMinorOrThrow, tryParseMinor } from "@/lib/purchases/money-input";
import { fromMinorUnits } from "@/lib/accounting/money";
import { formatHistoryDay } from "@/lib/purchases/bill-history";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { StatusBadge } from "@/components/common/stat-card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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
  const fetchBills = useServerFn(listBills);
  const doAllocate = useServerFn(allocateSupplierPayment);
  const { can } = useCan();
  const [allocs, setAllocs] = useState<Record<string, string>>({});
  const companyId = company?.id;

  const query = useQuery({
    queryKey: ["supplier-payment", companyId, paymentId],
    enabled: Boolean(companyId),
    queryFn: () => fetchPayment({ data: { companyId: companyId!, paymentId } }),
  });

  const pay = query.data as
    | { contact_id: string; currency_code: string; status: string; unallocated_minor: number }
    | undefined;
  const canAllocate = Boolean(pay && pay.status === "paid" && pay.unallocated_minor > 0);
  const payCurrency = (pay?.currency_code || company?.base_currency || "GBP").toUpperCase();

  // Open bills in the payment's currency, oldest due date first.
  const billsQ = useQuery({
    queryKey: ["bills-for-payment", companyId, pay?.contact_id, payCurrency],
    enabled: Boolean(companyId && pay?.contact_id && canAllocate),
    queryFn: () =>
      fetchBills({
        data: {
          companyId: companyId!,
          contactId: pay!.contact_id,
          tab: "to_pay",
          currencyCode: payCurrency,
          sortBy: "due_date",
          sortDir: "asc",
          limit: 100,
        },
      }),
  });
  const openBills = useMemo(() => {
    const rows = ((billsQ.data as { rows?: unknown[] } | undefined)?.rows ?? []) as Array<{
      id: string;
      total_minor: number;
      amount_paid_minor: number;
      amount_credited_minor: number;
      supplier_invoice_number: string | null;
      bill_number: string | null;
      due_date: string;
    }>;
    return rows
      .map((b) => ({
        ...b,
        outstanding: b.total_minor - b.amount_paid_minor - b.amount_credited_minor,
      }))
      .filter((b) => b.outstanding > 0);
  }, [billsQ.data]);
  const unallocated = pay?.unallocated_minor ?? 0;
  const allocInvalid = Object.values(allocs).some(
    (v) => tryParseMinor(v || "0", payCurrency) === null,
  );
  const allocTotal = Object.values(allocs).reduce(
    (n, v) => n + Number(minorOrZero(v || "0", payCurrency)),
    0,
  );

  const allocateM = useMutation({
    mutationFn: () =>
      doAllocate({
        data: {
          companyId: companyId!,
          paymentId,
          allocations: Object.entries(allocs)
            .map(([billId, amt]) => ({
              billId,
              amountMinor: Number(parseMinorOrThrow(amt || "0", payCurrency, "Allocation")),
            }))
            .filter((a) => a.amountMinor > 0),
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["supplier-payment", companyId, paymentId] });
      await queryClient.invalidateQueries({ queryKey: ["bills", companyId] });
      await queryClient.invalidateQueries({ queryKey: ["bills-for-payment", companyId] });
      setAllocs({});
      toast.success("Payment allocated to bills");
    },
    onError: (error) => toast.error(friendlyAuthError(error)),
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
          payment.status !== "void" && payment.posted_journal_id && can("purchases.payment") ? (
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
          <StatusBadge
            status={payment.status}
            label={statusLabel(payment.status)}
            className="capitalize"
          />
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

      {canAllocate && can("purchases.payment") ? (
        <section className="space-y-3 rounded-lg border border-border bg-background p-4">
          <h2 className="text-sm font-semibold">
            Allocate the unallocated {fromMinorUnits(BigInt(unallocated), payCurrency)}{" "}
            {payCurrency}
          </h2>
          {openBills.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No open {payCurrency} bills for this supplier.
            </p>
          ) : (
            <ul className="space-y-2">
              {openBills.map((b) => {
                const checked = b.id in allocs;
                return (
                  <li
                    key={b.id}
                    className="flex flex-wrap items-center gap-3 rounded border px-3 py-2 text-sm"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) =>
                        setAllocs((prev) => {
                          const next = { ...prev };
                          if (!v) {
                            delete next[b.id];
                            return next;
                          }
                          const already = Object.entries(prev).reduce(
                            (n, [id, amt]) =>
                              id === b.id ? n : n + Number(minorOrZero(amt || "0", payCurrency)),
                            0,
                          );
                          next[b.id] = fromMinorUnits(
                            BigInt(Math.max(0, Math.min(b.outstanding, unallocated - already))),
                            payCurrency,
                          );
                          return next;
                        })
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <p>{b.supplier_invoice_number ?? b.bill_number ?? b.id.slice(0, 8)}</p>
                      <p className="text-muted-foreground">
                        Due {b.due_date} · Outstanding{" "}
                        {fromMinorUnits(BigInt(b.outstanding), payCurrency)}
                      </p>
                    </div>
                    {checked ? (
                      <Input
                        className="w-28"
                        inputMode="decimal"
                        value={allocs[b.id] ?? ""}
                        onChange={(e) => setAllocs((prev) => ({ ...prev, [b.id]: e.target.value }))}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {allocTotal > unallocated ? (
            <p className="text-xs text-destructive">
              Allocations exceed the unallocated amount by{" "}
              {fromMinorUnits(BigInt(allocTotal - unallocated), payCurrency)}.
            </p>
          ) : null}
          <Button
            size="sm"
            disabled={
              allocateM.isPending || allocInvalid || allocTotal <= 0 || allocTotal > unallocated
            }
            onClick={() => allocateM.mutate()}
          >
            Allocate
          </Button>
        </section>
      ) : null}

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
