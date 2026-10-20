import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  allocateCreditNote,
  authoriseCreditNote,
  getCreditNote,
  listInvoices,
} from "@/lib/sales/sales.functions";
import { fromMinorUnits, toMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/sales/credit-notes/$creditNoteId")({
  head: () => ({ meta: [{ title: "Credit note — LinkBooks" }] }),
  component: CreditNoteDetail,
});

function CreditNoteDetail() {
  const { creditNoteId } = Route.useParams();
  const { company } = useActiveCompany();
  const qc = useQueryClient();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";

  const fetchCn = useServerFn(getCreditNote);
  const fetchInvoices = useServerFn(listInvoices);
  const doAuthorise = useServerFn(authoriseCreditNote);
  const doAllocate = useServerFn(allocateCreditNote);

  const [allocs, setAllocs] = useState<Record<string, string>>({});

  const query = useQuery({
    queryKey: ["sales-credit", companyId, creditNoteId],
    enabled: Boolean(companyId),
    queryFn: () => fetchCn({ data: { companyId: companyId!, creditNoteId } }),
  });

  const contactId = (query.data as { contact_id?: string } | undefined)?.contact_id;

  const invoicesQ = useQuery({
    queryKey: ["sales-invoices-for-credit", companyId, contactId],
    enabled: Boolean(companyId && contactId),
    queryFn: () => fetchInvoices({ data: { companyId: companyId! } }),
  });

  const openInvoices = useMemo(() => {
    return (
      (invoicesQ.data?.rows ?? []) as Array<{
        id: string;
        status: string;
        contact_id: string;
        total_minor: number;
        amount_paid_minor: number;
        amount_credited_minor: number;
        invoice_number: string | null;
        invoice_date: string;
      }>
    )
      .filter(
        (i) =>
          i.contact_id === contactId && ["authorised", "partly_paid"].includes(i.status),
      )
      .map((i) => ({
        ...i,
        outstanding: i.total_minor - i.amount_paid_minor - i.amount_credited_minor,
      }));
  }, [invoicesQ.data, contactId]);

  const authoriseM = useMutation({
    mutationFn: () => doAuthorise({ data: { companyId: companyId!, creditNoteId } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sales-credit", companyId, creditNoteId] });
      toast.success("Credit note authorised — reversing journal posted");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const allocateM = useMutation({
    mutationFn: async () => {
      const allocations = Object.entries(allocs)
        .map(([invoiceId, amt]) => ({
          invoiceId,
          amountMinor: Number(toMinorUnits(amt || "0", currency)),
        }))
        .filter((a) => a.amountMinor > 0);
      if (!allocations.length) throw new Error("Select at least one allocation");
      return doAllocate({
        data: { companyId: companyId!, creditNoteId, allocations },
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sales-credit", companyId, creditNoteId] });
      await qc.invalidateQueries({ queryKey: ["sales-invoices", companyId] });
      setAllocs({});
      toast.success("Credit allocated to invoice(s) — no second journal");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (query.isPending) return <LoadingState />;
  if (query.isError) {
    return (
      <ErrorState
        title="Credit note not found"
        description={friendlyAuthError(query.error)}
        onRetry={() => query.refetch()}
      />
    );
  }

  const cn = query.data as {
    status: string;
    credit_date: string;
    credit_number: string | null;
    memo: string | null;
    total_minor: number;
    amount_allocated_minor: number;
    posted_journal_id: string | null;
    contacts: { name: string } | null;
    sales_credit_note_lines: Array<{
      id: string;
      description: string;
      quantity: number;
      net_minor: number;
      tax_minor: number;
    }>;
    sales_credit_allocations: Array<{
      id: string;
      invoice_id: string;
      amount_minor: number;
    }>;
  };

  const remaining = cn.total_minor - cn.amount_allocated_minor;
  const canAllocate = ["authorised", "partly_paid"].includes(cn.status) && remaining > 0;

  return (
    <>
      <PageHeader
        title={`Credit note · ${cn.contacts?.name ?? "Customer"}`}
        description={`${cn.credit_date} · authorising posts DR revenue/tax / CR AR once`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link to="/sales/credit-notes">Back</Link>
            </Button>
            {cn.status === "draft" ? (
              <Button size="sm" disabled={authoriseM.isPending} onClick={() => authoriseM.mutate()}>
                {authoriseM.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                Authorise & post
              </Button>
            ) : null}
          </div>
        }
      />
      <div className="mb-4 flex flex-wrap gap-3 text-sm">
        <Badge variant="outline" className="capitalize">
          {cn.status.replace("_", " ")}
        </Badge>
        <span>#{cn.credit_number ?? "—"}</span>
        <span>Total {fromMinorUnits(cn.total_minor, currency)}</span>
        <span>Allocated {fromMinorUnits(cn.amount_allocated_minor, currency)}</span>
        <span>Remaining {fromMinorUnits(remaining, currency)}</span>
        {cn.posted_journal_id ? (
          <span className="text-muted-foreground">Journal {cn.posted_journal_id.slice(0, 8)}…</span>
        ) : null}
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Description</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Net</TableHead>
            <TableHead className="text-right">Tax</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {cn.sales_credit_note_lines.map((l) => (
            <TableRow key={l.id}>
              <TableCell>{l.description}</TableCell>
              <TableCell className="text-right">{l.quantity}</TableCell>
              <TableCell className="text-right">{fromMinorUnits(l.net_minor, currency)}</TableCell>
              <TableCell className="text-right">{fromMinorUnits(l.tax_minor, currency)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {cn.sales_credit_allocations?.length ? (
        <div className="mt-6">
          <h3 className="mb-2 text-sm font-medium">Existing allocations</h3>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {cn.sales_credit_allocations.map((a) => (
              <li key={a.id}>
                Invoice {a.invoice_id.slice(0, 8)}… · {fromMinorUnits(a.amount_minor, currency)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {canAllocate ? (
        <div className="mt-8 space-y-3 rounded-md border p-4">
          <Label>Allocate remaining credit ({fromMinorUnits(remaining, currency)})</Label>
          {openInvoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No open invoices for this customer.</p>
          ) : (
            <ul className="space-y-2">
              {openInvoices.map((inv) => {
                const checked = inv.id in allocs;
                return (
                  <li key={inv.id} className="flex flex-wrap items-center gap-3 rounded border px-3 py-2">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) => {
                        setAllocs((prev) => {
                          const next = { ...prev };
                          if (!v) {
                            delete next[inv.id];
                            return next;
                          }
                          next[inv.id] = fromMinorUnits(
                            Math.min(inv.outstanding, remaining),
                            currency,
                          );
                          return next;
                        });
                      }}
                    />
                    <div className="min-w-0 flex-1 text-sm">
                      <p>
                        {inv.invoice_number ?? inv.id.slice(0, 8)} · {inv.invoice_date}
                      </p>
                      <p className="text-muted-foreground">
                        Outstanding {fromMinorUnits(inv.outstanding, currency)}
                      </p>
                    </div>
                    {checked ? (
                      <Input
                        className="w-28"
                        value={allocs[inv.id] ?? ""}
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
          <Button size="sm" disabled={allocateM.isPending} onClick={() => allocateM.mutate()}>
            {allocateM.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Allocate credit
          </Button>
        </div>
      ) : null}
    </>
  );
}
