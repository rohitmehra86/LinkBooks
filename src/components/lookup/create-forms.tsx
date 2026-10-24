"use client";

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { AccountForm } from "@/components/accounting/AccountForm";
import { AccountLookup } from "@/components/lookup/variants";
import { LookupSelect } from "@/components/lookup/LookupSelect";
import type { LookupCreateContext } from "@/components/lookup/LookupSelect";
import {
  DocumentRecordPanel,
  type DocumentRecordHandle,
} from "@/components/documents/DocumentRecordPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AccountKind } from "@/lib/accounting/account-kinds";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import { toMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { createBankAccount } from "@/lib/banking/banking.functions";
import { upsertContact } from "@/lib/contacts/contacts.functions";
import { createProject } from "@/lib/create-new/money-documents.functions";
import type { AccountLookupRecord } from "@/lib/lookup/eligibility";
import { upsertProduct } from "@/lib/products/products.functions";
import { listTaxRates, saveTaxCode, saveTaxRate } from "@/lib/tax/tax.functions";
import type { LookupOption } from "@/lib/lookup/types";

function Actions({
  pending,
  saveLabel,
  onSave,
  onCancel,
}: {
  pending: boolean;
  saveLabel: string;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 pt-2">
      <Button type="button" size="sm" disabled={pending} onClick={onSave}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        {saveLabel}
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

async function refreshContactLists(qc: ReturnType<typeof useQueryClient>, companyId: string) {
  await qc.invalidateQueries({ queryKey: ["customers", companyId] });
  await qc.invalidateQueries({ queryKey: ["suppliers", companyId] });
  await qc.invalidateQueries({ queryKey: ["contacts", companyId] });
  await qc.invalidateQueries({ queryKey: ["bank-coding-options", companyId] });
}

export function ContactCreateForm({
  companyId,
  kind,
  ctx,
}: {
  companyId: string;
  kind: "customer" | "supplier" | "both";
  ctx: LookupCreateContext;
}) {
  const qc = useQueryClient();
  const save = useServerFn(upsertContact);
  const [name, setName] = useState(ctx.initialQuery);
  const [email, setEmail] = useState("");
  const [terms, setTerms] = useState("30");
  const [pending, setPending] = useState(false);
  const noun = kind === "customer" ? "Customer" : kind === "supplier" ? "Supplier" : "Contact";
  const group =
    kind === "customer" ? "Customers" : kind === "supplier" ? "Suppliers" : "Customers & suppliers";

  const onSave = async () => {
    const termsDays = terms.trim() === "" ? 30 : Number(terms);
    if (!Number.isInteger(termsDays) || termsDays < 0 || termsDays > 3650) {
      toast.error("Payment terms must be a whole number of days");
      return;
    }
    setPending(true);
    try {
      const result = await save({
        data: { companyId, name, kind, email, paymentTermsDays: termsDays },
      });
      await refreshContactLists(qc, companyId);
      toast.success(`${noun} created`);
      const option: LookupOption = {
        id: result.id,
        label: name.trim(),
        name: name.trim(),
        group,
        meta: String(termsDays),
      };
      ctx.complete(option);
    } catch (error) {
      toast.error(friendlyAuthError(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="grid gap-3">
      <div className="space-y-1.5">
        <Label>Name</Label>
        <Input value={name} autoFocus onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label>Email</Label>
        <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label>Payment terms (days)</Label>
        <Input
          inputMode="numeric"
          value={terms}
          onChange={(event) => setTerms(event.target.value)}
        />
      </div>
      <Actions
        pending={pending}
        saveLabel="Create and select"
        onSave={() => void onSave()}
        onCancel={ctx.close}
      />
    </div>
  );
}

export function ProductCreateForm({
  companyId,
  currency,
  ctx,
  priceRole = "sales",
}: {
  companyId: string;
  currency: string;
  ctx: LookupCreateContext;
  priceRole?: "sales" | "purchase";
}) {
  const qc = useQueryClient();
  const save = useServerFn(upsertProduct);
  const [kind, setKind] = useState("service");
  const [name, setName] = useState(ctx.initialQuery);
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [salesPrice, setSalesPrice] = useState("0.00");
  const [pending, setPending] = useState(false);
  const recordRef = useRef<DocumentRecordHandle>(null);

  const onSave = async () => {
    let salesPriceMinor = 0;
    try {
      salesPriceMinor = Number(toMinorUnits(salesPrice || "0", currency));
    } catch (error) {
      toast.error(friendlyAuthError(error));
      return;
    }
    if (!Number.isSafeInteger(salesPriceMinor)) {
      toast.error("Sales price is too large");
      return;
    }
    setPending(true);
    try {
      const result = await save({
        data: {
          companyId,
          kind,
          name,
          code,
          description,
          ...(priceRole === "purchase"
            ? { purchaseCostMinor: salesPriceMinor }
            : { salesPriceMinor }),
        },
      });
      await recordRef.current?.flush(result.id);
      await qc.invalidateQueries({ queryKey: ["products", companyId] });
      toast.success("Item created");
      const label = code.trim() ? `${code.trim()} — ${name.trim()}` : name.trim();
      ctx.complete({
        id: result.id,
        label,
        code: code.trim() || null,
        name: name.trim(),
        description: description.trim() || name.trim(),
        meta: salesPrice.trim() || "0.00",
      });
    } catch (error) {
      toast.error(friendlyAuthError(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="grid gap-3">
      <div className="space-y-1.5">
        <Label>Kind</Label>
        <select
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={kind}
          onChange={(event) => setKind(event.target.value)}
        >
          <option value="service">Service</option>
          <option value="product">Product (non-stock)</option>
          <option value="non_inventory">Non-inventory</option>
        </select>
      </div>
      <div className="space-y-1.5">
        <Label>Name</Label>
        <Input value={name} autoFocus onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label>Code / SKU</Label>
        <Input value={code} onChange={(event) => setCode(event.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label>Description</Label>
        <Input value={description} onChange={(event) => setDescription(event.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label>
          {priceRole === "purchase" ? "Purchase cost" : "Sales price"} ({currency})
        </Label>
        <Input
          inputMode="decimal"
          value={salesPrice}
          onChange={(event) => setSalesPrice(event.target.value)}
        />
      </div>
      <DocumentRecordPanel
        ref={recordRef}
        entityType="product"
        entityId={null}
        audience="internal"
      />
      <Actions
        pending={pending}
        saveLabel="Create and select"
        onSave={() => void onSave()}
        onCancel={ctx.close}
      />
    </div>
  );
}

export function AccountCreateForm({
  companyId,
  currency,
  initialKind,
  ctx,
}: {
  companyId: string;
  currency: string;
  initialKind?: AccountKind;
  ctx: LookupCreateContext;
}) {
  const qc = useQueryClient();
  return (
    <AccountForm
      companyId={companyId}
      currency={currency}
      {...(initialKind ? { initialKind } : {})}
      {...(ctx.initialQuery ? { initialName: ctx.initialQuery } : {})}
      onCancel={ctx.close}
      onSaved={(another, saved) => {
        void qc.invalidateQueries({ queryKey: ["payment-accounts", companyId] });
        void qc.invalidateQueries({ queryKey: ["deposit-accounts", companyId] });
        if (another || !saved) return;
        ctx.complete({
          id: saved.id,
          label: saved.code ? `${saved.code} — ${saved.name}` : saved.name,
          code: saved.code,
          name: saved.name,
        });
      }}
    />
  );
}

export function TaxCodeCreateForm({
  companyId,
  appliesTo,
  ctx,
}: {
  companyId: string;
  appliesTo: "sales" | "purchases" | "both";
  ctx: LookupCreateContext;
}) {
  const qc = useQueryClient();
  const fetchRates = useServerFn(listTaxRates);
  const save = useServerFn(saveTaxCode);
  const saveRate = useServerFn(saveTaxRate);
  const ratesQ = useQuery({
    queryKey: ["tax-rates", companyId],
    queryFn: () => fetchRates({ data: { companyId } }),
  });
  const rates = (
    (ratesQ.data ?? []) as Array<{
      id: string;
      name: string;
      code?: string | null;
      rate_bps: number;
      is_active: boolean;
    }>
  ).filter((rate) => rate.is_active);
  const [code, setCode] = useState("");
  const [name, setName] = useState(ctx.initialQuery);
  const [rateId, setRateId] = useState("");
  const [useNewRate, setUseNewRate] = useState(false);
  const [rateName, setRateName] = useState("");
  const [ratePercent, setRatePercent] = useState("");
  const [pending, setPending] = useState(false);

  const onSave = async () => {
    if (!useNewRate && !rateId) {
      toast.error("Choose a tax rate");
      return;
    }
    const selected = rates.find((row) => row.id === rateId);
    let taxRateId = rateId;
    let rateBps = selected?.rate_bps ?? 0;
    setPending(true);
    try {
      if (useNewRate) {
        const percent = Number(ratePercent);
        if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
          toast.error("Rate must be between 0 and 100");
          setPending(false);
          return;
        }
        rateBps = Math.round(percent * 100);
        const createdRate = await saveRate({
          data: {
            companyId,
            name: rateName.trim() || name.trim() || "Tax rate",
            rateBps,
            effectiveFrom: new Date().toISOString().slice(0, 10),
          },
        });
        taxRateId = createdRate.id;
      }
      const result = await save({
        data: {
          companyId,
          code,
          name,
          taxRateId,
          appliesTo,
          isRecoverable: appliesTo !== "sales",
          isActive: true,
        },
      });
      await qc.invalidateQueries({ queryKey: ["tax-codes", companyId] });
      await qc.invalidateQueries({ queryKey: ["tax-rates", companyId] });
      await qc.invalidateQueries({ queryKey: ["sales-doc-config", companyId] });
      await qc.invalidateQueries({ queryKey: ["bank-coding-options", companyId] });
      toast.success("Tax code created");
      const percent = (rateBps / 100).toFixed(2).replace(/\.00$/, "");
      ctx.complete({
        id: result.id,
        label: `${code.trim().toUpperCase()} — ${name.trim()} (${percent}%)`,
        code: code.trim().toUpperCase(),
        name: name.trim(),
        meta: String(rateBps),
      });
    } catch (error) {
      toast.error(friendlyAuthError(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="grid gap-3">
      <div className="space-y-1.5">
        <Label>Code</Label>
        <Input value={code} autoFocus onChange={(event) => setCode(event.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label>Name</Label>
        <Input value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label>Tax rate</Label>
        <LookupSelect
          ariaLabel="Tax rate"
          options={rates.map((rate) => ({
            id: rate.id,
            label: `${rate.name} (${(rate.rate_bps / 100).toFixed(2).replace(/\.00$/, "")}%)`,
            code: rate.code,
            name: rate.name,
          }))}
          value={rateId}
          onChange={setRateId}
          placeholder="Select tax rate"
          loading={ratesQ.isPending}
          error={ratesQ.isError ? friendlyAuthError(ratesQ.error) : null}
          onRetry={() => void ratesQ.refetch()}
          allowClear={false}
          companyId={companyId}
          emptyText="No tax rates yet. Create one below."
          disabled={useNewRate}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={useNewRate}
          onChange={(event) => setUseNewRate(event.target.checked)}
        />
        Create a new rate
      </label>
      {useNewRate ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Rate name</Label>
            <Input value={rateName} onChange={(event) => setRateName(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Percent</Label>
            <Input
              inputMode="decimal"
              value={ratePercent}
              onChange={(event) => setRatePercent(event.target.value)}
            />
          </div>
        </div>
      ) : null}
      <Actions
        pending={pending}
        saveLabel="Create and select"
        onSave={() => void onSave()}
        onCancel={ctx.close}
      />
    </div>
  );
}

export function TaxRateCreateForm({
  companyId,
  ctx,
}: {
  companyId: string;
  ctx: LookupCreateContext;
}) {
  const qc = useQueryClient();
  const save = useServerFn(saveTaxRate);
  const [name, setName] = useState(ctx.initialQuery);
  const [percent, setPercent] = useState("");
  const [pending, setPending] = useState(false);

  const onSave = async () => {
    const value = Number(percent);
    if (!name.trim()) {
      toast.error("Rate name is required");
      return;
    }
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      toast.error("Rate must be between 0 and 100");
      return;
    }
    const rateBps = Math.round(value * 100);
    setPending(true);
    try {
      const result = await save({
        data: {
          companyId,
          name,
          rateBps,
          effectiveFrom: new Date().toISOString().slice(0, 10),
        },
      });
      await qc.invalidateQueries({ queryKey: ["tax-rates", companyId] });
      await qc.invalidateQueries({ queryKey: ["tax-codes", companyId] });
      toast.success("Tax rate created");
      const label = `${value.toFixed(2).replace(/\.00$/, "")}%`;
      ctx.complete({
        id: result.id,
        name: name.trim(),
        label: `${name.trim()} (${label})`,
        meta: String(rateBps),
      });
    } catch (error) {
      toast.error(friendlyAuthError(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="grid gap-3">
      <div className="space-y-1.5">
        <Label>Name</Label>
        <Input value={name} autoFocus onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label>Percent</Label>
        <Input
          inputMode="decimal"
          value={percent}
          onChange={(event) => setPercent(event.target.value)}
        />
      </div>
      <Actions
        pending={pending}
        saveLabel="Create and select"
        onSave={() => void onSave()}
        onCancel={ctx.close}
      />
    </div>
  );
}

export function BankAccountCreateForm({
  companyId,
  currency,
  ctx,
}: {
  companyId: string;
  currency: string;
  ctx: LookupCreateContext;
}) {
  const qc = useQueryClient();
  const fetchAccounts = useServerFn(listAccounts);
  const save = useServerFn(createBankAccount);
  const accountsQ = useQuery({
    queryKey: ["accounts", companyId],
    queryFn: () => fetchAccounts({ data: { companyId } }),
  });
  const [name, setName] = useState(ctx.initialQuery);
  const [currencyCode, setCurrencyCode] = useState(currency);
  const [glAccountId, setGlAccountId] = useState("");
  const [pending, setPending] = useState(false);

  const onSave = async () => {
    if (!glAccountId) {
      toast.error("Choose the ledger account this bank uses");
      return;
    }
    setPending(true);
    try {
      const result = await save({
        data: { companyId, name, currencyCode, glAccountId },
      });
      await qc.invalidateQueries({ queryKey: ["bank-accounts", companyId] });
      await qc.invalidateQueries({ queryKey: ["bank-account-summaries", companyId] });
      toast.success("Bank account created");
      ctx.complete({
        id: result.id,
        name: name.trim(),
        label: name.trim(),
        meta: currencyCode.trim().toUpperCase(),
        group: currencyCode.trim().toUpperCase(),
      });
    } catch (error) {
      toast.error(friendlyAuthError(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="grid gap-3">
      <div className="space-y-1.5">
        <Label>Name</Label>
        <Input value={name} autoFocus onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label>Currency</Label>
        <Input
          maxLength={3}
          value={currencyCode}
          onChange={(event) => setCurrencyCode(event.target.value.toUpperCase())}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Ledger account</Label>
        <AccountLookup
          ariaLabel="Ledger account"
          accounts={(accountsQ.data ?? []) as AccountLookupRecord[]}
          value={glAccountId}
          onChange={setGlAccountId}
          companyId={companyId}
          purpose="bank"
          createKind="bank"
          placeholder="Bank or cash account"
          loading={accountsQ.isPending}
          error={accountsQ.isError ? friendlyAuthError(accountsQ.error) : null}
          onRetry={() => void accountsQ.refetch()}
          allowClear={false}
        />
      </div>
      <Actions
        pending={pending}
        saveLabel="Create and select"
        onSave={() => void onSave()}
        onCancel={ctx.close}
      />
    </div>
  );
}

export function ProjectCreateForm({
  companyId,
  currency,
  ctx,
}: {
  companyId: string;
  currency: string;
  ctx: LookupCreateContext;
}) {
  const qc = useQueryClient();
  const save = useServerFn(createProject);
  const [code, setCode] = useState("");
  const [name, setName] = useState(ctx.initialQuery);
  const [pending, setPending] = useState(false);

  const onSave = async () => {
    setPending(true);
    try {
      const result = await save({
        data: { companyId, code, name, currencyCode: currency, status: "active" },
      });
      await qc.invalidateQueries({ queryKey: ["project-options", companyId] });
      toast.success("Project created");
      const trimmedCode = code.trim();
      const trimmedName = name.trim();
      ctx.complete({
        id: result.id,
        code: trimmedCode,
        name: trimmedName,
        label: `${trimmedCode} — ${trimmedName}`,
        group: "Projects",
      });
    } catch (error) {
      toast.error(friendlyAuthError(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="grid gap-3">
      <div className="space-y-1.5">
        <Label>Code</Label>
        <Input value={code} autoFocus onChange={(event) => setCode(event.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label>Name</Label>
        <Input value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <Actions
        pending={pending}
        saveLabel="Create and select"
        onSave={() => void onSave()}
        onCancel={ctx.close}
      />
    </div>
  );
}
