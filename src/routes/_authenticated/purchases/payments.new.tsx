import { useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import {
  createAndPostPayment,
  listBills,
  listSuppliers,
} from "@/lib/purchases/purchases.functions";
import { fromMinorUnits, toMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, EmptyState } from "@/components/common/states";
import { EntityCombobox } from "@/components/common/EntityCombobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

export const Route = createFileRoute("/_authenticated/purchases/payments/new")({
  component: NewPayment,
});

function NewPayment() {
  const { company } = useActiveCompany();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fetchSuppliers = useServerFn(listSuppliers);
  const fetchBills = useServerFn(listBills);
  const fetchAccounts = useServerFn(listAccounts);
  const postPayment = useServerFn(createAndPostPayment);

  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const today = new Date().toISOString().slice(0, 10);

  const [contactId, setContactId] = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [paymentDate, setPaymentDate] = useState(today);
  const [amount, setAmount] = useState("0.00");
  const [reference, setReference] = useState("");
  const [alloc, setAlloc] = useState<Record<string, string>>({});

  const suppliersQ = useQuery({
    queryKey: ["suppliers", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchSuppliers({ data: { companyId: companyId! } }),
  });
  const billsQ = useQuery({
    queryKey: ["bills-open", companyId, contactId],
    enabled: Boolean(companyId && contactId),
    queryFn: () => fetchBills({ data: { companyId: companyId!, limit: 100 } }),
  });
  const accountsQ = useQuery({
    queryKey: ["accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });

  const openBills = useMemo(() => {
    const rows = (billsQ.data ?? []) as Array<{
      id: string;
      contact_id: string;
      status: string;
      total_minor: number;
      amount_paid_minor: number;
      amount_credited_minor: number;
      supplier_invoice_number: string | null;
      bill_date: string;
    }>;
    return rows.filter(
      (b) =>
        b.contact_id === contactId &&
        ["authorised", "partly_paid"].includes(b.status) &&
        b.total_minor - b.amount_paid_minor - b.amount_credited_minor > 0,
    );
  }, [billsQ.data, contactId]);

  const banks = (
    (accountsQ.data ?? []) as Array<{
      id: string;
      code: string;
      name: string;
      account_type: string;
      is_postable: boolean;
      is_active: boolean;
    }>
  ).filter((a) => a.is_active && a.is_postable && a.account_type === "asset");

  const supplierOptions = useMemo(
    () =>
      ((suppliersQ.data ?? []) as Array<{ id: string; name: string }>).map((s) => ({
        value: s.id,
        label: s.name,
      })),
    [suppliersQ.data],
  );
  const bankOptions = useMemo(
    () => banks.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
    [banks],
  );

  const amountMinor = Number(toMinorUnits(amount || "0", currency));
  const allocatedSum = openBills.reduce(
    (s, b) => s + Number(toMinorUnits(alloc[b.id] || "0", currency)),
    0,
  );
  const remaining = amountMinor - allocatedSum;

  const mutation = useMutation({
    mutationFn: () => {
      const amountMinor = Number(toMinorUnits(amount || "0", currency));
      const allocations = openBills
        .map((b) => ({
          billId: b.id,
          amountMinor: Number(toMinorUnits(alloc[b.id] || "0", currency)),
        }))
        .filter((a) => a.amountMinor > 0);
      return postPayment({
        data: {
          companyId: companyId!,
          contactId,
          paymentDate,
          bankAccountId,
          currencyCode: currency,
          amountMinor,
          reference,
          allocations,
        },
      });
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["payments", companyId] });
      await queryClient.invalidateQueries({ queryKey: ["bills", companyId] });
      toast.success(
        result.unallocatedMinor > 0
          ? `Payment posted (${fromMinorUnits(BigInt(result.unallocatedMinor), currency)} unallocated)`
          : "Payment posted and allocated",
      );
      navigate({ to: "/purchases/payments" });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (suppliersQ.isPending || accountsQ.isPending) return <LoadingState />;

  return (
    <>
      <PageHeader
        title="New supplier payment"
        description="Posts DR Accounts Payable / CR bank, then updates bill outstanding balances."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/purchases/payments">Back</Link>
          </Button>
        }
      />
      <div className="grid max-w-2xl gap-4">
        <div className="space-y-2">
          <Label>Supplier</Label>
          <EntityCombobox
            options={supplierOptions}
            value={contactId}
            onChange={(id) => {
              setContactId(id);
              setAlloc({});
            }}
            placeholder="Search suppliers"
            allowClear={false}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Date</Label>
            <Input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Amount ({currency})</Label>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
        </div>
        <div className="space-y-2">
          <Label>Bank / cash account</Label>
          <EntityCombobox
            options={bankOptions}
            value={bankAccountId}
            onChange={setBankAccountId}
            placeholder="Deposit from"
            allowClear={false}
          />
        </div>
        <div className="space-y-2">
          <Label>Reference</Label>
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>

        {contactId ? (
          <div className="space-y-3 rounded-md border p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <Label>Allocate to bills</Label>
              <p className="text-xs text-muted-foreground">
                Allocated {fromMinorUnits(allocatedSum, currency)} · Remaining{" "}
                <span className={remaining < 0 ? "text-destructive" : ""}>
                  {fromMinorUnits(remaining, currency)}
                </span>
              </p>
            </div>
            {openBills.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No open bills — payment can post fully unallocated.
              </p>
            ) : (
              openBills.map((b) => {
                const outstanding = b.total_minor - b.amount_paid_minor - b.amount_credited_minor;
                const checked = Boolean(alloc[b.id]);
                return (
                  <div key={b.id} className="flex flex-wrap items-center gap-3 rounded border px-3 py-2 text-sm">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) => {
                        setAlloc((prev) => {
                          const next = { ...prev };
                          if (!v) {
                            delete next[b.id];
                            return next;
                          }
                          const already = Object.entries(prev).reduce(
                            (s, [id, amt]) =>
                              id === b.id ? s : s + Number(toMinorUnits(amt || "0", currency)),
                            0,
                          );
                          const room = Math.max(0, amountMinor - already);
                          next[b.id] = fromMinorUnits(Math.min(outstanding, room), currency);
                          return next;
                        });
                      }}
                    />
                    <div className="min-w-0 flex-1">
                      <p>
                        {b.bill_date} · {b.supplier_invoice_number ?? b.id.slice(0, 8)}
                      </p>
                      <p className="text-muted-foreground">
                        Outstanding {fromMinorUnits(outstanding, currency)}
                      </p>
                    </div>
                    {checked ? (
                      <Input
                        className="w-28"
                        value={alloc[b.id] ?? ""}
                        onChange={(e) => setAlloc({ ...alloc, [b.id]: e.target.value })}
                      />
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        ) : null}

        <Button
          size="sm"
          disabled={mutation.isPending || !contactId || !bankAccountId || remaining < 0}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          Post payment
        </Button>
      </div>
    </>
  );
}
