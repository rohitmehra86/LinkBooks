import { createFileRoute } from "@tanstack/react-router";
import { SalesDocumentEditor } from "@/components/sales/SalesDocumentEditor";

export const Route = createFileRoute("/_authenticated/sales/invoices/new")({
  head: () => ({ meta: [{ title: "New invoice — LinkBooks" }] }),
  validateSearch: (s: Record<string, unknown>): { contactId?: string } =>
    typeof s["contactId"] === "string" ? { contactId: s["contactId"] } : {},
  component: NewInvoiceRoute,
});

function NewInvoiceRoute() {
  const { contactId } = Route.useSearch();
  return <SalesDocumentEditor kind="invoice" initialContactId={contactId} />;
}

/** Used by the Create-new panel, which renders the form outside a route. */
export function NewInvoice() {
  return <SalesDocumentEditor kind="invoice" />;
}
