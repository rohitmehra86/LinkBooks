import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { importBankCsv, listBankAccounts, listStatementImports } from "@/lib/banking/banking.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/banking/import")({
  head: () => ({ meta: [{ title: "Import statement — LinkBooks" }] }),
  component: ImportCsv,
});

function ImportCsv() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const qc = useQueryClient();
  const fetchAccounts = useServerFn(listBankAccounts);
  const fetchImports = useServerFn(listStatementImports);
  const doImport = useServerFn(importBankCsv);
  const [bankAccountId, setBankAccountId] = useState("");
  const [filename, setFilename] = useState("statement.csv");
  const [csvText, setCsvText] = useState("");

  const accountsQ = useQuery({
    queryKey: ["bank-accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });
  const importsQ = useQuery({
    queryKey: ["bank-imports", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchImports({ data: { companyId: companyId! } }),
  });

  const mutation = useMutation({
    mutationFn: () => doImport({
      data: { companyId: companyId!, bankAccountId, filename, csvText },
    }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["bank-imports", companyId] });
      await qc.invalidateQueries({ queryKey: ["bank-transactions", companyId] });
      toast.success(
        `Imported ${r.imported}. Duplicates skipped: ${r.duplicates}. Parse errors: ${r.parseErrors}. Status: ${r.status}`,
      );
      setCsvText("");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  return (
    <>
      <PageHeader title="Import CSV"
        description="Columns: date, description, amount [, reference]. Duplicates are detected by content hash and skipped." />
      <div className="mb-8 grid max-w-2xl gap-3">
        <div className="space-y-1">
          <Label>Bank account</Label>
          <Select value={bankAccountId} onValueChange={setBankAccountId}>
            <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
            <SelectContent>
              {((accountsQ.data ?? []) as Array<{ id: string; name: string }>).map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>CSV file</Label>
          <input
            type="file"
            accept=".csv,text/csv"
            className="block text-sm"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setFilename(f.name);
              setCsvText(await f.text());
            }}
          />
        </div>
        {csvText ? (
          <p className="text-xs text-muted-foreground">{csvText.split("\n").length} lines loaded from {filename}</p>
        ) : null}
        <Button size="sm" disabled={mutation.isPending || !bankAccountId || !csvText}
          onClick={() => mutation.mutate()}>
          {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null} Import
        </Button>
      </div>
      <h3 className="mb-2 text-sm font-medium text-muted-foreground">Import history</h3>
      {importsQ.isPending ? <LoadingState /> : importsQ.isError ? (
        <ErrorState title="Could not load imports" description={friendlyAuthError(importsQ.error)} />
      ) : (importsQ.data ?? []).length === 0 ? (
        <EmptyState title="No imports yet" description="Upload a CSV statement." />
      ) : (
        <Table>
          <TableHeader><TableRow>
            <TableHead>When</TableHead><TableHead>File</TableHead><TableHead>Status</TableHead>
            <TableHead>Imported</TableHead><TableHead>Duplicates</TableHead><TableHead>Errors</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {(importsQ.data as Array<{
              id: string; created_at: string; filename: string; status: string;
              imported_count: number; duplicate_count: number; error_count: number; error_summary: string | null;
            }>).map((i) => (
              <TableRow key={i.id}>
                <TableCell>{new Date(i.created_at).toLocaleString()}</TableCell>
                <TableCell>{i.filename}</TableCell>
                <TableCell><Badge variant="secondary">{i.status}</Badge></TableCell>
                <TableCell>{i.imported_count}</TableCell>
                <TableCell>{i.duplicate_count}</TableCell>
                <TableCell title={i.error_summary ?? undefined}>{i.error_count}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
