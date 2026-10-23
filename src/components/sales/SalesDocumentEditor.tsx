"use client";

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import {
  getInvoice,
  listCustomers,
  listInvoices,
  saveAndAuthoriseInvoice,
  saveInvoiceDraft,
  saveQuoteDraft,
} from "@/lib/sales/sales.functions";
import { authoriseCreditNote, saveCreditNoteDraft } from "@/lib/sales/sales-credits.functions";
import { getSalesDocumentConfig } from "@/lib/sales/sales-config.functions";
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
import {
  currencyOptions,
  lineFormToInput,
  lineRowToForm,
  type SavedLineRow,
} from "@/components/sales/sales-form-utils";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type SalesDocKind = "invoice" | "quote" | "credit_note";

export type ExistingSalesDoc = {
  id: string;
  contactId: string;
  date: string;
  /** Invoice due date or quote expiry date. */
  secondDate: string | null;
  number: string | null;
  memo: string | null;
  currencyCode: string;
  fxRateToBase: number;
  /** Credit note: the invoice it credits. */
  sourceInvoiceId: string | null;
  lines: SavedLineRow[];
};

const COPY = {
  invoice: {
    noun: "invoice",
    newTitle: "New invoice",
    editTitle: "Edit draft invoice",
    numberLabel: "Invoice #",
    dateLabel: "Invoice date",
    secondLabel: "Due date",
    authorise: "Save & authorise (post)",
    queryKey: "sales-invoices",
  },
  quote: {
    noun: "quote",
    newTitle: "New quote",
    editTitle: "Edit quote",
    numberLabel: "Quote #",
    dateLabel: "Quote date",
    secondLabel: "Expiry date",
    authorise: "",
    queryKey: "sales-quotes",
  },
  credit_note: {
    noun: "credit note",
    newTitle: "New credit note",
    editTitle: "Edit draft credit note",
    numberLabel: "Credit note #",
    dateLabel: "Credit date",
    secondLabel: "",
    authorise: "Save & authorise (post)",
    queryKey: "sales-credits",
  },
} as const;

type Props = {
  kind: SalesDocKind;
  existing?: ExistingSalesDoc;
  /** Credit note only: start from this invoice ("Credit from invoice"). */
  fromInvoiceId?: string | undefined;
  /** Start with this customer selected. */
  initialContactId?: string | undefined;
};

export function SalesDocumentEditor({ kind, existing, fromInvoiceId, initialContactId }: Props) {
  const copy = COPY[kind];
  const { company } = useActiveCompany();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const companyId = company?.id;

  const fetchCustomers = useServerFn(listCustomers);
  const fetchAccounts = useServerFn(listAccounts);
  const fetchProducts = useServerFn(listProducts);
  const fetchSettings = useServerFn(getWorkflowSettings);
  const fetchConfig = useServerFn(getSalesDocumentConfig);
  const fetchInvoice = useServerFn(getInvoice);
  const fetchInvoices = useServerFn(listInvoices);
  const saveInvoice = useServerFn(saveInvoiceDraft);
  const saveAndAuthorise = useServerFn(saveAndAuthoriseInvoice);
  const saveQuote = useServerFn(saveQuoteDraft);
  const saveCredit = useServerFn(saveCreditNoteDraft);
  const authoriseCredit = useServerFn(authoriseCreditNote);

  const enabled = Boolean(companyId);
  const customersQ = useQuery({
    queryKey: ["customers", companyId],
    enabled,
    queryFn: () => fetchCustomers({ data: { companyId: companyId! } }),
  });
  const accountsQ = useQuery({
    queryKey: ["accounts", companyId],
    enabled,
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });
  const productsQ = useQuery({
    queryKey: ["products", companyId],
    enabled,
    queryFn: () => fetchProducts({ data: { companyId: companyId!, limit: 200 } }),
  });
  const settingsQ = useQuery({
    queryKey: ["workflow-settings", companyId],
    enabled,
    queryFn: () => fetchSettings({ data: { companyId: companyId! } }),
  });
  const configQ = useQuery({
    queryKey: ["sales-doc-config", companyId],
    enabled,
    queryFn: () => fetchConfig({ data: { companyId: companyId! } }),
  });
  const sourceInvQ = useQuery({
    queryKey: ["sales-invoice", companyId, fromInvoiceId],
    enabled: enabled && kind === "credit_note" && Boolean(fromInvoiceId) && !existing,
    queryFn: () => fetchInvoice({ data: { companyId: companyId!, invoiceId: fromInvoiceId! } }),
  });

  const config = configQ.data;
  const base = config?.baseCurrency ?? company?.base_currency ?? "GBP";
  const today = config?.today ?? new Date().toISOString().slice(0, 10);

  const [savedId, setSavedId] = useState<string | undefined>(existing?.id);
  const [contactId, setContactId] = useState(existing?.contactId ?? initialContactId ?? "");
  const [docDate, setDocDate] = useState(existing?.date ?? "");
  const [secondDate, setSecondDate] = useState(existing?.secondDate ?? "");
  const [number, setNumber] = useState(existing?.number ?? "");
  const [memo, setMemo] = useState(existing?.memo ?? "");
  const [currency, setCurrency] = useState(existing?.currencyCode ?? "");
  const [fxRate, setFxRate] = useState(existing ? String(existing.fxRateToBase) : "");
  const [sourceInvoiceId, setSourceInvoiceId] = useState(
    existing?.sourceInvoiceId ?? fromInvoiceId ?? "",
  );
  const [lines, setLines] = useState<SalesLineFormState[]>(() =>
    existing
      ? existing.lines.map((l) => lineRowToForm(l, existing.currencyCode))
      : [emptySalesLine()],
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [defaultsApplied, setDefaultsApplied] = useState(Boolean(existing));
  const [sourceApplied, setSourceApplied] = useState(Boolean(existing));

  // Defaults (dates in the company's timezone, base currency, terms, notes) once config loads.
  useEffect(() => {
    if (defaultsApplied || !config || !settingsQ.data) return;
    setDocDate(today);
    setCurrency(base);
    if (kind === "invoice") {
      setSecondDate(addDaysIso(today, settingsQ.data.sales_default_payment_terms_days ?? 30));
    } else if (kind === "quote") {
      setSecondDate(addDaysIso(today, 30));
    }
    if (settingsQ.data.sales_default_notes && kind !== "credit_note") {
      setMemo(settingsQ.data.sales_default_notes);
    }
    setDefaultsApplied(true);
  }, [defaultsApplied, config, settingsQ.data, today, base, kind]);

  // "Credit from invoice": copy customer, currency and lines from the source invoice.
  useEffect(() => {
    if (sourceApplied || !sourceInvQ.data) return;
    const inv = sourceInvQ.data;
    setContactId(inv.contact_id);
    setCurrency(inv.currency_code);
    setFxRate(String((inv as { fx_rate_to_base?: number }).fx_rate_to_base ?? 1));
    setMemo(`Credit for invoice ${inv.invoice_number ?? ""}`.trim());
    setLines(
      inv.sales_invoice_lines.map((l) =>
        lineRowToForm(
          {
            description: l.description,
            account_id: l.account_id,
            quantity: l.quantity,
            unit_price_minor: l.unit_price_minor,
            discount_minor: l.discount_minor,
            tax_rate_bps: l.tax_rate_bps,
            tax_code_id: l.tax_code_id ?? null,
            product_id: l.product_id ?? null,
          },
          inv.currency_code,
        ),
      ),
    );
    setSourceApplied(true);
  }, [sourceApplied, sourceInvQ.data]);

  const customers = (customersQ.data ?? []) as Array<{
    id: string;
    name: string;
    payment_terms_days: number | null;
  }>;
  const customerOptions = useMemo(
    () => customers.map((c) => ({ value: c.id, label: c.name })),
    [customers],
  );

  // Credit notes can reference one of the customer's posted invoices.
  const customerInvoicesQ = useQuery({
    queryKey: ["sales-invoices-for-credit", companyId, contactId],
    enabled: enabled && kind === "credit_note" && Boolean(contactId),
    queryFn: () =>
      fetchInvoices({
        data: { companyId: companyId!, contactId, pageSize: 200, sort: "invoice_date" },
      }),
  });
  const creditableInvoices = (
    (customerInvoicesQ.data?.rows ?? []) as Array<{
      id: string;
      invoice_number: string | null;
      status: string;
      currency_code: string;
    }>
  ).filter((i) => !["draft", "void"].includes(i.status));

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

  const treatment = config?.treatment ?? "exclusive";
  const isForeign = currency !== "" && currency !== base;
  const sourceLocked = kind === "credit_note" && Boolean(sourceInvoiceId);

  const onCustomerChange = (id: string) => {
    setContactId(id);
    if (kind === "credit_note") setSourceInvoiceId("");
    if (kind === "invoice") {
      const c = customers.find((x) => x.id === id);
      const terms = c?.payment_terms_days ?? settingsQ.data?.sales_default_payment_terms_days ?? 30;
      setSecondDate(addDaysIso(docDate || today, terms));
    }
  };

  const mutation = useMutation({
    mutationFn: async (alsoAuthorise: boolean) => {
      setFormError(null);
      if (!companyId) throw new Error("No organisation");
      if (!contactId) throw new Error("Choose a customer");
      if (!docDate) throw new Error(`${copy.dateLabel} is required`);
      const fx = isForeign ? Number(fxRate) : 1;
      if (isForeign && !(fx > 0)) throw new Error(`Enter the exchange rate to ${base}`);
      const payloadLines = lines.map((l) => lineFormToInput(l, currency));
      const common = {
        companyId,
        contactId,
        memo,
        currencyCode: currency,
        fxRateToBase: fx,
        lines: payloadLines,
      };

      if (kind === "invoice") {
        if (!secondDate) throw new Error("Due date is required");
        const data = {
          ...common,
          ...(savedId ? { invoiceId: savedId } : {}),
          invoiceDate: docDate,
          dueDate: secondDate,
          invoiceNumber: number,
        };
        if (alsoAuthorise) {
          const r = await saveAndAuthorise({ data });
          return { id: r.id, authoriseError: r.authoriseError, authorised: !r.authoriseError };
        }
        const r = await saveInvoice({ data });
        return { id: r.id, authoriseError: null as string | null, authorised: false };
      }
      if (kind === "quote") {
        const r = await saveQuote({
          data: {
            ...common,
            ...(savedId ? { quoteId: savedId } : {}),
            quoteDate: docDate,
            expiryDate: secondDate,
            quoteNumber: number,
          },
        });
        return { id: r.id, authoriseError: null as string | null, authorised: false };
      }
      const r = await saveCredit({
        data: {
          ...common,
          ...(savedId ? { creditNoteId: savedId } : {}),
          creditDate: docDate,
          creditNumber: number,
          ...(sourceInvoiceId ? { invoiceId: sourceInvoiceId } : {}),
        },
      });
      if (alsoAuthorise) {
        try {
          await authoriseCredit({ data: { companyId, creditNoteId: r.id } });
          return { id: r.id, authoriseError: null as string | null, authorised: true };
        } catch (e) {
          return { id: r.id, authoriseError: friendlyAuthError(e), authorised: false };
        }
      }
      return { id: r.id, authoriseError: null as string | null, authorised: false };
    },
    onSuccess: async (res) => {
      // Keep the id: a retry after an authorise failure updates THIS draft, never creates another.
      setSavedId(res.id);
      await qc.invalidateQueries({ queryKey: [copy.queryKey, companyId] });
      await qc.invalidateQueries({ queryKey: ["sales-invoice", companyId, res.id] });
      if (res.authoriseError) {
        setFormError(`Saved as a draft, but it could not be authorised: ${res.authoriseError}`);
        toast.error("Saved as draft — authorise failed");
        return;
      }
      toast.success(
        res.authorised
          ? `${cap(copy.noun)} authorised and posted`
          : savedId
            ? `${cap(copy.noun)} updated`
            : `Draft ${copy.noun} saved`,
      );
      if (kind === "invoice") {
        navigate({ to: "/sales/invoices/$invoiceId", params: { invoiceId: res.id } });
      } else if (kind === "quote") {
        navigate({ to: "/sales/quotes/$quoteId", params: { quoteId: res.id } });
      } else {
        navigate({ to: "/sales/credit-notes/$creditNoteId", params: { creditNoteId: res.id } });
      }
    },
    onError: (e) => {
      const msg = friendlyAuthError(e);
      setFormError(msg);
      toast.error(msg);
    },
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (
    customersQ.isPending ||
    accountsQ.isPending ||
    configQ.isPending ||
    settingsQ.isPending ||
    (kind === "credit_note" && Boolean(fromInvoiceId) && !existing && sourceInvQ.isPending)
  ) {
    return <LoadingState />;
  }

  const backTo =
    kind === "invoice"
      ? "/sales/invoices"
      : kind === "quote"
        ? "/sales/quotes"
        : "/sales/credit-notes";
  const title = savedId || existing ? copy.editTitle : copy.newTitle;

  return (
    <>
      <PageHeader
        title={title}
        description={
          kind === "credit_note"
            ? "Authorising posts DR revenue / DR output tax / CR accounts receivable. Apply it to invoices afterwards."
            : kind === "invoice"
              ? "Defaults come from Sales settings and the customer’s payment terms. Authorising posts AR + revenue/tax once."
              : "Quotes do not post to the ledger. Convert to an invoice when the customer accepts."
        }
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to={backTo}>Back</Link>
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
            disabled={sourceLocked}
          />
        </div>
        {kind === "credit_note" ? (
          <div className="space-y-2">
            <Label>Credit against invoice (optional)</Label>
            <EntityCombobox
              aria-label="Source invoice"
              options={creditableInvoices.map((i) => ({
                value: i.id,
                label: `${i.invoice_number ?? i.id.slice(0, 8)} (${i.status.replace("_", " ")}, ${i.currency_code})`,
              }))}
              value={sourceInvoiceId}
              onChange={(v) => {
                setSourceInvoiceId(v);
                const inv = creditableInvoices.find((i) => i.id === v);
                if (inv) setCurrency(inv.currency_code);
              }}
              placeholder={contactId ? "None — standalone credit" : "Choose a customer first"}
              disabled={!contactId}
            />
          </div>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label>{copy.dateLabel}</Label>
            <Input
              type="date"
              value={docDate}
              onChange={(e) => {
                setDocDate(e.target.value);
                if (kind === "invoice") {
                  const c = customers.find((x) => x.id === contactId);
                  const terms =
                    c?.payment_terms_days ?? settingsQ.data?.sales_default_payment_terms_days ?? 30;
                  setSecondDate(addDaysIso(e.target.value, terms));
                }
              }}
            />
          </div>
          {copy.secondLabel ? (
            <div className="space-y-2">
              <Label>{copy.secondLabel}</Label>
              <Input
                type="date"
                value={secondDate}
                onChange={(e) => setSecondDate(e.target.value)}
              />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label>{copy.numberLabel}</Label>
            <Input
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="Leave blank to auto-number"
            />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label>Currency</Label>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={currency}
              disabled={sourceLocked}
              onChange={(e) => setCurrency(e.target.value)}
            >
              {currencyOptions(base, currency ? [currency] : []).map((c) => (
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
                Exchange rate (1 {currency} = ? {base})
              </Label>
              <Input
                value={fxRate}
                onChange={(e) => setFxRate(e.target.value)}
                inputMode="decimal"
                placeholder="e.g. 0.79"
              />
            </div>
          ) : null}
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
          currency={currency || base}
          treatment={treatment}
          taxCodes={config?.taxCodes ?? []}
          toMinor={(d) => toMinorUnits(d, currency || base)}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(false)}
          >
            {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            {savedId ? "Save changes" : "Save draft"}
          </Button>
          {copy.authorise ? (
            <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate(true)}>
              {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              {copy.authorise}
            </Button>
          ) : null}
        </div>
      </div>
    </>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
