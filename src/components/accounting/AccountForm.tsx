"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  listChartAccounts,
  saveChartAccount,
  type ChartAccount,
} from "@/lib/accounting/chart.functions";
import {
  ACCOUNT_KINDS,
  kindSpec,
  suggestNextCode,
  type AccountKind,
} from "@/lib/accounting/account-kinds";
import { saveAccountSchema } from "@/lib/accounting/account-schema";
import {
  BALANCE_SHEET_SECTION_LABELS,
  PROFIT_AND_LOSS_SECTION_LABELS,
  balanceSheetSectionFor,
  profitAndLossSectionFor,
} from "@/lib/accounting/reporting";
import { listTaxCodes } from "@/lib/tax/tax.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { AccountLookup, LookupSelect, type LookupCreateContext } from "@/components/lookup";
import { useCanDo } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type Draft = {
  code: string;
  name: string;
  accountKind: AccountKind;
  description: string;
  detailType: string;
  parentId: string;
  defaultTaxCodeId: string;
  currencyCode: string;
  isHeader: boolean;
  isPaymentEnabled: boolean;
  showOnDashboardWatchlist: boolean;
  showInExpenseClaims: boolean;
  bankName: string;
  accountNumberMasked: string;
};

const NO_ACCOUNTS: ChartAccount[] = [];

const empty = (kind: AccountKind): Draft => ({
  code: "",
  name: "",
  accountKind: kind,
  description: "",
  detailType: "",
  parentId: "",
  defaultTaxCodeId: "",
  currencyCode: "",
  isHeader: false,
  isPaymentEnabled: false,
  showOnDashboardWatchlist: false,
  showInExpenseClaims: false,
  bankName: "",
  accountNumberMasked: "",
});

function fromAccount(account: ChartAccount): Draft {
  return {
    code: account.code,
    name: account.name,
    accountKind: account.accountKind ?? "expense",
    description: account.description,
    detailType: account.detailType,
    parentId: account.parentId ?? "",
    defaultTaxCodeId: account.defaultTaxCodeId ?? "",
    currencyCode: account.currencyCode,
    isHeader: account.isHeader,
    isPaymentEnabled: account.isPaymentEnabled,
    showOnDashboardWatchlist: account.showOnDashboardWatchlist,
    showInExpenseClaims: account.showInExpenseClaims,
    bankName: account.bankName,
    accountNumberMasked: account.accountNumberMasked,
  };
}

export function AccountForm({
  companyId,
  currency,
  account,
  initialKind,
  initialName,
  onSaved,
  onCancel,
}: {
  companyId: string;
  currency: string;
  account?: ChartAccount | null;
  initialKind?: AccountKind;
  initialName?: string;
  onSaved: (another: boolean, saved?: { id: string; code: string; name: string }) => void;
  onCancel?: () => void;
}) {
  const queryClient = useQueryClient();
  const canTax = useCanDo("tax.settings");
  const fetchChart = useServerFn(listChartAccounts);
  const fetchTax = useServerFn(listTaxCodes);
  const save = useServerFn(saveChartAccount);
  const chartQuery = useQuery({
    queryKey: ["chart-accounts", companyId],
    queryFn: () => fetchChart({ data: { companyId } }),
  });
  const taxQuery = useQuery({
    queryKey: ["tax-codes", companyId],
    queryFn: () => fetchTax({ data: { companyId } }),
  });
  const starting = account
    ? fromAccount(account)
    : { ...empty(initialKind ?? "expense"), name: initialName ?? "" };
  const [draft, setDraft] = useState<Draft>(starting);
  const [baseline, setBaseline] = useState(JSON.stringify(starting));
  const dirty = JSON.stringify(draft) !== baseline;
  const spec = kindSpec(draft.accountKind);
  // AC-03: system, control and locked accounts keep their code, type and header setting.
  const fieldsLocked = !!account && (account.isSystem || account.isControl || account.isLocked);
  const typeLocked = fieldsLocked || (!!account && account.transactionCount > 0);

  useEffect(() => {
    const onLeave = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirty]);

  const accounts = chartQuery.data?.accounts ?? NO_ACCOUNTS;
  const parents = useMemo(() => {
    const blocked = new Set<string>();
    if (account) {
      blocked.add(account.id);
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of accounts) {
          if (row.parentId && blocked.has(row.parentId) && !blocked.has(row.id)) {
            blocked.add(row.id);
            changed = true;
          }
        }
      }
    }
    return accounts.filter(
      (row) => row.accountType === spec.accountClass && row.isActive && !blocked.has(row.id),
    );
  }, [account, accounts, spec.accountClass]);

  const taxCodes = useMemo(() => taxChoices(taxQuery.data), [taxQuery.data]);
  const section = reportSection(spec.accountClass, spec.subtype);

  const mutation = useMutation({
    mutationFn: async (another: boolean) => {
      const parsed = saveAccountSchema.safeParse({
        companyId,
        id: account?.id ?? null,
        ...draft,
        parentId: draft.parentId || null,
        defaultTaxCodeId: draft.defaultTaxCodeId || null,
      });
      if (!parsed.success)
        throw new Error(parsed.error.issues[0]?.message ?? "Check the account details.");
      const result = await save({ data: parsed.data });
      return {
        another,
        saved: { id: result.id, code: draft.code.trim(), name: draft.name.trim() },
      };
    },
    onSuccess: async ({ another, saved }) => {
      await queryClient.invalidateQueries({ queryKey: ["chart-accounts", companyId] });
      await queryClient.invalidateQueries({ queryKey: ["accounts", companyId] });
      toast.success(account ? "Account updated" : "Account created");
      if (another) {
        const next = empty(draft.accountKind);
        setDraft(next);
        setBaseline(JSON.stringify(next));
      }
      onSaved(another, saved);
    },
    onError: (error) => toast.error(friendlyAuthError(error)),
  });

  const setKind = (kind: AccountKind) => {
    setDraft((current) => ({
      ...current,
      accountKind: kind,
      isPaymentEnabled:
        kind === "bank" || kind === "credit_card" ? current.isPaymentEnabled : false,
      showInExpenseClaims:
        kindSpec(kind).accountClass === "expense" ? current.showInExpenseClaims : false,
    }));
  };

  const requestClose = () => {
    if (dirty && !window.confirm("You have unsaved changes. Close anyway?")) return;
    onCancel?.();
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate(false);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Account type">
          <Select
            value={draft.accountKind}
            onValueChange={(value) => setKind(value as AccountKind)}
            disabled={typeLocked}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACCOUNT_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {kindSpec(kind).classLabel} · {kindSpec(kind).label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {typeLocked ? (
            <p className="text-xs text-muted-foreground">
              {fieldsLocked
                ? "Type, code and header setting are locked because this is a system account."
                : "Type is locked because this account has posted transactions."}
            </p>
          ) : null}
        </Field>
        <Field label="Code">
          <div className="flex gap-2">
            <Input
              value={draft.code}
              maxLength={10}
              onChange={(event) => setDraft({ ...draft, code: event.target.value })}
              disabled={fieldsLocked}
            />
            <Button
              type="button"
              variant="outline"
              disabled={fieldsLocked}
              onClick={() =>
                setDraft({
                  ...draft,
                  code: suggestNextCode(
                    draft.accountKind,
                    accounts.map((row) => row.code),
                  ),
                })
              }
            >
              Suggest
            </Button>
          </div>
        </Field>
        <Field label="Name">
          <Input
            value={draft.name}
            maxLength={150}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </Field>
        <Field label="Detail type">
          <Input
            value={draft.detailType}
            maxLength={80}
            onChange={(event) => setDraft({ ...draft, detailType: event.target.value })}
          />
        </Field>
      </div>
      <Field label="Description">
        <Textarea
          value={draft.description}
          maxLength={500}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Sub-account of">
          <AccountLookup
            ariaLabel="Sub-account of"
            purpose="parent"
            accounts={parents}
            value={draft.parentId}
            onChange={(parentId) => setDraft({ ...draft, parentId })}
            companyId={companyId}
            placeholder="No parent"
            allowClear
          />
        </Field>
        <Field label="Default tax">
          <LookupSelect
            ariaLabel="Default tax"
            options={taxCodes.map((code) => ({ id: code.id, label: code.label }))}
            value={draft.defaultTaxCodeId}
            onChange={(defaultTaxCodeId) => setDraft({ ...draft, defaultTaxCodeId })}
            placeholder="No default"
            searchPlaceholder="Search tax code"
            allowClear
            companyId={companyId}
            canCreate={canTax}
            createTitle="New tax code"
            renderCreate={
              canTax ? (ctx) => <DefaultTaxCreate companyId={companyId} ctx={ctx} /> : undefined
            }
          />
        </Field>
        <Field label={`Currency (organisation uses ${currency})`}>
          <Input
            value={draft.currencyCode}
            maxLength={3}
            placeholder={currency}
            onChange={(event) =>
              setDraft({ ...draft, currencyCode: event.target.value.toUpperCase() })
            }
          />
        </Field>
        <Field label="Normal balance">
          <Input value={spec.normalBalance === "debit" ? "Debit" : "Credit"} readOnly />
        </Field>
      </div>
      <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
        Report section: {section}. A new account uses this placement. Existing report totals stay on
        the account’s current subtype until you change the type.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <CheckLine
          checked={draft.isHeader}
          label="Header only (cannot be posted)"
          disabled={fieldsLocked}
          onChange={(checked) => setDraft({ ...draft, isHeader: checked })}
        />
        <CheckLine
          checked={draft.showOnDashboardWatchlist}
          label="Show on dashboard watchlist"
          onChange={(checked) => setDraft({ ...draft, showOnDashboardWatchlist: checked })}
        />
        {spec.accountClass === "expense" ? (
          <CheckLine
            checked={draft.showInExpenseClaims}
            label="Show in expense claims"
            onChange={(checked) => setDraft({ ...draft, showInExpenseClaims: checked })}
          />
        ) : null}
        {draft.accountKind === "bank" || draft.accountKind === "credit_card" ? (
          <CheckLine
            checked={draft.isPaymentEnabled}
            label="Enable payments"
            onChange={(checked) => setDraft({ ...draft, isPaymentEnabled: checked })}
          />
        ) : null}
      </div>
      {draft.accountKind === "bank" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Bank name">
            <Input
              value={draft.bankName}
              maxLength={80}
              onChange={(event) => setDraft({ ...draft, bankName: event.target.value })}
            />
          </Field>
          <Field label="Account number (masked)">
            <Input
              value={draft.accountNumberMasked}
              maxLength={12}
              onChange={(event) => setDraft({ ...draft, accountNumberMasked: event.target.value })}
            />
          </Field>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          Save
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate(true)}
        >
          Save and new
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={requestClose}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function CheckLine({
  checked,
  label,
  onChange,
  disabled,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <Checkbox
        checked={checked}
        disabled={disabled === true}
        onCheckedChange={(value) => onChange(value === true)}
      />
      {label}
    </label>
  );
}

function reportSection(
  accountClass: "asset" | "liability" | "equity" | "income" | "expense",
  subtype: string,
): string {
  if (accountClass === "income" || accountClass === "expense") {
    return PROFIT_AND_LOSS_SECTION_LABELS[
      profitAndLossSectionFor({ account_type: accountClass, subtype })
    ];
  }
  const section = balanceSheetSectionFor({ account_type: accountClass, subtype });
  return section ? BALANCE_SHEET_SECTION_LABELS[section] : "Balance sheet";
}

function DefaultTaxCreate({ companyId, ctx }: { companyId: string; ctx: LookupCreateContext }) {
  const [Form, setForm] = useState<
    typeof import("@/components/lookup/create-forms").TaxCodeCreateForm | null
  >(null);
  useEffect(() => {
    let live = true;
    void import("@/components/lookup/create-forms").then((mod) => {
      if (live) setForm(() => mod.TaxCodeCreateForm);
    });
    return () => {
      live = false;
    };
  }, []);
  if (!Form) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return <Form companyId={companyId} appliesTo="both" ctx={ctx} />;
}

function taxChoices(value: unknown): { id: string; label: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const record = row as Record<string, unknown>;
    const id = record["id"];
    const code = record["code"];
    const name = record["name"];
    if (typeof id !== "string") return [];
    return [
      {
        id,
        label:
          `${typeof code === "string" ? code : ""} ${typeof name === "string" ? name : ""}`.trim(),
      },
    ];
  });
}
