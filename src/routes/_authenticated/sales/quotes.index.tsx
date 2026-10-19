import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { convertQuoteToInvoice, listQuotes } from "@/lib/sales/sales.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/sales/quotes/")({
  head: () => ({ meta: [{ title: "Quotes — LinkBooks" }] }),
  component: QuotesList,
});

function QuotesList() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const fetchQuotes = useServerFn(listQuotes);
  const convert = useServerFn(convertQuoteToInvoice);
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ["sales-quotes", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchQuotes({ data: { companyId: companyId! } }),
  });

  const convertM = useMutation({
    mutationFn: (quoteId: string) => convert({ data: { companyId: companyId!, quoteId } }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["sales-quotes", companyId] });
      toast.success("Quote converted to draft invoice");
      window.location.href = `/sales/invoices/${r.invoiceId}`;
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  return (
    <>
      <PageHeader
        title="Quotes"
        description="Quotes do not post to the ledger until converted and the invoice is authorised."
        actions={<Button size="sm" asChild><Link to="/sales/quotes/new">New quote</Link></Button>}
      />
      {query.isPending ? <LoadingState /> : query.isError ? (
        <ErrorState title="Could not load quotes" description={friendlyAuthError(query.error)} />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState title="No quotes" description="Create a quote for a customer." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(query.data as Array<{
              id: string; quote_date: string; status: string; total_minor: number;
              contacts: { name: string } | null; converted_invoice_id: string | null;
            }>).map((q) => (
              <TableRow key={q.id}>
                <TableCell>{q.quote_date}</TableCell>
                <TableCell>{q.contacts?.name ?? "—"}</TableCell>
                <TableCell><Badge variant="secondary">{q.status}</Badge></TableCell>
                <TableCell className="text-right">{fromMinorUnits(q.total_minor, currency)}</TableCell>
                <TableCell>
                  {q.status !== "converted" && q.status !== "void" ? (
                    <Button size="sm" variant="outline" disabled={convertM.isPending}
                      onClick={() => convertM.mutate(q.id)}>
                      Convert to invoice
                    </Button>
                  ) : q.converted_invoice_id ? (
                    <Link className="text-sm underline" to="/sales/invoices/$invoiceId"
                      params={{ invoiceId: q.converted_invoice_id }}>View invoice</Link>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
