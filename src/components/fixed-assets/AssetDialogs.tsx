import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useFormat } from "@/hooks/use-format";
import { useCanDo } from "@/hooks/use-can";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { todayIso } from "@/lib/accounting/fiscal-year";
import { fromMinorUnits } from "@/lib/accounting/money";
import { parseAmountCell } from "@/lib/budgets/budget-csv";
import {
  DEPRECIATION_METHODS,
  disposalOutcome,
  validateAssetTerms,
  type DepreciationMethod,
} from "@/lib/fixed-assets/depreciation";
import {
  disposeFixedAsset,
  saveAssetType,
  saveFixedAsset,
  type AssetAccount,
  type AssetTypeRow,
  type CapitaliseLine,
  type FixedAssetRow,
} from "@/lib/fixed-assets/fixed-assets.functions";
import { AccountLookup, LookupSelect, type LookupCreateContext } from "@/components/lookup";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const selectCls =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-60";

function money(text: string, currency: string): number | null {
  try {
    return parseAmountCell(text, currency);
  } catch {
    return null;
  }
}

function AccountSelect({
  id,
  label,
  value,
  onChange,
  accounts,
  types,
  companyId,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  accounts: AssetAccount[];
  types: string[];
  companyId: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <AccountLookup
        id={id}
        ariaLabel={label}
        accounts={accounts
          .filter((a) => types.includes(a.accountType))
          .map((a) => ({
            id: a.id,
            code: a.code,
            name: a.name,
            account_type: a.accountType,
          }))}
        value={value}
        onChange={onChange}
        companyId={companyId}
        purpose="posting"
        createKind={types.includes("expense") ? "depreciation" : "fixed_asset"}
        placeholder="Choose an account"
        allowClear
        disabled={disabled}
      />
    </div>
  );
}

function MethodFields({
  method,
  setMethod,
  life,
  setLife,
  rate,
  setRate,
  disabled,
}: {
  method: DepreciationMethod;
  setMethod: (m: DepreciationMethod) => void;
  life: string;
  setLife: (v: string) => void;
  rate: string;
  setRate: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <div className="space-y-1">
        <Label htmlFor="dep-method">Depreciation method</Label>
        <select
          id="dep-method"
          className={selectCls}
          value={method}
          disabled={disabled}
          onChange={(e) => setMethod(e.target.value as DepreciationMethod)}
        >
          {DEPRECIATION_METHODS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      {method === "straight_line" ? (
        <div className="space-y-1">
          <Label htmlFor="dep-life">Useful life (months)</Label>
          <Input
            id="dep-life"
            inputMode="numeric"
            value={life}
            disabled={disabled}
            onChange={(e) => setLife(e.target.value)}
          />
        </div>
      ) : null}
      {method === "reducing_balance" ? (
        <div className="space-y-1">
          <Label htmlFor="dep-rate">Annual rate (%)</Label>
          <Input
            id="dep-rate"
            inputMode="decimal"
            value={rate}
            disabled={disabled}
            onChange={(e) => setRate(e.target.value)}
          />
        </div>
      ) : null}
    </>
  );
}

function lifeOf(method: DepreciationMethod, life: string): number | null {
  if (method !== "straight_line") return null;
  const n = Number(life);
  return Number.isInteger(n) ? n : NaN;
}

function rateBpsOf(method: DepreciationMethod, rate: string): number | null {
  if (method !== "reducing_balance") return null;
  const n = Number(rate);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

/* ------------------------------------------------------------------ */
/* Asset type                                                          */
/* ------------------------------------------------------------------ */

export function AssetTypeDialog({
  open,
  onOpenChange,
  companyId,
  accounts,
  editing,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  companyId: string;
  accounts: AssetAccount[];
  editing: AssetTypeRow | null;
}) {
  const queryClient = useQueryClient();
  const saveFn = useServerFn(saveAssetType);
  const [name, setName] = useState(editing?.name ?? "");
  const [method, setMethod] = useState<DepreciationMethod>(
    editing?.depreciation_method ?? "straight_line",
  );
  const [life, setLife] = useState(editing?.useful_life_months?.toString() ?? "60");
  const [rate, setRate] = useState(
    editing?.annual_rate_bps ? String(editing.annual_rate_bps / 100) : "20",
  );
  const [asset, setAsset] = useState(editing?.asset_account_id ?? "");
  const [acc, setAcc] = useState(editing?.accumulated_account_id ?? "");
  const [exp, setExp] = useState(editing?.expense_account_id ?? "");

  const m = useMutation({
    mutationFn: () => {
      const usefulLifeMonths = lifeOf(method, life);
      const annualRateBps = rateBpsOf(method, rate);
      if (Number.isNaN(usefulLifeMonths) || Number.isNaN(annualRateBps)) {
        throw new Error("Enter a valid useful life or rate.");
      }
      return saveFn({
        data: {
          companyId,
          typeId: editing?.id ?? null,
          name,
          method,
          usefulLifeMonths,
          annualRateBps,
          assetAccountId: asset,
          accumulatedAccountId: acc,
          expenseAccountId: exp,
        },
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["fixed-assets", companyId] });
      toast.success("Asset type saved");
      onOpenChange(false);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit asset type" : "New asset type"}</DialogTitle>
          <DialogDescription>
            An asset type sets the default method and accounts for assets of that kind.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="space-y-1">
            <Label htmlFor="type-name">Name</Label>
            <Input
              id="type-name"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <MethodFields
            method={method}
            setMethod={setMethod}
            life={life}
            setLife={setLife}
            rate={rate}
            setRate={setRate}
          />
          <AccountSelect
            id="type-asset"
            label="Asset account (cost)"
            value={asset}
            onChange={setAsset}
            accounts={accounts}
            companyId={companyId}
            types={["asset"]}
          />
          <AccountSelect
            id="type-acc"
            label="Accumulated depreciation account"
            value={acc}
            onChange={setAcc}
            accounts={accounts}
            companyId={companyId}
            types={["asset"]}
          />
          <AccountSelect
            id="type-exp"
            label="Depreciation expense account"
            value={exp}
            onChange={setExp}
            accounts={accounts}
            companyId={companyId}
            types={["expense"]}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={m.isPending || !name.trim() || !asset || !acc || !exp}
            onClick={() => m.mutate()}
          >
            {m.isPending ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AssetTypeCreateForm({
  companyId,
  accounts,
  ctx,
}: {
  companyId: string;
  accounts: AssetAccount[];
  ctx: LookupCreateContext;
}) {
  const queryClient = useQueryClient();
  const saveFn = useServerFn(saveAssetType);
  const [name, setName] = useState(ctx.initialQuery);
  const [method, setMethod] = useState<DepreciationMethod>("straight_line");
  const [life, setLife] = useState("60");
  const [rate, setRate] = useState("20");
  const [asset, setAsset] = useState("");
  const [acc, setAcc] = useState("");
  const [exp, setExp] = useState("");
  const [pending, setPending] = useState(false);

  const onSave = async () => {
    const usefulLifeMonths = lifeOf(method, life);
    const annualRateBps = rateBpsOf(method, rate);
    if (
      !name.trim() ||
      !asset ||
      !acc ||
      !exp ||
      Number.isNaN(usefulLifeMonths) ||
      Number.isNaN(annualRateBps)
    ) {
      toast.error("Enter a name, a valid life or rate, and the three accounts");
      return;
    }
    setPending(true);
    try {
      const result = await saveFn({
        data: {
          companyId,
          typeId: null,
          name,
          method,
          usefulLifeMonths,
          annualRateBps,
          assetAccountId: asset,
          accumulatedAccountId: acc,
          expenseAccountId: exp,
        },
      });
      await queryClient.invalidateQueries({ queryKey: ["fixed-assets", companyId] });
      toast.success("Asset type created");
      ctx.complete({
        id: result.id,
        name: name.trim(),
        label: name.trim(),
        meta: JSON.stringify({ method, life, rate, asset, acc, exp }),
      });
    } catch (error) {
      toast.error(friendlyAuthError(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="grid gap-3">
      <div className="space-y-1">
        <Label>Name</Label>
        <Input value={name} autoFocus maxLength={120} onChange={(e) => setName(e.target.value)} />
      </div>
      <MethodFields
        method={method}
        setMethod={setMethod}
        life={life}
        setLife={setLife}
        rate={rate}
        setRate={setRate}
      />
      <AccountSelect
        id="create-type-asset"
        label="Asset account (cost)"
        value={asset}
        onChange={setAsset}
        accounts={accounts}
        companyId={companyId}
        types={["asset"]}
      />
      <AccountSelect
        id="create-type-acc"
        label="Accumulated depreciation account"
        value={acc}
        onChange={setAcc}
        accounts={accounts}
        companyId={companyId}
        types={["asset"]}
      />
      <AccountSelect
        id="create-type-exp"
        label="Depreciation expense account"
        value={exp}
        onChange={setExp}
        accounts={accounts}
        companyId={companyId}
        types={["expense"]}
      />
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={pending} onClick={() => void onSave()}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Create and select
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={ctx.close}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Asset                                                               */
/* ------------------------------------------------------------------ */

export function AssetDialog({
  open,
  onOpenChange,
  companyId,
  currency,
  accounts,
  types,
  editing,
  fromBillLine,
  frozen,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  companyId: string;
  currency: string;
  accounts: AssetAccount[];
  types: AssetTypeRow[];
  editing: FixedAssetRow | null;
  fromBillLine: CapitaliseLine | null;
  /** True once depreciation is posted: only descriptive fields can change. */
  frozen: boolean;
}) {
  const queryClient = useQueryClient();
  const canAccounts = useCanDo("accounts.manage");
  const saveFn = useServerFn(saveFixedAsset);
  const t = (v: number | null | undefined) =>
    v === null || v === undefined ? "" : fromMinorUnits(v, currency);
  const [name, setName] = useState(editing?.name ?? fromBillLine?.description ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [typeId, setTypeId] = useState(editing?.asset_type_id ?? "");
  const [purchase, setPurchase] = useState(
    editing?.purchase_date ?? fromBillLine?.billDate ?? todayIso(),
  );
  const [start, setStart] = useState(editing?.depreciation_start_date ?? purchase);
  const [cost, setCost] = useState(
    editing
      ? t(editing.cost_minor)
      : fromBillLine && fromBillLine.currency === currency
        ? fromMinorUnits(
            Math.max(0, fromBillLine.netMinor - fromBillLine.registeredMinor),
            currency,
          )
        : "",
  );
  const [residual, setResidual] = useState(editing ? t(editing.residual_minor) : "");
  const [opening, setOpening] = useState(editing ? t(editing.opening_accumulated_minor) : "");
  const [method, setMethod] = useState<DepreciationMethod>(
    editing?.depreciation_method ?? "straight_line",
  );
  const [life, setLife] = useState(editing?.useful_life_months?.toString() ?? "60");
  const [rate, setRate] = useState(
    editing?.annual_rate_bps ? String(editing.annual_rate_bps / 100) : "20",
  );
  const [asset, setAsset] = useState(editing?.asset_account_id ?? fromBillLine?.accountId ?? "");
  const [acc, setAcc] = useState(editing?.accumulated_account_id ?? "");
  const [exp, setExp] = useState(editing?.expense_account_id ?? "");

  const applyType = (id: string) => {
    setTypeId(id);
    const ty = types.find((x) => x.id === id);
    if (!ty) return;
    setMethod(ty.depreciation_method);
    if (ty.useful_life_months) setLife(String(ty.useful_life_months));
    if (ty.annual_rate_bps) setRate(String(ty.annual_rate_bps / 100));
    if (!fromBillLine) setAsset(ty.asset_account_id);
    setAcc(ty.accumulated_account_id);
    setExp(ty.expense_account_id);
  };

  const costMinor = money(cost, currency);
  const residualMinor = money(residual, currency);
  const openingMinor = money(opening, currency);
  const problems = useMemo(() => {
    if (frozen) return [];
    if (costMinor === null || residualMinor === null || openingMinor === null) {
      return ["Amounts must be valid numbers."];
    }
    const life_ = lifeOf(method, life);
    const rate_ = rateBpsOf(method, rate);
    if (Number.isNaN(life_) || Number.isNaN(rate_)) return ["Enter a valid useful life or rate."];
    const errs = validateAssetTerms({
      method,
      costMinor,
      residualMinor,
      openingAccumulatedMinor: openingMinor,
      usefulLifeMonths: life_,
      annualRateBps: rate_,
    });
    if (start < purchase) errs.push("Depreciation cannot start before the purchase date.");
    return errs;
  }, [frozen, costMinor, residualMinor, openingMinor, method, life, rate, start, purchase]);

  const m = useMutation({
    mutationFn: () =>
      saveFn({
        data: {
          companyId,
          assetId: editing?.id ?? null,
          assetTypeId: typeId || null,
          name,
          description,
          notes: editing?.notes ?? null,
          purchaseDate: purchase,
          depreciationStartDate: start,
          costMinor: costMinor ?? 0,
          residualMinor: residualMinor ?? 0,
          openingAccumulatedMinor: openingMinor ?? 0,
          method,
          usefulLifeMonths: lifeOf(method, life),
          annualRateBps: rateBpsOf(method, rate),
          assetAccountId: asset,
          accumulatedAccountId: acc,
          expenseAccountId: exp,
          sourceBillId: fromBillLine?.billId ?? editing?.source_bill_id ?? null,
          sourceBillLineId: fromBillLine?.lineId ?? editing?.source_bill_line_id ?? null,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["fixed-assets", companyId] });
      toast.success("Asset saved");
      onOpenChange(false);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const lock = frozen;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.asset_number}` : "New fixed asset"}</DialogTitle>
          <DialogDescription>
            Registering an asset does not post a journal: the purchase is already in your books
            (bill, expense or journal). The register records what to depreciate.
          </DialogDescription>
        </DialogHeader>
        {frozen ? (
          <Alert>
            <AlertDescription>
              Depreciation has been posted for this asset, so only the name, description and type
              can change.
            </AlertDescription>
          </Alert>
        ) : null}
        {fromBillLine ? (
          <Alert>
            <AlertDescription>
              Capitalising bill {fromBillLine.billNumber ?? ""} (
              {fromBillLine.supplier ?? "supplier"}): {fromBillLine.description}. The cost defaults
              to the line's net amount less anything already registered against it
              {fromBillLine.currency !== currency
                ? `; the bill is in ${fromBillLine.currency}, so enter the cost in ${currency}`
                : ""}
              .
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="asset-name">Name</Label>
            <Input
              id="asset-name"
              value={name}
              maxLength={160}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="asset-desc">Description</Label>
            <Input
              id="asset-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="asset-type">Asset type (fills defaults)</Label>
            <LookupSelect
              id="asset-type"
              ariaLabel="Asset type"
              allowClear
              value={typeId}
              onChange={applyType}
              placeholder="No type"
              searchPlaceholder="Search asset type"
              options={types
                .filter((x) => x.is_active)
                .map((x) => ({
                  id: x.id,
                  name: x.name,
                  label: x.name,
                  keywords: x.name,
                }))}
              companyId={companyId}
              canCreate={canAccounts && !lock}
              createTitle="New asset type"
              renderCreate={
                canAccounts && !lock
                  ? (ctx) => (
                      <AssetTypeCreateForm companyId={companyId} accounts={accounts} ctx={ctx} />
                    )
                  : undefined
              }
              onCreated={(option) => {
                if (!option.meta) return;
                try {
                  const saved = JSON.parse(option.meta) as {
                    method: DepreciationMethod;
                    life: string;
                    rate: string;
                    asset: string;
                    acc: string;
                    exp: string;
                  };
                  setMethod(saved.method);
                  setLife(saved.life);
                  setRate(saved.rate);
                  if (!fromBillLine) setAsset(saved.asset);
                  setAcc(saved.acc);
                  setExp(saved.exp);
                } catch {
                  /* The new type stays selected even if its defaults cannot be read. */
                }
              }}
            />
          </div>
          <MethodFields
            method={method}
            setMethod={setMethod}
            life={life}
            setLife={setLife}
            rate={rate}
            setRate={setRate}
            disabled={lock}
          />
          <div className="space-y-1">
            <Label htmlFor="asset-purchase">Purchase date</Label>
            <Input
              id="asset-purchase"
              type="date"
              value={purchase}
              disabled={lock}
              onChange={(e) => {
                if (start === purchase) setStart(e.target.value);
                setPurchase(e.target.value);
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="asset-start">Depreciation starts</Label>
            <Input
              id="asset-start"
              type="date"
              value={start}
              disabled={lock}
              onChange={(e) => setStart(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              A full month is charged for the month this date falls in.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="asset-cost">Cost ({currency})</Label>
            <Input
              id="asset-cost"
              inputMode="decimal"
              value={cost}
              disabled={lock}
              aria-invalid={costMinor === null}
              onChange={(e) => setCost(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="asset-residual">Residual value</Label>
            <Input
              id="asset-residual"
              inputMode="decimal"
              value={residual}
              disabled={lock}
              aria-invalid={residualMinor === null}
              onChange={(e) => setResidual(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="asset-opening">Depreciation already taken (brought forward)</Label>
            <Input
              id="asset-opening"
              inputMode="decimal"
              value={opening}
              disabled={lock}
              aria-invalid={openingMinor === null}
              onChange={(e) => setOpening(e.target.value)}
            />
          </div>
          <AccountSelect
            id="asset-asset"
            label="Asset account (cost)"
            value={asset}
            onChange={setAsset}
            accounts={accounts}
            companyId={companyId}
            types={["asset"]}
            disabled={lock}
          />
          <AccountSelect
            id="asset-acc"
            label="Accumulated depreciation account"
            value={acc}
            onChange={setAcc}
            accounts={accounts}
            companyId={companyId}
            types={["asset"]}
            disabled={lock}
          />
          <AccountSelect
            id="asset-exp"
            label="Depreciation expense account"
            value={exp}
            onChange={setExp}
            accounts={accounts}
            companyId={companyId}
            types={["expense"]}
            disabled={lock}
          />
        </div>
        {problems.length > 0 ? <p className="text-sm text-destructive">{problems[0]}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              m.isPending ||
              !name.trim() ||
              problems.length > 0 ||
              (!frozen && (!asset || !acc || !exp))
            }
            onClick={() => m.mutate()}
          >
            {m.isPending ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
            Save asset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Disposal                                                            */
/* ------------------------------------------------------------------ */

export function DisposeDialog({
  open,
  onOpenChange,
  companyId,
  currency,
  accounts,
  asset,
  accumulatedMinor,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  companyId: string;
  currency: string;
  accounts: AssetAccount[];
  asset: FixedAssetRow;
  accumulatedMinor: number;
}) {
  const fmt = useFormat();
  const queryClient = useQueryClient();
  const disposeFn = useServerFn(disposeFixedAsset);
  const [date, setDate] = useState(todayIso());
  const [proceeds, setProceeds] = useState("");
  const [proceedsAcc, setProceedsAcc] = useState("");
  const [gainLossAcc, setGainLossAcc] = useState("");
  const [notes, setNotes] = useState("");

  const proceedsMinor = money(proceeds, currency);
  const outcome = useMemo(() => {
    if (proceedsMinor === null || proceedsMinor < 0) return null;
    try {
      return disposalOutcome(asset.cost_minor, accumulatedMinor, proceedsMinor);
    } catch {
      return null;
    }
  }, [asset.cost_minor, accumulatedMinor, proceedsMinor]);

  const m = useMutation({
    mutationFn: () =>
      disposeFn({
        data: {
          companyId,
          assetId: asset.id,
          disposalDate: date,
          proceedsMinor: proceedsMinor ?? 0,
          proceedsAccountId: proceedsAcc || null,
          gainLossAccountId: gainLossAcc || null,
          notes,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["fixed-assets", companyId] });
      toast.success("Asset disposed and journal posted");
      onOpenChange(false);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const needsProceeds = (proceedsMinor ?? 0) > 0;
  const needsGainLoss = outcome !== null && outcome.gainLossMinor !== 0;
  const ready =
    outcome !== null &&
    (!needsProceeds || proceedsAcc) &&
    (!needsGainLoss || gainLossAcc) &&
    Boolean(date);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Dispose of {asset.asset_number} {asset.name}
          </DialogTitle>
          <DialogDescription>
            Posts one journal that removes the cost and accumulated depreciation, books the proceeds
            and takes the difference to a gain or loss account.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="space-y-1">
            <Label htmlFor="disp-date">Disposal date</Label>
            <Input
              id="disp-date"
              type="date"
              value={date}
              max={todayIso()}
              onChange={(e) => setDate(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Depreciation must be posted up to the month before this date.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="disp-proceeds">Proceeds ({currency}, 0 if scrapped)</Label>
            <Input
              id="disp-proceeds"
              inputMode="decimal"
              value={proceeds}
              aria-invalid={proceedsMinor === null}
              onChange={(e) => setProceeds(e.target.value)}
            />
          </div>
          {needsProceeds ? (
            <AccountSelect
              id="disp-proceeds-acc"
              label="Proceeds received into"
              value={proceedsAcc}
              onChange={setProceedsAcc}
              accounts={accounts}
              companyId={companyId}
              types={["asset", "liability", "equity"]}
            />
          ) : null}
          {needsGainLoss ? (
            <AccountSelect
              id="disp-gl-acc"
              label={
                outcome!.gainLossMinor > 0 ? "Gain on disposal account" : "Loss on disposal account"
              }
              value={gainLossAcc}
              onChange={setGainLossAcc}
              accounts={accounts}
              companyId={companyId}
              types={["income", "expense"]}
            />
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="disp-notes">Notes</Label>
            <Input id="disp-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {outcome ? (
            <dl className="grid grid-cols-2 gap-1 rounded-md border p-3 text-sm">
              <dt>Cost</dt>
              <dd className="text-right tabular-nums">{fmt.money(outcome.costMinor, currency)}</dd>
              <dt>Accumulated depreciation</dt>
              <dd className="text-right tabular-nums">
                {fmt.money(outcome.accumulatedMinor, currency)}
              </dd>
              <dt>Net book value</dt>
              <dd className="text-right tabular-nums">
                {fmt.money(outcome.netBookValueMinor, currency)}
              </dd>
              <dt className="font-semibold">
                {outcome.gainLossMinor >= 0 ? "Gain on disposal" : "Loss on disposal"}
              </dt>
              <dd
                className={`text-right font-semibold tabular-nums ${
                  outcome.gainLossMinor < 0 ? "text-destructive" : ""
                }`}
              >
                {fmt.money(Math.abs(outcome.gainLossMinor), currency)}
              </dd>
            </dl>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!ready || m.isPending} onClick={() => m.mutate()}>
            {m.isPending ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
            Post disposal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
