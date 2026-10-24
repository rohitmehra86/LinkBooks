import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { listBankAccounts } from "@/lib/banking/banking.functions";
import { listCodingOptions } from "@/lib/banking/coding.functions";
import {
  applyRuleSuggestions,
  deleteBankRule,
  listBankRules,
  previewRuleSuggestions,
  saveBankRule,
  setBankRuleActive,
} from "@/lib/banking/rules.functions";
import { MoneyField, moneyFieldMinor } from "@/components/banking/MoneyField";
import { ConfirmButton } from "@/components/banking/ConfirmButton";
import { AccountLookup, LookupSelect } from "@/components/lookup";
import { toContactLookupOption } from "@/lib/lookup/eligibility";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Search = { review?: string };

export const Route = createFileRoute("/_authenticated/banking/rules")({
  validateSearch: (s: Record<string, unknown>): Search =>
    typeof s["review"] === "string" ? { review: s["review"] } : {},
  head: () => ({ meta: [{ title: "Bank rules — LinkBooks" }] }),
  component: BankRules,
});

const ANY = "any";
const NONE = "none";

type FormState = {
  id?: string;
  name: string;
  matchField: string;
  matchType: string;
  pattern: string;
  direction: string;
  minAmount: string;
  maxAmount: string;
  bankAccountId: string;
  accountId: string;
  taxCodeId: string;
  contactId: string;
  priority: string;
  isActive: boolean;
};

const emptyForm: FormState = {
  name: "",
  matchField: "description",
  matchType: "contains",
  pattern: "",
  direction: ANY,
  minAmount: "",
  maxAmount: "",
  bankAccountId: ANY,
  accountId: "",
  taxCodeId: NONE,
  contactId: NONE,
  priority: "100",
  isActive: true,
};

function BankRules() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const search = Route.useSearch();
  const qc = useQueryClient();
  const fetchRules = useServerFn(listBankRules);
  const fetchOptions = useServerFn(listCodingOptions);
  const fetchAccounts = useServerFn(listBankAccounts);
  const save = useServerFn(saveBankRule);
  const remove = useServerFn(deleteBankRule);
  const toggle = useServerFn(setBankRuleActive);
  const preview = useServerFn(previewRuleSuggestions);
  const apply = useServerFn(applyRuleSuggestions);

  const [form, setForm] = useState<FormState>(emptyForm);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [reviewOpen, setReviewOpen] = useState(search.review === "1");
  useEffect(() => {
    if (search.review === "1") setReviewOpen(true);
  }, [search.review]);

  const rulesQ = useQuery({
    queryKey: ["bank-rules", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchRules({ data: { companyId: companyId! } }),
  });
  const optionsQ = useQuery({
    queryKey: ["bank-coding-options", companyId],
    enabled: Boolean(companyId),
    staleTime: 60_000,
    queryFn: () => fetchOptions({ data: { companyId: companyId! } }),
  });
  const accountsQ = useQuery({
    queryKey: ["bank-accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });
  const suggestQ = useQuery({
    queryKey: ["bank-rule-suggestions", companyId],
    enabled: Boolean(companyId && reviewOpen),
    queryFn: () => preview({ data: { companyId: companyId! } }),
  });

  const num = (v: string) =>
    v.trim() ? moneyFieldMinor(v, currency, { allowNegative: false }) : null;
  const minParsed = num(form.minAmount);
  const maxParsed = num(form.maxAmount);
  const amountsInvalid =
    (form.minAmount.trim() !== "" && minParsed === null) ||
    (form.maxAmount.trim() !== "" && maxParsed === null);

  const saveM = useMutation({
    mutationFn: () =>
      save({
        data: {
          companyId: companyId!,
          ...(form.id ? { id: form.id } : {}),
          name: form.name,
          matchField: form.matchField,
          matchPattern: form.pattern,
          matchType: form.matchType,
          offsetAccountId: form.accountId,
          priority: Number(form.priority) || 100,
          isActive: form.isActive,
          direction: form.direction,
          minAmountMinor: minParsed === null ? null : Number(minParsed),
          maxAmountMinor: maxParsed === null ? null : Number(maxParsed),
          bankAccountId: form.bankAccountId === ANY ? null : form.bankAccountId,
          taxCodeId: form.taxCodeId === NONE ? null : form.taxCodeId,
          contactId: form.contactId === NONE ? null : form.contactId,
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["bank-rules", companyId] });
      await qc.invalidateQueries({ queryKey: ["bank-rule-suggestions", companyId] });
      toast.success("Rule saved");
      setForm(emptyForm);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });
  const deleteM = useMutation({
    mutationFn: (id: string) => remove({ data: { companyId: companyId!, id } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["bank-rules", companyId] });
      toast.success("Rule deleted. Journals already posted are unchanged.");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });
  const toggleM = useMutation({
    mutationFn: (v: { id: string; isActive: boolean }) =>
      toggle({ data: { companyId: companyId!, ...v } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["bank-rules", companyId] });
      await qc.invalidateQueries({ queryKey: ["bank-rule-suggestions", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });
  const applyM = useMutation({
    mutationFn: (items: Array<{ bankTransactionId: string; ruleId: string }>) =>
      apply({ data: { companyId: companyId!, items } }),
    onSuccess: async (r) => {
      setPicked(new Set());
      await qc.invalidateQueries({ queryKey: ["bank-rule-suggestions", companyId] });
      await qc.invalidateQueries({ queryKey: ["bank-transactions", companyId] });
      await qc.invalidateQueries({ queryKey: ["banking-counts", companyId] });
      const bad = r.results.find((x) => !x.ok);
      if (r.failed) toast.warning(`${r.succeeded} coded, ${r.failed} failed. ${bad?.error ?? ""}`);
      else toast.success(`${r.succeeded} coded`);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  const accounts = optionsQ.data?.accounts ?? [];
  const accountLabel = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.code} ${a.name}` : "—";
  };
  const suggestions = suggestQ.data?.suggestions ?? [];
  const canSave =
    form.name.trim() &&
    form.pattern.trim() &&
    form.accountId &&
    !amountsInvalid &&
    !saveM.isPending;

  return (
    <>
      <PageHeader
        title="Bank rules"
        description="A rule suggests a coding for matching statement lines. Nothing posts until you confirm. The lowest priority number wins."
        actions={
          <Button size="sm" variant="outline" onClick={() => setReviewOpen((v) => !v)}>
            {reviewOpen ? "Hide" : "Review"} suggestions
          </Button>
        }
      />

      {reviewOpen ? (
        <section className="mb-8 space-y-2 rounded-md border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">Suggested codings</h2>
            <Button
              size="sm"
              disabled={picked.size === 0 || applyM.isPending}
              onClick={() =>
                applyM.mutate(
                  suggestions
                    .filter((s) => picked.has(s.bankTransactionId))
                    .map((s) => ({ bankTransactionId: s.bankTransactionId, ruleId: s.ruleId })),
                )
              }
            >
              OK selected ({picked.size})
            </Button>
          </div>
          {suggestQ.isPending ? (
            <LoadingState rows={2} />
          ) : suggestQ.isError ? (
            <p className="text-sm text-destructive">{friendlyAuthError(suggestQ.error)}</p>
          ) : suggestions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No uncategorised line matches an active rule ({suggestQ.data?.scanned ?? 0} checked).
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <Checkbox
                      aria-label="Select all suggestions"
                      checked={picked.size === suggestions.length}
                      onCheckedChange={(v) =>
                        setPicked(
                          v === true
                            ? new Set(suggestions.map((s) => s.bankTransactionId))
                            : new Set(),
                        )
                      }
                    />
                  </TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Rule</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {suggestions.map((s) => (
                  <TableRow key={s.bankTransactionId}>
                    <TableCell>
                      <Checkbox
                        aria-label={`Select ${s.description ?? "line"}`}
                        checked={picked.has(s.bankTransactionId)}
                        onCheckedChange={(v) =>
                          setPicked((prev) => {
                            const next = new Set(prev);
                            if (v === true) next.add(s.bankTransactionId);
                            else next.delete(s.bankTransactionId);
                            return next;
                          })
                        }
                      />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{s.txnDate}</TableCell>
                    <TableCell>{s.description ?? "—"}</TableCell>
                    <TableCell className="money">
                      {fromMinorUnits(s.amountMinor, currency)}
                    </TableCell>
                    <TableCell>{s.ruleName}</TableCell>
                    <TableCell>{s.accountLabel}</TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        disabled={applyM.isPending}
                        onClick={() =>
                          applyM.mutate([
                            { bankTransactionId: s.bankTransactionId, ruleId: s.ruleId },
                          ])
                        }
                      >
                        OK
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <p className="text-xs text-muted-foreground">
            Amounts show in {currency}; coding always uses the line's own bank-account currency.
          </p>
        </section>
      ) : null}

      <div className="mb-8 grid max-w-3xl gap-3 rounded-md border p-4">
        <Label className="text-base">{form.id ? "Edit rule" : "New rule"}</Label>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            placeholder="Name"
            aria-label="Rule name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <Input
            type="number"
            min={1}
            aria-label="Priority"
            placeholder="Priority (lower runs first)"
            value={form.priority}
            onChange={(e) => setForm({ ...form, priority: e.target.value })}
          />
          <Select
            value={form.matchField}
            onValueChange={(v) => setForm({ ...form, matchField: v })}
          >
            <SelectTrigger aria-label="Match field">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="description">Description</SelectItem>
              <SelectItem value="reference">Reference</SelectItem>
              <SelectItem value="payee">Payee</SelectItem>
            </SelectContent>
          </Select>
          <Select value={form.matchType} onValueChange={(v) => setForm({ ...form, matchType: v })}>
            <SelectTrigger aria-label="Match type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="contains">Contains</SelectItem>
              <SelectItem value="equals">Equals</SelectItem>
              <SelectItem value="starts_with">Starts with</SelectItem>
            </SelectContent>
          </Select>
          <Input
            className="sm:col-span-2"
            placeholder="Text to match…"
            aria-label="Text to match"
            value={form.pattern}
            onChange={(e) => setForm({ ...form, pattern: e.target.value })}
          />
          <Select value={form.direction} onValueChange={(v) => setForm({ ...form, direction: v })}>
            <SelectTrigger aria-label="Money direction">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Money in or out</SelectItem>
              <SelectItem value="in">Money in only</SelectItem>
              <SelectItem value="out">Money out only</SelectItem>
            </SelectContent>
          </Select>
          <LookupSelect
            ariaLabel="Bank account scope"
            allowClear={false}
            value={form.bankAccountId}
            onChange={(v) => setForm({ ...form, bankAccountId: v })}
            searchPlaceholder="Search bank account"
            options={[
              { id: ANY, label: "All bank accounts" },
              ...(accountsQ.data ?? []).map((a) => ({
                id: a.id,
                name: a.name,
                label: a.name,
                meta: a.currency_code,
                group: a.currency_code,
                keywords: `${a.name} ${a.currency_code}`,
              })),
            ]}
          />
          <MoneyField
            label="Minimum amount"
            placeholder="Minimum amount (optional)"
            value={form.minAmount}
            currency={currency}
            options={{ allowNegative: false }}
            onChange={(v) => setForm({ ...form, minAmount: v })}
          />
          <MoneyField
            label="Maximum amount"
            placeholder="Maximum amount (optional)"
            value={form.maxAmount}
            currency={currency}
            options={{ allowNegative: false }}
            onChange={(v) => setForm({ ...form, maxAmount: v })}
          />
          <AccountLookup
            ariaLabel="Account to code to"
            accounts={accounts}
            value={form.accountId}
            onChange={(v) => setForm({ ...form, accountId: v })}
            companyId={companyId}
            placeholder="Account"
            allowClear={false}
          />
          <LookupSelect
            ariaLabel="Tax code"
            allowClear={false}
            value={form.taxCodeId}
            onChange={(v) => setForm({ ...form, taxCodeId: v })}
            searchPlaceholder="Search tax code"
            options={[
              { id: NONE, label: "No tax" },
              ...(optionsQ.data?.taxCodes ?? [])
                .filter((t) => t.treatment !== "reverse_charge")
                .map((t) => ({
                  id: t.id,
                  code: t.code,
                  name: t.name,
                  label: t.name,
                  meta: t.code,
                  keywords: `${t.code} ${t.name}`,
                })),
            ]}
          />
          <LookupSelect
            ariaLabel="Contact"
            allowClear={false}
            value={form.contactId}
            onChange={(v) => setForm({ ...form, contactId: v })}
            searchPlaceholder="Search contact"
            options={[
              { id: NONE, label: "No contact" },
              ...(optionsQ.data?.contacts ?? []).map((c) => toContactLookupOption(c)),
            ]}
          />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.isActive}
              onCheckedChange={(v) => setForm({ ...form, isActive: v === true })}
              aria-label="Rule is active"
            />
            Active
          </label>
        </div>
        <div className="flex gap-2">
          <Button size="sm" disabled={!canSave} onClick={() => saveM.mutate()}>
            {form.id ? "Update rule" : "Save rule"}
          </Button>
          {form.id ? (
            <Button size="sm" variant="ghost" onClick={() => setForm(emptyForm)}>
              Cancel edit
            </Button>
          ) : null}
        </div>
      </div>

      {rulesQ.isPending ? (
        <LoadingState />
      ) : rulesQ.isError ? (
        <ErrorState title="Could not load rules" description={friendlyAuthError(rulesQ.error)} />
      ) : (rulesQ.data ?? []).length === 0 ? (
        <EmptyState title="No rules" description="Create a matching rule above." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Priority</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Condition</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rulesQ.data.map((r) => {
              const bank = (accountsQ.data ?? []).find((a) => a.id === r.bank_account_id);
              return (
                <TableRow key={r.id}>
                  <TableCell>{r.priority}</TableCell>
                  <TableCell>{r.name}</TableCell>
                  <TableCell className="text-sm">
                    {r.match_field} {r.match_type.replace("_", " ")} “{r.match_pattern}”
                    <div className="text-xs text-muted-foreground">
                      {[
                        r.direction !== "any" ? `money ${r.direction}` : null,
                        r.min_amount_minor !== null
                          ? `min ${fromMinorUnits(r.min_amount_minor, currency)}`
                          : null,
                        r.max_amount_minor !== null
                          ? `max ${fromMinorUnits(r.max_amount_minor, currency)}`
                          : null,
                        bank ? bank.name : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </TableCell>
                  <TableCell>
                    {r.account
                      ? `${r.account.code} ${r.account.name}`
                      : accountLabel(r.offset_account_id)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={r.is_active ? "secondary" : "outline"}>
                      {r.is_active ? "active" : "disabled"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setForm({
                            id: r.id,
                            name: r.name,
                            matchField: r.match_field,
                            matchType: r.match_type,
                            pattern: r.match_pattern,
                            direction: r.direction,
                            minAmount:
                              r.min_amount_minor === null
                                ? ""
                                : fromMinorUnits(r.min_amount_minor, currency),
                            maxAmount:
                              r.max_amount_minor === null
                                ? ""
                                : fromMinorUnits(r.max_amount_minor, currency),
                            bankAccountId: r.bank_account_id ?? ANY,
                            accountId: r.offset_account_id,
                            taxCodeId: r.tax_code_id ?? NONE,
                            contactId: r.contact_id ?? NONE,
                            priority: String(r.priority),
                            isActive: r.is_active,
                          })
                        }
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={toggleM.isPending}
                        onClick={() => toggleM.mutate({ id: r.id, isActive: !r.is_active })}
                      >
                        {r.is_active ? "Disable" : "Enable"}
                      </Button>
                      <ConfirmButton
                        title={`Delete rule “${r.name}”?`}
                        description="Journals already posted by this rule are not changed."
                        confirmLabel="Delete"
                        disabled={deleteM.isPending}
                        onConfirm={() => deleteM.mutate(r.id)}
                      >
                        Delete
                      </ConfirmButton>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </>
  );
}
