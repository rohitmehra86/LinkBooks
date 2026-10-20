import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Printer } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { authoriseInvoice, getInvoice, voidInvoice } from "@/lib/sales/sales.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/sales/invoices/$invoiceId")({
  head: () => ({ meta: [{ title: "Invoice — LinkBooks" }] }),
  component: InvoiceDetail,
});

function InvoiceDetail() {
  const { invoiceId } = Route.useParams();
  const { company } = useActiveCompany();
  const fetchInvoice = useServerFn(getInvoice);
  const doAuthorise = useServerFn(authoriseInvoice);
  const doVoid = useServerFn(voidInvoice);
  const queryClient = useQueryClient();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";

  const query = useQuery({
    queryKey: ["sales-invoice", companyId, invoiceId],
    enabled: Boolean(companyId),
    queryFn: () => fetchInvoice({ data: { companyId: companyId!, invoiceId } }),
  });

  const authoriseMutation = useMutation({
    mutationFn: () => doAuthorise({ data: { companyId: companyId!, invoiceId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["sales-invoice", companyId, invoiceId] });
      toast.success("Invoice authorised — journal posted");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const voidMutation = useMutation({
    mutationFn: () => doVoid({ data: { companyId: companyId!, invoiceId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["sales-invoice", companyId, invoiceId] });
      toast.success("Invoice voided");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (query.isPending) return <LoadingState />;
  if (query.isError) {
    return (
      <ErrorState title="Invoice not found" description={friendlyAuthError(query.error)} onRetry={() => query.refetch()} />
    );
  }

  const inv = query.data as {
    status: string;
    invoice_date: string;
    due_date: string;
    invoice_number: string | null;
    memo: string | null;
    total_minor: number;
    tax_minor: number;
    subtotal_minor: number;
    amount_paid_minor: number;
    amount_credited_minor: number;
    posted_journal_id: string | null;
    contacts: { name: string; email: string | null } | null;
    sales_invoice_lines: Array<{
      id: string; description: string; quantity: number; net_minor: number; tax_minor: number; discount_minor: number;
    }>;
  };
  const outstanding = inv.total_minor - inv.amount_paid_minor - inv.amount_credited_minor;

  return (
    <>
      <PageHeader
        title={`Invoice · ${inv.contacts?.name ?? "Customer"}`}
        description={`${inv.invoice_date} · due ${inv.due_date}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link to="/sales/invoices">Back</Link>
            </Button>
            <Button variant="outline" size="sm" onClick={() => window.print()}>
              <Printer className="mr-1 size-4" /> Print / PDF
            </Button>
            {inv.status === "draft" ? (
              <>
                <Button size="sm" variant="outline" asChild>
                  <Link to="/sales/invoices/$invoiceId/edit" params={{ invoiceId }}>
                    Edit draft
                  </Link>
                </Button>
                <Button size="sm" disabled={authoriseMutation.isPending} onClick={() => authoriseMutation.mutate()}>
                  {authoriseMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                  Authorise & post
                </Button>
              </>
            ) : null}
            {inv.status !== "void" ? (
              <Button size="sm" variant="destructive" disabled={voidMutation.isPending} onClick={() => voidMutation.mutate()}>
                Void
              </Button>
            ) : null}
            {["authorised", "partly_paid"].includes(inv.status) ? (
              <Button size="sm" variant="outline" asChild>
                <Link to="/sales/receipts/new">Record receipt</Link>
              </Button>
            ) : null}
          </div>
        }
      />
      <div className="mb-4 flex flex-wrap gap-3 text-sm">
        <Badge variant="outline" className="capitalize">{inv.status.replace("_", " ")}</Badge>
        <span>#{inv.invoice_number ?? "—"}</span>
        <span>Total {fromMinorUnits(inv.total_minor, currency)}</span>
        <span>Outstanding {fromMinorUnits(outstanding, currency)}</span>
        {inv.posted_journal_id ? (
          <span className="font-mono text-xs text-muted-foreground">Journal {inv.posted_journal_id.slice(0, 8)}…</span>
        ) : null}
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        Document delivery: use Print / PDF. Email delivery is not configured in this environment.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Description</TableHead>
            <TableHead>Qty</TableHead>
            <TableHead className="text-right">Net</TableHead>
            <TableHead className="text-right">Tax</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {inv.sales_invoice_lines.map((l) => (
            <TableRow key={l.id}>
              <TableCell>{l.description}</TableCell>
              <TableCell>{l.quantity}</TableCell>
              <TableCell className="text-right">{fromMinorUnits(l.net_minor, currency)}</TableCell>
              <TableCell className="text-right">{fromMinorUnits(l.tax_minor, currency)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
