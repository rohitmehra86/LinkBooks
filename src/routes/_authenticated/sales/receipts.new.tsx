import { useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import { listCustomers, listInvoices, recordReceipt } from "@/lib/sales/sales.functions";
import { toMinorUnits, fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, EmptyState } from "@/components/common/states";
import { EntityCombobox } from "@/components/common/EntityCombobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

export const Route = createFileRoute("/_authenticated/sales/receipts/new")({
  head: () => ({ meta: [{ title: "Record receipt — LinkBooks" }] }),
  component: NewReceipt,
});

type AllocRow = { invoiceId: string; amount: string; outstanding: number; label: string };

export function NewReceipt() {
  const { company } = useActiveCompany();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const today = new Date().toISOString().slice(0, 10);
  const fetchCustomers = useServerFn(listCustomers);
  const fetchAccounts = useServerFn(listAccounts);
  const fetchInvoices = useServerFn(listInvoices);
  const doRecord = useServerFn(recordReceipt);

  const [contactId, setContactId] = useState("");
  const [receiptDate, setReceiptDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [reference, setReference] = useState("");
  const [memo, setMemo] = useState("");
  const [allocs, setAllocs] = useState<Record<string, string>>({});

  const customersQ = useQuery({
    queryKey: ["customers", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchCustomers({ data: { companyId: companyId! } }),
  });
  const accountsQ = useQuery({
    queryKey: ["accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });
  const invoicesQ = useQuery({
    queryKey: ["sales-invoices-open", companyId, contactId],
    enabled: Boolean(companyId && contactId),
    queryFn: () => fetchInvoices({ data: { companyId: companyId! } }),
  });

  const bankAccounts = (
    (accountsQ.data ?? []) as Array<{
      id: string;
      code: string;
      name: string;
      account_type: string;
      is_postable: boolean;
      is_active: boolean;
    }>
  ).filter((a) => a.is_active && a.is_postable && a.account_type === "asset");

  const openInvoices: AllocRow[] = (
    (invoicesQ.data?.rows ?? []) as Array<{
      id: string;
      status: string;
      total_minor: number;
      amount_paid_minor: number;
      amount_credited_minor: number;
      invoice_number: string | null;
      contact_id: string;
      invoice_date: string;
      due_date: string;
    }>
  )
    .filter((i) => i.contact_id === contactId && ["authorised", "partly_paid"].includes(i.status))
    .map((i) => {
      const outstanding = i.total_minor - i.amount_paid_minor - i.amount_credited_minor;
      return {
        invoiceId: i.id,
        amount: allocs[i.id] ?? "",
        outstanding,
        label: `${i.invoice_number ?? i.id.slice(0, 8)} · ${i.invoice_date} · due ${i.due_date}`,
      };
    });

  const amountMinor = Number(toMinorUnits(amount || "0", currency));
  const allocatedSum = openInvoices.reduce((s, row) => {
    const v = allocs[row.invoiceId];
    if (!v) return s;
    return s + Number(toMinorUnits(v, currency));
  }, 0);
  const remaining = amountMinor - allocatedSum;

  const customerOptions = useMemo(
    () =>
      ((customersQ.data ?? []) as Array<{ id: string; name: string }>).map((c) => ({
        value: c.id,
        label: c.name,
      })),
    [customersQ.data],
  );
  const bankOptions = useMemo(
    () =>
      bankAccounts.map((a) => ({
        value: a.id,
        label: `${a.code} — ${a.name}`,
      })),
    [bankAccounts],
  );

  const toggleInvoice = (invoiceId: string, outstanding: number, checked: boolean) => {
    setAllocs((prev) => {
      const next = { ...prev };
      if (!checked) {
        delete next[invoiceId];
        return next;
      }
      const already = Object.entries(prev).reduce(
        (s, [id, v]) => (id === invoiceId ? s : s + Number(toMinorUnits(v || "0", currency))),
        0,
      );
      const room = Math.max(0, amountMinor - already);
      const apply = Math.min(outstanding, room);
      next[invoiceId] = fromMinorUnits(apply, currency);
      return next;
    });
  };

  const mutation = useMutation({
    mutationFn: async () => {
      if (!companyId) throw new Error("No organisation");
      if (!contactId) throw new Error("Choose a customer");
      if (!bankAccountId) throw new Error("Choose a deposit account");
      if (!(amountMinor > 0)) throw new Error("Receipt amount must be positive");
      if (allocatedSum > amountMinor) throw new Error("Allocations exceed receipt amount");
      const allocations = Object.entries(allocs)
        .map(([invoiceId, amt]) => ({
          invoiceId,
          amountMinor: Number(toMinorUnits(amt || "0", currency)),
        }))
        .filter((a) => a.amountMinor > 0);
      for (const a of allocations) {
        const inv = openInvoices.find((i) => i.invoiceId === a.invoiceId);
        if (inv && a.amountMinor > inv.outstanding) {
          throw new Error("Allocation exceeds invoice outstanding");
        }
      }
      return doRecord({
        data: {
          companyId,
          contactId,
          receiptDate,
          amountMinor,
          bankAccountId,
          currencyCode: currency,
          reference,
          memo,
          allocations,
        },
      });
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["sales-receipts", companyId] });
      await qc.invalidateQueries({ queryKey: ["sales-invoices", companyId] });
      toast.success(
        r.unallocatedMinor > 0
          ? `Receipt posted. Unallocated: ${fromMinorUnits(r.unallocatedMinor, currency)}`
          : "Receipt posted and allocated",
      );
      navigate({ to: "/sales/receipts" });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (customersQ.isPending || accountsQ.isPending) return <LoadingState />;

  return (
    <>
      <PageHeader
        title="Record receipt"
        description="Posts DR bank / CR AR once. Allocate across invoices without a second cash journal. Leave remainder unallocated for overpayments."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/sales/receipts">Back</Link>
          </Button>
        }
      />
      <div className="grid max-w-2xl gap-4">
        <div className="space-y-2">
          <Label>Customer</Label>
          <EntityCombobox
            options={customerOptions}
            value={contactId}
            onChange={(id) => {
              setContactId(id);
              setAllocs({});
            }}
            allowClear={false}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Date</Label>
            <Input type="date" value={receiptDate} onChange={(e) => setReceiptDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Amount</Label>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </div>
        </div>
        <div className="space-y-2">
          <Label>Bank / cash GL</Label>
          <EntityCombobox
            options={bankOptions}
            value={bankAccountId}
            onChange={setBankAccountId}
            placeholder="Deposit account"
            allowClear={false}
          />
        </div>
        <div className="space-y-2">
          <Label>Reference</Label>
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Memo</Label>
          <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
        </div>

        <div className="rounded-md border p-3 space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <Label>Allocate to invoices</Label>
            <p className="text-xs text-muted-foreground">
              Allocated {fromMinorUnits(allocatedSum, currency)} · Remaining{" "}
              <span className={remaining < 0 ? "text-destructive" : ""}>
                {fromMinorUnits(remaining, currency)}
              </span>
            </p>
          </div>
          {!contactId ? (
            <p className="text-sm text-muted-foreground">Select a customer to load open invoices.</p>
          ) : openInvoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No open invoices — receipt can post fully unallocated.
            </p>
          ) : (
            <ul className="space-y-2">
              {openInvoices.map((row) => {
                const checked = row.invoiceId in allocs;
                return (
                  <li
                    key={row.invoiceId}
                    className="flex flex-wrap items-center gap-3 rounded border border-border/60 px-3 py-2"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) =>
                        toggleInvoice(row.invoiceId, row.outstanding, Boolean(v))
                      }
                      aria-label={`Allocate ${row.label}`}
                    />
                    <div className="min-w-0 flex-1 text-sm">
                      <p className="truncate font-medium">{row.label}</p>
                      <p className="text-muted-foreground">
                        Outstanding {fromMinorUnits(row.outstanding, currency)}
                      </p>
                    </div>
                    {checked ? (
                      <Input
                        className="w-28"
                        value={allocs[row.invoiceId] ?? ""}
                        onChange={(e) =>
                          setAllocs((prev) => ({ ...prev, [row.invoiceId]: e.target.value }))
                        }
                        aria-label="Allocation amount"
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <Button size="sm" disabled={mutation.isPending || remaining < 0} onClick={() => mutation.mutate()}>
          {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null} Post receipt
        </Button>
      </div>
    </>
  );
}
