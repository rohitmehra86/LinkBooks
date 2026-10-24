"use client";

import { fromMinorUnits } from "@/lib/accounting/money";
import { computeTaxLineRounded } from "@/lib/sales/line-math-rounded";
import type { TaxTreatment } from "@/lib/sales/line-helpers";
import type { SalesTaxCode } from "@/lib/sales/tax-codes";
import { bpsToPercentString, percentStringToBps } from "@/components/sales/sales-form-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EntityCombobox, type EntityOption } from "@/components/common/EntityCombobox";
import {
  AccountCreateForm,
  ProductCreateForm,
  TaxCodeCreateForm,
} from "@/components/lookup/create-forms";
import { useCan } from "@/hooks/use-can";

export type SalesLineFormState = {
  productId: string;
  description: string;
  accountId: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  taxRateBps: string;
  /** tax_codes.id; when set the server derives the rate from the code. */
  taxCodeId: string;
};

export const emptySalesLine = (): SalesLineFormState => ({
  productId: "",
  description: "",
  accountId: "",
  quantity: "1",
  unitPrice: "0.00",
  discount: "0",
  taxRateBps: "0",
  taxCodeId: "",
});

type ProductOption = {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  sales_price_minor: number;
  income_account_id: string | null;
  sales_tax_rate_bps: number;
};

type AccountOption = {
  id: string;
  code: string;
  name: string;
};

type Props = {
  lines: SalesLineFormState[];
  onChange: (lines: SalesLineFormState[]) => void;
  products: ProductOption[];
  accounts: AccountOption[];
  currency: string;
  treatment?: TaxTreatment;
  taxCodes?: SalesTaxCode[];
  toMinor: (display: string) => bigint | number;
  disabled?: boolean;
  companyId?: string;
  /** Organisation base currency, used when creating an account from the line. */
  baseCurrency?: string;
};

const NO_CODE = "__custom__";

export function SalesDocumentLines({
  lines,
  onChange,
  products,
  accounts,
  currency,
  treatment = "exclusive",
  taxCodes = [],
  toMinor,
  disabled = false,
  companyId,
  baseCurrency,
}: Props) {
  const { can } = useCan();
  const canProduct = Boolean(companyId) && can("products.manage") && !disabled;
  const canAccount = Boolean(companyId) && can("accounts.manage") && !disabled;
  const canTax = Boolean(companyId) && can("tax.settings") && !disabled;
  const productOptions: EntityOption[] = products.map((p) => ({
    value: p.id,
    label: p.code ? `${p.code} — ${p.name}` : p.name,
    description: fromMinorUnits(p.sales_price_minor, currency),
    keywords: `${p.code ?? ""} ${p.description ?? ""}`,
  }));

  const accountOptions: EntityOption[] = accounts.map((a) => ({
    value: a.id,
    label: `${a.code} — ${a.name}`,
    keywords: a.name,
  }));

  const taxOptions: EntityOption[] = [
    { value: NO_CODE, label: "No tax code (custom rate)" },
    ...taxCodes.map((c) => ({
      value: c.id,
      label: `${c.code} — ${c.name} (${bpsToPercentString(c.rate_bps)}%)`,
      keywords: `${c.code} ${c.name}`,
    })),
  ];
  const codeById = new Map(taxCodes.map((c) => [c.id, c]));

  const update = (idx: number, patch: Partial<SalesLineFormState>) => {
    const next = [...lines];
    next[idx] = { ...lines[idx]!, ...patch };
    onChange(next);
  };

  const applyProduct = (idx: number, productId: string) => {
    if (!productId) {
      update(idx, { productId: "" });
      return;
    }
    const p = products.find((x) => x.id === productId);
    if (!p) {
      update(idx, { productId });
      return;
    }
    update(idx, {
      productId,
      description: p.description?.trim() || p.name,
      accountId: p.income_account_id ?? lines[idx]?.accountId ?? "",
      unitPrice: fromMinorUnits(p.sales_price_minor, currency),
      taxRateBps: String(p.sales_tax_rate_bps ?? 0),
      taxCodeId: "",
    });
  };

  const effectiveBps = (l: SalesLineFormState): number => {
    const code = l.taxCodeId ? codeById.get(l.taxCodeId) : undefined;
    return code ? code.rate_bps : Number(l.taxRateBps || 0);
  };

  const preview = (() => {
    try {
      const computed = lines.map((l) =>
        computeTaxLineRounded({
          quantity: Number(l.quantity),
          unit_price_minor: Number(toMinor(l.unitPrice || "0")),
          discount_minor: Number(toMinor(l.discount || "0")),
          tax_rate_bps: effectiveBps(l),
          treatment,
        }),
      );
      return {
        subtotal: computed.reduce((s, c) => s + Number(c.net_minor), 0),
        tax: computed.reduce((s, c) => s + Number(c.tax_minor), 0),
        total: computed.reduce((s, c) => s + Number(c.gross_minor), 0),
      };
    } catch {
      return null;
    }
  })();

  return (
    <div className="space-y-3">
      <Label>Lines</Label>
      {lines.map((line, idx) => {
        const code = line.taxCodeId ? codeById.get(line.taxCodeId) : undefined;
        return (
          <div key={idx} className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-12">
            <div className="sm:col-span-4 space-y-1">
              <span className="text-xs text-muted-foreground">Product / service</span>
              <EntityCombobox
                aria-label={`Line ${idx + 1} product`}
                options={productOptions}
                value={line.productId}
                onChange={(v) => applyProduct(idx, v)}
                placeholder="Optional catalogue item"
                emptyText="No products — enter a free-text line"
                disabled={disabled}
                companyId={companyId}
                canAddNew={canProduct}
                createTitle="New product or service"
                renderCreate={
                  canProduct
                    ? (ctx) => (
                        <ProductCreateForm companyId={companyId!} currency={currency} ctx={ctx} />
                      )
                    : undefined
                }
                onCreated={(option) =>
                  update(idx, {
                    productId: option.id,
                    description: option.description || option.name || option.label,
                    unitPrice: option.meta || line.unitPrice,
                  })
                }
              />
            </div>
            <div className="sm:col-span-8 space-y-1">
              <span className="text-xs text-muted-foreground">Description</span>
              <Input
                placeholder="Description"
                value={line.description}
                disabled={disabled}
                onChange={(e) => update(idx, { description: e.target.value })}
              />
            </div>
            <div className="sm:col-span-4 space-y-1">
              <span className="text-xs text-muted-foreground">Revenue account</span>
              <EntityCombobox
                aria-label={`Line ${idx + 1} account`}
                options={accountOptions}
                value={line.accountId}
                onChange={(v) => update(idx, { accountId: v })}
                placeholder="Account"
                allowClear={false}
                disabled={disabled}
                companyId={companyId}
                canAddNew={canAccount}
                createTitle="New account"
                renderCreate={
                  canAccount
                    ? (ctx) => (
                        <AccountCreateForm
                          companyId={companyId!}
                          currency={baseCurrency || currency}
                          initialKind="revenue"
                          ctx={ctx}
                        />
                      )
                    : undefined
                }
              />
            </div>
            <div className="sm:col-span-2 space-y-1">
              <span className="text-xs text-muted-foreground">Qty</span>
              <Input
                value={line.quantity}
                disabled={disabled}
                onChange={(e) => update(idx, { quantity: e.target.value })}
                inputMode="decimal"
              />
            </div>
            <div className="sm:col-span-2 space-y-1">
              <span className="text-xs text-muted-foreground">Price</span>
              <Input
                value={line.unitPrice}
                disabled={disabled}
                onChange={(e) => update(idx, { unitPrice: e.target.value })}
                inputMode="decimal"
              />
            </div>
            <div className="sm:col-span-2 space-y-1">
              <span className="text-xs text-muted-foreground">Discount (amount)</span>
              <Input
                value={line.discount}
                disabled={disabled}
                onChange={(e) => update(idx, { discount: e.target.value })}
                inputMode="decimal"
              />
            </div>
            <div className="sm:col-span-6 space-y-1">
              <span className="text-xs text-muted-foreground">Tax</span>
              <EntityCombobox
                aria-label={`Line ${idx + 1} tax code`}
                options={taxOptions}
                value={line.taxCodeId || NO_CODE}
                onChange={(v) => {
                  if (!v || v === NO_CODE) update(idx, { taxCodeId: "" });
                  else {
                    const c = codeById.get(v);
                    update(idx, { taxCodeId: v, taxRateBps: String(c?.rate_bps ?? 0) });
                  }
                }}
                placeholder="Tax code"
                allowClear={false}
                disabled={disabled}
                companyId={companyId}
                canAddNew={canTax}
                createTitle="New tax code"
                renderCreate={
                  canTax
                    ? (ctx) => (
                        <TaxCodeCreateForm companyId={companyId!} appliesTo="sales" ctx={ctx} />
                      )
                    : undefined
                }
                onCreated={(option) =>
                  update(idx, { taxCodeId: option.id, taxRateBps: option.meta ?? "0" })
                }
              />
            </div>
            <div className="sm:col-span-2 space-y-1">
              <span className="text-xs text-muted-foreground">Rate %</span>
              <Input
                value={
                  code ? bpsToPercentString(code.rate_bps) : bpsToPercentString(line.taxRateBps)
                }
                disabled={disabled || Boolean(code)}
                onChange={(e) =>
                  update(idx, { taxRateBps: String(percentStringToBps(e.target.value)) })
                }
                inputMode="decimal"
                title={code ? "Rate comes from the tax code" : "Custom rate in percent, e.g. 20"}
              />
            </div>
            <div className="sm:col-span-4 flex items-end justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled || lines.length <= 1}
                onClick={() => onChange(lines.filter((_, i) => i !== idx))}
              >
                Remove
              </Button>
            </div>
          </div>
        );
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => onChange([...lines, emptySalesLine()])}
      >
        Add line
      </Button>
      {preview ? (
        <p className="text-sm text-muted-foreground">
          Subtotal {currency} {fromMinorUnits(preview.subtotal, currency)} · Tax {currency}{" "}
          {fromMinorUnits(preview.tax, currency)} · Total {currency}{" "}
          {fromMinorUnits(preview.total, currency)}
          {treatment === "inclusive" ? " (prices include tax)" : " (prices exclude tax)"}
        </p>
      ) : null}
    </div>
  );
}
