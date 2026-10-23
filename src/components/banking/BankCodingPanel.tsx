import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { codeBankTransaction, type listCodingOptions } from "@/lib/banking/coding.functions";
import { computeSplitTotals, type CodingTaxCode } from "@/lib/banking/coding";
import { MoneyField, moneyFieldMinor } from "@/components/banking/MoneyField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type CodingOptions = Awaited<ReturnType<typeof listCodingOptions>>;

type SplitDraft = {
  key: number;
  accountId: string;
  description: string;
  taxCodeId: string;
  amount: string;
};

const NO_TAX = "none";
const NO_CONTACT = "none";

/**
 * Bank coding panel: contact, one or more split lines (account, tax code, description) and a reference.
 * Posts one balanced journal; the server re-validates everything (accounts, tax code, totals).
 */
export function BankCodingPanel({
  companyId,
  txn,
  currency,
  options,
  initialAccountId,
  onDone,
  onCancel,
}: {
  companyId: string;
  txn: { id: string; amountMinor: number; description: string | null };
  currency: string;
  options: CodingOptions;
  initialAccountId?: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const post = useServerFn(codeBankTransaction);
  const direction = txn.amountMinor > 0 ? "in" : "out";
  const statementAbs = BigInt(Math.abs(txn.amountMinor));

  const taxChoices = useMemo(
    () =>
      options.taxCodes.filter(
        (t) =>
          t.rateActive &&
          t.treatment !== "reverse_charge" &&
          (t.appliesTo === "both" || t.appliesTo === (direction === "in" ? "sales" : "purchases")),
      ),
    [options.taxCodes, direction],
  );
  const taxMap = useMemo(() => {
    const m = new Map<string, CodingTaxCode>();
    for (const t of taxChoices) {
      m.set(t.id, {
        id: t.id,
        code: t.code,
        rateBps: t.rateBps,
        treatment: t.treatment,
        taxAccountId: null,
        isRecoverable: t.isRecoverable,
      });
    }
    return m;
  }, [taxChoices]);

  const [treatment, setTreatment] = useState<"inclusive" | "exclusive">("inclusive");
  const [contactId, setContactId] = useState(NO_CONTACT);
  const [reference, setReference] = useState("");
  const [memo, setMemo] = useState("");
  const [nextKey, setNextKey] = useState(2);
  const [splits, setSplits] = useState<SplitDraft[]>([
    {
      key: 1,
      accountId: initialAccountId ?? "",
      description: "",
      taxCodeId: NO_TAX,
      amount: fromMinorUnits(statementAbs, currency),
    },
  ]);

  const parsed = splits.map((s) => moneyFieldMinor(s.amount, currency, { allowNegative: false }));
  const allAmountsValid = parsed.every((p) => p !== null && p > 0n);
  const totals = (() => {
    if (!allAmountsValid) return null;
    try {
      return computeSplitTotals(
        splits.map((s, i) => ({
          amountMinor: parsed[i]!,
          taxCodeId: s.taxCodeId === NO_TAX ? null : s.taxCodeId,
        })),
        treatment,
        taxMap,
      );
    } catch {
      return null;
    }
  })();
  const remaining = totals ? statementAbs - totals.grossMinor : null;
  const accountsOk = splits.every((s) => s.accountId);
  const canPost = Boolean(totals) && remaining === 0n && accountsOk;

  const update = (key: number, patch: Partial<SplitDraft>) =>
    setSplits((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const addLine = () => {
    const amount = remaining !== null && remaining > 0n ? fromMinorUnits(remaining, currency) : "";
    setSplits((rows) => [
      ...rows,
      { key: nextKey, accountId: "", description: "", taxCodeId: NO_TAX, amount },
    ]);
    setNextKey((k) => k + 1);
  };

  const postM = useMutation({
    mutationFn: () =>
      post({
        data: {
          companyId,
          bankTransactionId: txn.id,
          treatment,
          contactId: contactId === NO_CONTACT ? null : contactId,
          reference: reference.trim() || null,
          memo: memo.trim() || null,
          splits: splits.map((s, i) => ({
            accountId: s.accountId,
            amountMinor: Number(parsed[i]!),
            description: s.description.trim() || null,
            taxCodeId: s.taxCodeId === NO_TAX ? null : s.taxCodeId,
          })),
        },
      }),
    onSuccess: () => {
      toast.success("Coded. One balanced journal was posted and linked.");
      onDone();
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const money = (v: bigint) => fromMinorUnits(v, currency);

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3 text-sm">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label>{direction === "in" ? "Received from" : "Paid to"} (contact)</Label>
          <Select value={contactId} onValueChange={setContactId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_CONTACT}>No contact</SelectItem>
              {options.contacts.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Reference</Label>
          <Input value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Amounts are</Label>
          <Select
            value={treatment}
            onValueChange={(v) => setTreatment(v as "inclusive" | "exclusive")}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inclusive">Tax inclusive</SelectItem>
              <SelectItem value="exclusive">Tax exclusive</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        {splits.map((s, i) => (
          <div key={s.key} className="grid gap-2 sm:grid-cols-[2fr_2fr_1.2fr_1fr_auto]">
            <Select value={s.accountId} onValueChange={(v) => update(s.key, { accountId: v })}>
              <SelectTrigger aria-label="Account">
                <SelectValue placeholder="Account" />
              </SelectTrigger>
              <SelectContent>
                {options.accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              aria-label="Description"
              placeholder="Description"
              maxLength={500}
              value={s.description}
              onChange={(e) => update(s.key, { description: e.target.value })}
            />
            <Select value={s.taxCodeId} onValueChange={(v) => update(s.key, { taxCodeId: v })}>
              <SelectTrigger aria-label="Tax code">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TAX}>No tax</SelectItem>
                {taxChoices.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.code} ({(t.rateBps / 100).toFixed(2).replace(/\.00$/, "")}%)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <MoneyField
              label="Amount"
              value={s.amount}
              currency={currency}
              options={{ allowNegative: false }}
              onChange={(v) => update(s.key, { amount: v })}
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={`Remove line ${i + 1}`}
              disabled={splits.length === 1}
              onClick={() => setSplits((rows) => rows.filter((r) => r.key !== s.key))}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={addLine}
          disabled={splits.length >= 30}
        >
          <Plus className="mr-1 size-4" /> Add split line
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
        <div className="space-y-0.5 font-mono text-xs">
          <div>
            Statement {direction === "in" ? "received" : "spent"}: {money(statementAbs)} {currency}
          </div>
          {totals ? (
            <>
              <div>
                Net {money(totals.netMinor)} · Tax {money(totals.taxMinor)} · Gross{" "}
                {money(totals.grossMinor)}
              </div>
              <div className={remaining === 0n ? "text-emerald-600" : "text-destructive"}>
                {remaining === 0n
                  ? "Fully allocated"
                  : `${remaining! > 0n ? "Still to allocate" : "Over-allocated by"}: ${money(remaining! < 0n ? -remaining! : remaining!)}`}
              </div>
            </>
          ) : (
            <div className="text-muted-foreground">Enter valid amounts for every line.</div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Input
            className="w-48"
            placeholder="Memo (optional)"
            maxLength={500}
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
          />
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canPost || postM.isPending}
            onClick={() => postM.mutate()}
          >
            {postM.isPending ? "Posting…" : "Post"}
          </Button>
        </div>
      </div>
    </div>
  );
}
