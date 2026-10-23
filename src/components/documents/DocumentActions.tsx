import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Copy, Link2, Loader2, Mail, Printer } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { useCan } from "@/hooks/use-can";
import { useFormat } from "@/hooks/use-format";
import {
  createInvoiceShareLink,
  getDocumentDelivery,
  getPrintableDocument,
  revokeInvoiceShareLinks,
} from "@/lib/documents/documents.functions";
import {
  defaultTemplateFor,
  renderEmail,
  type EmailTemplate,
} from "@/lib/documents/email-templates";
import { daysOverdue } from "@/lib/documents/helpers";
import { DOCUMENT_KIND_LABEL, type DocumentKind } from "@/lib/documents/types";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmailDocumentDialog } from "@/components/documents/EmailDocumentDialog";
import { EMAIL_NOT_CONFIGURED_TEXT, TEMPLATE_LABEL } from "@/lib/documents/ui";

/**
 * Delivery panel shown on a document's detail page: print / PDF, email, online link and the
 * send history. Nothing is claimed as sent unless the server really sent it.
 */
export function DocumentActions({ kind, id }: { kind: DocumentKind; id: string }) {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const { can } = useCan();
  const fmt = useFormat();
  const queryClient = useQueryClient();
  const fetchDoc = useServerFn(getPrintableDocument);
  const fetchDelivery = useServerFn(getDocumentDelivery);
  const createLink = useServerFn(createInvoiceShareLink);
  const revokeLinks = useServerFn(revokeInvoiceShareLinks);
  const [emailOpen, setEmailOpen] = useState(false);
  const [reminder, setReminder] = useState(false);
  const [lastLink, setLastLink] = useState<string | null>(null);

  const docQ = useQuery({
    queryKey: ["printable-document", companyId, kind, id],
    enabled: Boolean(companyId),
    queryFn: () => fetchDoc({ data: { companyId: companyId!, kind, id } }),
  });
  const deliveryQ = useQuery({
    queryKey: ["document-delivery", companyId, kind, id],
    enabled: Boolean(companyId),
    queryFn: () => fetchDelivery({ data: { companyId: companyId!, kind, id } }),
  });

  const refreshDelivery = () =>
    queryClient.invalidateQueries({ queryKey: ["document-delivery", companyId, kind, id] });

  const linkM = useMutation({
    mutationFn: () => createLink({ data: { companyId: companyId!, invoiceId: id } }),
    onSuccess: async (r) => {
      setLastLink(r.url);
      await refreshDelivery();
      toast.success("Online link created");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });
  const revokeM = useMutation({
    mutationFn: () => revokeLinks({ data: { companyId: companyId!, invoiceId: id } }),
    onSuccess: async (r) => {
      setLastLink(null);
      await refreshDelivery();
      toast.success(r.revoked ? "Online links revoked" : "No active links");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return null;
  const isSales = !(kind.startsWith("purchase_") || kind === "supplier_remittance");
  const canSend = can(isSales ? "sales.draft" : "purchases.draft");
  const template = defaultTemplateFor(kind);
  const doc = docQ.data?.document;
  const delivery = deliveryQ.data;
  const sendable = Boolean(template) && doc?.mark !== "DRAFT" && doc?.mark !== "VOID";
  const canRemind =
    kind === "sales_invoice" && sendable && (doc?.totals.dueMinor ?? 0) > 0 && canSend;
  const templates: EmailTemplate[] = template
    ? canRemind
      ? [template, "reminder"]
      : [template]
    : [];

  const preview = (t: EmailTemplate, message: string) => {
    if (!doc || !docQ.data) return { subject: "", body: "" };
    const r = renderEmail(t, {
      companyName: docQ.data.branding.displayName,
      partyName: doc.party.name,
      documentLabel: DOCUMENT_KIND_LABEL[doc.kind],
      documentNumber: doc.number,
      currency: doc.currency,
      totalMinor:
        t === "receipt" || t === "remittance"
          ? (doc.paymentAmountMinor ?? doc.totals.totalMinor)
          : doc.totals.totalMinor,
      dueMinor: doc.totals.dueMinor,
      issueDate: doc.issueDate,
      dueDate: doc.dueDate,
      daysOverdue: doc.dueDate ? daysOverdue(doc.dueDate, docQ.data.today) : 0,
      link: lastLink,
      customMessage: message.trim() || null,
      locale: docQ.data.locale,
      dateFormat: docQ.data.dateFormat,
      bankDetails: doc.showPaymentDetails ? docQ.data.branding.bankDetails : null,
    });
    return { subject: r.subject, body: r.text };
  };

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied`);
    } catch {
      toast.error("Could not copy. Select and copy the text manually.");
    }
  };

  return (
    <Card className="mt-6 max-w-4xl print:hidden" data-testid="document-delivery">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Send &amp; share</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to="/documents/print/$kind/$id" params={{ kind, id }}>
              <Printer className="mr-1 size-4" /> Print / Save as PDF
            </Link>
          </Button>
          {template ? (
            <Button
              variant="outline"
              size="sm"
              disabled={!sendable || !docQ.data}
              title={
                !sendable
                  ? doc?.mark === "DRAFT"
                    ? "Authorise the document before sending it."
                    : "A void document cannot be sent."
                  : undefined
              }
              onClick={() => {
                setReminder(false);
                setEmailOpen(true);
              }}
            >
              <Mail className="mr-1 size-4" /> Email…
            </Button>
          ) : null}
          {canRemind ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setReminder(true);
                setEmailOpen(true);
              }}
            >
              Send reminder
            </Button>
          ) : null}
          {kind === "sales_invoice" && sendable && canSend ? (
            <Button
              variant="outline"
              size="sm"
              disabled={linkM.isPending}
              onClick={() => linkM.mutate()}
            >
              {linkM.isPending ? (
                <Loader2 className="mr-1 size-4 animate-spin" />
              ) : (
                <Link2 className="mr-1 size-4" />
              )}
              Create online link
            </Button>
          ) : null}
        </div>

        {delivery && !delivery.emailConfigured ? (
          <p className="text-xs text-muted-foreground">{EMAIL_NOT_CONFIGURED_TEXT}</p>
        ) : null}
        {delivery?.blockedReason === "demo" ? (
          <p className="text-xs text-muted-foreground">
            Email sending is switched off in the Demo Company.
          </p>
        ) : null}

        {lastLink ? (
          <div className="rounded border border-border p-3">
            <p className="mb-1 text-xs text-muted-foreground">
              Anyone with this link can view this invoice (read-only). It is shown only now; create
              a new link if you lose it.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="max-w-full break-all rounded bg-muted px-2 py-1 text-xs">
                {lastLink}
              </code>
              <Button size="sm" variant="outline" onClick={() => copy(lastLink, "Link")}>
                <Copy className="mr-1 size-4" /> Copy link
              </Button>
            </div>
          </div>
        ) : null}

        {delivery?.share ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {delivery.share.active} active online link{delivery.share.active === 1 ? "" : "s"} ·
              viewed {delivery.share.views} time{delivery.share.views === 1 ? "" : "s"}
              {delivery.share.lastViewedAt
                ? ` · last ${fmt.dateTime(delivery.share.lastViewedAt)}`
                : ""}
              . The online page shows the invoice only; paying online is not available.
            </span>
            {delivery.share.active > 0 && canSend ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={revokeM.isPending}
                onClick={() => revokeM.mutate()}
              >
                Revoke links
              </Button>
            ) : null}
          </div>
        ) : null}

        {delivery && delivery.history.length > 0 ? (
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Send history
            </h3>
            <ul className="divide-y divide-border rounded border border-border">
              {delivery.history.map((h) => (
                <li
                  key={h.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                >
                  <span>
                    <span className="font-medium">
                      {TEMPLATE_LABEL[h.template as EmailTemplate] ?? h.template}
                    </span>{" "}
                    to {h.to_addresses.join(", ")}
                    {h.error ? <span className="text-destructive"> — {h.error}</span> : null}
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant={h.status === "sent" ? "secondary" : "destructive"}>
                      {h.status === "sent" ? "Sent" : "Failed"}
                    </Badge>
                    {fmt.dateTime(h.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : delivery ? (
          <p className="text-xs text-muted-foreground">
            Nothing has been emailed from LinkBooks yet.
          </p>
        ) : null}
      </CardContent>

      {template && delivery && docQ.data ? (
        <EmailDocumentDialog
          open={emailOpen}
          onOpenChange={setEmailOpen}
          companyId={companyId}
          kind={kind}
          id={id}
          title={
            reminder ? "Send overdue reminder" : `Email ${DOCUMENT_KIND_LABEL[kind].toLowerCase()}`
          }
          templates={reminder ? ["reminder"] : templates.filter((t) => t !== "reminder")}
          defaultTemplate={reminder ? "reminder" : template}
          defaultTo={doc?.partyEmail ?? ""}
          emailConfigured={delivery.emailConfigured}
          blockedReason={delivery.blockedReason}
          canSend={canSend}
          preview={preview}
          onSent={() => void refreshDelivery()}
        />
      ) : null}
    </Card>
  );
}
