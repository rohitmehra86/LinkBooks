import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveCompany } from "@/hooks/use-active-company";
import { getCreditNote } from "@/lib/sales/sales-credits.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { LoadingState, EmptyState, ErrorState } from "@/components/common/states";
import { SalesDocumentEditor } from "@/components/sales/SalesDocumentEditor";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/sales/credit-notes/$creditNoteId/edit")({
  head: () => ({ meta: [{ title: "Edit credit note — LinkBooks" }] }),
  component: EditCreditNote,
});

function EditCreditNote() {
  const { creditNoteId } = Route.useParams();
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const fetchCn = useServerFn(getCreditNote);
  const q = useQuery({
    queryKey: ["sales-credit", companyId, creditNoteId],
    enabled: Boolean(companyId),
    queryFn: () => fetchCn({ data: { companyId: companyId!, creditNoteId } }),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (q.isPending) return <LoadingState />;
  if (q.isError)
    return <ErrorState description={friendlyAuthError(q.error)} onRetry={() => void q.refetch()} />;
  const cn = q.data;
  if (cn.status !== "draft") {
    return (
      <div className="space-y-4">
        <EmptyState
          title="Only draft credit notes can be edited"
          description="Authorised credit notes are locked. Void it (with a reason) and issue a new one."
        />
        <div className="flex justify-center">
          <Button asChild size="sm" variant="outline">
            <Link to="/sales/credit-notes/$creditNoteId" params={{ creditNoteId }}>
              Back
            </Link>
          </Button>
        </div>
      </div>
    );
  }
  return (
    <SalesDocumentEditor
      kind="credit_note"
      existing={{
        id: cn.id,
        contactId: cn.contact_id,
        date: cn.credit_date,
        secondDate: null,
        number: cn.credit_number,
        memo: cn.memo,
        currencyCode: cn.currency_code,
        fxRateToBase: Number((cn as { fx_rate_to_base?: number }).fx_rate_to_base ?? 1),
        sourceInvoiceId: cn.invoice_id,
        lines: cn.sales_credit_note_lines,
      }}
    />
  );
}
