import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  allocatePurchaseCreditNote,
  getCreditNote,
  listBills,
} from "@/lib/purchases/purchases.functions";
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

export const Route = createFileRoute("/_authenticated/purchases/credit-notes/$creditNoteId")({
  head: () => ({ meta: [{ title: "Supplier credit — LinkBooks" }] }),
  component: CreditNoteDetail,
});

function CreditNoteDetail() {
  const { creditNoteId } = Route.useParams();
  const { company } = useActiveCompany();
  const qc = useQueryClient();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";

  const fetchCn = useServerFn(getCreditNote);
  const fetchBills = useServerFn(listBills);
  const doAllocate = useServerFn(allocatePurchaseCreditNote);
  const [allocs, setAllocs] = useState<Record<string, string>>({});

  const query = useQuery({
    queryKey: ["purchase-credit", companyId, creditNoteId],
    enabled: Boolean(companyId),
    queryFn: () => fetchCn({ data: { companyId: companyId!, creditNoteId } }),
  });

  const contactId = (query.data as { contact_id?: string } | undefined)?.contact_id;

  const billsQ = useQuery({
    queryKey: ["bills-for-credit", companyId, contactId],
    enabled: Boolean(companyId && contactId),
    queryFn: () => fetchBills({ data: { companyId: companyId!, limit: 100 } }),
  });

  const openBills = useMemo(() => {
    return (
      (billsQ.data ?? []) as Array<{
        id: string;
        status: string;
        contact_id: string;
        total_minor: number;
        amount_paid_minor: number;
        amount_credited_minor: number;
        supplier_invoice_number: string | null;
        bill_date: string;
      }>
    )
      .filter(
        (b) =>
          b.contact_id === contactId && ["authorised", "partly_paid"].includes(b.status),
      )
      .map((b) => ({
        ...b,
        outstanding: b.total_minor - b.amount_paid_minor - b.amount_credited_minor,
      }))
      .filter((b) => b.outstanding > 0);
  }, [billsQ.data, contactId]);

  const allocateM = useMutation({
    mutationFn: async () => {
      const allocations = Object.entries(allocs)
        .map(([billId, amt]) => ({
          billId,
          amountMinor: Number(toMinorUnits(amt || "0", currency)),
        }))
        .filter((a) => a.amountMinor > 0);
      if (!allocations.length) throw new Error("Select at least one allocation");
      return doAllocate({
        data: { companyId: companyId!, creditNoteId, allocations },
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["purchase-credit", companyId, creditNoteId] });
      await qc.invalidateQueries({ queryKey: ["bills", companyId] });
      setAllocs({});
      toast.success("Credit allocated — no second journal");
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
    purchase_credit_note_lines: Array<{
      id: string;
      description: string;
      net_minor: number;
      tax_minor: number;
    }>;
    purchase_credit_allocations: Array<{
      id: string;
      bill_id: string;
      amount_minor: number;
    }>;
  };

  const remaining = cn.total_minor - cn.amount_allocated_minor;
  const canAllocate = ["authorised", "partly_paid"].includes(cn.status) && remaining > 0;

  return (
    <>
      <PageHeader
        title={`Supplier credit · ${cn.contacts?.name ?? "Supplier"}`}
        description={`${cn.credit_date} · authorising posts DR AP / CR expense+tax once`}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/purchases/credit-notes">Back</Link>
          </Button>
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
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Description</TableHead>
            <TableHead className="text-right">Net</TableHead>
            <TableHead className="text-right">Tax</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {cn.purchase_credit_note_lines.map((l) => (
            <TableRow key={l.id}>
              <TableCell>{l.description}</TableCell>
              <TableCell className="text-right">{fromMinorUnits(l.net_minor, currency)}</TableCell>
              <TableCell className="text-right">{fromMinorUnits(l.tax_minor, currency)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {canAllocate ? (
        <div className="mt-8 space-y-3 rounded-md border p-4">
          <Label>Allocate remaining credit ({fromMinorUnits(remaining, currency)})</Label>
          {openBills.length === 0 ? (
            <p className="text-sm text-muted-foreground">No open bills for this supplier.</p>
          ) : (
            <ul className="space-y-2">
              {openBills.map((b) => {
                const checked = b.id in allocs;
                return (
                  <li key={b.id} className="flex flex-wrap items-center gap-3 rounded border px-3 py-2">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) => {
                        setAllocs((prev) => {
                          const next = { ...prev };
                          if (!v) {
                            delete next[b.id];
                            return next;
                          }
                          next[b.id] = fromMinorUnits(Math.min(b.outstanding, remaining), currency);
                          return next;
                        });
                      }}
                    />
                    <div className="min-w-0 flex-1 text-sm">
                      <p>
                        {b.supplier_invoice_number ?? b.id.slice(0, 8)} · {b.bill_date}
                      </p>
                      <p className="text-muted-foreground">
                        Outstanding {fromMinorUnits(b.outstanding, currency)}
                      </p>
                    </div>
                    {checked ? (
                      <Input
                        className="w-28"
                        value={allocs[b.id] ?? ""}
                        onChange={(e) => setAllocs((prev) => ({ ...prev, [b.id]: e.target.value }))}
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
