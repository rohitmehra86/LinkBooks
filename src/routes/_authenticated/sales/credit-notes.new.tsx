import { createFileRoute } from "@tanstack/react-router";
import { SalesDocumentEditor } from "@/components/sales/SalesDocumentEditor";

export const Route = createFileRoute("/_authenticated/sales/credit-notes/new")({
  head: () => ({ meta: [{ title: "New credit note — LinkBooks" }] }),
  validateSearch: (s: Record<string, unknown>): { invoiceId?: string } =>
    typeof s["invoiceId"] === "string" ? { invoiceId: s["invoiceId"] } : {},
  component: NewCreditRoute,
});

function NewCreditRoute() {
  const { invoiceId } = Route.useSearch();
  return <SalesDocumentEditor kind="credit_note" fromInvoiceId={invoiceId} />;
}

export function NewCredit() {
  return <SalesDocumentEditor kind="credit_note" />;
}
