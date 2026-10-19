import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listCustomers, upsertCustomer } from "@/lib/sales/sales.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/sales/customers")({
  head: () => ({ meta: [{ title: "Customers — LinkBooks" }] }),
  component: Customers,
});

function Customers() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const qc = useQueryClient();
  const fetch = useServerFn(listCustomers);
  const upsert = useServerFn(upsertCustomer);
  const [q, setQ] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [terms, setTerms] = useState("30");

  const query = useQuery({
    queryKey: ["customers", companyId, q],
    enabled: Boolean(companyId),
    queryFn: () => fetch({ data: { companyId: companyId!, ...(q ? { q } : {}) } }),
  });

  const createM = useMutation({
    mutationFn: () => upsert({
      data: { companyId: companyId!, name, email, paymentTermsDays: Number(terms) || 30 },
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["customers", companyId] });
      toast.success("Customer saved");
      setName(""); setEmail("");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  return (
    <>
      <PageHeader title="Customers" description="Shared contact records. Full hub at Contacts."
        actions={<Button variant="outline" size="sm" asChild><Link to="/contacts">Open Contacts</Link></Button>} />
      <div className="mb-6 grid max-w-lg gap-2 rounded-md border p-4">
        <Label>New customer</Label>
        <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <Input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input placeholder="Payment terms (days)" value={terms} onChange={(e) => setTerms(e.target.value)} />
        <Button size="sm" disabled={createM.isPending || !name.trim()} onClick={() => createM.mutate()}>Save</Button>
      </div>
      <Input className="mb-4 max-w-xs" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
      {query.isPending ? <LoadingState /> : query.isError ? (
        <ErrorState title="Could not load" description={friendlyAuthError(query.error)} />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState title="No customers" description="Add a customer above." />
      ) : (
        <Table>
          <TableHeader><TableRow>
            <TableHead>Name</TableHead><TableHead>Email</TableHead><TableHead>Terms</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {(query.data as Array<{ id: string; name: string; email: string | null; payment_terms_days: number }>).map((c) => (
              <TableRow key={c.id}>
                <TableCell>
                  <Link to="/contacts/$contactId" params={{ contactId: c.id }} className="underline-offset-2 hover:underline">{c.name}</Link>
                </TableCell>
                <TableCell>{c.email ?? "—"}</TableCell>
                <TableCell>{c.payment_terms_days}d</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
