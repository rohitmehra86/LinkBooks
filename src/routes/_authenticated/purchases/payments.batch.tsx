import { useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  createBatchPayment,
  listBills,
  listPaymentAccounts,
} from "@/lib/purchases/purchases.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { buildBatchPayments, type BatchBill } from "@/lib/purchases/batch-payment";
import { useCanDo } from "@/hooks/use-can";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, EmptyState } from "@/components/common/states";
import { EntityCombobox } from "@/components/common/EntityCombobox";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/purchases/payments/batch")({
  head: () => ({ meta: [{ title: "Batch payment — LinkBooks" }] }),
  component: BatchPayment,
});

type BillRow = BatchBill & {
  bill_number: string | null;
  supplier_invoice_number: string | null;
  due_date: string;
  contacts: { name: string } | null;
};

function BatchPayment() {
  const { company } = useActiveCompany();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fetchBills = useServerFn(listBills);
  const fetchAccounts = useServerFn(listPaymentAccounts);
  const postBatch = useServerFn(createBatchPayment);
  const canPay = useCanDo("purchases.payment");
  const companyId = company?.id;
  const today = new Date().toISOString().slice(0, 10);

  const [bankAccountId, setBankAccountId] = useState("");
  const [paymentDate, setPaymentDate] = useState(today);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [batchKey] = useState(() => `batch-${crypto.randomUUID()}`);

  const billsQ = useQuery({
    queryKey: ["bills-open-batch", companyId],
    enabled: Boolean(companyId),
    queryFn: () =>
      fetchBills({
        data: {
          companyId: companyId!,
          tab: "to_pay",
          sortBy: "due_date",
          sortDir: "asc",
          limit: 200,
        },
      }),
  });
  const accountsQ = useQuery({
    queryKey: ["payment-accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });

  const bills = useMemo(() => {
    const rows = ((billsQ.data as { rows?: unknown[] } | undefined)?.rows ?? []) as BillRow[];
    return rows.filter((b) => b.total_minor - b.amount_paid_minor - b.amount_credited_minor > 0);
  }, [billsQ.data]);
  const bankOptions = useMemo(
    () =>
      ((accountsQ.data ?? []) as Array<{ id: string; code: string; name: string }>).map((a) => ({
        value: a.id,
        label: `${a.code} — ${a.name}`,
      })),
    [accountsQ.data],
  );

  const chosen = bills.filter((b) => selected[b.id]);
  const payments = buildBatchPayments(chosen);

  const mutation = useMutation({
    mutationFn: () =>
      postBatch({
        data: {
          companyId: companyId!,
          paymentDate,
          bankAccountId,
          batchKey,
          payments: payments.map((p) => ({
            contactId: p.contactId,
            currencyCode: p.currencyCode,
            allocations: p.allocations,
          })),
        },
      }),
    onSuccess: async (r) => {
      await queryClient.invalidateQueries({ queryKey: ["payments", companyId] });
      await queryClient.invalidateQueries({ queryKey: ["bills", companyId] });
      toast.success(`${r.count} payment${r.count === 1 ? "" : "s"} posted`);
      navigate({ to: "/purchases/payments" });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (billsQ.isPending) return <LoadingState />;

  return (
    <>
      <PageHeader
        title="Batch payment"
        description="Pay several bills in one go. One payment is created per supplier and currency; all post together or not at all."
        actions={
          <Button size="sm" variant="outline" asChild>
            <Link to="/purchases/payments">Cancel</Link>
          </Button>
        }
      />
      <div className="max-w-4xl space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Bank / cash account</Label>
            <EntityCombobox
              options={bankOptions}
              value={bankAccountId}
              onChange={setBankAccountId}
              placeholder="Paid from (bank or cash account)"
              allowClear={false}
            />
          </div>
          <div className="space-y-2">
            <Label>Payment date</Label>
            <Input
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Each selected bill is paid in full. Foreign-currency bills are settled at the rate they
          were booked at; use “New payment” to enter a different rate and book exchange gain or
          loss.
        </p>

        {bills.length === 0 ? (
          <EmptyState title="Nothing to pay" description="No authorised bills have a balance." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10" />
                <TableHead>Supplier</TableHead>
                <TableHead>Bill</TableHead>
                <TableHead>Due</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bills.map((b) => {
                const due = b.total_minor - b.amount_paid_minor - b.amount_credited_minor;
                return (
                  <TableRow key={b.id}>
                    <TableCell>
                      <Checkbox
                        checked={Boolean(selected[b.id])}
                        aria-label={`Pay ${b.bill_number ?? b.supplier_invoice_number ?? "bill"}`}
                        onCheckedChange={(v) => setSelected((s) => ({ ...s, [b.id]: v === true }))}
                      />
                    </TableCell>
                    <TableCell>{b.contacts?.name ?? "—"}</TableCell>
                    <TableCell>{b.supplier_invoice_number || b.bill_number || "—"}</TableCell>
                    <TableCell>{b.due_date}</TableCell>
                    <TableCell className="text-right">
                      {b.currency_code} {fromMinorUnits(BigInt(due), b.currency_code)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        <div className="flex items-center justify-between rounded-md border p-3 text-sm">
          <span>
            {chosen.length} bill{chosen.length === 1 ? "" : "s"} → {payments.length} payment
            {payments.length === 1 ? "" : "s"}
          </span>
          <Button
            disabled={
              !canPay ||
              !bankAccountId ||
              !paymentDate ||
              payments.length === 0 ||
              mutation.isPending
            }
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Pay selected
          </Button>
        </div>
      </div>
    </>
  );
}
