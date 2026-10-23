"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts, postManualJournal } from "@/lib/accounting/accounting.functions";
import {
  generateRecurringJournal,
  saveRecurringJournalTemplate,
} from "@/lib/create-new/money-documents.functions";
import { fromMinorUnits, toMinorUnits } from "@/lib/accounting/money";
import { validateAutoReverseDate } from "@/lib/accounting/fx-reval";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

type Line = { accountId: string; description: string; debit: string; credit: string };
type AccountRow = {
  id: string;
  code: string;
  name: string;
  is_postable: boolean;
  is_active: boolean;
  is_control?: boolean;
};

const emptyLine = (): Line => ({ accountId: "", description: "", debit: "", credit: "" });

export function ManualJournalPanel() {
  return <JournalLines mode="post" />;
}

export function RecurringJournalPanel() {
  return <JournalLines mode="template" />;
}

function safeMinor(value: string, currency: string): bigint {
  try {
    return toMinorUnits(value.trim() || "0", currency);
  } catch {
    return 0n;
  }
}

function JournalLines({ mode }: { mode: "post" | "template" }) {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const today = new Date().toISOString().slice(0, 10);
  const qc = useQueryClient();
  const fetchAccounts = useServerFn(listAccounts);
  const post = useServerFn(postManualJournal);
  const saveTemplate = useServerFn(saveRecurringJournalTemplate);
  const generate = useServerFn(generateRecurringJournal);
  const accountsQ = useQuery({
    queryKey: ["accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });
  const [date, setDate] = useState(today);
  const [name, setName] = useState("");
  const [memo, setMemo] = useState("");
  const [autoReverseOn, setAutoReverseOn] = useState("");
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()]);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const allAccounts = (accountsQ.data ?? []) as unknown as AccountRow[];
  // Control accounts (receivables, payables, tax) are written by their own documents, not by hand.
  const accounts = allAccounts.filter((a) => a.is_active && a.is_postable && !a.is_control);

  const totals = useMemo(() => {
    let debit = 0n;
    let credit = 0n;
    for (const line of lines) {
      debit += safeMinor(line.debit, currency);
      credit += safeMinor(line.credit, currency);
    }
    return { debit, credit, difference: debit - credit };
  }, [lines, currency]);

  const filled = lines.filter((line) => line.accountId);
  const bothSides = lines.some(
    (line) => safeMinor(line.debit, currency) > 0n && safeMinor(line.credit, currency) > 0n,
  );
  const balanced = totals.debit > 0n && totals.difference === 0n;
  const reverseError = mode === "post" ? validateAutoReverseDate(date, autoReverseOn) : null;
  const canSubmit =
    balanced &&
    filled.length >= 2 &&
    !bothSides &&
    !reverseError &&
    (mode === "post" || name.trim().length > 0);

  function updateLine(index: number, patch: Partial<Line>) {
    setLines((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function payloadLines() {
    return lines
      .filter((line) => line.accountId)
      .map((line) => ({
        accountId: line.accountId,
        description: line.description || memo || name,
        debitMinor: Number(safeMinor(line.debit, currency)),
        creditMinor: Number(safeMinor(line.credit, currency)),
      }));
  }

  function reset() {
    setLines([emptyLine(), emptyLine()]);
    setMemo("");
    setName("");
    setAutoReverseOn("");
    setIdempotencyKey(crypto.randomUUID());
  }

  const saveM = useMutation({
    mutationFn: async () => {
      const journalLines = payloadLines();
      if (mode === "template") {
        return saveTemplate({
          data: { companyId: companyId!, name, startDate: date, lines: journalLines },
        });
      }
      return post({
        data: {
          companyId: companyId!,
          journalDate: date,
          memo,
          idempotencyKey,
          ...(autoReverseOn ? { autoReverseOn } : {}),
          lines: journalLines,
        },
      });
    },
    onSuccess: async (result) => {
      setError(null);
      if (result && "posted" in result) {
        setTemplateId(result.id);
        toast.success("Template saved. Nothing was posted.");
        return;
      }
      toast.success("Journal posted");
      reset();
      await qc.invalidateQueries({ queryKey: ["journals", companyId] });
      await qc.invalidateQueries({ queryKey: ["accounts", companyId] });
    },
    onError: (e) => setError(friendlyAuthError(e)),
  });

  const generateM = useMutation({
    mutationFn: () => generate({ data: { companyId: companyId!, templateId: templateId! } }),
    onSuccess: (result) => toast.success(`Journal posted for ${result.occurrenceDate}`),
    onError: (e) => setError(friendlyAuthError(e)),
  });

  if (!companyId) return null;
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        saveM.mutate();
      }}
    >
      <p className="text-sm text-muted-foreground">
        {mode === "template"
          ? "Saving this template does not post a journal. Generate posts one occurrence through the ledger."
          : "Posts a balanced journal through the accounting engine. A locked period rejects the date. Receivables, payables and tax accounts are not available here: use an invoice, bill, credit note or payment."}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {mode === "template" ? (
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="journal-name">Template name</Label>
            <Input
              id="journal-name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="journal-date">{mode === "template" ? "First date" : "Date"}</Label>
          <Input
            id="journal-date"
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="journal-memo">Narration</Label>
          <Input id="journal-memo" value={memo} onChange={(e) => setMemo(e.target.value)} />
        </div>
        {mode === "post" ? (
          <div className="space-y-1.5">
            <Label htmlFor="journal-auto-reverse">Reverse automatically on (optional)</Label>
            <Input
              id="journal-auto-reverse"
              type="date"
              min={date}
              value={autoReverseOn}
              onChange={(e) => setAutoReverseOn(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              For accruals and prepayments. The reversal is posted when due; process it from
              Accounting → FX &amp; reversals.
            </p>
            {reverseError ? <p className="text-xs text-destructive">{reverseError}</p> : null}
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="hidden grid-cols-12 gap-2 text-xs font-medium text-muted-foreground sm:grid">
          <span className="col-span-4">Account</span>
          <span className="col-span-3">Description</span>
          <span className="col-span-2 text-right">Debit</span>
          <span className="col-span-2 text-right">Credit</span>
          <span />
        </div>
        {lines.map((line, index) => (
          <div key={index} className="grid grid-cols-2 gap-2 sm:grid-cols-12">
            <select
              aria-label={`Line ${index + 1} account`}
              className="col-span-2 h-9 rounded-md border border-input bg-background px-2 text-sm sm:col-span-4"
              value={line.accountId}
              onChange={(e) => updateLine(index, { accountId: e.target.value })}
            >
              <option value="">Select account</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} {account.name}
                </option>
              ))}
            </select>
            <Input
              aria-label={`Line ${index + 1} description`}
              className="col-span-2 sm:col-span-3"
              placeholder="Description"
              value={line.description}
              onChange={(e) => updateLine(index, { description: e.target.value })}
            />
            <Input
              aria-label={`Line ${index + 1} debit`}
              className="text-right sm:col-span-2"
              inputMode="decimal"
              placeholder="0.00"
              value={line.debit}
              onChange={(e) =>
                updateLine(index, {
                  debit: e.target.value,
                  credit: e.target.value ? "" : line.credit,
                })
              }
            />
            <Input
              aria-label={`Line ${index + 1} credit`}
              className="text-right sm:col-span-2"
              inputMode="decimal"
              placeholder="0.00"
              value={line.credit}
              onChange={(e) =>
                updateLine(index, {
                  credit: e.target.value,
                  debit: e.target.value ? "" : line.debit,
                })
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove line ${index + 1}`}
              disabled={lines.length <= 2}
              onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setLines((current) => [...current, emptyLine()])}
        >
          Add line
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
        <span className="tabular-nums">Debits {fromMinorUnits(totals.debit, currency)}</span>
        <span className="tabular-nums">Credits {fromMinorUnits(totals.credit, currency)}</span>
        {balanced ? (
          <Badge variant="secondary">Balanced</Badge>
        ) : (
          <Badge variant="destructive" className="tabular-nums">
            Out of balance by{" "}
            {fromMinorUnits(
              totals.difference < 0n ? -totals.difference : totals.difference,
              currency,
            )}
          </Badge>
        )}
      </div>
      {bothSides ? (
        <p className="text-sm text-destructive">A line cannot have both a debit and a credit.</p>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" disabled={!canSubmit || saveM.isPending}>
          {saveM.isPending ? "Saving…" : mode === "template" ? "Save template" : "Post journal"}
        </Button>
        {mode === "template" && templateId ? (
          <Button
            type="button"
            variant="secondary"
            disabled={generateM.isPending}
            onClick={() => generateM.mutate()}
          >
            Generate now
          </Button>
        ) : null}
      </div>
    </form>
  );
}
