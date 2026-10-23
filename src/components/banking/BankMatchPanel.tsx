import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { MAX_MATCH_LINES, validateMatchSum } from "@/lib/banking/matching";
import {
  listMatchCandidates,
  matchBankTransaction,
  matchStatementLinesToJournalLine,
} from "@/lib/banking/matching.functions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { LoadingState } from "@/components/common/states";

/**
 * Match a statement line to existing ledger activity on the bank account:
 *  - one-to-many: tick several ledger lines; a running difference shows what is still missing
 *  - many-to-one: tick other statement lines that together equal one ledger line
 */
export function BankMatchPanel({
  companyId,
  txn,
  currency,
  onDone,
  onCancel,
}: {
  companyId: string;
  txn: { id: string; amountMinor: number; description: string | null; bankAccountId: string };
  currency: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const fetchCandidates = useServerFn(listMatchCandidates);
  const doMatch = useServerFn(matchBankTransaction);
  const doMatchMany = useServerFn(matchStatementLinesToJournalLine);

  const [windowDays, setWindowDays] = useState(7);
  const [mode, setMode] = useState<"ledger" | "statement">("ledger");
  const [pickedLines, setPickedLines] = useState<Set<string>>(new Set());
  const [pickedStatement, setPickedStatement] = useState<Set<string>>(new Set());
  const [singleLine, setSingleLine] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["bank-match-candidates", companyId, txn.id, windowDays],
    queryFn: () => fetchCandidates({ data: { companyId, bankTransactionId: txn.id, windowDays } }),
  });

  const money = (v: number | bigint) => fromMinorUnits(v, currency);
  const toggle = (set: Set<string>, id: string, apply: (next: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    apply(next);
  };

  const candidates = q.data?.candidates ?? [];
  const others = q.data?.otherStatementLines ?? [];

  const ledgerSum = validateMatchSum(
    txn.amountMinor,
    candidates.filter((c) => pickedLines.has(c.lineId)).map((c) => c.amountMinor),
  );
  const chosenLedger = candidates.find((c) => c.lineId === singleLine) ?? null;
  const statementAmounts = [
    txn.amountMinor,
    ...others.filter((o) => pickedStatement.has(o.id)).map((o) => o.amount_minor),
  ];
  const statementSum = chosenLedger
    ? validateMatchSum(chosenLedger.amountMinor, statementAmounts)
    : null;

  const matchM = useMutation({
    mutationFn: () =>
      doMatch({ data: { companyId, bankTransactionId: txn.id, journalLineIds: [...pickedLines] } }),
    onSuccess: () => {
      toast.success("Matched. No new journal was posted.");
      onDone();
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });
  const matchManyM = useMutation({
    mutationFn: () =>
      doMatchMany({
        data: {
          companyId,
          bankTransactionIds: [txn.id, ...pickedStatement],
          journalLineId: singleLine!,
        },
      }),
    onSuccess: () => {
      toast.success("Matched. No new journal was posted.");
      onDone();
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={mode === "ledger" ? "default" : "outline"}
          onClick={() => setMode("ledger")}
        >
          Match to ledger lines
        </Button>
        <Button
          size="sm"
          variant={mode === "statement" ? "default" : "outline"}
          onClick={() => setMode("statement")}
        >
          Several statement lines → one ledger line
        </Button>
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          Within ±
          <select
            className="rounded border bg-background px-1 py-0.5"
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value))}
          >
            {[3, 7, 14, 30, 60].map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          days
        </label>
      </div>

      {q.isPending ? (
        <LoadingState rows={2} />
      ) : q.isError ? (
        <p className="text-destructive">{friendlyAuthError(q.error)}</p>
      ) : candidates.length === 0 ? (
        <p className="text-muted-foreground">
          No unreconciled ledger lines on this bank account within ±{windowDays} days. Code the line
          instead, or widen the window.
        </p>
      ) : (
        <ul className="max-h-64 space-y-1 overflow-auto">
          {candidates.map((c) => (
            <li key={c.lineId} className="flex items-center gap-3 rounded px-2 py-1 hover:bg-muted">
              {mode === "ledger" ? (
                <Checkbox
                  aria-label={`Select journal ${c.journalNumber}`}
                  checked={pickedLines.has(c.lineId)}
                  onCheckedChange={() => toggle(pickedLines, c.lineId, setPickedLines)}
                />
              ) : (
                <input
                  type="radio"
                  name={`single-line-${txn.id}`}
                  aria-label={`Select journal ${c.journalNumber}`}
                  checked={singleLine === c.lineId}
                  onChange={() => setSingleLine(c.lineId)}
                />
              )}
              <span className="w-24 whitespace-nowrap">{c.date}</span>
              <span className="min-w-0 flex-1 truncate">
                #{c.journalNumber} · {c.description || c.source}
              </span>
              {c.exact ? <Badge variant="secondary">Exact amount</Badge> : null}
              <span className="numeric">{money(c.amountMinor)}</span>
            </li>
          ))}
        </ul>
      )}

      {mode === "ledger" ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
          <div className="font-mono text-xs">
            Statement {money(txn.amountMinor)} · Selected {money(ledgerSum.total)} ·{" "}
            <span className={ledgerSum.ok ? "text-emerald-600" : "text-destructive"}>
              Difference {money(ledgerSum.difference)}
            </span>
            {pickedLines.size > MAX_MATCH_LINES ? ` · max ${MAX_MATCH_LINES} lines` : ""}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!ledgerSum.ok || matchM.isPending}
              onClick={() => matchM.mutate()}
            >
              {matchM.isPending ? "Matching…" : "Match"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2 border-t pt-2">
          <p className="text-xs text-muted-foreground">
            Pick the ledger line above, then tick the other statement lines that make up the same
            amount.
          </p>
          <ul className="max-h-40 space-y-1 overflow-auto">
            {others.map((o) => (
              <li key={o.id} className="flex items-center gap-3 rounded px-2 py-1 hover:bg-muted">
                <Checkbox
                  aria-label={`Select statement line ${o.description ?? o.id}`}
                  checked={pickedStatement.has(o.id)}
                  onCheckedChange={() => toggle(pickedStatement, o.id, setPickedStatement)}
                />
                <span className="w-24 whitespace-nowrap">{o.txn_date}</span>
                <span className="min-w-0 flex-1 truncate">{o.description ?? "—"}</span>
                <span className="numeric">{money(o.amount_minor)}</span>
              </li>
            ))}
            {others.length === 0 ? (
              <li className="text-xs text-muted-foreground">
                No other uncategorised statement lines nearby.
              </li>
            ) : null}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-mono text-xs">
              {statementSum ? (
                <>
                  Ledger {money(chosenLedger!.amountMinor)} · Statement {money(statementSum.total)}{" "}
                  ·{" "}
                  <span className={statementSum.ok ? "text-emerald-600" : "text-destructive"}>
                    Difference {money(statementSum.difference)}
                  </span>
                </>
              ) : (
                "Choose a ledger line first"
              )}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!statementSum?.ok || matchManyM.isPending}
                onClick={() => matchManyM.mutate()}
              >
                {matchManyM.isPending ? "Matching…" : "Match"}
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="border-t pt-2 text-xs text-muted-foreground">
        Money moved between your own bank accounts?{" "}
        <Link
          to="/banking/transfers"
          search={
            {
              bankAccountId: txn.bankAccountId,
              amount: fromMinorUnits(Math.abs(txn.amountMinor), currency),
              direction: txn.amountMinor > 0 ? "in" : "out",
            } as never
          }
          className="underline underline-offset-4"
        >
          Create transfer from this line
        </Link>
        .
      </div>
    </div>
  );
}
