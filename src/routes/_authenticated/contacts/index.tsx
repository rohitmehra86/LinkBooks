import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Users } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listContacts, upsertContact } from "@/lib/contacts/contacts.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/contacts/")({
  head: () => ({
    meta: [
      { title: "Contacts — LinkBooks" },
      { name: "description", content: "Customers and suppliers managed in LinkBooks." },
    ],
  }),
  component: ContactsPage,
});

function ContactsPage() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const qc = useQueryClient();
  const fetch = useServerFn(listContacts);
  const upsert = useServerFn(upsertContact);
  const [kind, setKind] = useState("all");
  const [q, setQ] = useState("");
  const [name, setName] = useState("");
  const [newKind, setNewKind] = useState("customer");
  const [email, setEmail] = useState("");
  const [terms, setTerms] = useState("30");

  const query = useQuery({
    queryKey: ["contacts", companyId, kind, q],
    enabled: Boolean(companyId),
    queryFn: () => fetch({ data: { companyId: companyId!, kind, ...(q ? { q } : {}) } }),
  });

  const createM = useMutation({
    mutationFn: () => upsert({
      data: {
        companyId: companyId!, name, kind: newKind, email,
        paymentTermsDays: Number(terms) || 30,
      },
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["contacts", companyId] });
      toast.success("Contact saved");
      setName(""); setEmail("");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  return (
    <>
      <PageHeader title="Contacts"
        description="Shared customers and suppliers across sales and purchases. Requires contacts.manage to create." />
      <div className="mb-6 grid max-w-lg gap-2 rounded-md border p-4">
        <Label>New contact</Label>
        <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <Select value={newKind} onValueChange={setNewKind}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="customer">Customer</SelectItem>
            <SelectItem value="supplier">Supplier</SelectItem>
            <SelectItem value="both">Both</SelectItem>
          </SelectContent>
        </Select>
        <Input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input placeholder="Payment terms (days)" value={terms} onChange={(e) => setTerms(e.target.value)} />
        <Button size="sm" disabled={createM.isPending || !name.trim()} onClick={() => createM.mutate()}>
          Save contact
        </Button>
      </div>
      <Tabs value={kind} onValueChange={setKind}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="customers">Customers</TabsTrigger>
            <TabsTrigger value="suppliers">Suppliers</TabsTrigger>
          </TabsList>
          <Input placeholder="Search contacts" className="sm:max-w-xs" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <TabsContent value={kind} className="mt-4">
          {query.isPending ? <LoadingState /> : query.isError ? (
            <ErrorState title="Could not load contacts" description={friendlyAuthError(query.error)} />
          ) : (query.data ?? []).length === 0 ? (
            <EmptyState icon={Users} title="No contacts" description="Add a contact above." />
          ) : (
            <Table>
              <TableHeader><TableRow>
                <TableHead>Name</TableHead><TableHead>Kind</TableHead><TableHead>Email</TableHead><TableHead>Terms</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {(query.data as Array<{ id: string; name: string; kind: string; email: string | null; payment_terms_days: number }>).map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link to="/contacts/$contactId" params={{ contactId: c.id }} className="underline-offset-2 hover:underline">
                        {c.name}
                      </Link>
                    </TableCell>
                    <TableCell><Badge variant="secondary">{c.kind}</Badge></TableCell>
                    <TableCell>{c.email ?? "—"}</TableCell>
                    <TableCell>{c.payment_terms_days}d</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}
