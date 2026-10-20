import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listBankAccounts } from "@/lib/banking/banking.functions";
import { PageHeader, EmptyState, LoadingState } from "@/components/common/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/banking/feeds")({
  head: () => ({ meta: [{ title: "Bank feeds — LinkBooks" }] }),
  component: BankFeeds,
});

function BankFeeds() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const fetchAccounts = useServerFn(listBankAccounts);
  const accountsQ = useQuery({
    queryKey: ["bank-accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  return (
    <>
      <PageHeader
        title="Bank feed connections"
        description="Live bank feeds require a configured provider. CSV import remains fully supported without a feed."
        actions={
          <Button size="sm" variant="outline" asChild>
            <Link to="/banking/import">Import CSV</Link>
          </Button>
        }
      />

      <Alert className="mb-4">
        <AlertTitle>No feed provider configured</AlertTitle>
        <AlertDescription>
          LinkBooks does not fabricate live syncs. When a provider (e.g. TrueLayer / Plaid) is
          connected with credentials, accounts will show connected / syncing / error statuses from{" "}
          <code>bank_feed_connections</code>. Until then, use Import CSV.
        </AlertDescription>
      </Alert>

      {accountsQ.isPending ? (
        <LoadingState />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Account</TableHead>
              <TableHead>Currency</TableHead>
              <TableHead>Feed status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(
              (accountsQ.data ?? []) as Array<{
                id: string;
                name: string;
                currency_code: string;
                feed: { status: string; provider?: string | null };
              }>
            ).map((a) => (
              <TableRow key={a.id}>
                <TableCell>{a.name}</TableCell>
                <TableCell>{a.currency_code}</TableCell>
                <TableCell>
                  <Badge variant="outline">{a.feed?.status ?? "disconnected"}</Badge>
                  {a.feed?.provider ? (
                    <span className="ml-2 text-xs text-muted-foreground">{a.feed.provider}</span>
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
