import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveCompany } from "@/hooks/use-active-company";
import { getInvoice } from "@/lib/sales/sales.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { LoadingState, EmptyState, ErrorState } from "@/components/common/states";
import { SalesDocumentEditor } from "@/components/sales/SalesDocumentEditor";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/sales/invoices/$invoiceId/edit")({
  head: () => ({ meta: [{ title: "Edit invoice — LinkBooks" }] }),
  component: EditInvoice,
});

function EditInvoice() {
  const { invoiceId } = Route.useParams();
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const fetchInvoice = useServerFn(getInvoice);
  const q = useQuery({
    queryKey: ["sales-invoice", companyId, invoiceId],
    enabled: Boolean(companyId),
    queryFn: () => fetchInvoice({ data: { companyId: companyId!, invoiceId } }),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (q.isPending) return <LoadingState />;
  if (q.isError)
    return <ErrorState description={friendlyAuthError(q.error)} onRetry={() => void q.refetch()} />;
  const inv = q.data;
  if (inv.status !== "draft") {
    return (
      <div className="space-y-4">
        <EmptyState
          title="Only draft invoices can be edited"
          description="Authorised invoices are locked. Void it (with a reason) or issue a credit note instead."
        />
        <div className="flex justify-center">
          <Button asChild size="sm" variant="outline">
            <Link to="/sales/invoices/$invoiceId" params={{ invoiceId }}>
              Back
            </Link>
          </Button>
        </div>
      </div>
    );
  }
  return (
    <SalesDocumentEditor
      kind="invoice"
      existing={{
        id: inv.id,
        contactId: inv.contact_id,
        date: inv.invoice_date,
        secondDate: inv.due_date,
        number: inv.invoice_number,
        memo: inv.memo,
        currencyCode: inv.currency_code,
        fxRateToBase: Number((inv as { fx_rate_to_base?: number }).fx_rate_to_base ?? 1),
        sourceInvoiceId: null,
        lines: inv.sales_invoice_lines,
      }}
    />
  );
}
