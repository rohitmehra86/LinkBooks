import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Printer } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  convertQuoteToInvoice,
  deleteDraftQuote,
  getQuote,
  updateQuoteStatus,
} from "@/lib/sales/sales.functions";
import { getSalesDocumentConfig } from "@/lib/sales/sales-config.functions";
import { isQuoteConvertible, quoteStatusActions, type QuoteStatus } from "@/lib/sales/quote-status";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { bpsToPercentString, money } from "@/components/sales/sales-form-utils";
import { StatusBadge } from "@/components/common/stat-card";
import { Button } from "@/components/ui/button";
import { DocumentActions } from "@/components/documents/DocumentActions";
import { AttachmentsPanel } from "@/components/documents/AttachmentsPanel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/sales/quotes/$quoteId/")({
  head: () => ({ meta: [{ title: "Quote — LinkBooks" }] }),
  component: QuoteDetailPage,
});

const ACTION_LABEL: Record<QuoteStatus, string> = {
  draft: "Back to draft",
  sent: "Mark sent",
  accepted: "Mark accepted",
  declined: "Mark declined",
  expired: "Mark expired",
  converted: "Converted",
  void: "Void quote",
};

function QuoteDetailPage() {
  const { quoteId } = Route.useParams();
  const { company } = useActiveCompany();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const companyId = company?.id;
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);

  const fetchQuote = useServerFn(getQuote);
  const fetchConfig = useServerFn(getSalesDocumentConfig);
  const doStatus = useServerFn(updateQuoteStatus);
  const doConvert = useServerFn(convertQuoteToInvoice);
  const doDelete = useServerFn(deleteDraftQuote);

  const query = useQuery({
    queryKey: ["sales-quote", companyId, quoteId],
    enabled: Boolean(companyId),
    queryFn: () => fetchQuote({ data: { companyId: companyId!, quoteId } }),
  });
  const configQ = useQuery({
    queryKey: ["sales-doc-config", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchConfig({ data: { companyId: companyId! } }),
  });

  const statusM = useMutation({
    mutationFn: (status: string) => doStatus({ data: { companyId: companyId!, quoteId, status } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sales-quote", companyId, quoteId] });
      await qc.invalidateQueries({ queryKey: ["sales-quotes", companyId] });
      setVoidOpen(false);
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
  const deleteM = useMutation({
    mutationFn: () => doDelete({ data: { companyId: companyId!, quoteId } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sales-quotes", companyId] });
      toast.success("Draft quote deleted");
      navigate({ to: "/sales/quotes" });
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

  const q = query.data;
  const cur = q.currency_code;
  const today = configQ.data?.today ?? q.quote_date;
  const convertible = isQuoteConvertible(q, today);
  const actions = quoteStatusActions(q.status).filter((s) => s !== "void");
  const canVoid = quoteStatusActions(q.status).includes("void");
  const lines = [...q.sales_quote_lines].sort((a, b) => a.line_order - b.line_order);

  return (
    <>
      <PageHeader
        title={`Quote ${q.quote_number ?? ""} · ${q.contacts?.name ?? "Customer"}`}
        description={`${q.quote_date}${q.expiry_date ? ` · expires ${q.expiry_date}` : ""} · never posts to the ledger`}
        actions={
          <div className="flex flex-wrap gap-2 print:hidden">
            <Button variant="outline" size="sm" asChild>
              <Link to="/sales/quotes">Back</Link>
            </Button>
            <Button variant="outline" size="sm" onClick={() => window.print()}>
              <Printer className="mr-1 size-4" /> Print / PDF
            </Button>
            {q.status === "draft" ? (
              <>
                <Button variant="outline" size="sm" asChild>
                  <Link to="/sales/quotes/$quoteId/edit" params={{ quoteId }}>
                    Edit draft
                  </Link>
                </Button>
                <Button variant="outline" size="sm" onClick={() => setDeleteOpen(true)}>
                  Delete draft
                </Button>
              </>
            ) : null}
            {actions.map((s) => (
              <Button
                key={s}
                size="sm"
                variant="outline"
                disabled={statusM.isPending}
                onClick={() => statusM.mutate(s)}
              >
                {ACTION_LABEL[s]}
              </Button>
            ))}
            {canVoid ? (
              <Button size="sm" variant="outline" onClick={() => setVoidOpen(true)}>
                Void quote
              </Button>
            ) : null}
            {convertible.ok ? (
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
        <StatusBadge status={q.status} />
        <span>#{q.quote_number ?? "—"}</span>
        <span>Total {money(q.total_minor, cur)}</span>
        {q.sent_at ? <span>Sent {q.sent_at.slice(0, 10)}</span> : null}
        {q.accepted_at ? <span>Accepted {q.accepted_at.slice(0, 10)}</span> : null}
      </div>
      {!convertible.ok && !q.converted_invoice_id && q.status !== "void" ? (
        <p className="mb-4 text-sm text-muted-foreground">{convertible.reason}</p>
      ) : null}
      {q.memo ? <p className="mb-4 text-sm text-muted-foreground">{q.memo}</p> : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Description</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Unit price</TableHead>
            <TableHead className="text-right">Discount</TableHead>
            <TableHead className="text-right">Tax %</TableHead>
            <TableHead className="text-right">Net</TableHead>
            <TableHead className="text-right">Tax</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((l) => (
            <TableRow key={l.id}>
              <TableCell>{l.description}</TableCell>
              <TableCell className="text-right">{l.quantity}</TableCell>
              <TableCell className="text-right">{money(l.unit_price_minor, cur)}</TableCell>
              <TableCell className="text-right">{money(l.discount_minor, cur)}</TableCell>
              <TableCell className="text-right">{bpsToPercentString(l.tax_rate_bps)}%</TableCell>
              <TableCell className="text-right">{money(l.net_minor, cur)}</TableCell>
              <TableCell className="text-right">{money(l.tax_minor, cur)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="mt-4 ml-auto w-64 space-y-1 text-sm">
        <div className="flex justify-between">
          <span>Subtotal</span>
          <span>{money(q.subtotal_minor, cur)}</span>
        </div>
        <div className="flex justify-between">
          <span>Tax</span>
          <span>{money(q.tax_minor, cur)}</span>
        </div>
        <div className="flex justify-between font-medium">
          <span>Total</span>
          <span>{money(q.total_minor, cur)}</span>
        </div>
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this draft quote?</AlertDialogTitle>
            <AlertDialogDescription>
              The draft and its lines are removed. Nothing was posted to the ledger.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteM.mutate()}>Delete draft</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={voidOpen} onOpenChange={setVoidOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Void this quote?</AlertDialogTitle>
            <AlertDialogDescription>
              A void quote cannot be converted or reopened. It never affected the ledger.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => statusM.mutate("void")}>Void quote</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <DocumentActions kind="sales_quote" id={quoteId} />
      <AttachmentsPanel entityType="sales_quote" entityId={quoteId} />
    </>
  );
}
