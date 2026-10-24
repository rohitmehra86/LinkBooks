import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { useCan } from "@/hooks/use-can";
import { listCustomers } from "@/lib/sales/sales.functions";
import { listOpenInvoicesForCustomer, recordReceipt } from "@/lib/sales/sales-receipts.functions";
import { getSalesDocumentConfig, listDepositAccounts } from "@/lib/sales/sales-config.functions";
import { fromMinorUnits, toMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, EmptyState } from "@/components/common/states";
import { EntityCombobox } from "@/components/common/EntityCombobox";
import { ContactCreateForm } from "@/components/lookup/create-forms";
import { currencyOptions, money } from "@/components/sales/sales-form-utils";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/sales/receipts/new")({
  head: () => ({ meta: [{ title: "Record receipt — LinkBooks" }] }),
  validateSearch: (s: Record<string, unknown>): { contactId?: string; invoiceId?: string } => ({
    ...(typeof s["contactId"] === "string" ? { contactId: s["contactId"] } : {}),
    ...(typeof s["invoiceId"] === "string" ? { invoiceId: s["invoiceId"] } : {}),
  }),
  component: NewReceiptRoute,
});

function NewReceiptRoute() {
  const search = Route.useSearch();
  return <ReceiptForm contactId={search.contactId} invoiceId={search.invoiceId} />;
}

/** Used by the Create-new panel, which renders the form outside a route. */
export function NewReceipt() {
  return <ReceiptForm />;
}

function ReceiptForm({
  contactId: initialContactId,
  invoiceId: initialInvoiceId,
}: {
  contactId?: string | undefined;
  invoiceId?: string | undefined;
}) {
  const { company } = useActiveCompany();
  const { can } = useCan();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const companyId = company?.id;

  const fetchCustomers = useServerFn(listCustomers);
  const fetchDeposits = useServerFn(listDepositAccounts);
  const fetchOpen = useServerFn(listOpenInvoicesForCustomer);
  const fetchConfig = useServerFn(getSalesDocumentConfig);
  const record = useServerFn(recordReceipt);

  const enabled = Boolean(companyId);
  const customersQ = useQuery({
    queryKey: ["customers", companyId],
    enabled,
    queryFn: () => fetchCustomers({ data: { companyId: companyId! } }),
  });
  const depositsQ = useQuery({
    queryKey: ["deposit-accounts", companyId],
    enabled,
    queryFn: () => fetchDeposits({ data: { companyId: companyId! } }),
  });
  const configQ = useQuery({
    queryKey: ["sales-doc-config", companyId],
    enabled,
    queryFn: () => fetchConfig({ data: { companyId: companyId! } }),
  });

  const [contactId, setContactId] = useState(initialContactId ?? "");
  const openQ = useQuery({
    queryKey: ["open-invoices", companyId, contactId],
    enabled: enabled && Boolean(contactId),
    queryFn: () => fetchOpen({ data: { companyId: companyId!, contactId } }),
  });

  const base = configQ.data?.baseCurrency ?? company?.base_currency ?? "GBP";
  const today = configQ.data?.today ?? new Date().toISOString().slice(0, 10);

  const [receiptDate, setReceiptDate] = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [currency, setCurrency] = useState("");
  const [fxRate, setFxRate] = useState("");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [memo, setMemo] = useState("");
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [preselected, setPreselected] = useState(false);
  const [datesReady, setDatesReady] = useState(false);

  useEffect(() => {
    if (datesReady || !configQ.data) return;
    setReceiptDate(today);
    setCurrency(base);
    setDatesReady(true);
  }, [datesReady, configQ.data, today, base]);

  const deposits = useMemo(
    () => (depositsQ.data ?? []) as Array<{ id: string; code: string; name: string }>,
    [depositsQ.data],
  );
  useEffect(() => {
    if (!bankAccountId && deposits.length === 1) setBankAccountId(deposits[0]!.id);
  }, [deposits, bankAccountId]);

  const open = useMemo(
    () =>
      (openQ.data ?? []) as Array<{
        id: string;
        invoice_number: string | null;
        invoice_date: string;
        due_date: string;
        currency_code: string;
        outstanding_minor: number;
      }>,
    [openQ.data],
  );

  // "Record receipt" from an invoice page: preselect that invoice, its currency and its balance.
  useEffect(() => {
    if (preselected || !initialInvoiceId || !openQ.data || !datesReady) return;
    const inv = open.find((i) => i.id === initialInvoiceId);
    if (inv) {
      setCurrency(inv.currency_code);
      setAlloc({ [inv.id]: fromMinorUnits(inv.outstanding_minor, inv.currency_code) });
      setAmount(fromMinorUnits(inv.outstanding_minor, inv.currency_code));
    }
    setPreselected(true);
  }, [preselected, initialInvoiceId, openQ.data, open, datesReady]);

  const cur = currency || base;
  const isForeign = cur !== base;
  const visible = open.filter((i) => i.currency_code === cur);
  const otherCurrencies = [...new Set(open.map((i) => i.currency_code).filter((c) => c !== cur))];

  const toMinor = (v: string): number => {
    try {
      return Number(toMinorUnits(v || "0", cur));
    } catch {
      return Number.NaN;
    }
  };
  const amountMinor = toMinor(amount);
  const allocRows = visible.map((i) => ({ inv: i, minor: toMinor(alloc[i.id] ?? "") }));
  const allocatedMinor = allocRows.reduce((s, r) => s + (r.minor > 0 ? r.minor : 0), 0);
  const unallocatedMinor = amountMinor - allocatedMinor;
  const overAlloc = allocRows.find((r) => r.minor > r.inv.outstanding_minor);

  const customerOptions = useMemo(
    () =>
      ((customersQ.data ?? []) as Array<{ id: string; name: string }>).map((c) => ({
        value: c.id,
        label: c.name,
      })),
    [customersQ.data],
  );

  const autoAllocate = () => {
    let left = amountMinor;
    const next: Record<string, string> = {};
    for (const i of visible) {
      if (!(left > 0)) break;
      const take = Math.min(left, i.outstanding_minor);
      next[i.id] = fromMinorUnits(take, cur);
      left -= take;
    }
    setAlloc(next);
  };

  const mutation = useMutation({
    mutationFn: async () => {
      setFormError(null);
      if (!companyId) throw new Error("No organisation");
      if (!contactId) throw new Error("Choose a customer");
      if (!bankAccountId) throw new Error("Choose the bank or cash account the money went into");
      if (!(amountMinor > 0)) throw new Error("Enter a receipt amount greater than zero");
      if (overAlloc) throw new Error("An allocation exceeds that invoice’s outstanding balance");
      if (unallocatedMinor < 0) throw new Error("Allocations exceed the receipt amount");
      const fx = isForeign ? Number(fxRate) : 1;
      if (isForeign && !(fx > 0)) throw new Error(`Enter the exchange rate to ${base}`);
      return record({
        data: {
          companyId,
          contactId,
          receiptDate,
          amountMinor,
          bankAccountId,
          currencyCode: cur,
          fxRateToBase: fx,
          reference,
          memo,
          allocations: allocRows
            .filter((r) => r.minor > 0)
            .map((r) => ({ invoiceId: r.inv.id, amountMinor: r.minor })),
        },
      });
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["sales-receipts", companyId] });
      await qc.invalidateQueries({ queryKey: ["sales-invoices", companyId] });
      await qc.invalidateQueries({ queryKey: ["sales-invoice", companyId] });
      await qc.invalidateQueries({ queryKey: ["open-invoices", companyId] });
      toast.success(
        r.unallocatedMinor > 0
          ? `Receipt recorded — ${money(r.unallocatedMinor, cur)} left unallocated`
          : "Receipt recorded and allocated",
      );
      navigate({ to: "/sales/receipts/$receiptId", params: { receiptId: r.id } });
    },
    onError: (e) => {
      const msg = friendlyAuthError(e);
      setFormError(msg);
      toast.error(msg);
    },
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (customersQ.isPending || depositsQ.isPending || configQ.isPending) return <LoadingState />;

  return (
    <>
      <PageHeader
        title="Record receipt"
        description="Posts DR bank / CR accounts receivable in one step together with the invoice allocations."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/sales/receipts">Back</Link>
          </Button>
        }
      />
      {formError ? (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}
      {deposits.length === 0 ? (
        <Alert className="mb-4">
          <AlertDescription>
            No bank or cash account found. Add one in Banking or the chart of accounts first.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid max-w-4xl gap-4">
        <div className="space-y-2">
          <Label>Customer</Label>
          <EntityCombobox
            aria-label="Customer"
            options={customerOptions}
            value={contactId}
            onChange={(v) => {
              setContactId(v);
              setAlloc({});
            }}
            placeholder="Search customers"
            allowClear={false}
            companyId={companyId}
            canAddNew={can("contacts.manage")}
            createTitle="New customer"
            renderCreate={
              can("contacts.manage")
                ? (ctx) => <ContactCreateForm companyId={companyId} kind="customer" ctx={ctx} />
                : undefined
            }
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label>Receipt date</Label>
            <Input
              type="date"
              value={receiptDate}
              onChange={(e) => setReceiptDate(e.target.value)}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label>Deposit to (bank / cash account)</Label>
            <EntityCombobox
              aria-label="Deposit account"
              options={deposits.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` }))}
              value={bankAccountId}
              onChange={setBankAccountId}
              placeholder="Choose bank or cash account"
              allowClear={false}
            />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-4">
          <div className="space-y-2">
            <Label>Currency</Label>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={cur}
              onChange={(e) => {
                setCurrency(e.target.value);
                setAlloc({});
              }}
            >
              {currencyOptions(
                base,
                open.map((i) => i.currency_code),
              ).map((c) => (
                <option key={c} value={c}>
                  {c}
                  {c === base ? " (base)" : ""}
                </option>
              ))}
            </select>
          </div>
          {isForeign ? (
            <div className="space-y-2">
              <Label>
                Rate (1 {cur} = ? {base})
              </Label>
              <Input
                value={fxRate}
                onChange={(e) => setFxRate(e.target.value)}
                inputMode="decimal"
              />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label>Amount received ({cur})</Label>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </div>
          <div className="space-y-2">
            <Label>Reference</Label>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>
        </div>
        <div className="space-y-2">
          <Label>Memo</Label>
          <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
        </div>

        {contactId ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Apply to invoices ({cur})</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={autoAllocate}
                disabled={!(amountMinor > 0)}
              >
                Allocate oldest first
              </Button>
            </div>
            {openQ.isPending ? (
              <LoadingState rows={2} />
            ) : visible.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No open {cur} invoices for this customer. The whole amount will be recorded as an
                unallocated payment on account.
                {otherCurrencies.length
                  ? ` Open invoices exist in ${otherCurrencies.join(", ")} — change the currency to apply to them.`
                  : ""}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                    <TableHead className="w-40 text-right">Apply</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((i) => {
                    const minor = toMinor(alloc[i.id] ?? "");
                    const bad = minor > i.outstanding_minor;
                    return (
                      <TableRow key={i.id}>
                        <TableCell>{i.invoice_number ?? i.id.slice(0, 8)}</TableCell>
                        <TableCell>{i.due_date}</TableCell>
                        <TableCell className="text-right">
                          {money(i.outstanding_minor, cur)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Input
                            className={`text-right ${bad ? "border-destructive" : ""}`}
                            value={alloc[i.id] ?? ""}
                            onChange={(e) => setAlloc((a) => ({ ...a, [i.id]: e.target.value }))}
                            inputMode="decimal"
                            aria-label={`Apply to ${i.invoice_number ?? "invoice"}`}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
            <p className="text-sm text-muted-foreground">
              Allocated {money(allocatedMinor, cur)} · Unallocated{" "}
              {Number.isFinite(unallocatedMinor) ? money(unallocatedMinor, cur) : "—"}
            </p>
          </div>
        ) : null}

        <div>
          <Button
            size="sm"
            disabled={mutation.isPending || deposits.length === 0}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Record receipt
          </Button>
        </div>
      </div>
    </>
  );
}
