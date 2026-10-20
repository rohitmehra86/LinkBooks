import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { authoriseBill, getBill, voidBill } from "@/lib/purchases/purchases.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
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

export const Route = createFileRoute("/_authenticated/purchases/bills/$billId")({
  head: () => ({ meta: [{ title: "Bill — LinkBooks" }] }),
  component: BillDetail,
});

function BillDetail() {
  const { billId } = Route.useParams();
  const { company } = useActiveCompany();
  const fetchBill = useServerFn(getBill);
  const doAuthorise = useServerFn(authoriseBill);
  const doVoid = useServerFn(voidBill);
  const queryClient = useQueryClient();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";

  const query = useQuery({
    queryKey: ["bill", companyId, billId],
    enabled: Boolean(companyId),
    queryFn: () => fetchBill({ data: { companyId: companyId!, billId } }),
  });

  const authoriseMutation = useMutation({
    mutationFn: () => doAuthorise({ data: { companyId: companyId!, billId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["bill", companyId, billId] });
      await queryClient.invalidateQueries({ queryKey: ["bills", companyId] });
      toast.success("Bill authorised — journal posted");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const voidMutation = useMutation({
    mutationFn: () => doVoid({ data: { companyId: companyId!, billId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["bill", companyId, billId] });
      toast.success("Bill voided (reversing journal if posted)");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (query.isPending) return <LoadingState />;
  if (query.isError) {
    return (
      <ErrorState
        title="Bill not found"
        description={friendlyAuthError(query.error)}
        onRetry={() => query.refetch()}
      />
    );
  }

  const bill = query.data as {
    status: string;
    bill_date: string;
    due_date: string;
    supplier_invoice_number: string | null;
    memo: string | null;
    total_minor: number;
    tax_minor: number;
    subtotal_minor: number;
    amount_paid_minor: number;
    amount_credited_minor: number;
    posted_journal_id: string | null;
    contacts: { name: string } | null;
    purchase_bill_lines: Array<{
      id: string;
      description: string;
      quantity: number;
      net_minor: number;
      tax_minor: number;
    }>;
  };

  const outstanding = bill.total_minor - bill.amount_paid_minor - bill.amount_credited_minor;

  return (
    <>
      <PageHeader
        title={`Bill · ${bill.contacts?.name ?? "Supplier"}`}
        description={`${bill.bill_date} · due ${bill.due_date}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link to="/purchases/bills">Back</Link>
            </Button>
            {bill.status === "draft" ? (
              <>
                <Button size="sm" variant="outline" asChild>
                  <Link to="/purchases/bills/$billId/edit" params={{ billId }}>
                    Edit draft
                  </Link>
                </Button>
                <Button
                  size="sm"
                  disabled={authoriseMutation.isPending}
                  onClick={() => authoriseMutation.mutate()}
                >
                  {authoriseMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                  Authorise & post
                </Button>
              </>
            ) : null}
            {bill.status !== "void" ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={voidMutation.isPending}
                onClick={() => voidMutation.mutate()}
              >
                Void
              </Button>
            ) : null}
            {["authorised", "partly_paid"].includes(bill.status) ? (
              <Button size="sm" variant="outline" asChild>
                <Link to="/purchases/payments/new">Record payment</Link>
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap gap-3 text-sm">
        <Badge variant="outline" className="capitalize">
          {bill.status.replace("_", " ")}
        </Badge>
        <span>Invoice # {bill.supplier_invoice_number ?? "—"}</span>
        <span>Total {fromMinorUnits(BigInt(bill.total_minor), currency)}</span>
        <span>Outstanding {fromMinorUnits(BigInt(outstanding), currency)}</span>
        {bill.posted_journal_id ? (
          <span className="font-mono text-xs text-muted-foreground">
            Journal {bill.posted_journal_id.slice(0, 8)}…
          </span>
        ) : null}
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Description</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Net</TableHead>
            <TableHead className="text-right">Tax</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {bill.purchase_bill_lines.map((l) => (
            <TableRow key={l.id}>
              <TableCell>{l.description}</TableCell>
              <TableCell className="text-right">{l.quantity}</TableCell>
              <TableCell className="text-right">
                {fromMinorUnits(BigInt(l.net_minor), currency)}
              </TableCell>
              <TableCell className="text-right">
                {fromMinorUnits(BigInt(l.tax_minor), currency)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {bill.memo ? <p className="mt-4 text-sm text-muted-foreground">{bill.memo}</p> : null}
    </>
  );
}
