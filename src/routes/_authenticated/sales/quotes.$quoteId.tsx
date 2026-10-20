import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Printer } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  convertQuoteToInvoice,
  getQuote,
  updateQuoteStatus,
} from "@/lib/sales/sales.functions";
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

export const Route = createFileRoute("/_authenticated/sales/quotes/$quoteId")({
  head: () => ({ meta: [{ title: "Quote — LinkBooks" }] }),
  component: QuoteDetail,
});

function QuoteDetail() {
  const { quoteId } = Route.useParams();
  const { company } = useActiveCompany();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";

  const fetchQuote = useServerFn(getQuote);
  const doStatus = useServerFn(updateQuoteStatus);
  const doConvert = useServerFn(convertQuoteToInvoice);

  const query = useQuery({
    queryKey: ["sales-quote", companyId, quoteId],
    enabled: Boolean(companyId),
    queryFn: () => fetchQuote({ data: { companyId: companyId!, quoteId } }),
  });

  const statusM = useMutation({
    mutationFn: (status: string) =>
      doStatus({ data: { companyId: companyId!, quoteId, status } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sales-quote", companyId, quoteId] });
      toast.success("Quote status updated");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const convertM = useMutation({
    mutationFn: () => doConvert({ data: { companyId: companyId!, quoteId } }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["sales-quotes", companyId] });
      toast.success("Converted to draft invoice");
      navigate({ to: "/sales/invoices/$invoiceId", params: { invoiceId: r.invoiceId } });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (query.isPending) return <LoadingState />;
  if (query.isError) {
    return (
      <ErrorState
        title="Quote not found"
        description={friendlyAuthError(query.error)}
        onRetry={() => query.refetch()}
      />
    );
  }

  const q = query.data as {
    status: string;
    quote_date: string;
    expiry_date: string | null;
    quote_number: string | null;
    memo: string | null;
    total_minor: number;
    tax_minor: number;
    subtotal_minor: number;
    converted_invoice_id: string | null;
    contacts: { name: string } | null;
    sales_quote_lines: Array<{
      id: string;
      description: string;
      quantity: number;
      net_minor: number;
      tax_minor: number;
    }>;
  };

  const canConvert = !["converted", "void", "declined"].includes(q.status);

  return (
    <>
      <PageHeader
        title={`Quote · ${q.contacts?.name ?? "Customer"}`}
        description={`${q.quote_date}${q.expiry_date ? ` · expires ${q.expiry_date}` : ""} · never posts to the ledger`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link to="/sales/quotes">Back</Link>
            </Button>
            <Button variant="outline" size="sm" onClick={() => window.print()}>
              <Printer className="mr-1 size-4" /> Print / PDF
            </Button>
            {q.status === "draft" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={statusM.isPending}
                onClick={() => statusM.mutate("sent")}
              >
                Mark sent
              </Button>
            ) : null}
            {["draft", "sent"].includes(q.status) ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={statusM.isPending}
                  onClick={() => statusM.mutate("accepted")}
                >
                  Accept
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={statusM.isPending}
                  onClick={() => statusM.mutate("declined")}
                >
                  Decline
                </Button>
              </>
            ) : null}
            {canConvert ? (
              <Button size="sm" disabled={convertM.isPending} onClick={() => convertM.mutate()}>
                {convertM.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                Convert to invoice
              </Button>
            ) : null}
            {q.converted_invoice_id ? (
              <Button size="sm" variant="outline" asChild>
                <Link
                  to="/sales/invoices/$invoiceId"
                  params={{ invoiceId: q.converted_invoice_id }}
                >
                  Open invoice
                </Link>
              </Button>
            ) : null}
          </div>
        }
      />
      <div className="mb-4 flex flex-wrap gap-3 text-sm">
        <Badge variant="outline" className="capitalize">
          {q.status}
        </Badge>
        <span>#{q.quote_number ?? "—"}</span>
        <span>Total {fromMinorUnits(q.total_minor, currency)}</span>
      </div>
      {q.memo ? <p className="mb-4 text-sm text-muted-foreground">{q.memo}</p> : null}
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
          {q.sales_quote_lines.map((l) => (
            <TableRow key={l.id}>
              <TableCell>{l.description}</TableCell>
              <TableCell className="text-right">{l.quantity}</TableCell>
              <TableCell className="text-right">{fromMinorUnits(l.net_minor, currency)}</TableCell>
              <TableCell className="text-right">{fromMinorUnits(l.tax_minor, currency)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
