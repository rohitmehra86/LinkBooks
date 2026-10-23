import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Printer } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  authoriseInvoice,
  copyInvoice,
  deleteDraftInvoice,
  getInvoice,
  markInvoiceSent,
  voidInvoice,
  writeOffInvoiceBadDebt,
} from "@/lib/sales/sales.functions";
import { getSalesDocumentConfig } from "@/lib/sales/sales-config.functions";
import { canVoidInvoice } from "@/lib/sales/allocation-rules";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { ReasonDialog } from "@/components/sales/ReasonDialog";
import { bpsToPercentString, money } from "@/components/sales/sales-form-utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

export const Route = createFileRoute("/_authenticated/sales/invoices/$invoiceId/")({
  head: () => ({ meta: [{ title: "Invoice — LinkBooks" }] }),
  component: InvoiceDetail,
});

function InvoiceDetail() {
  const { invoiceId } = Route.useParams();
  const { company } = useActiveCompany();
  const navigate = useNavigate();
  const fetchInvoice = useServerFn(getInvoice);
  const fetchConfig = useServerFn(getSalesDocumentConfig);
  const doAuthorise = useServerFn(authoriseInvoice);
  const doVoid = useServerFn(voidInvoice);
  const doWriteOff = useServerFn(writeOffInvoiceBadDebt);
  const doDelete = useServerFn(deleteDraftInvoice);
  const doCopy = useServerFn(copyInvoice);
  const doSent = useServerFn(markInvoiceSent);
  const queryClient = useQueryClient();
  const companyId = company?.id;
  const [voidOpen, setVoidOpen] = useState(false);
  const [writeOffOpen, setWriteOffOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const query = useQuery({
    queryKey: ["sales-invoice", companyId, invoiceId],
    enabled: Boolean(companyId),
    queryFn: () => fetchInvoice({ data: { companyId: companyId!, invoiceId } }),
  });
  const configQ = useQuery({
    queryKey: ["sales-doc-config", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchConfig({ data: { companyId: companyId! } }),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["sales-invoice", companyId, invoiceId] });
    await queryClient.invalidateQueries({ queryKey: ["sales-invoices", companyId] });
  };

  const authoriseMutation = useMutation({
    mutationFn: () => doAuthorise({ data: { companyId: companyId!, invoiceId } }),
    onSuccess: async () => {
      await refresh();
      toast.success("Invoice authorised — journal posted");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const voidMutation = useMutation({
    mutationFn: (v: { reason: string; date: string }) =>
      doVoid({ data: { companyId: companyId!, invoiceId, reason: v.reason, voidDate: v.date } }),
    onSuccess: async () => {
      setVoidOpen(false);
      await refresh();
      toast.success("Invoice voided — reversing journal posted");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const writeOffMutation = useMutation({
    mutationFn: (v: { reason: string; date: string }) =>
      doWriteOff({
        data: { companyId: companyId!, invoiceId, reason: v.reason, writeOffDate: v.date },
      }),
    onSuccess: async () => {
      setWriteOffOpen(false);
      await refresh();
      toast.success("Written off as bad debt — credit note posted");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: () => doDelete({ data: { companyId: companyId!, invoiceId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["sales-invoices", companyId] });
      toast.success("Draft deleted");
      navigate({ to: "/sales/invoices" });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const copyMutation = useMutation({
    mutationFn: () => doCopy({ data: { companyId: companyId!, invoiceId } }),
    onSuccess: async (r) => {
      await queryClient.invalidateQueries({ queryKey: ["sales-invoices", companyId] });
      toast.success("Copied to a new draft");
      navigate({ to: "/sales/invoices/$invoiceId/edit", params: { invoiceId: r.id } });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const sentMutation = useMutation({
    mutationFn: () => doSent({ data: { companyId: companyId!, invoiceId } }),
    onSuccess: async () => {
      await refresh();
      toast.success("Marked as sent");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (query.isPending) return <LoadingState />;
  if (query.isError) {
    return (
      <ErrorState
        title="Invoice not found"
        description={friendlyAuthError(query.error)}
        onRetry={() => query.refetch()}
      />
    );
  }

  const inv = query.data;
  const cur = inv.currency_code;
  const today = configQ.data?.today ?? new Date().toISOString().slice(0, 10);
  const outstanding =
    inv.status === "draft" || inv.status === "void"
      ? 0
      : inv.total_minor - inv.amount_paid_minor - inv.amount_credited_minor;
  const posted = ["authorised", "partly_paid", "paid"].includes(inv.status);
  const voidable = canVoidInvoice({
    status: inv.status,
    amountPaidMinor: inv.amount_paid_minor,
    amountCreditedMinor: inv.amount_credited_minor,
  });
  const overdue =
    ["authorised", "partly_paid"].includes(inv.status) && inv.due_date < today && outstanding > 0;
  const hasLineDiscount = inv.sales_invoice_lines.some((l) => l.discount_minor > 0);
  const company_ = inv.company;
  const brand = inv.branding;
  const customer = inv.contacts;

  return (
    <>
      {/* Hide the app chrome when printing so the page reads as a clean document. */}
      <style>{`@media print { aside, nav, [data-sidebar], [data-app-header] { display: none !important; } }`}</style>
      <div className="print:hidden">
        <PageHeader
          title={`Invoice ${inv.invoice_number ?? "(draft)"}`}
          description={`${customer?.name ?? "Customer"} · ${inv.invoice_date} · due ${inv.due_date}`}
          actions={
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link to="/sales/invoices">Back</Link>
              </Button>
              <Button variant="outline" size="sm" onClick={() => window.print()}>
                <Printer className="mr-1 size-4" /> Print / PDF
              </Button>
              {inv.status === "draft" ? (
                <>
                  <Button size="sm" variant="outline" asChild>
                    <Link to="/sales/invoices/$invoiceId/edit" params={{ invoiceId }}>
                      Edit draft
                    </Link>
                  </Button>
                  <Button
                    size="sm"
                    disabled={authoriseMutation.isPending}
                    onClick={() => authoriseMutation.mutate()}
                  >
                    {authoriseMutation.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : null}
                    Authorise & post
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => setDeleteOpen(true)}>
                    Delete draft
                  </Button>
                </>
              ) : null}
              {posted ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={sentMutation.isPending}
                    onClick={() => sentMutation.mutate()}
                  >
                    {inv.sent_at ? "Mark as sent again" : "Mark as sent"}
                  </Button>
                  <Button size="sm" variant="outline" asChild>
                    <Link to="/sales/credit-notes/new" search={{ invoiceId }}>
                      Credit this invoice
                    </Link>
                  </Button>
                </>
              ) : null}
              {["authorised", "partly_paid"].includes(inv.status) ? (
                <Button size="sm" asChild>
                  <Link
                    to="/sales/receipts/new"
                    search={{ contactId: inv.contact_id, invoiceId: inv.id }}
                  >
                    Record receipt
                  </Link>
                </Button>
              ) : null}
              {inv.status !== "draft" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={copyMutation.isPending}
                  onClick={() => copyMutation.mutate()}
                >
                  Copy invoice
                </Button>
              ) : null}
              {(inv.status === "authorised" || inv.status === "partly_paid") && outstanding > 0 ? (
                <Button size="sm" variant="outline" onClick={() => setWriteOffOpen(true)}>
                  Write off bad debt
                </Button>
              ) : null}
              {voidable ? (
                <Button size="sm" variant="destructive" onClick={() => setVoidOpen(true)}>
                  Void
                </Button>
              ) : null}
            </div>
          }
        />
        {inv.status === "authorised" || inv.status === "partly_paid" || inv.status === "paid" ? (
          !voidable ? (
            <p className="mb-3 text-xs text-muted-foreground">
              {inv.status === "paid" || inv.amount_paid_minor > 0 || inv.amount_credited_minor > 0
                ? "This invoice has payments or credits applied, so it cannot be voided. Remove them first (receipt or credit note page), or issue a credit note."
                : null}
            </p>
          ) : null
        ) : null}
        <p className="mb-4 text-xs text-muted-foreground">
          Delivery: use Print / PDF. Email delivery is not configured in this environment.
        </p>
      </div>

      <article className="max-w-4xl space-y-6 rounded-md border border-border bg-card p-6 print:border-0 print:p-0">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">
              {brand?.trading_name || company_?.name || "Your company"}
            </h2>
            {company_?.legal_name && company_.legal_name !== company_.name ? (
              <p className="text-sm text-muted-foreground">{company_.legal_name}</p>
            ) : null}
            {brand?.letterhead_line ? <p className="text-sm">{brand.letterhead_line}</p> : null}
            {brand?.invoice_email ? (
              <p className="text-sm text-muted-foreground">{brand.invoice_email}</p>
            ) : null}
            {brand?.invoice_phone ? (
              <p className="text-sm text-muted-foreground">{brand.invoice_phone}</p>
            ) : null}
          </div>
          <div className="text-right">
            <p className="text-lg font-semibold uppercase tracking-wide">
              {inv.status === "draft" ? "Draft invoice" : "Tax invoice"}
            </p>
            <p className="text-sm">No. {inv.invoice_number ?? "—"}</p>
            <p className="text-sm text-muted-foreground">Date {inv.invoice_date}</p>
            <p className="text-sm text-muted-foreground">Due {inv.due_date}</p>
            <div className="mt-1 flex justify-end gap-2 print:hidden">
              <Badge variant="outline" className="capitalize">
                {inv.status.replace("_", " ")}
              </Badge>
              {overdue ? <Badge variant="destructive">Overdue</Badge> : null}
              {inv.sent_at ? <Badge variant="secondary">Sent</Badge> : null}
            </div>
          </div>
        </header>

        <section className="text-sm">
          <p className="text-xs uppercase text-muted-foreground">Bill to</p>
          <p className="font-medium">{customer?.name ?? "—"}</p>
          {customer?.email ? <p>{customer.email}</p> : null}
          {customer?.phone ? <p>{customer.phone}</p> : null}
          {customer?.tax_number ? <p>Tax no. {customer.tax_number}</p> : null}
        </section>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Unit price</TableHead>
              {hasLineDiscount ? <TableHead className="text-right">Discount</TableHead> : null}
              <TableHead className="text-right">Tax</TableHead>
              <TableHead className="text-right">Net</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {inv.sales_invoice_lines.map((l) => (
              <TableRow key={l.id}>
                <TableCell>{l.description}</TableCell>
                <TableCell className="text-right">{l.quantity}</TableCell>
                <TableCell className="text-right">{money(l.unit_price_minor, cur)}</TableCell>
                {hasLineDiscount ? (
                  <TableCell className="text-right">
                    {l.discount_minor > 0 ? money(l.discount_minor, cur) : "—"}
                  </TableCell>
                ) : null}
                <TableCell className="text-right">
                  {bpsToPercentString(l.tax_rate_bps)}% · {money(l.tax_minor, cur)}
                </TableCell>
                <TableCell className="text-right">{money(l.net_minor, cur)}</TableCell>
                <TableCell className="text-right">{money(l.gross_minor, cur)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <div className="ml-auto w-full max-w-xs space-y-1 text-sm">
          <Row label="Subtotal" value={money(inv.subtotal_minor, cur)} />
          <Row label="Tax" value={money(inv.tax_minor, cur)} />
          <Row label="Total" value={money(inv.total_minor, cur)} bold />
          {inv.amount_paid_minor > 0 ? (
            <Row label="Paid" value={`− ${money(inv.amount_paid_minor, cur)}`} />
          ) : null}
          {inv.amount_credited_minor > 0 ? (
            <Row label="Credited" value={`− ${money(inv.amount_credited_minor, cur)}`} />
          ) : null}
          {inv.status !== "draft" && inv.status !== "void" ? (
            <Row label="Amount due" value={money(outstanding, cur)} bold />
          ) : null}
        </div>

        {inv.memo ? <p className="whitespace-pre-line text-sm">{inv.memo}</p> : null}
        {company_?.invoice_footer ? (
          <p className="whitespace-pre-line text-xs text-muted-foreground">
            {company_.invoice_footer}
          </p>
        ) : null}
        {inv.status === "void" ? (
          <p className="text-sm text-destructive">
            Voided{inv.void_reason ? `: ${inv.void_reason}` : ""}
          </p>
        ) : null}
      </article>

      {inv.payments.length + inv.credit_applications.length > 0 ? (
        <section className="mt-6 max-w-4xl space-y-2 print:break-inside-avoid">
          <h3 className="text-sm font-semibold">Payment history</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inv.payments.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>{p.sales_receipts?.receipt_date ?? p.allocated_on ?? "—"}</TableCell>
                  <TableCell>Payment</TableCell>
                  <TableCell>
                    <Link
                      className="underline"
                      to="/sales/receipts/$receiptId"
                      params={{ receiptId: p.receipt_id }}
                    >
                      {p.sales_receipts?.reference || "Receipt"}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right">{money(p.amount_minor, cur)}</TableCell>
                </TableRow>
              ))}
              {inv.credit_applications.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    {c.allocated_on ?? c.sales_credit_notes?.credit_date ?? "—"}
                  </TableCell>
                  <TableCell>Credit note</TableCell>
                  <TableCell>
                    <Link
                      className="underline"
                      to="/sales/credit-notes/$creditNoteId"
                      params={{ creditNoteId: c.credit_note_id }}
                    >
                      {c.sales_credit_notes?.credit_number ?? "Credit note"}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right">{money(c.amount_minor, cur)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ) : null}

      {inv.reversed_payments.length + inv.reversed_credit_applications.length > 0 ? (
        <section className="mt-4 max-w-4xl space-y-1 text-sm text-muted-foreground print:hidden">
          <h3 className="text-sm font-semibold text-foreground">Reversed applications</h3>
          {inv.reversed_payments.map((p) => (
            <p key={p.id}>
              Payment {money(p.amount_minor, cur)} unallocated on {p.reversed_on ?? "—"}
              {p.reverse_reason ? ` — ${p.reverse_reason}` : ""}
            </p>
          ))}
          {inv.reversed_credit_applications.map((c) => (
            <p key={c.id}>
              Credit {c.sales_credit_notes?.credit_number ?? ""} {money(c.amount_minor, cur)}{" "}
              removed on {c.reversed_on ?? "—"}
              {c.reverse_reason ? ` — ${c.reverse_reason}` : ""}
            </p>
          ))}
        </section>
      ) : null}

      <ReasonDialog
        open={voidOpen}
        onOpenChange={setVoidOpen}
        title="Void this invoice?"
        description="This posts a reversing journal and cannot be undone. Only invoices with no payments or credits can be voided."
        confirmLabel="Void invoice"
        dateLabel="Void date"
        minDate={inv.invoice_date}
        defaultDate={today}
        pending={voidMutation.isPending}
        onConfirm={(v) => voidMutation.mutate(v)}
      />
      <ReasonDialog
        open={writeOffOpen}
        onOpenChange={setWriteOffOpen}
        title="Write off the remaining balance as bad debt?"
        description={`Posts a credit note for ${money(outstanding, cur)} against your bad debt expense account and applies it to this invoice. Tax is relieved in proportion. This cannot be undone except by voiding the credit note.`}
        confirmLabel="Write off"
        dateLabel="Write-off date"
        minDate={inv.invoice_date}
        defaultDate={today}
        pending={writeOffMutation.isPending}
        onConfirm={(v) => writeOffMutation.mutate(v)}
      />
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this draft?</AlertDialogTitle>
            <AlertDialogDescription>
              The draft has not posted to the ledger. It will be removed permanently.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteMutation.mutate()}>
              Delete draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "font-semibold" : ""}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
