import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveCompany } from "@/hooks/use-active-company";
import { getQuote } from "@/lib/sales/sales.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { LoadingState, EmptyState, ErrorState } from "@/components/common/states";
import { SalesDocumentEditor } from "@/components/sales/SalesDocumentEditor";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/sales/quotes/$quoteId/edit")({
  head: () => ({ meta: [{ title: "Edit quote — LinkBooks" }] }),
  component: EditQuote,
});

function EditQuote() {
  const { quoteId } = Route.useParams();
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const fetchQuote = useServerFn(getQuote);
  const q = useQuery({
    queryKey: ["sales-quote", companyId, quoteId],
    enabled: Boolean(companyId),
    queryFn: () => fetchQuote({ data: { companyId: companyId!, quoteId } }),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (q.isPending) return <LoadingState />;
  if (q.isError)
    return <ErrorState description={friendlyAuthError(q.error)} onRetry={() => void q.refetch()} />;
  const quote = q.data;
  if (quote.status === "converted" || quote.status === "void") {
    return (
      <div className="space-y-4">
        <EmptyState
          title="This quote can no longer be edited"
          description="Converted and void quotes are locked."
        />
        <div className="flex justify-center">
          <Button asChild size="sm" variant="outline">
            <Link to="/sales/quotes/$quoteId" params={{ quoteId }}>
              Back
            </Link>
          </Button>
        </div>
      </div>
    );
  }
  return (
    <SalesDocumentEditor
      kind="quote"
      existing={{
        id: quote.id,
        contactId: quote.contact_id,
        date: quote.quote_date,
        secondDate: quote.expiry_date,
        number: quote.quote_number,
        memo: quote.memo,
        currencyCode: quote.currency_code,
        fxRateToBase: Number((quote as { fx_rate_to_base?: number }).fx_rate_to_base ?? 1),
        sourceInvoiceId: null,
        lines: quote.sales_quote_lines,
      }}
    />
  );
}
