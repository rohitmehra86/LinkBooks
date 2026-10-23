import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Landmark } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import { DEFAULT_CURRENCY_DECIMALS, fromMinorUnits } from "@/lib/accounting/money";
import {
  createBankAccount,
  getBankAccountSummaries,
  updateBankAccount,
} from "@/lib/banking/banking.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { ConfirmButton } from "@/components/banking/ConfirmButton";
import { BankIntegrityBanner } from "@/components/banking/BankIntegrityBanner";
import { BankAccountDetailsDialog } from "@/components/banking/BankAccountDetailsDialog";
import { listBankAccountDetails } from "@/lib/banking/bank-ops.functions";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/banking/")({
  head: () => ({
    meta: [
      { title: "Banking — LinkBooks" },
      { name: "description", content: "Bank and cash accounts, CSV import and reconciliation." },
    ],
  }),
  component: BankingAccounts,
});

type GlAccount = {
  id: string;
  code: string;
  name: string;
  is_postable: boolean;
  is_active: boolean;
  account_type: string;
};

function BankingAccounts() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const baseCurrency = company?.base_currency ?? "GBP";
  const qc = useQueryClient();
  const fetchSummaries = useServerFn(getBankAccountSummaries);
  const fetchGl = useServerFn(listAccounts);
  const fetchDetails = useServerFn(listBankAccountDetails);
  const detailsQ = useQuery({
    queryKey: ["bank-account-details", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchDetails({ data: { companyId: companyId! } }),
  });
  const detailsById = new Map((detailsQ.data ?? []).map((d) => [d.bankAccountId, d]));
  const create = useServerFn(createBankAccount);
  const update = useServerFn(updateBankAccount);

  const [name, setName] = useState("");
  const [glAccountId, setGlAccountId] = useState("");
  const [currency, setCurrency] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const query = useQuery({
    queryKey: ["bank-account-summaries", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchSummaries({ data: { companyId: companyId! } }),
  });
  const glQ = useQuery({
    queryKey: ["accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchGl({ data: { companyId: companyId! } }),
  });

  const glOptions = ((glQ.data ?? []) as GlAccount[]).filter(
    (a) => a.is_active && a.is_postable && a.account_type === "asset",
  );
  const usedGl = new Set<string>();
  void usedGl;

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["bank-account-summaries", companyId] });
    await qc.invalidateQueries({ queryKey: ["bank-accounts", companyId] });
  };

  const createM = useMutation({
    mutationFn: () =>
      create({
        data: { companyId: companyId!, name, currencyCode: currency ?? baseCurrency, glAccountId },
      }),
    onSuccess: async () => {
      await refresh();
      toast.success("Bank account created");
      setName("");
      setGlAccountId("");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const updateM = useMutation({
    mutationFn: (vars: { id: string; name?: string; isActive?: boolean }) =>
      update({ data: { companyId: companyId!, ...vars } }),
    onSuccess: async (_r, vars) => {
      await refresh();
      setEditingId(null);
      toast.success(
        vars.isActive === false
          ? "Account archived"
          : vars.isActive
            ? "Account restored"
            : "Account renamed",
      );
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  const accounts = (query.data ?? []).filter((a) => showArchived || a.isActive);
  const archivedCount = (query.data ?? []).filter((a) => !a.isActive).length;

  return (
    <>
      <PageHeader
        title="Bank & cash accounts"
        description="Link bank/cash accounts to ledger GL codes. Live bank feeds appear only when a provider connection exists."
        actions={
          <Button size="sm" asChild>
            <Link to="/banking/import">Import CSV</Link>
          </Button>
        }
      />

      <BankIntegrityBanner />

      <Alert className="mb-6">
        <AlertDescription>
          Bank feeds: no provider is connected for this organisation. Use CSV import. An empty feed
          list is not a successful sync.
        </AlertDescription>
      </Alert>

      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState title="Could not load accounts" description={friendlyAuthError(query.error)} />
      ) : accounts.length === 0 ? (
        <EmptyState
          icon={Landmark}
          title="No bank accounts"
          description="Add a bank or cash account linked to a GL code."
        />
      ) : (
        <div className="mb-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {accounts.map((a) => {
            const diff =
              a.lastStatementBalanceMinor === null
                ? null
                : a.ledgerBalanceMinor - a.lastStatementBalanceMinor;
            const search = { bankAccountId: a.id };
            return (
              <Card key={a.id} className={a.isActive ? "" : "opacity-70"}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between gap-2 text-base">
                    {editingId === a.id ? (
                      <Input
                        aria-label="Account name"
                        value={editName}
                        maxLength={120}
                        onChange={(e) => setEditName(e.target.value)}
                      />
                    ) : (
                      <Link
                        to="/banking/transactions"
                        search={search as never}
                        className="underline-offset-2 hover:underline"
                      >
                        {a.name}
                      </Link>
                    )}
                    <Badge variant="outline">{a.currencyCode}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <dl className="grid grid-cols-2 gap-y-1">
                    <dt className="text-muted-foreground">Ledger balance</dt>
                    <dd className="text-right font-mono">
                      {fromMinorUnits(a.ledgerBalanceMinor, a.currencyCode)}
                    </dd>
                    <dt className="text-muted-foreground">
                      Statement balance
                      {a.lastStatementDate ? ` (${a.lastStatementDate})` : ""}
                    </dt>
                    <dd className="text-right font-mono">
                      {a.lastStatementBalanceMinor === null
                        ? "Not reconciled yet"
                        : fromMinorUnits(a.lastStatementBalanceMinor, a.currencyCode)}
                    </dd>
                    {diff !== null ? (
                      <>
                        <dt className="text-muted-foreground">Ledger − statement</dt>
                        <dd className="text-right font-mono">
                          {fromMinorUnits(diff, a.currencyCode)}
                        </dd>
                      </>
                    ) : null}
                    {detailsById.get(a.id)?.accountNumberMasked ||
                    detailsById.get(a.id)?.ibanMasked ? (
                      <>
                        <dt className="text-muted-foreground">Account</dt>
                        <dd className="text-right font-mono text-xs">
                          {detailsById.get(a.id)?.sortCodeMasked
                            ? `${detailsById.get(a.id)?.sortCodeMasked} `
                            : ""}
                          {detailsById.get(a.id)?.accountNumberMasked ??
                            detailsById.get(a.id)?.ibanMasked}
                        </dd>
                      </>
                    ) : null}
                    <dt className="text-muted-foreground">To review / matched</dt>
                    <dd className="text-right">
                      {a.uncategorisedCount} / {a.matchedCount}
                    </dd>
                  </dl>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" asChild>
                      <Link
                        to="/banking/transactions"
                        search={{ ...search, status: "uncategorised" } as never}
                      >
                        For review ({a.uncategorisedCount})
                      </Link>
                    </Button>
                    <Button size="sm" variant="outline" asChild>
                      <Link to="/banking/reconcile" search={search as never}>
                        Reconcile
                      </Link>
                    </Button>
                    <Button size="sm" variant="outline" asChild>
                      <Link to="/banking/import" search={search as never}>
                        Import
                      </Link>
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2 border-t pt-2">
                    {editingId === a.id ? (
                      <>
                        <Button
                          size="sm"
                          disabled={!editName.trim() || updateM.isPending}
                          onClick={() => updateM.mutate({ id: a.id, name: editName })}
                        >
                          Save
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditingId(a.id);
                          setEditName(a.name);
                        }}
                      >
                        Rename
                      </Button>
                    )}
                    <BankAccountDetailsDialog
                      companyId={companyId}
                      bankAccountId={a.id}
                      accountName={a.name}
                      currencyCode={a.currencyCode}
                      details={detailsById.get(a.id)}
                    />
                    {a.isActive ? (
                      <ConfirmButton
                        variant="ghost"
                        title={`Archive ${a.name}?`}
                        description={
                          a.unreconciledCount > 0
                            ? `${a.unreconciledCount} statement lines are not reconciled yet. Archiving hides the account from pickers; history and journals stay.`
                            : "Archiving hides the account from pickers; history and journals stay."
                        }
                        confirmLabel="Archive"
                        onConfirm={() => updateM.mutate({ id: a.id, isActive: false })}
                      >
                        Archive
                      </ConfirmButton>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => updateM.mutate({ id: a.id, isActive: true })}
                      >
                        Restore
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {archivedCount > 0 ? (
        <Button
          size="sm"
          variant="link"
          className="mb-6 px-0"
          onClick={() => setShowArchived((v) => !v)}
        >
          {showArchived ? "Hide" : "Show"} {archivedCount} archived account
          {archivedCount === 1 ? "" : "s"}
        </Button>
      ) : null}

      <div className="grid max-w-lg gap-3 rounded-md border p-4">
        <Label>Add bank / cash account</Label>
        <Input
          placeholder="Name (e.g. Operating account)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Select value={glAccountId} onValueChange={setGlAccountId}>
          <SelectTrigger aria-label="GL account">
            <SelectValue placeholder="GL account" />
          </SelectTrigger>
          <SelectContent>
            {glOptions.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.code} — {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={currency ?? baseCurrency} onValueChange={setCurrency}>
          <SelectTrigger aria-label="Currency">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.keys(DEFAULT_CURRENCY_DECIMALS).map((c) => (
              <SelectItem key={c} value={c}>
                {c}
                {c === baseCurrency ? " (base currency)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(currency ?? baseCurrency) !== baseCurrency ? (
          <p className="text-xs text-muted-foreground">
            Foreign-currency bank accounts keep their own currency for statements. Ledger journals
            post in your base currency; no revaluation is performed here.
          </p>
        ) : null}
        <Button
          size="sm"
          disabled={createM.isPending || !name.trim() || !glAccountId}
          onClick={() => createM.mutate()}
        >
          Add account
        </Button>
      </div>
    </>
  );
}
