import { createFileRoute } from "@tanstack/react-router";
import { SalesDocumentEditor } from "@/components/sales/SalesDocumentEditor";

export const Route = createFileRoute("/_authenticated/sales/quotes/new")({
  head: () => ({ meta: [{ title: "New quote — LinkBooks" }] }),
  component: NewQuote,
});

export function NewQuote() {
  return <SalesDocumentEditor kind="quote" />;
}
