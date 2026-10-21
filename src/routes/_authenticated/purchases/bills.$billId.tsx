import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Paperclip,
  Printer,
} from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  addBillNote,
  authoriseBill,
  deleteDraftBill,
  downloadBillAttachment,
  getBill,
  getBillNeighbors,
  listBillActivity,
  listBillNotes,
  rejectBillApproval,
  submitBillForApproval,
  voidBill,
} from "@/lib/purchases/purchases.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

type BillSearch = { fromTab?: string };

export const Route = createFileRoute("/_authenticated/purchases/bills/$billId")({
  validateSearch: (s: Record<string, unknown>): BillSearch => {
    const out: BillSearch = {};
    if (typeof s["fromTab"] === "string" && s["fromTab"]) out.fromTab = s["fromTab"];
    return out;
  },
  head: () => ({ meta: [{ title: "Bill — LinkBooks" }] }),
  component: BillDocumentWorkspace,
});

function BillDocumentWorkspace() {
  const { billId } = Route.useParams();
  const search = Route.useSearch();
  const { company } = useActiveCompany();
  const fetchBill = useServerFn(getBill);
  const fetchNeighbors = useServerFn(getBillNeighbors);
  const fetchNotes = useServerFn(listBillNotes);
  const fetchActivity = useServerFn(listBillActivity);
  const doAuthorise = useServerFn(authoriseBill);
  const doVoid = useServerFn(voidBill);
  const doSubmit = useServerFn(submitBillForApproval);
  const doReject = useServerFn(rejectBillApproval);
  const doDelete = useServerFn(deleteDraftBill);
  const doAddNote = useServerFn(addBillNote);
  const doDownload = useServerFn(downloadBillAttachment);
  const queryClient = useQueryClient();
  const companyId = company?.id;
  const baseCurrency = company?.base_currency ?? "GBP";
  const [supplierOpen, setSupplierOpen] = useState(true);
  const [noteDraft, setNoteDraft] = useState("");
  const [approvalComment, setApprovalComment] = useState("");

  const query = useQuery({
    queryKey: ["bill", companyId, billId],
    enabled: Boolean(companyId),
    queryFn: () => fetchBill({ data: { companyId: companyId!, billId } }),
  });

  const neighborsQ = useQuery({
    queryKey: ["bill-neighbors", companyId, billId],
    enabled: Boolean(companyId),
    queryFn: () => fetchNeighbors({ data: { companyId: companyId!, billId } }),
  });

  const notesQ = useQuery({
    queryKey: ["bill-notes", companyId, billId],
    enabled: Boolean(companyId),
    queryFn: () => fetchNotes({ data: { companyId: companyId!, billId } }),
  });

  const activityQ = useQuery({
    queryKey: ["bill-activity", companyId, billId],
    enabled: Boolean(companyId),
    queryFn: () => fetchActivity({ data: { companyId: companyId!, billId } }),
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["bill", companyId, billId] });
    await queryClient.invalidateQueries({ queryKey: ["bills", companyId] });
    await queryClient.invalidateQueries({ queryKey: ["bills-workspace-summary", companyId] });
    await queryClient.invalidateQueries({ queryKey: ["bill-notes", companyId, billId] });
    await queryClient.invalidateQueries({ queryKey: ["bill-activity", companyId, billId] });
  };

  const authoriseMutation = useMutation({
    mutationFn: () => doAuthorise({ data: { companyId: companyId!, billId } }),
    onSuccess: async () => {
      await invalidate();
      toast.success("Bill authorised — journal posted");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const voidMutation = useMutation({
    mutationFn: () => doVoid({ data: { companyId: companyId!, billId } }),
    onSuccess: async () => {
      await invalidate();
      toast.success("Bill voided (reversing journal if posted)");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const submitMutation = useMutation({
    mutationFn: () =>
      doSubmit({
        data: {
          companyId: companyId!,
          billId,
          ...(approvalComment.trim() ? { comment: approvalComment.trim() } : {}),
        },
      }),
    onSuccess: async () => {
      await invalidate();
      toast.success("Submitted for approval");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const rejectMutation = useMutation({
    mutationFn: () =>
      doReject({
        data: {
          companyId: companyId!,
          billId,
          reason: approvalComment || "Returned for correction",
        },
      }),
    onSuccess: async () => {
      await invalidate();
      toast.success("Returned to draft");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: () => doDelete({ data: { companyId: companyId!, billId } }),
    onSuccess: async () => {
      toast.success("Draft deleted");
      window.location.href = "/purchases/bills";
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const noteMutation = useMutation({
    mutationFn: () => doAddNote({ data: { companyId: companyId!, billId, body: noteDraft } }),
    onSuccess: async () => {
      setNoteDraft("");
      await queryClient.invalidateQueries({ queryKey: ["bill-notes", companyId, billId] });
      toast.success("Note added");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (query.isPending) return <LoadingState />;
  if (query.isError) {
    return (
      <ErrorState
        title="Bill not found"
        description={friendlyAuthError(query.error)}
        onRetry={() => query.refetch()}
      />
    );
  }

  const bill = query.data as {
    id: string;
    status: string;
    bill_date: string;
    due_date: string;
    bill_number: string | null;
    supplier_invoice_number: string | null;
    display_reference: string | null;
    memo: string | null;
    currency_code: string;
    fx_rate_to_base: number | null;
    payment_terms_days: number | null;
    total_minor: number;
    tax_minor: number;
    subtotal_minor: number;
    amount_paid_minor: number;
    amount_credited_minor: number;
    balance_due_minor: number;
    document_total_minor: number;
    posted_journal_id: string | null;
    contact_id: string;
    approval_comment: string | null;
    rejection_reason: string | null;
    submitted_for_approval_at: string | null;
    contacts: {
      id: string;
      name: string;
      email: string | null;
      phone: string | null;
      account_number: string | null;
      tax_number: string | null;
      billing_address_line1: string | null;
      billing_city: string | null;
      billing_country: string | null;
    } | null;
    purchase_bill_lines: Array<{
      id: string;
      description: string;
      quantity: number;
      unit_price_minor: number;
      discount_minor: number;
      net_minor: number;
      tax_minor: number;
      tax_rate_bps: number;
      account_id: string | null;
      class_id: string | null;
      location_id: string | null;
      project_id: string | null;
    }>;
    attachments: Array<{
      id: string;
      file_name: string;
      content_type: string | null;
      size_bytes: number | null;
      created_at: string;
    }>;
    payment_allocations: Array<{
      id: string;
      amount_minor: number;
      supplier_payments:
        | { id: string; payment_date: string; reference: string | null; total_minor: number; status: string }
        | Array<{ id: string; payment_date: string; reference: string | null; total_minor: number; status: string }>
        | null;
    }>;
  };

  const currency = bill.currency_code || baseCurrency;
  const outstanding =
    bill.status === "draft" || bill.status === "awaiting_approval"
      ? 0
      : bill.balance_due_minor ??
        Math.max(0, bill.total_minor - bill.amount_paid_minor - bill.amount_credited_minor);
  const backSearch =
    search.fromTab && search.fromTab !== "all" ? { tab: search.fromTab as never } : {};
  const neighbors = neighborsQ.data;

  const downloadAttachment = async (attachmentId: string) => {
    try {
      const file = await doDownload({ data: { companyId, attachmentId } });
      const bin = atob(file.contentBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: file.contentType || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(friendlyAuthError(e));
    }
  };

  return (
    <div className="space-y-4">
      <header className="rounded-xl border border-border/80 bg-gradient-to-br from-background to-muted/30 p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Purchase bill
            </p>
            <h1 className="truncate text-xl font-semibold tracking-tight">
              {bill.contacts?.name ?? "Supplier"}
              {bill.display_reference ? (
                <span className="ml-2 font-mono text-base font-normal text-muted-foreground">
                  {bill.display_reference}
                </span>
              ) : null}
            </h1>
            <p className="text-sm text-muted-foreground">
              Bill {bill.bill_date} · Due {bill.due_date}
              {bill.bill_number ? ` · Internal ${bill.bill_number}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link to="/purchases/bills" search={backSearch}>
                Back to Bills
              </Link>
            </Button>
            {neighbors?.previousId ? (
              <Button variant="outline" size="sm" asChild>
                <Link
                  to="/purchases/bills/$billId"
                  params={{ billId: neighbors.previousId }}
                  search={search}
                >
                  <ChevronLeft className="size-4" />
                  Previous
                </Link>
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled>
                <ChevronLeft className="size-4" />
                Previous
              </Button>
            )}
            {neighbors?.nextId ? (
              <Button variant="outline" size="sm" asChild>
                <Link
                  to="/purchases/bills/$billId"
                  params={{ billId: neighbors.nextId }}
                  search={search}
                >
                  Next
                  <ChevronRight className="size-4" />
                </Link>
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled>
                Next
                <ChevronRight className="size-4" />
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => window.print()}>
              <Printer className="mr-1 size-4" />
              Print / PDF
            </Button>
            {bill.status === "draft" || bill.status === "awaiting_approval" ? (
              <Button size="sm" variant="outline" asChild>
                <Link to="/purchases/bills/$billId/edit" params={{ billId }}>
                  Edit
                </Link>
              </Button>
            ) : null}
            {bill.status === "draft" ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={submitMutation.isPending}
                  onClick={() => submitMutation.mutate()}
                >
                  Submit for approval
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
              </>
            ) : null}
            {bill.status === "awaiting_approval" ? (
              <>
                <Button
                  size="sm"
                  disabled={authoriseMutation.isPending}
                  onClick={() => authoriseMutation.mutate()}
                >
                  Approve & authorise
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={rejectMutation.isPending}
                  onClick={() => rejectMutation.mutate()}
                >
                  Return for correction
                </Button>
              </>
            ) : null}
            {["authorised", "partly_paid"].includes(bill.status) ? (
              <Button size="sm" variant="outline" asChild>
                <Link to="/purchases/payments/new">Record payment</Link>
              </Button>
            ) : null}
            {bill.status === "draft" || bill.status === "awaiting_approval" ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={deleteMutation.isPending}
                onClick={() => {
                  if (confirm("Delete this unposted bill?")) deleteMutation.mutate();
                }}
              >
                Delete
              </Button>
            ) : bill.status !== "void" ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={voidMutation.isPending}
                onClick={() => {
                  if (confirm("Void this bill? Posted journals will be reversed.")) {
                    voidMutation.mutate();
                  }
                }}
              >
                Void
              </Button>
            ) : null}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <Badge variant="outline" className="capitalize">
            {bill.status.replace(/_/g, " ")}
          </Badge>
          <span>
            Supplier invoice #{" "}
            <strong>{bill.supplier_invoice_number?.trim() || "—"}</strong>
          </span>
          <span>
            Document total{" "}
            <strong className="tabular-nums">
              {fromMinorUnits(BigInt(bill.document_total_minor ?? bill.total_minor), currency)}
            </strong>
          </span>
          <span>
            Paid{" "}
            <strong className="tabular-nums">
              {fromMinorUnits(BigInt(bill.amount_paid_minor), currency)}
            </strong>
          </span>
          <span>
            Balance due{" "}
            <strong className="tabular-nums">
              {bill.status === "draft" || bill.status === "awaiting_approval"
                ? "— (unposted)"
                : fromMinorUnits(BigInt(outstanding), currency)}
            </strong>
          </span>
          {bill.posted_journal_id ? (
            <span className="font-mono text-xs text-muted-foreground">
              Journal {bill.posted_journal_id.slice(0, 8)}…
            </span>
          ) : null}
          {neighbors?.position ? (
            <span className="text-xs text-muted-foreground">
              {neighbors.position} of {neighbors.total}
            </span>
          ) : null}
        </div>
      </header>

      {!bill.supplier_invoice_number?.trim() ? (
        <Alert>
          <AlertTitle>Missing supplier invoice number</AlertTitle>
          <AlertDescription>
            This bill has no supplier invoice # stored. The list shows the internal bill number
            instead.{" "}
            {bill.status === "draft" || bill.status === "awaiting_approval" ? (
              <Link
                to="/purchases/bills/$billId/edit"
                params={{ billId }}
                className="underline underline-offset-2"
              >
                Edit the draft
              </Link>
            ) : (
              "Add it via a controlled correction workflow when available — historical numbers are not fabricated."
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
        <div className="space-y-4">
          <section className="rounded-lg border border-border bg-background p-4">
            <h2 className="mb-3 text-sm font-semibold">Line items</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Unit</TableHead>
                  <TableHead className="text-right">Discount</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                  <TableHead className="text-right">Tax</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bill.purchase_bill_lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell>
                      <div>{l.description}</div>
                      <div className="mt-0.5 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                        {l.account_id ? <span>Acct {l.account_id.slice(0, 8)}…</span> : null}
                        {l.class_id ? <span>Class</span> : null}
                        {l.location_id ? <span>Location</span> : null}
                        {l.project_id ? <span>Project</span> : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{l.quantity}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fromMinorUnits(BigInt(l.unit_price_minor ?? 0), currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fromMinorUnits(BigInt(l.discount_minor ?? 0), currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fromMinorUnits(BigInt(l.net_minor), currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fromMinorUnits(BigInt(l.tax_minor), currency)}
                      {l.tax_rate_bps ? (
                        <span className="ml-1 text-[10px] text-muted-foreground">
                          ({(l.tax_rate_bps / 100).toFixed(1)}%)
                        </span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="mt-4 flex flex-col items-end gap-1 text-sm">
              <div className="flex w-56 justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span className="tabular-nums">
                  {fromMinorUnits(BigInt(bill.subtotal_minor), currency)}
                </span>
              </div>
              <div className="flex w-56 justify-between">
                <span className="text-muted-foreground">Tax</span>
                <span className="tabular-nums">
                  {fromMinorUnits(BigInt(bill.tax_minor), currency)}
                </span>
              </div>
              <div className="flex w-56 justify-between font-semibold">
                <span>Total</span>
                <span className="tabular-nums">
                  {fromMinorUnits(BigInt(bill.total_minor), currency)}
                </span>
              </div>
              <div className="flex w-56 justify-between text-muted-foreground">
                <span>Paid</span>
                <span className="tabular-nums">
                  {fromMinorUnits(BigInt(bill.amount_paid_minor), currency)}
                </span>
              </div>
              <div className="flex w-56 justify-between text-muted-foreground">
                <span>Credited</span>
                <span className="tabular-nums">
                  {fromMinorUnits(BigInt(bill.amount_credited_minor), currency)}
                </span>
              </div>
              <Separator className="my-1 w-56" />
              <div className="flex w-56 justify-between font-semibold">
                <span>Balance due</span>
                <span className="tabular-nums">
                  {bill.status === "draft" || bill.status === "awaiting_approval"
                    ? "—"
                    : fromMinorUnits(BigInt(outstanding), currency)}
                </span>
              </div>
            </div>
            {bill.memo ? (
              <p className="mt-4 rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
                {bill.memo}
              </p>
            ) : null}
          </section>

          <section className="rounded-lg border border-border bg-background p-4">
            <h2 className="mb-3 text-sm font-semibold">Payments & credits</h2>
            {(bill.payment_allocations ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No payment allocations on this bill.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Allocated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bill.payment_allocations.map((a) => {
                    const payRaw = a.supplier_payments;
                    const pay = Array.isArray(payRaw) ? payRaw[0] : payRaw;
                    return (
                      <TableRow key={a.id}>
                        <TableCell>{pay?.payment_date ?? "—"}</TableCell>
                        <TableCell>{pay?.reference ?? "—"}</TableCell>
                        <TableCell className="capitalize">{pay?.status ?? "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {fromMinorUnits(BigInt(a.amount_minor), currency)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Recording a payment here updates AP allocations. Bank transmission requires a verified
              payment integration (not implied by this screen).
            </p>
          </section>

          <section className="rounded-lg border border-border bg-background p-4">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Paperclip className="size-4" />
              Attachments ({bill.attachments?.length ?? 0})
            </h2>
            {(bill.attachments ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No attachments.</p>
            ) : (
              <ul className="space-y-2">
                {bill.attachments.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{a.file_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {a.content_type ?? "file"}
                        {a.size_bytes != null ? ` · ${Math.round(a.size_bytes / 1024)} KB` : ""}
                      </p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => void downloadAttachment(a.id)}>
                      Download
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-border bg-background p-4">
            <h2 className="mb-3 text-sm font-semibold">Internal notes</h2>
            <div className="mb-3 flex gap-2">
              <Textarea
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                placeholder="Add an internal note…"
                rows={2}
              />
              <Button
                size="sm"
                disabled={!noteDraft.trim() || noteMutation.isPending}
                onClick={() => noteMutation.mutate()}
              >
                Add
              </Button>
            </div>
            <ul className="space-y-2 text-sm">
              {((notesQ.data ?? []) as Array<{ id: string; body: string; created_at: string }>).map(
                (n) => (
                  <li key={n.id} className="rounded-md bg-muted/40 px-3 py-2">
                    <p>{n.body}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {new Date(n.created_at).toLocaleString()}
                    </p>
                  </li>
                ),
              )}
            </ul>
          </section>

          <section className="rounded-lg border border-border bg-background p-4">
            <h2 className="mb-3 text-sm font-semibold">Audit history</h2>
            <ul className="max-h-64 space-y-2 overflow-y-auto text-sm">
              {(
                (activityQ.data ?? []) as Array<{
                  id: string;
                  action: string;
                  created_at: string;
                  details: unknown;
                }>
              ).map((ev) => (
                <li key={ev.id} className="flex justify-between gap-2 border-b border-border/50 pb-2">
                  <span className="font-mono text-xs">{ev.action}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {new Date(ev.created_at).toLocaleString()}
                  </span>
                </li>
              ))}
              {!activityQ.isPending && !(activityQ.data as unknown[] | undefined)?.length ? (
                <li className="text-muted-foreground">No audit events yet.</li>
              ) : null}
            </ul>
          </section>
        </div>

        <aside className="space-y-3">
          <Collapsible open={supplierOpen} onOpenChange={setSupplierOpen}>
            <div className="rounded-lg border border-border bg-background p-4">
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex w-full items-center justify-between text-left text-sm font-semibold"
                >
                  Supplier
                  <span className="text-xs font-normal text-muted-foreground">
                    {supplierOpen ? "Hide" : "Show"}
                  </span>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-3 space-y-2 text-sm">
                <p className="font-medium">{bill.contacts?.name ?? "—"}</p>
                {bill.contacts?.account_number ? (
                  <p className="text-muted-foreground">Acct {bill.contacts.account_number}</p>
                ) : null}
                {bill.contacts?.email ? <p>{bill.contacts.email}</p> : null}
                {bill.contacts?.phone ? <p>{bill.contacts.phone}</p> : null}
                {(bill.contacts?.billing_address_line1 || bill.contacts?.billing_city) && (
                  <p className="text-muted-foreground">
                    {[bill.contacts.billing_address_line1, bill.contacts.billing_city, bill.contacts.billing_country]
                      .filter(Boolean)
                      .join(", ")}
                  </p>
                )}
                {bill.contacts?.tax_number ? (
                  <p className="text-xs text-muted-foreground">Tax {bill.contacts.tax_number}</p>
                ) : null}
                {bill.contact_id ? (
                  <Button variant="link" className="h-auto p-0" asChild>
                    <Link to="/contacts/$contactId" params={{ contactId: bill.contact_id }}>
                      Open contact
                    </Link>
                  </Button>
                ) : null}
              </CollapsibleContent>
            </div>
          </Collapsible>

          <div className="rounded-lg border border-border bg-background p-4 text-sm">
            <h3 className="font-semibold">Document details</h3>
            <dl className="mt-2 space-y-2">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Currency</dt>
                <dd>{currency}</dd>
              </div>
              {bill.fx_rate_to_base != null ? (
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">FX to base</dt>
                  <dd className="tabular-nums">{Number(bill.fx_rate_to_base).toFixed(6)}</dd>
                </div>
              ) : null}
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Payment terms</dt>
                <dd>
                  {bill.payment_terms_days != null ? `${bill.payment_terms_days} days` : "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Internal ID</dt>
                <dd className="max-w-[9rem] truncate font-mono text-xs" title={bill.id}>
                  {bill.id.slice(0, 8)}…
                </dd>
              </div>
            </dl>
          </div>

          {(bill.status === "draft" || bill.status === "awaiting_approval") && (
            <div className="rounded-lg border border-border bg-background p-4 text-sm">
              <h3 className="font-semibold">Approval</h3>
              <Input
                className="mt-2"
                placeholder="Comment / reason"
                value={approvalComment}
                onChange={(e) => setApprovalComment(e.target.value)}
              />
              {bill.approval_comment ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Last comment: {bill.approval_comment}
                </p>
              ) : null}
              {bill.rejection_reason ? (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                  Rejection: {bill.rejection_reason}
                </p>
              ) : null}
              {bill.submitted_for_approval_at ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Submitted {new Date(bill.submitted_for_approval_at).toLocaleString()}
                </p>
              ) : null}
            </div>
          )}

          {bill.status === "void" ? (
            <Alert>
              <AlertTitle>Voided</AlertTitle>
              <AlertDescription>Historical read-only. Posted journals were reversed.</AlertDescription>
            </Alert>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
