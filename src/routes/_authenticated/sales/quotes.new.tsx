import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import { listCustomers, saveQuoteDraft } from "@/lib/sales/sales.functions";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/_authenticated/sales/quotes/new")({
  head: () => ({ meta: [{ title: "New quote — LinkBooks" }] }),
  component: NewQuote,
});

export function NewQuote() {
  const { company } = useActiveCompany();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const today = new Date().toISOString().slice(0, 10);
  const fetchCustomers = useServerFn(listCustomers);
  const fetchAccounts = useServerFn(listAccounts);
  const fetchProducts = useServerFn(listProducts);
  const fetchSettings = useServerFn(getWorkflowSettings);
  const saveDraft = useServerFn(saveQuoteDraft);

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
  const [quoteDate, setQuoteDate] = useState(today);
  const [expiryDate, setExpiryDate] = useState("");
  const [quoteNumber, setQuoteNumber] = useState("");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<SalesLineFormState[]>([emptySalesLine()]);
  const [defaultsApplied, setDefaultsApplied] = useState(false);

  useEffect(() => {
    if (defaultsApplied || !settingsQ.data) return;
    const days = settingsQ.data.sales_quote_validity_days ?? 30;
    setExpiryDate(addDaysIso(today, days));
    if (settingsQ.data.sales_default_notes) setMemo(settingsQ.data.sales_default_notes);
    setDefaultsApplied(true);
  }, [settingsQ.data, defaultsApplied, today]);

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
  const customerOptions = useMemo(
    () =>
      ((customersQ.data ?? []) as Array<{ id: string; name: string }>).map((c) => ({
        value: c.id,
        label: c.name,
      })),
    [customersQ.data],
  );

  const mutation = useMutation({
    mutationFn: async () => {
      if (!companyId || !contactId) throw new Error("Customer is required");
      return saveDraft({
        data: {
          companyId,
          contactId,
          quoteDate,
          expiryDate,
          quoteNumber,
          memo,
          currencyCode: currency,
          lines: lines.map((l) => ({
            description: l.description,
            accountId: l.accountId,
            quantity: Number(l.quantity),
            unitPriceMinor: Number(toMinorUnits(l.unitPrice || "0", currency)),
            discountMinor: Number(toMinorUnits(l.discount || "0", currency)),
            taxRateBps: Number(l.taxRateBps || 0),
            productId: l.productId || null,
          })),
        },
      });
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["sales-quotes", companyId] });
      toast.success("Quote saved (no ledger posting)");
      navigate({ to: "/sales/quotes/$quoteId", params: { quoteId: r.id } });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (customersQ.isPending || accountsQ.isPending) return <LoadingState />;

  return (
    <>
      <PageHeader
        title="New quote"
        description="Quotes never post to the ledger. Convert to a draft invoice when accepted."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/sales/quotes">Back</Link>
          </Button>
        }
      />
      <div className="grid max-w-4xl gap-4">
        <div className="space-y-2">
          <Label>Customer</Label>
          <EntityCombobox
            options={customerOptions}
            value={contactId}
            onChange={setContactId}
            allowClear={false}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label>Quote date</Label>
            <Input
              type="date"
              value={quoteDate}
              onChange={(e) => {
                setQuoteDate(e.target.value);
                const days = settingsQ.data?.sales_quote_validity_days ?? 30;
                setExpiryDate(addDaysIso(e.target.value, days));
              }}
            />
          </div>
          <div className="space-y-2">
            <Label>Expiry</Label>
            <Input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Quote #</Label>
            <Input value={quoteNumber} onChange={(e) => setQuoteNumber(e.target.value)} />
          </div>
        </div>
        <div className="space-y-2">
          <Label>Memo</Label>
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
        <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          Save quote
        </Button>
      </div>
    </>
  );
}
