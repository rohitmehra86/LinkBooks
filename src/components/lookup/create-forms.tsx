"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { AccountForm } from "@/components/accounting/AccountForm";
import { LookupSelect } from "@/components/lookup/LookupSelect";
import type { LookupCreateContext } from "@/components/lookup/LookupSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AccountKind } from "@/lib/accounting/account-kinds";
import { toMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { upsertContact } from "@/lib/contacts/contacts.functions";
import { upsertProduct } from "@/lib/products/products.functions";
import { listTaxRates, saveTaxCode } from "@/lib/tax/tax.functions";
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
  kind: "customer" | "supplier";
  ctx: LookupCreateContext;
}) {
  const qc = useQueryClient();
  const save = useServerFn(upsertContact);
  const [name, setName] = useState(ctx.initialQuery);
  const [email, setEmail] = useState("");
  const [terms, setTerms] = useState("30");
  const [pending, setPending] = useState(false);
  const noun = kind === "customer" ? "Customer" : "Supplier";

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
        group: kind === "customer" ? "Customers" : "Suppliers",
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
  return (
    <AccountForm
      companyId={companyId}
      currency={currency}
      {...(initialKind ? { initialKind } : {})}
      {...(ctx.initialQuery ? { initialName: ctx.initialQuery } : {})}
      onCancel={ctx.close}
      onSaved={(another, saved) => {
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
  appliesTo: "sales" | "purchases";
  ctx: LookupCreateContext;
}) {
  const qc = useQueryClient();
  const fetchRates = useServerFn(listTaxRates);
  const save = useServerFn(saveTaxCode);
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
  const [pending, setPending] = useState(false);

  const onSave = async () => {
    if (!rateId) {
      toast.error("Choose a tax rate");
      return;
    }
    const rate = rates.find((row) => row.id === rateId);
    setPending(true);
    try {
      const result = await save({
        data: {
          companyId,
          code,
          name,
          taxRateId: rateId,
          appliesTo,
          isRecoverable: appliesTo !== "sales",
          isActive: true,
        },
      });
      await qc.invalidateQueries({ queryKey: ["tax-codes", companyId] });
      await qc.invalidateQueries({ queryKey: ["sales-doc-config", companyId] });
      await qc.invalidateQueries({ queryKey: ["bank-coding-options", companyId] });
      toast.success("Tax code created");
      const percent = ((rate?.rate_bps ?? 0) / 100).toFixed(2).replace(/\.00$/, "");
      ctx.complete({
        id: result.id,
        label: `${code.trim().toUpperCase()} — ${name.trim()} (${percent}%)`,
        code: code.trim().toUpperCase(),
        name: name.trim(),
        meta: String(rate?.rate_bps ?? 0),
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
          emptyText="No tax rates yet. Add one in Tax settings first."
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
