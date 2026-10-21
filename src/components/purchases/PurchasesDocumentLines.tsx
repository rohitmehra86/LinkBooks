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

type AccountOption = {
  id: string;
  code: string;
  name: string;
  account_type?: string;
};

type TaxCodeOption = {
  id: string;
  code: string;
  name: string;
  rateBps: number;
  appliesTo?: string;
};

type TrackingOption = { id: string; name: string; categoryId: string };
type CustomerOption = { id: string; name: string };

export type LineColumnKey =
  | "item"
  | "description"
  | "quantity"
  | "unitPrice"
  | "discount"
  | "account"
  | "tax"
  | "class"
  | "location"
  | "customer"
  | "project"
  | "billable"
  | "amount";

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
  /** @deprecated Prefer onAddNewItem inside the item dropdown */
  onCreateItem?: () => void;
  onAddNewItem?: () => void;
  onAddNewAccount?: () => void;
  onAddNewTax?: () => void;
  onAddNewClass?: () => void;
  onAddNewLocation?: () => void;
  onAddNewCustomer?: () => void;
  onAddNewProject?: () => void;
  showClass?: boolean;
  showLocation?: boolean;
  showCustomer?: boolean;
  showProject?: boolean;
  showBillable?: boolean;
  showDiscount?: boolean;
  visibleColumns?: LineColumnKey[];
  baseCurrencyEquivalent?: string | null;
};

function accountGroupLabel(type?: string): string {
  switch (type) {
    case "expense":
      return "EXPENSES";
    case "income":
      return "INCOME";
    case "asset":
      return "ASSETS";
    case "liability":
      return "LIABILITIES";
    case "equity":
      return "EQUITY";
    default:
      return "ACCOUNTS";
  }
}

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
  onAddNewItem,
  onAddNewAccount,
  onAddNewTax,
  onAddNewClass,
  onAddNewLocation,
  onAddNewCustomer,
  onAddNewProject,
  showClass = true,
  showLocation = true,
  showCustomer = false,
  showProject = false,
  showBillable = false,
  showDiscount = true,
  visibleColumns,
  baseCurrencyEquivalent,
}: Props) {
  const col = (key: LineColumnKey) => {
    if (visibleColumns) return visibleColumns.includes(key);
    if (key === "class") return showClass;
    if (key === "location") return showLocation;
    if (key === "customer") return showCustomer;
    if (key === "project") return showProject;
    if (key === "billable") return showBillable;
    if (key === "discount") return showDiscount;
    return true;
  };

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
    group: accountGroupLabel(a.account_type),
  }));
  const customerOptions: EntityOption[] = customers.map((c) => ({
    value: c.id,
    label: c.name,
  }));
  const addItem = onAddNewItem ?? onCreateItem;

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
          <Select
            onValueChange={(v) => {
              if (v === "1") onChange([...lines, emptyPurchaseLine()]);
              else if (v === "dup") {
                const last = lines[lines.length - 1] ?? emptyPurchaseLine();
                onChange([...lines, { ...last }]);
              } else addMultiple(Number(v));
            }}
          >
            <SelectTrigger className="h-8 w-[140px]" aria-label="Add lines">
              <SelectValue placeholder="Add lines" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Add 1</SelectItem>
              <SelectItem value="5">Add 5</SelectItem>
              <SelectItem value="10">Add 10</SelectItem>
              <SelectItem value="15">Add 15</SelectItem>
              <SelectItem value="20">Add 20</SelectItem>
              <SelectItem value="dup">Duplicate selected line</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[1100px] border-collapse text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="p-2 w-8" scope="col">
                <span className="sr-only">Reorder</span>
              </th>
              {col("item") ? (
                <th className="p-2" scope="col">
                  Item / service
                </th>
              ) : null}
              {col("description") ? (
                <th className="p-2" scope="col">
                  Description
                </th>
              ) : null}
              {col("quantity") ? (
                <th className="p-2 w-20" scope="col">
                  Qty
                </th>
              ) : null}
              {col("unitPrice") ? (
                <th className="p-2 w-24" scope="col">
                  Unit price
                </th>
              ) : null}
              {col("discount") ? (
                <th className="p-2 w-24" scope="col">
                  Discount
                </th>
              ) : null}
              {col("account") ? (
                <th className="p-2" scope="col">
                  Expense / asset account
                </th>
              ) : null}
              {col("tax") ? (
                <th className="p-2" scope="col">
                  Tax rate
                </th>
              ) : null}
              {col("class") ? (
                <th className="p-2" scope="col">
                  Class
                </th>
              ) : null}
              {col("location") ? (
                <th className="p-2" scope="col">
                  Location
                </th>
              ) : null}
              {col("customer") || col("project") ? (
                <th className="p-2" scope="col">
                  Customer / project
                </th>
              ) : null}
              {col("billable") ? (
                <th className="p-2 w-16" scope="col">
                  Billable
                </th>
              ) : null}
              {col("amount") ? (
                <th className="p-2 w-24 text-right" scope="col">
                  Amount
                </th>
              ) : null}
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
                  {col("item") ? (
                    <td className="p-1 min-w-[140px]">
                      <EntityCombobox
                        aria-label={`Line ${idx + 1} product`}
                        options={productOptions}
                        value={line.productId}
                        onChange={(v) => applyProduct(idx, v)}
                        placeholder="Optional"
                        emptyText="No catalogue items"
                        onAddNew={addItem}
                        addNewLabel="+ Add new item or service…"
                      />
                    </td>
                  ) : null}
                  {col("description") ? (
                    <td className="p-1 min-w-[160px]">
                      <Input
                        aria-label={`Line ${idx + 1} description`}
                        value={line.description}
                        onChange={(e) => update(idx, { description: e.target.value })}
                        placeholder="Description"
                        className="h-9"
                      />
                    </td>
                  ) : null}
                  {col("quantity") ? (
                    <td className="p-1">
                      <Input
                        aria-label={`Line ${idx + 1} quantity`}
                        value={line.quantity}
                        onChange={(e) => update(idx, { quantity: e.target.value })}
                        inputMode="decimal"
                        className="h-9"
                      />
                    </td>
                  ) : null}
                  {col("unitPrice") ? (
                    <td className="p-1">
                      <Input
                        aria-label={`Line ${idx + 1} unit price`}
                        value={line.unitPrice}
                        onChange={(e) => update(idx, { unitPrice: e.target.value })}
                        inputMode="decimal"
                        className="h-9"
                      />
                    </td>
                  ) : null}
                  {col("discount") ? (
                    <td className="p-1">
                      <Input
                        aria-label={`Line ${idx + 1} discount`}
                        value={line.discount}
                        onChange={(e) => update(idx, { discount: e.target.value })}
                        inputMode="decimal"
                        className="h-9"
                      />
                    </td>
                  ) : null}
                  {col("account") ? (
                    <td className="p-1 min-w-[160px]">
                      <EntityCombobox
                        aria-label={`Line ${idx + 1} account`}
                        options={accountOptions}
                        value={line.accountId}
                        onChange={(v) => update(idx, { accountId: v })}
                        placeholder="Account"
                        allowClear={false}
                        onAddNew={onAddNewAccount}
                        addNewLabel="+ Add new account…"
                      />
                    </td>
                  ) : null}
                  {col("tax") ? (
                    <td className="p-1 min-w-[130px]">
                      <EntityCombobox
                        aria-label={`Line ${idx + 1} tax rate`}
                        options={
                          taxCalculation === "none"
                            ? [{ value: "__none__", label: "No tax" }]
                            : [
                                {
                                  value: "__bps__",
                                  label: `Manual (${(Number(line.taxRateBps || 0) / 100).toFixed(2)}%)`,
                                },
                                ...purchaseTaxCodes.map((t) => ({
                                  value: t.id,
                                  label: `${t.code} — ${(t.rateBps / 100).toFixed(2)}%`,
                                  keywords: t.name,
                                })),
                              ]
                        }
                        value={
                          taxCalculation === "none"
                            ? "__none__"
                            : line.taxCodeId || "__bps__"
                        }
                        onChange={(v) => {
                          if (v === "__bps__" || v === "__none__") update(idx, { taxCodeId: "" });
                          else applyTaxCode(idx, v);
                        }}
                        placeholder="Tax"
                        allowClear={false}
                        onAddNew={taxCalculation === "none" ? undefined : onAddNewTax}
                        addNewLabel="+ Add new tax rate…"
                      />
                    </td>
                  ) : null}
                  {col("class") ? (
                    <td className="p-1 min-w-[100px]">
                      <EntityCombobox
                        aria-label={`Line ${idx + 1} class`}
                        options={classOptions.map((o) => ({ value: o.id, label: o.name }))}
                        value={line.classOptionId}
                        onChange={(v) => update(idx, { classOptionId: v })}
                        placeholder="Class"
                        onAddNew={onAddNewClass}
                        addNewLabel="+ Add new class…"
                      />
                    </td>
                  ) : null}
                  {col("location") ? (
                    <td className="p-1 min-w-[100px]">
                      <EntityCombobox
                        aria-label={`Line ${idx + 1} location`}
                        options={locationOptions.map((o) => ({ value: o.id, label: o.name }))}
                        value={line.locationOptionId}
                        onChange={(v) => update(idx, { locationOptionId: v })}
                        placeholder="Location"
                        onAddNew={onAddNewLocation}
                        addNewLabel="+ Add new location…"
                      />
                    </td>
                  ) : null}
                  {col("customer") || col("project") ? (
                    <td className="p-1 min-w-[140px] space-y-1">
                      {col("customer") ? (
                        <EntityCombobox
                          aria-label={`Line ${idx + 1} customer`}
                          options={customerOptions}
                          value={line.customerContactId}
                          onChange={(v) => update(idx, { customerContactId: v })}
                          placeholder="Customer"
                          onAddNew={onAddNewCustomer}
                          addNewLabel="+ Add new customer…"
                        />
                      ) : null}
                      {col("project") ? (
                        <EntityCombobox
                          aria-label={`Line ${idx + 1} project`}
                          options={projectOptions.map((o) => ({ value: o.id, label: o.name }))}
                          value={line.projectOptionId}
                          onChange={(v) => update(idx, { projectOptionId: v })}
                          placeholder="Project"
                          onAddNew={onAddNewProject}
                          addNewLabel="+ Add new project…"
                        />
                      ) : null}
                    </td>
                  ) : null}
                  {col("billable") ? (
                    <td className="p-2">
                      <Checkbox
                        checked={line.isBillable}
                        onCheckedChange={(c) => update(idx, { isBillable: Boolean(c) })}
                        aria-label={`Line ${idx + 1} billable`}
                      />
                    </td>
                  ) : null}
                  {col("amount") ? (
                    <td className="p-2 text-right tabular-nums whitespace-nowrap">{lineAmount}</td>
                  ) : null}
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
