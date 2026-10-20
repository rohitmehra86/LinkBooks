"use client";

import { Trash2, ChevronUp, ChevronDown, GripVertical } from "lucide-react";
import { fromMinorUnits } from "@/lib/accounting/money";
import { computeBillTotals, type TaxCalculationMode } from "@/lib/purchases/bill-form-helpers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { EntityCombobox, type EntityOption } from "@/components/common/EntityCombobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type PurchaseLineFormState = {
  productId: string;
  description: string;
  accountId: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  taxRateBps: string;
  taxCodeId: string;
  classOptionId: string;
  locationOptionId: string;
  projectOptionId: string;
  customerContactId: string;
  isBillable: boolean;
};

export const emptyPurchaseLine = (): PurchaseLineFormState => ({
  productId: "",
  description: "",
  accountId: "",
  quantity: "1",
  unitPrice: "0.00",
  discount: "0",
  taxRateBps: "0",
  taxCodeId: "",
  classOptionId: "",
  locationOptionId: "",
  projectOptionId: "",
  customerContactId: "",
  isBillable: false,
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

type TaxCodeOption = {
  id: string;
  code: string;
  name: string;
  rateBps: number;
  appliesTo?: string;
};

type TrackingOption = { id: string; name: string; categoryId: string };
type CustomerOption = { id: string; name: string };

type Props = {
  lines: PurchaseLineFormState[];
  onChange: (lines: PurchaseLineFormState[]) => void;
  products: ProductOption[];
  accounts: AccountOption[];
  taxCodes?: TaxCodeOption[];
  classOptions?: TrackingOption[];
  locationOptions?: TrackingOption[];
  projectOptions?: TrackingOption[];
  customers?: CustomerOption[];
  currency: string;
  taxCalculation: TaxCalculationMode;
  toMinor: (display: string) => bigint | number;
  onCreateItem?: () => void;
  baseCurrencyEquivalent?: string | null;
};

export function PurchasesDocumentLines({
  lines,
  onChange,
  products,
  accounts,
  taxCodes = [],
  classOptions = [],
  locationOptions = [],
  projectOptions = [],
  customers = [],
  currency,
  taxCalculation,
  toMinor,
  onCreateItem,
  baseCurrencyEquivalent,
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
  const customerOptions: EntityOption[] = customers.map((c) => ({
    value: c.id,
    label: c.name,
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
    const cur = lines[idx]!;
    // Apply catalogue defaults only for empty / default fields — preserve manual overrides.
    update(idx, {
      productId,
      description: cur.description.trim() ? cur.description : p.description?.trim() || p.name,
      accountId: cur.accountId || p.expense_account_id || "",
      unitPrice:
        cur.unitPrice && cur.unitPrice !== "0.00"
          ? cur.unitPrice
          : fromMinorUnits(p.purchase_cost_minor, currency),
      taxRateBps:
        cur.taxRateBps && cur.taxRateBps !== "0"
          ? cur.taxRateBps
          : String(p.purchase_tax_rate_bps ?? 0),
    });
  };

  const applyTaxCode = (idx: number, taxCodeId: string) => {
    if (!taxCodeId) {
      update(idx, { taxCodeId: "" });
      return;
    }
    const code = taxCodes.find((t) => t.id === taxCodeId);
    update(idx, {
      taxCodeId,
      taxRateBps: code ? String(code.rateBps) : lines[idx]!.taxRateBps,
    });
  };

  const moveLine = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= lines.length) return;
    const next = [...lines];
    const tmp = next[idx]!;
    next[idx] = next[j]!;
    next[j] = tmp;
    onChange(next);
  };

  const addMultiple = (n: number) => {
    onChange([...lines, ...Array.from({ length: n }, () => emptyPurchaseLine())]);
  };

  const onDragStart = (e: React.DragEvent, idx: number) => {
    e.dataTransfer.setData("text/plain", String(idx));
    e.dataTransfer.effectAllowed = "move";
  };
  const onDrop = (e: React.DragEvent, toIdx: number) => {
    e.preventDefault();
    const fromIdx = Number(e.dataTransfer.getData("text/plain"));
    if (!Number.isInteger(fromIdx) || fromIdx === toIdx || fromIdx < 0 || fromIdx >= lines.length) {
      return;
    }
    const next = [...lines];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved!);
    onChange(next);
  };

  const preview = (() => {
    try {
      return computeBillTotals(
        lines.map((l) => ({
          quantity: Number(l.quantity),
          unitPriceMinor: Number(toMinor(l.unitPrice || "0")),
          discountMinor: Number(toMinor(l.discount || "0")),
          taxRateBps: Number(l.taxRateBps || 0),
        })),
        taxCalculation,
      );
    } catch {
      return null;
    }
  })();

  const purchaseTaxCodes = taxCodes.filter(
    (t) => !t.appliesTo || t.appliesTo === "purchases" || t.appliesTo === "both",
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <Label>Line items</Label>
        <div className="flex flex-wrap gap-1">
          <Button type="button" variant="outline" size="sm" onClick={() => onChange([...lines, emptyPurchaseLine()])}>
            Add line
          </Button>
          {[5, 10, 15, 20].map((n) => (
            <Button key={n} type="button" variant="ghost" size="sm" onClick={() => addMultiple(n)}>
              +{n}
            </Button>
          ))}
          {onCreateItem ? (
            <Button type="button" variant="secondary" size="sm" onClick={onCreateItem}>
              Create item / service
            </Button>
          ) : null}
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[1100px] border-collapse text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="p-2 w-8" scope="col">
                <span className="sr-only">Reorder</span>
              </th>
              <th className="p-2" scope="col">
                Item / service
              </th>
              <th className="p-2" scope="col">
                Description
              </th>
              <th className="p-2 w-20" scope="col">
                Qty
              </th>
              <th className="p-2 w-24" scope="col">
                Unit price
              </th>
              <th className="p-2 w-24" scope="col">
                Discount
              </th>
              <th className="p-2" scope="col">
                Expense / asset account
              </th>
              <th className="p-2" scope="col">
                Tax rate
              </th>
              <th className="p-2" scope="col">
                Class
              </th>
              <th className="p-2" scope="col">
                Location
              </th>
              <th className="p-2" scope="col">
                Customer / project
              </th>
              <th className="p-2 w-16" scope="col">
                Billable
              </th>
              <th className="p-2 w-24 text-right" scope="col">
                Amount
              </th>
              <th className="p-2 w-20" scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, idx) => {
              let lineAmount = "—";
              try {
                const c = computeBillTotals(
                  [
                    {
                      quantity: Number(line.quantity),
                      unitPriceMinor: Number(toMinor(line.unitPrice || "0")),
                      discountMinor: Number(toMinor(line.discount || "0")),
                      taxRateBps: Number(line.taxRateBps || 0),
                    },
                  ],
                  taxCalculation,
                );
                lineAmount = fromMinorUnits(c.total_minor, currency);
              } catch {
                /* invalid row */
              }
              return (
                <tr
                  key={idx}
                  className="border-b align-top"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => onDrop(e, idx)}
                >
                  <td className="p-1">
                    <button
                      type="button"
                      className="cursor-grab p-1 text-muted-foreground"
                      draggable
                      onDragStart={(e) => onDragStart(e, idx)}
                      aria-label={`Drag to reorder line ${idx + 1}`}
                    >
                      <GripVertical className="size-4" />
                    </button>
                  </td>
                  <td className="p-1 min-w-[140px]">
                    <EntityCombobox
                      aria-label={`Line ${idx + 1} product`}
                      options={productOptions}
                      value={line.productId}
                      onChange={(v) => applyProduct(idx, v)}
                      placeholder="Optional"
                      emptyText="No catalogue items"
                    />
                  </td>
                  <td className="p-1 min-w-[160px]">
                    <Input
                      aria-label={`Line ${idx + 1} description`}
                      value={line.description}
                      onChange={(e) => update(idx, { description: e.target.value })}
                      placeholder="Description"
                    />
                  </td>
                  <td className="p-1">
                    <Input
                      aria-label={`Line ${idx + 1} quantity`}
                      value={line.quantity}
                      onChange={(e) => update(idx, { quantity: e.target.value })}
                      inputMode="decimal"
                    />
                  </td>
                  <td className="p-1">
                    <Input
                      aria-label={`Line ${idx + 1} unit price`}
                      value={line.unitPrice}
                      onChange={(e) => update(idx, { unitPrice: e.target.value })}
                      inputMode="decimal"
                    />
                  </td>
                  <td className="p-1">
                    <Input
                      aria-label={`Line ${idx + 1} discount`}
                      value={line.discount}
                      onChange={(e) => update(idx, { discount: e.target.value })}
                      inputMode="decimal"
                    />
                  </td>
                  <td className="p-1 min-w-[160px]">
                    <EntityCombobox
                      aria-label={`Line ${idx + 1} account`}
                      options={accountOptions}
                      value={line.accountId}
                      onChange={(v) => update(idx, { accountId: v })}
                      placeholder="Account"
                      allowClear={false}
                    />
                  </td>
                  <td className="p-1 min-w-[130px]">
                    {purchaseTaxCodes.length > 0 && taxCalculation !== "none" ? (
                      <Select
                        value={line.taxCodeId || "__bps__"}
                        onValueChange={(v) => {
                          if (v === "__bps__") update(idx, { taxCodeId: "" });
                          else applyTaxCode(idx, v);
                        }}
                      >
                        <SelectTrigger aria-label={`Line ${idx + 1} tax rate`}>
                          <SelectValue placeholder="Tax" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__bps__">
                            Manual ({(Number(line.taxRateBps || 0) / 100).toFixed(2)}%)
                          </SelectItem>
                          {purchaseTaxCodes.map((t) => (
                            <SelectItem key={t.id} value={t.id}>
                              {t.code} — {(t.rateBps / 100).toFixed(2)}%
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        aria-label={`Line ${idx + 1} tax bps`}
                        value={taxCalculation === "none" ? "0" : line.taxRateBps}
                        disabled={taxCalculation === "none"}
                        onChange={(e) => update(idx, { taxRateBps: e.target.value })}
                        inputMode="numeric"
                        title="Basis points — 2000 = 20%"
                      />
                    )}
                  </td>
                  <td className="p-1 min-w-[100px]">
                    <Select
                      value={line.classOptionId || "__none__"}
                      onValueChange={(v) => update(idx, { classOptionId: v === "__none__" ? "" : v })}
                    >
                      <SelectTrigger aria-label={`Line ${idx + 1} class`}>
                        <SelectValue placeholder="—" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">—</SelectItem>
                        {classOptions.map((o) => (
                          <SelectItem key={o.id} value={o.id}>
                            {o.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="p-1 min-w-[100px]">
                    <Select
                      value={line.locationOptionId || "__none__"}
                      onValueChange={(v) =>
                        update(idx, { locationOptionId: v === "__none__" ? "" : v })
                      }
                    >
                      <SelectTrigger aria-label={`Line ${idx + 1} location`}>
                        <SelectValue placeholder="—" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">—</SelectItem>
                        {locationOptions.map((o) => (
                          <SelectItem key={o.id} value={o.id}>
                            {o.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="p-1 min-w-[140px] space-y-1">
                    <EntityCombobox
                      aria-label={`Line ${idx + 1} customer`}
                      options={customerOptions}
                      value={line.customerContactId}
                      onChange={(v) => update(idx, { customerContactId: v })}
                      placeholder="Customer"
                    />
                    <Select
                      value={line.projectOptionId || "__none__"}
                      onValueChange={(v) =>
                        update(idx, { projectOptionId: v === "__none__" ? "" : v })
                      }
                    >
                      <SelectTrigger aria-label={`Line ${idx + 1} project`}>
                        <SelectValue placeholder="Project" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">—</SelectItem>
                        {projectOptions.map((o) => (
                          <SelectItem key={o.id} value={o.id}>
                            {o.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="p-2">
                    <Checkbox
                      checked={line.isBillable}
                      onCheckedChange={(c) => update(idx, { isBillable: Boolean(c) })}
                      aria-label={`Line ${idx + 1} billable`}
                    />
                  </td>
                  <td className="p-2 text-right tabular-nums whitespace-nowrap">{lineAmount}</td>
                  <td className="p-1">
                    <div className="flex items-center gap-0.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        disabled={idx === 0}
                        onClick={() => moveLine(idx, -1)}
                        aria-label={`Move line ${idx + 1} up`}
                      >
                        <ChevronUp className="size-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        disabled={idx >= lines.length - 1}
                        onClick={() => moveLine(idx, 1)}
                        aria-label={`Move line ${idx + 1} down`}
                      >
                        <ChevronDown className="size-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 text-destructive"
                        disabled={lines.length <= 1}
                        onClick={() => onChange(lines.filter((_, i) => i !== idx))}
                        aria-label={`Delete line ${idx + 1}`}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {preview ? (
        <div className="flex flex-wrap justify-end gap-x-6 gap-y-1 text-sm">
          <span>
            Subtotal{" "}
            <strong className="tabular-nums">{fromMinorUnits(preview.subtotal_minor, currency)}</strong>
          </span>
          <span>
            Total tax{" "}
            <strong className="tabular-nums">{fromMinorUnits(preview.tax_minor, currency)}</strong>
          </span>
          <span>
            Total{" "}
            <strong className="tabular-nums">{fromMinorUnits(preview.total_minor, currency)}</strong>
          </span>
          {baseCurrencyEquivalent ? (
            <span className="text-muted-foreground">
              Base-currency equivalent <strong className="tabular-nums">{baseCurrencyEquivalent}</strong>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
