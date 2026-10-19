import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Landmark } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import { createBankAccount, listBankAccounts } from "@/lib/banking/banking.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";

export const Route = createFileRoute("/_authenticated/banking/")({
  head: () => ({
    meta: [
      { title: "Banking — LinkBooks" },
      { name: "description", content: "Bank and cash accounts, CSV import and reconciliation." },
    ],
  }),
  component: BankingAccounts,
});

function BankingAccounts() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const qc = useQueryClient();
  const fetchAccounts = useServerFn(listBankAccounts);
  const fetchGl = useServerFn(listAccounts);
  const create = useServerFn(createBankAccount);

  const [name, setName] = useState("");
  const [glAccountId, setGlAccountId] = useState("");

  const query = useQuery({
    queryKey: ["bank-accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });
  const glQ = useQuery({
    queryKey: ["accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchGl({ data: { companyId: companyId! } }),
  });

  const glOptions = ((glQ.data ?? []) as Array<{ id: string; code: string; name: string; is_postable: boolean; is_active: boolean; account_type: string }>)
    .filter((a) => a.is_active && a.is_postable && a.account_type === "asset");

  const createM = useMutation({
    mutationFn: () => create({
      data: { companyId: companyId!, name, currencyCode: currency, glAccountId },
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["bank-accounts", companyId] });
      toast.success("Bank account created");
      setName(""); setGlAccountId("");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  return (
    <>
      <PageHeader title="Bank & cash accounts"
        description="Link bank/cash accounts to ledger GL codes. Live bank feeds appear only when a provider connection exists."
        actions={<Button size="sm" asChild><Link to="/banking/import">Import CSV</Link></Button>} />

      <Alert className="mb-6">
        <AlertDescription>
          Bank feeds: no provider is connected for this organisation. Use CSV import. Do not treat an empty feed list as a successful sync.
        </AlertDescription>
      </Alert>

      <div className="mb-8 grid max-w-lg gap-3 rounded-md border p-4">
        <Label>Add bank / cash account</Label>
        <Input placeholder="Name (e.g. Operating account)" value={name} onChange={(e) => setName(e.target.value)} />
        <Select value={glAccountId} onValueChange={setGlAccountId}>
          <SelectTrigger><SelectValue placeholder="GL account" /></SelectTrigger>
          <SelectContent>
            {glOptions.map((a) => (
              <SelectItem key={a.id} value={a.id}>{a.code} — {a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" disabled={createM.isPending || !name || !glAccountId} onClick={() => createM.mutate()}>
          Add account
        </Button>
      </div>

      {query.isPending ? <LoadingState /> : query.isError ? (
        <ErrorState title="Could not load accounts" description={friendlyAuthError(query.error)} />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState icon={Landmark} title="No bank accounts" description="Add a bank or cash account linked to a GL code." />
      ) : (
        <Table>
          <TableHeader><TableRow>
            <TableHead>Name</TableHead><TableHead>Currency</TableHead><TableHead>GL</TableHead><TableHead>Feed</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {(query.data as Array<{
              id: string; name: string; currency_code: string; is_active: boolean;
              accounts: { code: string; name: string } | null;
              feed: { status: string; provider: string | null };
            }>).map((a) => (
              <TableRow key={a.id}>
                <TableCell>
                  <Link to="/banking/transactions" className="underline-offset-2 hover:underline">
                    {a.name}
                  </Link>
                </TableCell>
                <TableCell>{a.currency_code}</TableCell>
                <TableCell>{a.accounts ? `${a.accounts.code} — ${a.accounts.name}` : "—"}</TableCell>
                <TableCell>
                  <Badge variant="outline">{a.feed?.status ?? "disconnected"}</Badge>
                  {!a.feed?.provider ? (
                    <span className="ml-2 text-xs text-muted-foreground">not configured</span>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
