import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Users, Download, Upload, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  listContacts,
  upsertContact,
  getContactsDirectorySummary,
  exportContactsCsv,
} from "@/lib/contacts/contacts.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
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
      { name: "description", content: "LinkBooks contact directory for customers and suppliers." },
    ],
  }),
  component: ContactsPage,
});

type ContactRow = {
  id: string;
  name: string;
  kind: string;
  email: string | null;
  phone: string | null;
  payment_terms_days: number;
  account_number: string | null;
  is_active: boolean;
};

function ContactsPage() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const qc = useQueryClient();
  const fetch = useServerFn(listContacts);
  const upsert = useServerFn(upsertContact);
  const fetchSummary = useServerFn(getContactsDirectorySummary);
  const exportFn = useServerFn(exportContactsCsv);

  const [view, setView] = useState("all");
  const [q, setQ] = useState("");
  const [name, setName] = useState("");
  const [newKind, setNewKind] = useState("customer");
  const [email, setEmail] = useState("");
  const [terms, setTerms] = useState("30");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const kindForApi = useMemo(() => {
    if (view === "customers") return "customers";
    if (view === "suppliers") return "suppliers";
    return "all";
  }, [view]);

  const query = useQuery({
    queryKey: ["contacts", companyId, view, q],
    enabled: Boolean(companyId),
    queryFn: () =>
      fetch({
        data: {
          companyId: companyId!,
          kind: kindForApi,
          view,
          ...(q ? { q } : {}),
          includeInactive: view === "inactive" || view === "archived",
        },
      }),
  });

  const summaryQ = useQuery({
    queryKey: ["contacts-summary", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchSummary({ data: { companyId: companyId! } }),
  });

  const createM = useMutation({
    mutationFn: () =>
      upsert({
        data: {
          companyId: companyId!,
          name,
          kind: newKind,
          email,
          paymentTermsDays: Number(terms) || 30,
        },
      }),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ["contacts", companyId] });
      await qc.invalidateQueries({ queryKey: ["contacts-summary", companyId] });
      toast.success("Contact saved");
      setName("");
      setEmail("");
      window.location.href = `/contacts/${res.id}`;
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const exportM = useMutation({
    mutationFn: () =>
      exportFn({
        data: { companyId: companyId!, kind: kindForApi, includeInactive: view === "archived" },
      }),
    onSuccess: (res) => {
      const blob = new Blob([res.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `linkbooks-contacts-${view}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${res.count} contacts`);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  const summary = summaryQ.data;

  return (
    <>
      <PageHeader
        title="Contacts"
        description="One directory for customers and suppliers — shared with sales, purchases and statements."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link to="/contacts/import">
                <Upload className="mr-1 size-4" /> Import
              </Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={exportM.isPending}
              onClick={() => exportM.mutate()}
            >
              <Download className="mr-1 size-4" /> Export
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link to="/contacts/settings">
                <Settings2 className="mr-1 size-4" /> Settings
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link to="/contacts/duplicates">Duplicates</Link>
            </Button>
          </div>
        }
      />

      {summary ? (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Metric label="Active contacts" value={String(summary.activeContactCount)} />
          <Metric label="Receivables" value={fromMinorUnits(summary.receivableMinor, currency)} />
          <Metric label="Payables" value={fromMinorUnits(summary.payableMinor, currency)} />
          <Metric
            label="Overdue receivables"
            value={fromMinorUnits(summary.overdueReceivableMinor, currency)}
          />
          <Metric
            label="Overdue payables"
            value={fromMinorUnits(summary.overduePayableMinor, currency)}
          />
        </div>
      ) : null}

      <div className="mb-6 max-w-xl rounded-md border p-4">
        <div className="mb-2 flex items-center justify-between">
          <Label>Quick add</Label>
          <Button variant="ghost" size="sm" type="button" onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? "Hide" : "More fields"}
          </Button>
        </div>
        <div className="grid gap-2">
          <Input
            placeholder="Contact name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Contact name"
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <Select value={newKind} onValueChange={setNewKind}>
              <SelectTrigger aria-label="Role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="customer">Customer</SelectItem>
                <SelectItem value="supplier">Supplier</SelectItem>
                <SelectItem value="both">Customer & supplier</SelectItem>
              </SelectContent>
            </Select>
            <Input
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-label="Email"
            />
          </div>
          {showAdvanced ? (
            <Input
              placeholder="Payment terms (days)"
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              aria-label="Payment terms"
            />
          ) : null}
          <Button
            size="sm"
            disabled={createM.isPending || !name.trim()}
            onClick={() => createM.mutate()}
          >
            Save contact
          </Button>
        </div>
      </div>

      <Tabs value={view} onValueChange={setView}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <TabsList className="flex h-auto flex-wrap">
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="customers">Customers</TabsTrigger>
            <TabsTrigger value="suppliers">Suppliers</TabsTrigger>
            <TabsTrigger value="both">Both roles</TabsTrigger>
            <TabsTrigger value="recent">Recently added</TabsTrigger>
            <TabsTrigger value="updated">Recently updated</TabsTrigger>
            <TabsTrigger value="inactive">Inactive</TabsTrigger>
            <TabsTrigger value="archived">Archived</TabsTrigger>
          </TabsList>
          <Input
            placeholder="Search name, email, phone, account #, tax ID…"
            className="lg:max-w-sm"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <TabsContent value={view} className="mt-4">
          {query.isPending ? (
            <LoadingState />
          ) : query.isError ? (
            <ErrorState title="Could not load contacts" description={friendlyAuthError(query.error)} />
          ) : (query.data ?? []).length === 0 ? (
            <EmptyState icon={Users} title="No contacts" description="Add a contact above or import a CSV." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Account #</TableHead>
                  <TableHead>Roles</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Terms</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(query.data as ContactRow[]).map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link
                        to="/contacts/$contactId"
                        params={{ contactId: c.id }}
                        className="font-medium underline-offset-2 hover:underline"
                      >
                        {c.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{c.account_number ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{c.kind}</Badge>
                    </TableCell>
                    <TableCell>{c.email ?? "—"}</TableCell>
                    <TableCell>{c.phone ?? "—"}</TableCell>
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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium tabular-nums">{value}</p>
    </div>
  );
}
