import { useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { useCan } from "@/hooks/use-can";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import {
  allocatePurchaseCreditNote,
  authoriseCreditNote,
  deleteCreditNoteDraft,
  getCreditNote,
  listBills,
  unallocatePurchaseCredit,
  updateCreditNoteDraft,
  voidPurchaseCreditNote,
  type CreditNoteDetail as CreditNoteDetailData,
} from "@/lib/purchases/purchases.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { minorOrZero, parseMinorOrThrow, tryParseMinor } from "@/lib/purchases/money-input";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DocumentActions } from "@/components/documents/DocumentActions";
import { AttachmentsPanel } from "@/components/documents/AttachmentsPanel";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

type EditLine = { description: string; accountId: string; net: string; tax: string };

function CreditNoteDetail() {
  const { creditNoteId } = Route.useParams();
  const { company } = useActiveCompany();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { can } = useCan();
  const companyId = company?.id;
  const baseCurrency = company?.base_currency ?? "GBP";

  const fetchCn = useServerFn(getCreditNote);
  const fetchBills = useServerFn(listBills);
  const fetchAccounts = useServerFn(listAccounts);
  const doAllocate = useServerFn(allocatePurchaseCreditNote);
  const doAuthorise = useServerFn(authoriseCreditNote);
  const doDelete = useServerFn(deleteCreditNoteDraft);
  const doUnallocate = useServerFn(unallocatePurchaseCredit);
  const doVoid = useServerFn(voidPurchaseCreditNote);
  const doUpdate = useServerFn(updateCreditNoteDraft);
  const [allocs, setAllocs] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [editDate, setEditDate] = useState("");
  const [editMemo, setEditMemo] = useState("");
  const [editLines, setEditLines] = useState<EditLine[]>([]);

  const query = useQuery({
    queryKey: ["purchase-credit", companyId, creditNoteId],
    enabled: Boolean(companyId),
    queryFn: () => fetchCn({ data: { companyId: companyId!, creditNoteId } }),
  });

  const cn = query.data as CreditNoteDetailData | undefined;
  const contactId = cn?.contact_id;
  const currency = (cn?.currency_code || baseCurrency).toUpperCase();
  const remaining = cn ? cn.total_minor - cn.amount_allocated_minor : 0;
  const canAllocate = Boolean(
    cn && ["authorised", "partly_paid"].includes(cn.status) && remaining > 0,
  );

  // Open bills in the credit note's own currency, oldest due date first (P-04 / P-07 / P-10).
  const billsQ = useQuery({
    queryKey: ["bills-for-credit", companyId, contactId, currency],
    enabled: Boolean(companyId && contactId && canAllocate),
    queryFn: () =>
      fetchBills({
        data: {
          companyId: companyId!,
          contactId: contactId!,
          tab: "to_pay",
          currencyCode: currency,
          sortBy: "due_date",
          sortDir: "asc",
          limit: 100,
        },
      }),
  });

  const accountsQ = useQuery({
    queryKey: ["accounts", companyId],
    enabled: Boolean(companyId) && editing,
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });
  const accounts = (
    (accountsQ.data ?? []) as Array<{
      id: string;
      code: string;
      name: string;
      account_type: string;
      is_postable: boolean;
      is_active: boolean;
    }>
  ).filter(
    (a) =>
      a.is_active && a.is_postable && (a.account_type === "expense" || a.account_type === "asset"),
  );

  const openBills = useMemo(() => {
    const rows = ((billsQ.data as { rows?: unknown[] } | undefined)?.rows ?? []) as Array<{
      id: string;
      status: string;
      total_minor: number;
      amount_paid_minor: number;
      amount_credited_minor: number;
      supplier_invoice_number: string | null;
      bill_number: string | null;
      bill_date: string;
      due_date: string;
    }>;
    return rows
      .map((b) => ({
        ...b,
        outstanding: b.total_minor - b.amount_paid_minor - b.amount_credited_minor,
      }))
      .filter((b) => b.outstanding > 0);
  }, [billsQ.data]);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["purchase-credit", companyId, creditNoteId] });
    await qc.invalidateQueries({ queryKey: ["bills", companyId] });
    await qc.invalidateQueries({ queryKey: ["bills-for-credit", companyId] });
    await qc.invalidateQueries({ queryKey: ["credits", companyId] });
  };

  const allocInvalid = Object.values(allocs).some(
    (v) => tryParseMinor(v || "0", currency) === null,
  );
  const allocTotal = Object.values(allocs).reduce(
    (s, v) => s + Number(minorOrZero(v || "0", currency)),
    0,
  );

  const allocateM = useMutation({
    mutationFn: async () => {
      const allocations = Object.entries(allocs)
        .map(([billId, amt]) => ({
          billId,
          amountMinor: Number(parseMinorOrThrow(amt || "0", currency, "Allocation")),
        }))
        .filter((a) => a.amountMinor > 0);
      if (!allocations.length) throw new Error("Select at least one allocation");
      return doAllocate({
        data: { companyId: companyId!, creditNoteId, allocations },
      });
    },
    onSuccess: async () => {
      await refresh();
      setAllocs({});
      toast.success("Credit allocated — no second journal");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const authoriseM = useMutation({
    mutationFn: () => doAuthorise({ data: { companyId: companyId!, creditNoteId } }),
    onSuccess: async () => {
      await refresh();
      toast.success("Credit note authorised and posted");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const deleteM = useMutation({
    mutationFn: () => doDelete({ data: { companyId: companyId!, creditNoteId } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["credits", companyId] });
      toast.success("Draft credit note deleted");
      navigate({ to: "/purchases/credit-notes" });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const unallocateM = useMutation({
    mutationFn: (billId?: string) =>
      doUnallocate({
        data: { companyId: companyId!, creditNoteId, ...(billId ? { billId } : {}) },
      }),
    onSuccess: async () => {
      await refresh();
      toast.success("Allocation removed — the bill balance is restored");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const voidM = useMutation({
    mutationFn: () => doVoid({ data: { companyId: companyId!, creditNoteId } }),
    onSuccess: async () => {
      await refresh();
      toast.success("Credit note voided — the journal was reversed");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const saveEditM = useMutation({
    mutationFn: () =>
      doUpdate({
        data: {
          companyId: companyId!,
          creditNoteId,
          contactId: cn!.contact_id,
          creditDate: editDate,
          memo: editMemo,
          lines: editLines.map((l, i) => ({
            description: l.description,
            accountId: l.accountId,
            netMinor: Number(parseMinorOrThrow(l.net || "0", currency, `Line ${i + 1} net`)),
            taxMinor: Number(parseMinorOrThrow(l.tax || "0", currency, `Line ${i + 1} tax`)),
          })),
        },
      }),
    onSuccess: async () => {
      await refresh();
      setEditing(false);
      toast.success("Draft saved");
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

  const isDraft = cn.status === "draft";
  const canVoid = !isDraft && cn.status !== "void" && can("purchases.authorise");
  const billLabel = (a: CreditNoteDetailData["purchase_credit_allocations"][number]) =>
    a.supplier_invoice_number || a.bill_number || a.bill_id.slice(0, 8);

  const startEdit = () => {
    setEditDate(cn.credit_date);
    setEditMemo(cn.memo ?? "");
    setEditLines(
      [...cn.purchase_credit_note_lines]
        .sort((a, b) => a.line_no - b.line_no)
        .map((l) => ({
          description: l.description,
          accountId: l.account_id,
          net: fromMinorUnits(BigInt(l.net_minor), currency),
          tax: fromMinorUnits(BigInt(l.tax_minor), currency),
        })),
    );
    setEditing(true);
  };

  return (
    <>
      <PageHeader
        title={`Supplier credit · ${cn.contacts?.name ?? "Supplier"}`}
        description={`${cn.credit_date} · authorising posts DR AP / CR expense+tax once`}
        actions={
          <div className="flex flex-wrap gap-2">
            {isDraft && !editing ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={startEdit}
                  disabled={!can("purchases.draft")}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  disabled={authoriseM.isPending || !can("purchases.authorise")}
                  title={
                    can("purchases.authorise")
                      ? undefined
                      : "You do not have permission to authorise credit notes"
                  }
                  onClick={() => authoriseM.mutate()}
                >
                  {authoriseM.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                  Authorise &amp; post
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={deleteM.isPending || !can("purchases.draft")}
                  onClick={() => {
                    if (confirm("Delete this draft credit note?")) deleteM.mutate();
                  }}
                >
                  Delete draft
                </Button>
              </>
            ) : null}
            {canVoid ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={voidM.isPending}
                onClick={() => {
                  if (
                    confirm(
                      "Void this credit note? Its journal is reversed and any allocations are removed.",
                    )
                  ) {
                    voidM.mutate();
                  }
                }}
              >
                Void
              </Button>
            ) : null}
            <Button variant="outline" size="sm" asChild>
              <Link to="/purchases/credit-notes">Back</Link>
            </Button>
          </div>
        }
      />
      <div className="mb-4 flex flex-wrap gap-3 text-sm">
        <Badge variant="outline" className="capitalize">
          {cn.status.replace("_", " ")}
        </Badge>
        <span>#{cn.credit_number ?? "—"}</span>
        <span>
          Total {fromMinorUnits(cn.total_minor, currency)} {currency}
        </span>
        <span>Allocated {fromMinorUnits(cn.amount_allocated_minor, currency)}</span>
        <span>Remaining {fromMinorUnits(remaining, currency)}</span>
      </div>

      {editing ? (
        <div className="mb-6 max-w-3xl space-y-3 rounded-md border p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Date</Label>
              <Input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Memo</Label>
              <Input value={editMemo} onChange={(e) => setEditMemo(e.target.value)} />
            </div>
          </div>
          {editLines.map((l, i) => (
            <div
              key={i}
              className="grid gap-2 rounded border p-2 sm:grid-cols-[2fr_2fr_1fr_1fr_auto]"
            >
              <Input
                placeholder="Description"
                value={l.description}
                onChange={(e) =>
                  setEditLines((rows) =>
                    rows.map((r, j) => (j === i ? { ...r, description: e.target.value } : r)),
                  )
                }
              />
              <Select
                value={l.accountId}
                onValueChange={(v) =>
                  setEditLines((rows) => rows.map((r, j) => (j === i ? { ...r, accountId: v } : r)))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Account" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                placeholder="Net"
                inputMode="decimal"
                aria-invalid={tryParseMinor(l.net || "0", currency) === null}
                value={l.net}
                onChange={(e) =>
                  setEditLines((rows) =>
                    rows.map((r, j) => (j === i ? { ...r, net: e.target.value } : r)),
                  )
                }
              />
              <Input
                placeholder="Tax"
                inputMode="decimal"
                aria-invalid={tryParseMinor(l.tax || "0", currency) === null}
                value={l.tax}
                onChange={(e) =>
                  setEditLines((rows) =>
                    rows.map((r, j) => (j === i ? { ...r, tax: e.target.value } : r)),
                  )
                }
              />
              <Button
                size="sm"
                variant="ghost"
                disabled={editLines.length <= 1}
                onClick={() => setEditLines((rows) => rows.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setEditLines((rows) => [
                  ...rows,
                  { description: "", accountId: "", net: "0.00", tax: "0.00" },
                ])
              }
            >
              Add line
            </Button>
            <Button
              size="sm"
              disabled={
                saveEditM.isPending ||
                editLines.some(
                  (l) =>
                    tryParseMinor(l.net || "0", currency) === null ||
                    tryParseMinor(l.tax || "0", currency) === null ||
                    !l.accountId,
                )
              }
              onClick={() => saveEditM.mutate()}
            >
              {saveEditM.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Save draft
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
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
                <TableCell className="text-right">
                  {fromMinorUnits(l.net_minor, currency)}
                </TableCell>
                <TableCell className="text-right">
                  {fromMinorUnits(l.tax_minor, currency)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {cn.purchase_credit_allocations.length > 0 ? (
        <div className="mt-6 space-y-2 rounded-md border p-4">
          <div className="flex items-center justify-between gap-2">
            <Label>Allocated to bills</Label>
            {can("purchases.payment") && cn.status !== "void" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={unallocateM.isPending}
                onClick={() => {
                  if (confirm("Remove every allocation from this credit note?")) {
                    unallocateM.mutate(undefined);
                  }
                }}
              >
                Remove all allocations
              </Button>
            ) : null}
          </div>
          <ul className="space-y-1 text-sm">
            {cn.purchase_credit_allocations.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-2 rounded border px-3 py-2"
              >
                <Link
                  to="/purchases/bills/$billId"
                  params={{ billId: a.bill_id }}
                  className="underline-offset-2 hover:underline"
                >
                  {billLabel(a)}
                </Link>
                <span className="tabular-nums">{fromMinorUnits(a.amount_minor, currency)}</span>
                {can("purchases.payment") && cn.status !== "void" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={unallocateM.isPending}
                    onClick={() => unallocateM.mutate(a.bill_id)}
                  >
                    Remove
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {canAllocate && can("purchases.payment") ? (
        <div className="mt-8 space-y-3 rounded-md border p-4">
          <Label>
            Allocate remaining credit ({fromMinorUnits(remaining, currency)} {currency})
          </Label>
          {openBills.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No open {currency} bills for this supplier.
            </p>
          ) : (
            <ul className="space-y-2">
              {openBills.map((b) => {
                const checked = b.id in allocs;
                return (
                  <li
                    key={b.id}
                    className="flex flex-wrap items-center gap-3 rounded border px-3 py-2"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) => {
                        setAllocs((prev) => {
                          const next = { ...prev };
                          if (!v) {
                            delete next[b.id];
                            return next;
                          }
                          const already = Object.entries(prev).reduce(
                            (s, [id, amt]) =>
                              id === b.id ? s : s + Number(minorOrZero(amt || "0", currency)),
                            0,
                          );
                          next[b.id] = fromMinorUnits(
                            Math.max(0, Math.min(b.outstanding, remaining - already)),
                            currency,
                          );
                          return next;
                        });
                      }}
                    />
                    <div className="min-w-0 flex-1 text-sm">
                      <p>
                        {b.supplier_invoice_number ?? b.bill_number ?? b.id.slice(0, 8)} ·{" "}
                        {b.bill_date}
                      </p>
                      <p className="text-muted-foreground">
                        Due {b.due_date} · Outstanding {fromMinorUnits(b.outstanding, currency)}
                      </p>
                    </div>
                    {checked ? (
                      <Input
                        className="w-28"
                        inputMode="decimal"
                        value={allocs[b.id] ?? ""}
                        onChange={(e) => setAllocs((prev) => ({ ...prev, [b.id]: e.target.value }))}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {allocTotal > remaining ? (
            <p className="text-xs text-destructive">
              Allocations exceed the remaining credit by{" "}
              {fromMinorUnits(allocTotal - remaining, currency)}.
            </p>
          ) : null}
          <Button
            size="sm"
            disabled={
              allocateM.isPending || allocInvalid || allocTotal > remaining || allocTotal <= 0
            }
            onClick={() => allocateM.mutate()}
          >
            {allocateM.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Allocate credit
          </Button>
        </div>
      ) : null}
      <DocumentActions kind="purchase_credit_note" id={creditNoteId} />
      <AttachmentsPanel entityType="purchase_credit_note" entityId={creditNoteId} />
    </>
  );
}
