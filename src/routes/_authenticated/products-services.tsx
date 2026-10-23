import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Package, Plus, Archive } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { useFormat } from "@/hooks/use-format";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { parseMinorOrThrow, tryParseMinor } from "@/lib/purchases/money-input";
import { listTaxCodes } from "@/lib/tax/tax.functions";
import { useCanDo } from "@/hooks/use-can";
import {
  archiveProduct,
  listProducts,
  upsertProduct,
  type ProductRow,
} from "@/lib/products/products.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, EmptyState, ErrorState, LoadingState } from "@/components/common/states";
import { CompanyEmptyState } from "@/components/common/company-empty";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/products-services")({
  head: () => ({
    meta: [
      { title: "Products & Services — LinkBooks" },
      {
        name: "description",
        content: "Catalogue items with default accounts and tax for invoices and bills.",
      },
    ],
  }),
  component: ProductsPage,
});

export function ProductsPage() {
  const { company, isPending } = useActiveCompany();
  if (isPending) return <LoadingState />;
  if (!company) {
    return (
      <CompanyEmptyState
        title="No organisation selected"
        description="Open a company to manage products and services."
      />
    );
  }
  return <ProductsWorkspace companyId={company.id} currency={company.base_currency} />;
}

function ProductsWorkspace({ companyId, currency }: { companyId: string; currency: string }) {
  const queryClient = useQueryClient();
  const fmt = useFormat();
  const fetchProducts = useServerFn(listProducts);
  const fetchAccounts = useServerFn(listAccounts);
  const saveProduct = useServerFn(upsertProduct);
  const doArchive = useServerFn(archiveProduct);
  const fetchTaxCodes = useServerFn(listTaxCodes);
  const canManage = useCanDo("products.manage");
  const [limit, setLimit] = useState(100);

  const [q, setQ] = useState("");
  const [kind, setKind] = useState("all");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ProductRow | null>(null);

  const [form, setForm] = useState({
    kind: "service",
    code: "",
    name: "",
    description: "",
    salesPrice: "",
    purchaseCost: "",
    incomeAccountId: "",
    expenseAccountId: "",
    salesTaxBps: "2000",
    purchaseTaxBps: "2000",
    unit: "each",
  });

  const productsQ = useQuery({
    queryKey: ["products", companyId, q, kind, includeInactive, limit],
    queryFn: () =>
      fetchProducts({
        data: { companyId, q, kind, includeInactive, limit },
      }),
  });
  const accountsQ = useQuery({
    queryKey: ["accounts", companyId],
    queryFn: () => fetchAccounts({ data: { companyId } }),
  });

  const taxCodesQ = useQuery({
    queryKey: ["tax-codes", companyId],
    queryFn: () => fetchTaxCodes({ data: { companyId } }),
  });
  // Pick a tax code by name; the item stores that code's current rate (basis points).
  const taxChoices = useMemo(() => {
    const rows = (taxCodesQ.data ?? []) as Array<{
      id: string;
      code: string;
      name: string;
      is_active: boolean;
      tax_rates: { rate_bps: number } | { rate_bps: number }[] | null;
    }>;
    const seen = new Set<string>();
    return (
      rows
        .filter((t) => t.is_active)
        .map((t) => {
          const rate = Array.isArray(t.tax_rates) ? t.tax_rates[0] : t.tax_rates;
          const bps = rate?.rate_bps ?? 0;
          return {
            key: String(bps),
            code: t.code,
            name: t.name,
            bps,
            label: `${t.code} — ${t.name} (${(bps / 100).toFixed(2)}%)`,
          };
        })
        // One entry per rate: the item stores the rate, so two codes at 20% are the same choice.
        .filter((c) => (seen.has(c.key) ? false : (seen.add(c.key), true)))
    );
  }, [taxCodesQ.data]);
  const salesPriceInvalid = tryParseMinor(form.salesPrice || "0", currency) === null;
  const purchaseCostInvalid = tryParseMinor(form.purchaseCost || "0", currency) === null;

  const incomeAccounts = useMemo(
    () =>
      (
        (accountsQ.data ?? []) as Array<{
          id: string;
          code: string;
          name: string;
          account_type: string;
        }>
      ).filter((a) => a.account_type === "income"),
    [accountsQ.data],
  );
  const expenseAccounts = useMemo(
    () =>
      (
        (accountsQ.data ?? []) as Array<{
          id: string;
          code: string;
          name: string;
          account_type: string;
        }>
      ).filter((a) => a.account_type === "expense"),
    [accountsQ.data],
  );

  const saveMut = useMutation({
    mutationFn: async () => {
      // Integer minor units via the shared parser - never floats, and the currency's own decimals.
      const salesPriceMinor = Number(
        parseMinorOrThrow(form.salesPrice || "0", currency, "Sales price"),
      );
      const purchaseCostMinor = Number(
        parseMinorOrThrow(form.purchaseCost || "0", currency, "Purchase cost"),
      );
      if (!form.name.trim()) throw new Error("Name is required");
      const data: Parameters<typeof saveProduct>[0]["data"] = {
        companyId,
        kind: form.kind,
        name: form.name,
        salesPriceMinor,
        purchaseCostMinor,
        salesTaxRateBps: Number(form.salesTaxBps) || 0,
        purchaseTaxRateBps: Number(form.purchaseTaxBps) || 0,
        unit: form.unit,
        isActive: true,
      };
      if (editing?.id) data.id = editing.id;
      if (form.code) data.code = form.code;
      if (form.description) data.description = form.description;
      if (form.incomeAccountId) data.incomeAccountId = form.incomeAccountId;
      if (form.expenseAccountId) data.expenseAccountId = form.expenseAccountId;
      return saveProduct({ data });
    },
    onSuccess: async () => {
      toast.success(editing ? "Product updated" : "Product created");
      setOpen(false);
      setEditing(null);
      await queryClient.invalidateQueries({ queryKey: ["products", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  function openCreate() {
    setEditing(null);
    setForm({
      kind: "service",
      code: "",
      name: "",
      description: "",
      salesPrice: "",
      purchaseCost: "",
      incomeAccountId: incomeAccounts[0]?.id ?? "",
      expenseAccountId: expenseAccounts[0]?.id ?? "",
      salesTaxBps: "2000",
      purchaseTaxBps: "2000",
      unit: "each",
    });
    setOpen(true);
  }

  function openEdit(p: ProductRow) {
    setEditing(p);
    setForm({
      kind: p.kind,
      code: p.code ?? "",
      name: p.name,
      description: p.description ?? "",
      salesPrice: fromMinorUnits(BigInt(p.sales_price_minor), currency),
      purchaseCost: fromMinorUnits(BigInt(p.purchase_cost_minor), currency),
      incomeAccountId: p.income_account_id ?? "",
      expenseAccountId: p.expense_account_id ?? "",
      salesTaxBps: String(p.sales_tax_rate_bps),
      purchaseTaxBps: String(p.purchase_tax_rate_bps),
      unit: p.unit,
    });
    setOpen(true);
  }

  const rows = (productsQ.data ?? []) as ProductRow[];

  return (
    <>
      <PageHeader
        title="Products & Services"
        description="Catalogue defaults for sales and purchase lines. Stock valuation is not enabled — this is a non-inventory catalogue."
        actions={
          <Button size="sm" onClick={openCreate} disabled={!canManage}>
            <Plus className="size-4" />
            New item
          </Button>
        }
      />

      <Alert className="mb-4">
        <AlertDescription>
          Selecting an item on invoices/bills can use these defaults. No stock-on-hand or COGS
          inventory engine is claimed.
        </AlertDescription>
      </Alert>

      <div className="mb-4 flex flex-wrap gap-3">
        <Input
          className="max-w-xs"
          placeholder="Search name or code…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All kinds</SelectItem>
            <SelectItem value="service">Services</SelectItem>
            <SelectItem value="product">Products</SelectItem>
            <SelectItem value="non_inventory">Non-inventory</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant={includeInactive ? "secondary" : "outline"}
          size="sm"
          onClick={() => setIncludeInactive((v) => !v)}
        >
          {includeInactive ? "Showing archived" : "Active only"}
        </Button>
      </div>

      {productsQ.isPending ? (
        <LoadingState />
      ) : productsQ.isError ? (
        <ErrorState
          title="Could not load products"
          description={friendlyAuthError(productsQ.error)}
          onRetry={() => productsQ.refetch()}
        />
      ) : rows.length === 0 ? (
        <div className="space-y-3">
          <EmptyState
            icon={Package}
            title="No products yet"
            description="Create services and non-inventory items with default accounts and tax rates."
          />
          <div className="flex justify-center">
            <Button size="sm" onClick={openCreate}>
              <Plus className="size-4" />
              New item
            </Button>
          </div>
        </div>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead className="text-right">Sales price</TableHead>
                  <TableHead className="text-right">Purchase cost</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono text-xs">{p.code ?? "—"}</TableCell>
                    <TableCell>
                      <div className="font-medium">{p.name}</div>
                      {p.description ? (
                        <div className="text-xs text-muted-foreground line-clamp-1">
                          {p.description}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="capitalize">{p.kind.replace("_", " ")}</TableCell>
                    <TableCell className="money">
                      {fmt.money(p.sales_price_minor, currency)}
                    </TableCell>
                    <TableCell className="money">
                      {fmt.money(p.purchase_cost_minor, currency)}
                    </TableCell>
                    <TableCell>
                      {p.is_active ? (
                        <Badge variant="success">Active</Badge>
                      ) : (
                        <Badge variant="neutral">Archived</Badge>
                      )}
                    </TableCell>
                    <TableCell className="space-x-1 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!canManage}
                        onClick={() => openEdit(p)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!canManage}
                        onClick={async () => {
                          try {
                            await doArchive({
                              data: { companyId, productId: p.id, restore: !p.is_active },
                            });
                            toast.success(p.is_active ? "Archived" : "Restored");
                            await productsQ.refetch();
                          } catch (e) {
                            toast.error(friendlyAuthError(e));
                          }
                        }}
                      >
                        <Archive className="size-4" />
                        {p.is_active ? "Archive" : "Restore"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      {rows.length >= limit && limit < 500 ? (
        <div className="mt-3 flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLimit((n) => Math.min(500, n + 100))}
          >
            Show more
          </Button>
        </div>
      ) : null}
      {rows.length >= 500 ? (
        <p className="mt-3 text-center text-xs text-muted-foreground">
          Showing the first 500 matches - search to narrow the list.
        </p>
      ) : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit item" : "New product / service"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="grid gap-1">
              <Label>Kind</Label>
              <Select value={form.kind} onValueChange={(v) => setForm((f) => ({ ...f, kind: v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="service">Service</SelectItem>
                  <SelectItem value="product">Product (non-stock)</SelectItem>
                  <SelectItem value="non_inventory">Non-inventory</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1">
                <Label>Code / SKU</Label>
                <Input
                  value={form.code}
                  onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
                />
              </div>
              <div className="grid gap-1">
                <Label>Unit</Label>
                <Input
                  value={form.unit}
                  onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}
                />
              </div>
            </div>
            <div className="grid gap-1">
              <Label>
                Name
                <span aria-hidden className="ml-0.5 text-destructive">
                  *
                </span>
                <span className="sr-only"> (required)</span>
              </Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="grid gap-1">
              <Label>Description</Label>
              <Input
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1">
                <Label>Sales price ({currency})</Label>
                <Input
                  inputMode="decimal"
                  aria-invalid={salesPriceInvalid}
                  value={form.salesPrice}
                  onChange={(e) => setForm((f) => ({ ...f, salesPrice: e.target.value }))}
                />
              </div>
              <div className="grid gap-1">
                <Label>Purchase cost ({currency})</Label>
                <Input
                  inputMode="decimal"
                  aria-invalid={purchaseCostInvalid}
                  value={form.purchaseCost}
                  onChange={(e) => setForm((f) => ({ ...f, purchaseCost: e.target.value }))}
                />
              </div>
            </div>
            <div className="grid gap-1">
              <Label>Income account</Label>
              <Select
                value={form.incomeAccountId || "none"}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, incomeAccountId: v === "none" ? "" : v }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {incomeAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1">
              <Label>Expense account</Label>
              <Select
                value={form.expenseAccountId || "none"}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, expenseAccountId: v === "none" ? "" : v }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {expenseAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1">
                <Label>Sales tax</Label>
                <TaxSelect
                  value={form.salesTaxBps}
                  choices={taxChoices}
                  onChange={(v) => setForm((f) => ({ ...f, salesTaxBps: v }))}
                />
              </div>
              <div className="grid gap-1">
                <Label>Purchase tax</Label>
                <TaxSelect
                  value={form.purchaseTaxBps}
                  choices={taxChoices}
                  onChange={(v) => setForm((f) => ({ ...f, purchaseTaxBps: v }))}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => saveMut.mutate()}
              disabled={saveMut.isPending || salesPriceInvalid || purchaseCostInvalid || !canManage}
            >
              {saveMut.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function TaxSelect({
  value,
  choices,
  onChange,
}: {
  value: string;
  choices: Array<{ key: string; label: string; bps: number }>;
  onChange: (bps: string) => void;
}) {
  const known = choices.some((c) => c.key === value);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue placeholder="Select a tax code" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="0">No tax (0.00%)</SelectItem>
        {choices
          .filter((c) => c.key !== "0")
          .map((c) => (
            <SelectItem key={`${c.key}-${c.label}`} value={c.key}>
              {c.label}
            </SelectItem>
          ))}
        {!known && value !== "0" ? (
          <SelectItem value={value}>Custom rate ({(Number(value) / 100).toFixed(2)}%)</SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  );
}
