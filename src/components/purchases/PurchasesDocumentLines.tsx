"use client";

import { fromMinorUnits } from "@/lib/accounting/money";
import { computeLineAmounts } from "@/lib/purchases/line-math";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EntityCombobox, type EntityOption } from "@/components/common/EntityCombobox";

export type PurchaseLineFormState = {
  productId: string;
  description: string;
  accountId: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  taxRateBps: string;
};

export const emptyPurchaseLine = (): PurchaseLineFormState => ({
  productId: "",
  description: "",
  accountId: "",
  quantity: "1",
  unitPrice: "0.00",
  discount: "0",
  taxRateBps: "0",
});

type ProductOption = {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  purchase_cost_minor: number;
  expense_account_id: string | null;
  purchase_tax_rate_bps: number;
};

type AccountOption = { id: string; code: string; name: string };

type Props = {
  lines: PurchaseLineFormState[];
  onChange: (lines: PurchaseLineFormState[]) => void;
  products: ProductOption[];
  accounts: AccountOption[];
  currency: string;
  toMinor: (display: string) => bigint | number;
};

export function PurchasesDocumentLines({
  lines,
  onChange,
  products,
  accounts,
  currency,
  toMinor,
}: Props) {
  const productOptions: EntityOption[] = products.map((p) => ({
    value: p.id,
    label: p.code ? `${p.code} — ${p.name}` : p.name,
    description: fromMinorUnits(p.purchase_cost_minor, currency),
    keywords: `${p.code ?? ""} ${p.description ?? ""}`,
  }));
  const accountOptions: EntityOption[] = accounts.map((a) => ({
    value: a.id,
    label: `${a.code} — ${a.name}`,
    keywords: a.name,
  }));

  const update = (idx: number, patch: Partial<PurchaseLineFormState>) => {
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
      accountId: p.expense_account_id ?? lines[idx]?.accountId ?? "",
      unitPrice: fromMinorUnits(p.purchase_cost_minor, currency),
      taxRateBps: String(p.purchase_tax_rate_bps ?? 0),
    });
  };

  const preview = (() => {
    try {
      const computed = lines.map((l) =>
        computeLineAmounts({
          quantity: Number(l.quantity),
          unit_price_minor: Number(toMinor(l.unitPrice || "0")),
          discount_minor: Number(toMinor(l.discount || "0")),
          tax_rate_bps: Number(l.taxRateBps || 0),
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
      {lines.map((line, idx) => (
        <div key={idx} className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-12">
          <div className="sm:col-span-4 space-y-1">
            <span className="text-xs text-muted-foreground">Item / service</span>
            <EntityCombobox
              aria-label={`Line ${idx + 1} product`}
              options={productOptions}
              value={line.productId}
              onChange={(v) => applyProduct(idx, v)}
              placeholder="Optional catalogue item"
              emptyText="No products — enter a free-text line"
            />
          </div>
          <div className="sm:col-span-8 space-y-1">
            <span className="text-xs text-muted-foreground">Description</span>
            <Input
              value={line.description}
              onChange={(e) => update(idx, { description: e.target.value })}
              placeholder="Description"
            />
          </div>
          <div className="sm:col-span-4 space-y-1">
            <span className="text-xs text-muted-foreground">Expense / asset account</span>
            <EntityCombobox
              aria-label={`Line ${idx + 1} account`}
              options={accountOptions}
              value={line.accountId}
              onChange={(v) => update(idx, { accountId: v })}
              placeholder="Account"
              allowClear={false}
            />
          </div>
          <div className="sm:col-span-2 space-y-1">
            <span className="text-xs text-muted-foreground">Qty</span>
            <Input
              value={line.quantity}
              onChange={(e) => update(idx, { quantity: e.target.value })}
              inputMode="decimal"
            />
          </div>
          <div className="sm:col-span-2 space-y-1">
            <span className="text-xs text-muted-foreground">Price</span>
            <Input
              value={line.unitPrice}
              onChange={(e) => update(idx, { unitPrice: e.target.value })}
              inputMode="decimal"
            />
          </div>
          <div className="sm:col-span-2 space-y-1">
            <span className="text-xs text-muted-foreground">Discount</span>
            <Input
              value={line.discount}
              onChange={(e) => update(idx, { discount: e.target.value })}
              inputMode="decimal"
            />
          </div>
          <div className="sm:col-span-2 space-y-1">
            <span className="text-xs text-muted-foreground">Tax (bps)</span>
            <Input
              value={line.taxRateBps}
              onChange={(e) => update(idx, { taxRateBps: e.target.value })}
              inputMode="numeric"
              title="Basis points — 2000 = 20%"
            />
          </div>
          <div className="sm:col-span-12 flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={lines.length <= 1}
              onClick={() => onChange(lines.filter((_, i) => i !== idx))}
            >
              Remove
            </Button>
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...lines, emptyPurchaseLine()])}
      >
        Add line
      </Button>
      {preview ? (
        <p className="text-sm text-muted-foreground">
          Subtotal {fromMinorUnits(preview.subtotal, currency)} · Tax{" "}
          {fromMinorUnits(preview.tax, currency)} · Total{" "}
          {fromMinorUnits(preview.total, currency)}
        </p>
      ) : null}
    </div>
  );
}
