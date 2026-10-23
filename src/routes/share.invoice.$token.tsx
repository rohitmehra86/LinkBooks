import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Printer } from "lucide-react";
import { getSharedInvoice } from "@/lib/documents/documents.functions";
import { DocumentSheet } from "@/components/documents/DocumentSheet";
import { Button } from "@/components/ui/button";

/**
 * PUBLIC page (outside the signed-in area): one invoice by unguessable token, read-only.
 * No account data, navigation or contact details beyond the printed invoice are shown.
 */
export const Route = createFileRoute("/share/invoice/$token")({
  head: () => ({
    meta: [
      { title: "Invoice" },
      { name: "robots", content: "noindex, nofollow, noarchive" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: SharedInvoicePage,
});

function SharedInvoicePage() {
  const { token } = Route.useParams();
  const fetchShared = useServerFn(getSharedInvoice);
  const q = useQuery({
    queryKey: ["shared-invoice", token],
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () => fetchShared({ data: { token } }),
  });

  if (q.isPending) {
    return (
      <div className="grid min-h-screen place-items-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading invoice</span>
      </div>
    );
  }
  if (q.isError) {
    return (
      <Message
        title="This invoice could not be opened"
        text="Something went wrong. Please try again in a moment."
      />
    );
  }
  if (!q.data) {
    return (
      <Message
        title="This link is not valid"
        text="The link may have been revoked, may have expired, or may be incomplete. Please ask the sender for a new one."
      />
    );
  }

  const { document: doc, branding, locale, dateFormat } = q.data;
  return (
    <div className="min-h-screen bg-muted/30 px-4 py-6 print:bg-white print:p-0">
      <div className="mx-auto mb-4 flex max-w-[820px] flex-wrap items-center justify-between gap-2 print:hidden">
        <p className="text-sm text-muted-foreground">
          Invoice from {branding.displayName}. Online payment is not available on this page — use
          the payment details on the invoice.
        </p>
        <Button size="sm" onClick={() => window.print()}>
          <Printer className="mr-1 size-4" /> Print / Save as PDF
        </Button>
      </div>
      <DocumentSheet document={doc} branding={branding} locale={locale} dateFormat={dateFormat} />
    </div>
  );
}

function Message({ title, text }: { title: string; text: string }) {
  return (
    <div className="grid min-h-screen place-items-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{text}</p>
      </div>
    </div>
  );
}
