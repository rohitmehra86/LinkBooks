import { useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  allocateCreditNote,
  authoriseCreditNote,
  deleteDraftCreditNote,
  getCreditNote,
  removeCreditAllocation,
  voidCreditNote,
} from "@/lib/sales/sales-credits.functions";
import { listOpenInvoicesForCustomer } from "@/lib/sales/sales-receipts.functions";
import { getSalesDocumentConfig } from "@/lib/sales/sales-config.functions";
import { canVoidCreditNote, creditNoteStatusLabel } from "@/lib/sales/allocation-rules";
import { fromMinorUnits, toMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { ReasonDialog } from "@/components/sales/ReasonDialog";
import { bpsToPercentString, money } from "@/components/sales/sales-form-utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
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

export const Route = createFileRoute("/_authenticated/sales/credit-notes/$creditNoteId/")({
  head: () => ({ meta: [{ title: "Credit note — LinkBooks" }] }),
  component: CreditNoteDetail,
});

type Dialog =
  { kind: "void" } | { kind: "remove"; allocationId: string; allocatedOn: string } | null;

function CreditNoteDetail() {
  const { creditNoteId } = Route.useParams();
  const { company } = useActiveCompany();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const companyId = company?.id;

  const fetchCn = useServerFn(getCreditNote);
  const fetchOpen = useServerFn(listOpenInvoicesForCustomer);
  const fetchConfig = useServerFn(getSalesDocumentConfig);
  const doAuthorise = useServerFn(authoriseCreditNote);
  const doAllocate = useServerFn(allocateCreditNote);
  const doVoid = useServerFn(voidCreditNote);
  const doRemove = useServerFn(removeCreditAllocation);
  const doDelete = useServerFn(deleteDraftCreditNote);

  const [allocs, setAllocs] = useState<Record<string, string>>({});
  const [allocDate, setAllocDate] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const query = useQuery({
    queryKey: ["sales-credit", companyId, creditNoteId],
    enabled: Boolean(companyId),
    queryFn: () => fetchCn({ data: { companyId: companyId!, creditNoteId } }),
  });
  const configQ = useQuery({
    queryKey: ["sales-doc-config", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchConfig({ data: { companyId: companyId! } }),
  });
  const cn = query.data;
  const cur = cn?.currency_code ?? company?.base_currency ?? "GBP";
  const live = Boolean(cn && ["authorised", "partly_paid"].includes(cn.status));

  const openQ = useQuery({
    queryKey: ["open-invoices", companyId, cn?.contact_id],
    enabled: Boolean(companyId && cn?.contact_id && live),
    queryFn: () => fetchOpen({ data: { companyId: companyId!, contactId: cn!.contact_id } }),
  });
  const openInvoices = useMemo(
    () =>
      (
        (openQ.data ?? []) as Array<{
          id: string;
          invoice_number: string | null;
          invoice_date: string;
          due_date: string;
          currency_code: string;
          outstanding_minor: number;
        }>
      ).filter((i) => i.currency_code === cur),
    [openQ.data, cur],
  );

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["sales-credit", companyId, creditNoteId] });
    await qc.invalidateQueries({ queryKey: ["sales-credits", companyId] });
    await qc.invalidateQueries({ queryKey: ["sales-invoices", companyId] });
    await qc.invalidateQueries({ queryKey: ["sales-invoice", companyId] });
    await qc.invalidateQueries({ queryKey: ["open-invoices", companyId] });
  };

  const authoriseM = useMutation({
    mutationFn: () => doAuthorise({ data: { companyId: companyId!, creditNoteId } }),
    onSuccess: async () => {
      await refresh();
      toast.success("Credit note authorised — reversing journal posted");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });
  const allocateM = useMutation({
    mutationFn: async () => {
      const allocations = Object.entries(allocs)
        .map(([invoiceId, amt]) => ({
          invoiceId,
          amountMinor: Number(toMinorUnits(amt || "0", cur)),
        }))
        .filter((a) => a.amountMinor > 0);
      if (!allocations.length)
        throw new Error("Select at least one invoice to apply the credit to");
      return doAllocate({
        data: {
          companyId: companyId!,
          creditNoteId,
          ...(allocDate ? { allocationDate: allocDate } : {}),
          allocations,
        },
      });
    },
    onSuccess: async () => {
      await refresh();
      setAllocs({});
      toast.success("Credit applied to invoice(s) — no second journal");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });
  const voidM = useMutation({
    mutationFn: (v: { reason: string; date: string }) =>
      doVoid({ data: { companyId: companyId!, creditNoteId, reason: v.reason, voidDate: v.date } }),
    onSuccess: async () => {
      await refresh();
      setDialog(null);
      toast.success("Credit note voided and journal reversed");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });
  const removeM = useMutation({
    mutationFn: (v: { reason: string; date: string; allocationId: string }) =>
      doRemove({
        data: {
          companyId: companyId!,
          allocationId: v.allocationId,
          reason: v.reason,
          reversalDate: v.date,
        },
      }),
    onSuccess: async () => {
      await refresh();
      setDialog(null);
      toast.success("Allocation removed — the credit is available again");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });
  const deleteM = useMutation({
    mutationFn: () => doDelete({ data: { companyId: companyId!, creditNoteId } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sales-credits", companyId] });
      toast.success("Draft credit note deleted");
      navigate({ to: "/sales/credit-notes" });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (query.isPending) return <LoadingState />;
  if (query.isError || !cn) {
    return (
      <ErrorState
        title="Credit note not found"
        description={friendlyAuthError(query.error)}
        onRetry={() => query.refetch()}
      />
    );
  }

  const today = configQ.data?.today ?? cn.credit_date;
  const remaining = cn.total_minor - cn.amount_allocated_minor;
  const canAllocate = live && remaining > 0;
  const voidable = canVoidCreditNote({
    status: cn.status,
    amountAllocatedMinor: cn.amount_allocated_minor,
  });
  const latestAlloc = cn.allocations.reduce(
    (m, a) => ((a.allocated_on ?? "") > m ? (a.allocated_on ?? "") : m),
    cn.credit_date,
  );
  const allocatedTotal = Object.values(allocs).reduce((s, v) => {
    try {
      return s + Number(toMinorUnits(v || "0", cur));
    } catch {
      return s;
    }
  }, 0);

  return (
    <>
      <PageHeader
        title={`Credit note ${cn.credit_number ?? ""} · ${cn.contacts?.name ?? "Customer"}`}
        description={`${cn.credit_date} · authorising posts DR revenue/tax / CR AR once`}
        actions={
          <div className="flex flex-wrap gap-2 print:hidden">
            <Button variant="outline" size="sm" asChild>
              <Link to="/sales/credit-notes">Back</Link>
            </Button>
            {cn.status === "draft" ? (
              <>
                <Button variant="outline" size="sm" asChild>
                  <Link to="/sales/credit-notes/$creditNoteId/edit" params={{ creditNoteId }}>
                    Edit draft
                  </Link>
                </Button>
                <Button variant="outline" size="sm" onClick={() => setDeleteOpen(true)}>
                  Delete draft
                </Button>
                <Button
                  size="sm"
                  disabled={authoriseM.isPending}
                  onClick={() => authoriseM.mutate()}
                >
                  {authoriseM.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                  Authorise & post
                </Button>
              </>
            ) : null}
            {voidable ? (
              <Button variant="destructive" size="sm" onClick={() => setDialog({ kind: "void" })}>
                Void credit note
              </Button>
            ) : null}
          </div>
        }
      />
      <div className="mb-4 flex flex-wrap gap-3 text-sm">
        <Badge variant="outline">{creditNoteStatusLabel(cn.status)}</Badge>
        <span>#{cn.credit_number ?? "—"}</span>
        <span>Total {money(cn.total_minor, cur)}</span>
        <span>Applied {money(cn.amount_allocated_minor, cur)}</span>
        {live ? <span>Remaining credit {money(remaining, cur)}</span> : null}
        {cn.source_invoice ? (
          <span>
            Credits invoice{" "}
            <Link
              className="underline"
              to="/sales/invoices/$invoiceId"
              params={{ invoiceId: cn.source_invoice.id }}
            >
              {cn.source_invoice.invoice_number ?? cn.source_invoice.id.slice(0, 8)}
            </Link>
          </span>
        ) : null}
        {cn.status === "void" && cn.void_reason ? (
          <span className="text-destructive">Void: {cn.void_reason}</span>
        ) : null}
      </div>
      {cn.memo ? <p className="mb-4 text-sm text-muted-foreground">{cn.memo}</p> : null}

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
          {cn.sales_credit_note_lines.map((l) => (
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
          <span>{money(cn.subtotal_minor, cur)}</span>
        </div>
        <div className="flex justify-between">
          <span>Tax</span>
          <span>{money(cn.tax_minor, cur)}</span>
        </div>
        <div className="flex justify-between font-medium">
          <span>Total</span>
          <span>{money(cn.total_minor, cur)}</span>
        </div>
      </div>

      {cn.allocations.length > 0 ? (
        <div className="mt-6">
          <h3 className="mb-2 text-sm font-medium">Applied to invoices</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Applied on</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {cn.allocations.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    <Link
                      className="underline-offset-2 hover:underline"
                      to="/sales/invoices/$invoiceId"
                      params={{ invoiceId: a.invoice_id }}
                    >
                      {a.sales_invoices?.invoice_number ?? a.invoice_id.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell>{a.allocated_on ?? "—"}</TableCell>
                  <TableCell className="text-right">{money(a.amount_minor, cur)}</TableCell>
                  <TableCell className="text-right print:hidden">
                    {live ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setDialog({
                            kind: "remove",
                            allocationId: a.id,
                            allocatedOn: a.allocated_on ?? cn.credit_date,
                          })
                        }
                      >
                        Remove
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      {cn.reversedAllocations.length > 0 ? (
        <div className="mt-6">
          <h3 className="mb-2 text-sm font-medium">Removed applications</h3>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {cn.reversedAllocations.map((a) => (
              <li key={a.id}>
                {a.sales_invoices?.invoice_number ?? a.invoice_id.slice(0, 8)} ·{" "}
                {money(a.amount_minor, cur)} · removed {a.reversed_on}
                {a.reverse_reason ? ` — ${a.reverse_reason}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {canAllocate ? (
        <div className="mt-8 space-y-3 rounded-md border p-4 print:hidden">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <Label>Apply remaining credit ({money(remaining, cur)})</Label>
            <div className="flex items-center gap-2 text-sm">
              <Label htmlFor="alloc-date">Applied on</Label>
              <Input
                id="alloc-date"
                type="date"
                className="w-40"
                min={cn.credit_date}
                value={allocDate || today}
                onChange={(e) => setAllocDate(e.target.value)}
              />
            </div>
          </div>
          {openQ.isPending ? (
            <LoadingState rows={2} />
          ) : openInvoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No open {cur} invoices for this customer.
            </p>
          ) : (
            <ul className="space-y-2">
              {openInvoices.map((inv) => {
                const checked = inv.id in allocs;
                return (
                  <li
                    key={inv.id}
                    className="flex flex-wrap items-center gap-3 rounded border px-3 py-2"
                  >
                    <Checkbox
                      checked={checked}
                      aria-label={`Select ${inv.invoice_number ?? "invoice"}`}
                      onCheckedChange={(v) =>
                        setAllocs((prev) => {
                          const next = { ...prev };
                          if (!v) {
                            delete next[inv.id];
                            return next;
                          }
                          const left =
                            remaining -
                            Object.entries(prev).reduce((s, [, val]) => {
                              try {
                                return s + Number(toMinorUnits(val || "0", cur));
                              } catch {
                                return s;
                              }
                            }, 0);
                          next[inv.id] = fromMinorUnits(
                            Math.max(0, Math.min(inv.outstanding_minor, left)),
                            cur,
                          );
                          return next;
                        })
                      }
                    />
                    <div className="min-w-0 flex-1 text-sm">
                      <p>
                        {inv.invoice_number ?? inv.id.slice(0, 8)} · {inv.invoice_date}
                      </p>
                      <p className="text-muted-foreground">
                        Outstanding {money(inv.outstanding_minor, cur)} · due {inv.due_date}
                      </p>
                    </div>
                    {checked ? (
                      <Input
                        className="w-28"
                        value={allocs[inv.id] ?? ""}
                        inputMode="decimal"
                        onChange={(e) =>
                          setAllocs((prev) => ({ ...prev, [inv.id]: e.target.value }))
                        }
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              disabled={allocateM.isPending || allocatedTotal <= 0 || allocatedTotal > remaining}
              onClick={() => allocateM.mutate()}
            >
              {allocateM.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Apply credit
            </Button>
            {allocatedTotal > remaining ? (
              <span className="text-sm text-destructive">Exceeds the remaining credit</span>
            ) : null}
          </div>
        </div>
      ) : null}

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this draft credit note?</AlertDialogTitle>
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

      <ReasonDialog
        open={dialog?.kind === "void"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Void credit note"
        description="Reverses the posted journal. Only possible while no credit has been applied to an invoice."
        confirmLabel="Void credit note"
        dateLabel="Void date"
        minDate={cn.credit_date}
        defaultDate={today < cn.credit_date ? cn.credit_date : today}
        pending={voidM.isPending}
        destructive
        onConfirm={(v) => voidM.mutate(v)}
      />
      <ReasonDialog
        open={dialog?.kind === "remove"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Remove credit application"
        description="The invoice becomes outstanding again and the credit is available to apply elsewhere. No journal is posted."
        confirmLabel="Remove application"
        dateLabel="Reversal date"
        minDate={dialog?.kind === "remove" ? dialog.allocatedOn : latestAlloc}
        defaultDate={today}
        pending={removeM.isPending}
        onConfirm={(v) =>
          dialog?.kind === "remove"
            ? removeM.mutate({ ...v, allocationId: dialog.allocationId })
            : undefined
        }
      />
    </>
  );
}
