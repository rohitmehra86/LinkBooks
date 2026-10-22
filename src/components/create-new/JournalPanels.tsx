"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts, postManualJournal } from "@/lib/accounting/accounting.functions";
import {
  generateRecurringJournal,
  saveRecurringJournalTemplate,
} from "@/lib/create-new/money-documents.functions";
import { toMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Line = { accountId: string; description: string; debit: string; credit: string };

const emptyLine = (): Line => ({ accountId: "", description: "", debit: "", credit: "" });

export function ManualJournalPanel() {
  return <JournalLines mode="post" />;
}

export function RecurringJournalPanel() {
  return <JournalLines mode="template" />;
}

function JournalLines({ mode }: { mode: "post" | "template" }) {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const today = new Date().toISOString().slice(0, 10);
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
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()]);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useState(() => crypto.randomUUID())[0];

  const accounts = ((accountsQ.data ?? []) as Array<{ id: string; code: string; name: string; is_postable: boolean; is_active: boolean }>).filter(
    (account) => account.is_active && account.is_postable,
  );

  function payloadLines() {
    return lines
      .filter((line) => line.accountId)
      .map((line) => ({
        accountId: line.accountId,
        description: line.description || memo || name,
        debitMinor: Number(toMinorUnits(line.debit || "0", currency)),
        creditMinor: Number(toMinorUnits(line.credit || "0", currency)),
      }));
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
          lines: journalLines,
        },
      });
    },
    onSuccess: (result) => {
      setError(null);
      if (result && "posted" in result) {
        setTemplateId(result.id);
        toast.success("Template saved. Nothing was posted.");
        return;
      }
      toast.success("Journal posted");
    },
    onError: (e) => setError(friendlyAuthError(e)),
  });

  const generateM = useMutation({
    mutationFn: () => generate({ data: { companyId: companyId!, templateId: templateId! } }),
    onSuccess: () => toast.success("Occurrence posted"),
    onError: (e) => setError(friendlyAuthError(e)),
  });

  if (!companyId) return null;
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        saveM.mutate();
      }}
    >
      <p className="text-sm text-muted-foreground">
        {mode === "template"
          ? "Saving this template does not post a journal. Generate posts one occurrence through the ledger."
          : "Posts a balanced journal through the accounting engine. A locked period rejects the date."}
      </p>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {mode === "template" ? (
        <>
          <Label>Name</Label>
          <Input required value={name} onChange={(e) => setName(e.target.value)} />
        </>
      ) : null}
      <Label>{mode === "template" ? "First date" : "Date"}</Label>
      <Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
      <Label>Memo</Label>
      <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
      {lines.map((line, index) => (
        <div key={index} className="grid gap-2 sm:grid-cols-4">
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm sm:col-span-2"
            value={line.accountId}
            onChange={(e) =>
              setLines((current) => current.map((item, i) => (i === index ? { ...item, accountId: e.target.value } : item)))
            }
          >
            <option value="">Account</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>{account.code} {account.name}</option>
            ))}
          </select>
          <Input placeholder="Debit" value={line.debit} onChange={(e) => setLines((current) => current.map((item, i) => (i === index ? { ...item, debit: e.target.value } : item)))} />
          <Input placeholder="Credit" value={line.credit} onChange={(e) => setLines((current) => current.map((item, i) => (i === index ? { ...item, credit: e.target.value } : item)))} />
        </div>
      ))}
      <Button type="button" variant="outline" onClick={() => setLines((current) => [...current, emptyLine()])}>
        Add line
      </Button>
      <div className="flex gap-2">
        <Button type="submit" disabled={saveM.isPending}>{mode === "template" ? "Save template" : "Post journal"}</Button>
        {mode === "template" && templateId ? (
          <Button type="button" variant="secondary" disabled={generateM.isPending} onClick={() => generateM.mutate()}>
            Generate now
          </Button>
        ) : null}
      </div>
    </form>
  );
}
