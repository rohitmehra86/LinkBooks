import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import { listCustomers, saveInvoiceDraft, authoriseInvoice } from "@/lib/sales/sales.functions";
import { listProducts } from "@/lib/products/products.functions";
import { getWorkflowSettings } from "@/lib/settings/workflow-settings.functions";
import { addDaysIso } from "@/lib/sales/line-helpers";
import { toMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, EmptyState } from "@/components/common/states";
import { EntityCombobox } from "@/components/common/EntityCombobox";
import {
  SalesDocumentLines,
  emptySalesLine,
  type SalesLineFormState,
} from "@/components/sales/SalesDocumentLines";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/_authenticated/sales/invoices/new")({
  head: () => ({ meta: [{ title: "New invoice — LinkBooks" }] }),
  component: NewInvoice,
});

function NewInvoice() {
  const { company } = useActiveCompany();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fetchCustomers = useServerFn(listCustomers);
  const fetchAccounts = useServerFn(listAccounts);
  const fetchProducts = useServerFn(listProducts);
  const fetchSettings = useServerFn(getWorkflowSettings);
  const saveDraft = useServerFn(saveInvoiceDraft);
  const authorise = useServerFn(authoriseInvoice);

  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const today = new Date().toISOString().slice(0, 10);

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
  const productsQ = useQuery({
    queryKey: ["products", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchProducts({ data: { companyId: companyId!, limit: 200 } }),
  });
  const settingsQ = useQuery({
    queryKey: ["workflow-settings", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchSettings({ data: { companyId: companyId! } }),
  });

  const [contactId, setContactId] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(today);
  const [dueDate, setDueDate] = useState(today);
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<SalesLineFormState[]>([emptySalesLine()]);
  const [formError, setFormError] = useState<string | null>(null);
  const [defaultsApplied, setDefaultsApplied] = useState(false);

  useEffect(() => {
    if (defaultsApplied || !settingsQ.data) return;
    const terms = settingsQ.data.sales_default_payment_terms_days ?? 30;
    setDueDate(addDaysIso(today, terms));
    if (settingsQ.data.sales_default_notes) setMemo(settingsQ.data.sales_default_notes);
    setDefaultsApplied(true);
  }, [settingsQ.data, defaultsApplied, today]);

  const customers = (customersQ.data ?? []) as Array<{
    id: string;
    name: string;
    payment_terms_days: number | null;
  }>;

  const incomeAccounts = (
    (accountsQ.data ?? []) as Array<{
      id: string;
      code: string;
      name: string;
      account_type: string;
      is_postable: boolean;
      is_active: boolean;
    }>
  ).filter(
    (a) => a.is_active && a.is_postable && (a.account_type === "income" || a.code.startsWith("4")),
  );

  const treatment = settingsQ.data?.sales_prices_include_tax ? "inclusive" : "exclusive";

  const onCustomerChange = (id: string) => {
    setContactId(id);
    const c = customers.find((x) => x.id === id);
    const terms =
      c?.payment_terms_days ??
      settingsQ.data?.sales_default_payment_terms_days ??
      30;
    setDueDate(addDaysIso(invoiceDate, terms));
  };

  const mutation = useMutation({
    mutationFn: async (alsoAuthorise: boolean) => {
      setFormError(null);
      if (!companyId) throw new Error("No organisation");
      if (!contactId) throw new Error("Choose a customer");
      const payloadLines = lines.map((l) => ({
        description: l.description,
        accountId: l.accountId,
        quantity: Number(l.quantity),
        unitPriceMinor: Number(toMinorUnits(l.unitPrice || "0", currency)),
        discountMinor: Number(toMinorUnits(l.discount || "0", currency)),
        taxRateBps: Number(l.taxRateBps || 0),
        productId: l.productId || null,
      }));
      const saved = await saveDraft({
        data: {
          companyId,
          contactId,
          invoiceDate,
          dueDate,
          invoiceNumber,
          memo,
          currencyCode: currency,
          lines: payloadLines,
        },
      });
      if (alsoAuthorise) {
        await authorise({ data: { companyId, invoiceId: saved.id } });
      }
      return { id: saved.id, authorised: alsoAuthorise };
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["sales-invoices", companyId] });
      toast.success(result.authorised ? "Invoice authorised and posted" : "Draft invoice saved");
      navigate({ to: "/sales/invoices/$invoiceId", params: { invoiceId: result.id } });
    },
    onError: (e) => {
      const msg = friendlyAuthError(e);
      setFormError(msg);
      toast.error(msg);
    },
  });

  const customerOptions = useMemo(
    () => customers.map((c) => ({ value: c.id, label: c.name })),
    [customers],
  );

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (customersQ.isPending || accountsQ.isPending) return <LoadingState />;

  return (
    <>
      <PageHeader
        title="New invoice"
        description="Defaults come from Sales settings and the customer’s payment terms. Authorise posts AR + revenue/tax once."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/sales/invoices">Back</Link>
          </Button>
        }
      />
      {formError ? (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid max-w-4xl gap-4">
        <div className="space-y-2">
          <Label>Customer</Label>
          <EntityCombobox
            aria-label="Customer"
            options={customerOptions}
            value={contactId}
            onChange={onCustomerChange}
            placeholder="Search customers"
            allowClear={false}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label>Invoice date</Label>
            <Input
              type="date"
              value={invoiceDate}
              onChange={(e) => {
                setInvoiceDate(e.target.value);
                const c = customers.find((x) => x.id === contactId);
                const terms =
                  c?.payment_terms_days ??
                  settingsQ.data?.sales_default_payment_terms_days ??
                  30;
                setDueDate(addDaysIso(e.target.value, terms));
              }}
            />
          </div>
          <div className="space-y-2">
            <Label>Due date</Label>
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Invoice #</Label>
            <Input
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              placeholder="Optional — leave blank for later"
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label>Memo / customer message</Label>
          <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
        </div>
        <SalesDocumentLines
          lines={lines}
          onChange={setLines}
          products={(productsQ.data ?? []) as never}
          accounts={incomeAccounts}
          currency={currency}
          treatment={treatment}
          toMinor={(d) => toMinorUnits(d, currency)}
        />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={mutation.isPending} onClick={() => mutation.mutate(false)}>
            {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save draft
          </Button>
          <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate(true)}>
            {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save & authorise (post)
          </Button>
        </div>
      </div>
    </>
  );
}
