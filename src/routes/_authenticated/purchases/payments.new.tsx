import { useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  createAndPostPayment,
  listBills,
  listPaymentAccounts,
  listSuppliers,
} from "@/lib/purchases/purchases.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { minorOrZero, parseMinorOrThrow, tryParseMinor } from "@/lib/purchases/money-input";
import { useCanDo } from "@/hooks/use-can";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

export function NewPayment() {
  const { company } = useActiveCompany();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fetchSuppliers = useServerFn(listSuppliers);
  const fetchBills = useServerFn(listBills);
  const fetchAccounts = useServerFn(listPaymentAccounts);
  const canPay = useCanDo("purchases.payment");
  const postPayment = useServerFn(createAndPostPayment);

  const companyId = company?.id;
  const baseCurrency = company?.base_currency ?? "GBP";
  const today = new Date().toISOString().slice(0, 10);

  const [contactId, setContactId] = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [paymentDate, setPaymentDate] = useState(today);
  const [amount, setAmount] = useState("0.00");
  const [reference, setReference] = useState("");
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [currencyOverride, setCurrencyOverride] = useState("");
  const [billLimit, setBillLimit] = useState(50);

  const suppliersQ = useQuery({
    queryKey: ["suppliers", companyId, "all"],
    enabled: Boolean(companyId),
    queryFn: () => fetchSuppliers({ data: { companyId: companyId!, includeInactive: true } }),
  });
  const supplier = (
    (suppliersQ.data ?? []) as Array<{
      id: string;
      name: string;
      default_currency: string | null;
    }>
  ).find((s) => s.id === contactId);
  // The payment currency defaults to the supplier's currency; it can be changed.
  const currency = (currencyOverride || supplier?.default_currency || baseCurrency).toUpperCase();

  // Open bills for this supplier + currency come from the server, oldest due date first (P-04).
  const billsQ = useQuery({
    queryKey: ["bills-open", companyId, contactId, currency, billLimit],
    enabled: Boolean(companyId && contactId),
    queryFn: () =>
      fetchBills({
        data: {
          companyId: companyId!,
          contactId,
          tab: "to_pay",
          currencyCode: currency,
          sortBy: "due_date",
          sortDir: "asc",
          limit: billLimit,
        },
      }),
  });
  const accountsQ = useQuery({
    queryKey: ["payment-accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });

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
    return rows.filter((b) => b.total_minor - b.amount_paid_minor - b.amount_credited_minor > 0);
  }, [billsQ.data]);
  const totalOpenBills = (billsQ.data as { totalCount?: number } | undefined)?.totalCount ?? 0;

  // Bank / cash accounts only (the server enforces the same rule).
  const bankOptions = useMemo(
    () =>
      ((accountsQ.data ?? []) as Array<{ id: string; code: string; name: string }>).map((a) => ({
        value: a.id,
        label: `${a.code} — ${a.name}`,
      })),
    [accountsQ.data],
  );

  const supplierOptions = useMemo(
    () =>
      ((suppliersQ.data ?? []) as Array<{ id: string; name: string }>).map((s) => ({
        value: s.id,
        label: s.name,
      })),
    [suppliersQ.data],
  );
  // Parsing never throws while typing (P-03); invalid text is flagged and blocks submit.
  const parsedAmount = tryParseMinor(amount || "0", currency);
  const amountInvalid = parsedAmount === null;
  const amountMinor = Number(parsedAmount ?? 0n);
  const allocInvalid = openBills.some(
    (b) => alloc[b.id] !== undefined && tryParseMinor(alloc[b.id] || "0", currency) === null,
  );
  const allocatedSum = openBills.reduce(
    (s, b) => s + Number(minorOrZero(alloc[b.id] || "0", currency)),
    0,
  );
  const remaining = amountMinor - allocatedSum;

  const mutation = useMutation({
    mutationFn: () => {
      const amountMinor = Number(parseMinorOrThrow(amount || "0", currency, "Payment amount"));
      if (amountMinor <= 0) throw new Error("Enter a payment amount greater than zero");
      const allocations = openBills
        .filter((b) => alloc[b.id] !== undefined)
        .map((b) => ({
          billId: b.id,
          amountMinor: Number(parseMinorOrThrow(alloc[b.id] || "0", currency, "Allocation")),
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
              setCurrencyOverride("");
              setBillLimit(50);
            }}
            placeholder="Search suppliers"
            allowClear={false}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Date</Label>
            <Input
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Amount ({currency})</Label>
            <Input
              value={amount}
              inputMode="decimal"
              aria-invalid={amountInvalid}
              onChange={(e) => setAmount(e.target.value)}
            />
            {amountInvalid ? (
              <p className="text-xs text-destructive">Enter a number, e.g. 1,250.00</p>
            ) : null}
          </div>
        </div>
        <div className="space-y-2">
          <Label>Currency</Label>
          <Select
            value={currency}
            onValueChange={(v) => {
              setCurrencyOverride(v);
              setAlloc({});
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[
                ...new Set(
                  [supplier?.default_currency, baseCurrency, currency]
                    .filter((c): c is string => Boolean(c))
                    .map((c) => c.toUpperCase()),
                ),
              ].map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            A payment can only be allocated to bills in its own currency.
          </p>
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
                No open {currency} bills for this supplier — payment can post fully unallocated.
              </p>
            ) : (
              openBills.map((b) => {
                const outstanding = b.total_minor - b.amount_paid_minor - b.amount_credited_minor;
                const checked = alloc[b.id] !== undefined;
                return (
                  <div
                    key={b.id}
                    className="flex flex-wrap items-center gap-3 rounded border px-3 py-2 text-sm"
                  >
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
                              id === b.id ? s : s + Number(minorOrZero(amt || "0", currency)),
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
                        {b.bill_date} ·{" "}
                        {b.supplier_invoice_number ?? b.bill_number ?? b.id.slice(0, 8)}
                      </p>
                      <p className="text-muted-foreground">
                        Due {b.due_date} · Outstanding {fromMinorUnits(outstanding, currency)}
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
        {contactId && totalOpenBills > openBills.length ? (
          <Button variant="outline" size="sm" onClick={() => setBillLimit((n) => n + 50)}>
            Show more bills ({openBills.length} of {totalOpenBills})
          </Button>
        ) : null}
        {!canPay ? (
          <p className="text-sm text-muted-foreground">
            You do not have permission to record supplier payments.
          </p>
        ) : null}

        <Button
          size="sm"
          disabled={
            mutation.isPending ||
            !canPay ||
            !contactId ||
            !bankAccountId ||
            remaining < 0 ||
            amountInvalid ||
            allocInvalid
          }
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          Post payment
        </Button>
      </div>
    </>
  );
}
