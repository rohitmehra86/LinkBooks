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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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

  const banks = ((accountsQ.data ?? []) as Array<{ id: string; code: string; name: string; is_postable: boolean; is_active: boolean }>).filter(
    (a) => a.is_active && a.is_postable,
  );

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
          <Select value={contactId} onValueChange={setContactId}>
            <SelectTrigger>
              <SelectValue placeholder="Select" />
            </SelectTrigger>
            <SelectContent>
              {((suppliersQ.data ?? []) as Array<{ id: string; name: string }>).map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
          <Label>Bank account</Label>
          <Select value={bankAccountId} onValueChange={setBankAccountId}>
            <SelectTrigger>
              <SelectValue placeholder="Select" />
            </SelectTrigger>
            <SelectContent>
              {banks.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Reference</Label>
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>

        {contactId ? (
          <div className="space-y-2">
            <Label>Allocate to bills</Label>
            {openBills.length === 0 ? (
              <p className="text-sm text-muted-foreground">No open authorised bills for this supplier.</p>
            ) : (
              openBills.map((b) => {
                const outstanding = b.total_minor - b.amount_paid_minor - b.amount_credited_minor;
                return (
                  <div key={b.id} className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="min-w-[10rem]">
                      {b.bill_date} · {b.supplier_invoice_number ?? b.id.slice(0, 8)}
                    </span>
                    <span className="text-muted-foreground">
                      Due {fromMinorUnits(BigInt(outstanding), currency)}
                    </span>
                    <Input
                      className="w-28"
                      placeholder="0.00"
                      value={alloc[b.id] ?? ""}
                      onChange={(e) => setAlloc({ ...alloc, [b.id]: e.target.value })}
                    />
                  </div>
                );
              })
            )}
          </div>
        ) : null}

        <Button
          size="sm"
          disabled={mutation.isPending || !contactId || !bankAccountId}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          Post payment
        </Button>
      </div>
    </>
  );
}
