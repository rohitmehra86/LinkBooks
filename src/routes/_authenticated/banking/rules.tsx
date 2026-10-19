import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import { listBankRules, saveBankRule } from "@/lib/banking/banking.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/banking/rules")({
  head: () => ({ meta: [{ title: "Bank rules — LinkBooks" }] }),
  component: BankRules,
});

function BankRules() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const qc = useQueryClient();
  const fetchRules = useServerFn(listBankRules);
  const fetchGl = useServerFn(listAccounts);
  const save = useServerFn(saveBankRule);

  const [name, setName] = useState("");
  const [pattern, setPattern] = useState("");
  const [matchType, setMatchType] = useState("contains");
  const [offsetAccountId, setOffsetAccountId] = useState("");

  const rulesQ = useQuery({
    queryKey: ["bank-rules", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchRules({ data: { companyId: companyId! } }),
  });
  const glQ = useQuery({
    queryKey: ["accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchGl({ data: { companyId: companyId! } }),
  });
  const offsets = ((glQ.data ?? []) as Array<{ id: string; code: string; name: string; is_postable: boolean; is_active: boolean }>)
    .filter((a) => a.is_active && a.is_postable);

  const createM = useMutation({
    mutationFn: () => save({
      data: {
        companyId: companyId!, name, matchField: "description", matchPattern: pattern,
        matchType, offsetAccountId,
      },
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["bank-rules", companyId] });
      toast.success("Rule saved");
      setName(""); setPattern("");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  return (
    <>
      <PageHeader title="Bank rules"
        description="Suggest / auto-categorise repeating description patterns. Rules never invent feed connections." />
      <div className="mb-8 grid max-w-lg gap-3 rounded-md border p-4">
        <Label>New rule</Label>
        <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <Input placeholder="Description contains…" value={pattern} onChange={(e) => setPattern(e.target.value)} />
        <Select value={matchType} onValueChange={setMatchType}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="contains">Contains</SelectItem>
            <SelectItem value="equals">Equals</SelectItem>
            <SelectItem value="starts_with">Starts with</SelectItem>
          </SelectContent>
        </Select>
        <Select value={offsetAccountId} onValueChange={setOffsetAccountId}>
          <SelectTrigger><SelectValue placeholder="Offset account" /></SelectTrigger>
          <SelectContent>{offsets.map((a) => (
            <SelectItem key={a.id} value={a.id}>{a.code} — {a.name}</SelectItem>
          ))}</SelectContent>
        </Select>
        <Button size="sm" disabled={createM.isPending || !name || !pattern || !offsetAccountId}
          onClick={() => createM.mutate()}>Save rule</Button>
      </div>
      {rulesQ.isPending ? <LoadingState /> : rulesQ.isError ? (
        <ErrorState title="Could not load rules" description={friendlyAuthError(rulesQ.error)} />
      ) : (rulesQ.data ?? []).length === 0 ? (
        <EmptyState title="No rules" description="Create a matching rule above." />
      ) : (
        <Table>
          <TableHeader><TableRow>
            <TableHead>Name</TableHead><TableHead>Pattern</TableHead><TableHead>Offset</TableHead><TableHead>Active</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {(rulesQ.data as Array<{
              id: string; name: string; match_pattern: string; match_type: string; is_active: boolean;
              accounts: { code: string; name: string } | null;
            }>).map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.name}</TableCell>
                <TableCell>{r.match_type} “{r.match_pattern}”</TableCell>
                <TableCell>{r.accounts ? `${r.accounts.code}` : "—"}</TableCell>
                <TableCell><Badge variant="secondary">{r.is_active ? "yes" : "no"}</Badge></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
