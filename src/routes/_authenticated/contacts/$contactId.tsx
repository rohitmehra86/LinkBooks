import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { useCanDo } from "@/hooks/use-can";
import {
  getContact,
  getContactBalances,
  upsertContact,
  archiveContact,
  upsertContactPerson,
  deleteContactPerson,
  listContactGroups,
  listContactTags,
  setContactGroups,
  setContactTags,
} from "@/lib/contacts/contacts.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";

export const Route = createFileRoute("/_authenticated/contacts/$contactId")({
  head: () => ({ meta: [{ title: "Contact — LinkBooks" }] }),
  component: ContactDetail,
});

function ContactDetail() {
  const { contactId } = Route.useParams();
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const qc = useQueryClient();
  const canManage = useCanDo("contacts.manage");

  const fetchContact = useServerFn(getContact);
  const fetchBalances = useServerFn(getContactBalances);
  const saveContact = useServerFn(upsertContact);
  const archiveFn = useServerFn(archiveContact);
  const savePerson = useServerFn(upsertContactPerson);
  const removePerson = useServerFn(deleteContactPerson);
  const fetchGroups = useServerFn(listContactGroups);
  const fetchTags = useServerFn(listContactTags);
  const saveGroups = useServerFn(setContactGroups);
  const saveTags = useServerFn(setContactTags);

  const contactQ = useQuery({
    queryKey: ["contact", companyId, contactId],
    enabled: Boolean(companyId),
    queryFn: () => fetchContact({ data: { companyId: companyId!, contactId } }),
  });
  const balQ = useQuery({
    queryKey: ["contact-balances", companyId, contactId],
    enabled: Boolean(companyId),
    queryFn: () => fetchBalances({ data: { companyId: companyId!, contactId } }),
  });
  const groupsQ = useQuery({
    queryKey: ["contact-groups", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchGroups({ data: { companyId: companyId! } }),
  });
  const tagsQ = useQuery({
    queryKey: ["contact-tags", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchTags({ data: { companyId: companyId! } }),
  });

  const c = contactQ.data?.contact as {
    name?: unknown;
    kind?: unknown;
    email?: unknown;
    phone?: unknown;
    tax_number?: unknown;
    payment_terms_days?: unknown;
    notes?: unknown;
    account_number?: unknown;
    legal_name?: unknown;
    website?: unknown;
    billing_address_line1?: unknown;
    billing_city?: unknown;
    billing_country?: unknown;
    archived_at?: unknown;
  } | undefined;

  const [name, setName] = useState("");
  const [kind, setKind] = useState("customer");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [taxNumber, setTaxNumber] = useState("");
  const [terms, setTerms] = useState("30");
  const [notes, setNotes] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [legalName, setLegalName] = useState("");
  const [website, setWebsite] = useState("");
  const [billingLine1, setBillingLine1] = useState("");
  const [billingCity, setBillingCity] = useState("");
  const [billingCountry, setBillingCountry] = useState("");
  const [personFirst, setPersonFirst] = useState("");
  const [personLast, setPersonLast] = useState("");
  const [personEmail, setPersonEmail] = useState("");
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  useEffect(() => {
    if (!c) return;
    setName(String(c.name ?? ""));
    setKind(String(c.kind ?? "customer"));
    setEmail(String(c.email ?? ""));
    setPhone(String(c.phone ?? ""));
    setTaxNumber(String(c.tax_number ?? ""));
    setTerms(String(c.payment_terms_days ?? 30));
    setNotes(String(c.notes ?? ""));
    setAccountNumber(String(c.account_number ?? ""));
    setLegalName(String(c.legal_name ?? ""));
    setWebsite(String(c.website ?? ""));
    setBillingLine1(String(c.billing_address_line1 ?? ""));
    setBillingCity(String(c.billing_city ?? ""));
    setBillingCountry(String(c.billing_country ?? ""));
  }, [c]);

  useEffect(() => {
    const g = (contactQ.data?.groups ?? []) as Array<{ group_id?: string; contact_groups?: { id: string } }>;
    setSelectedGroups(
      g.map((x) => x.group_id ?? x.contact_groups?.id).filter(Boolean) as string[],
    );
    const t = (contactQ.data?.tags ?? []) as Array<{ tag_id?: string; contact_tags?: { id: string } }>;
    setSelectedTags(t.map((x) => x.tag_id ?? x.contact_tags?.id).filter(Boolean) as string[]);
  }, [contactQ.data]);

  const saveM = useMutation({
    mutationFn: () =>
      saveContact({
        data: {
          companyId: companyId!,
          id: contactId,
          name,
          kind,
          email,
          phone,
          taxNumber,
          paymentTermsDays: Number(terms) || 0,
          notes,
          accountNumber,
          legalName,
          website,
          billingAddressLine1: billingLine1,
          billingCity,
          billingCountry,
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["contact", companyId, contactId] });
      toast.success("Contact updated");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const archiveM = useMutation({
    mutationFn: (restore: boolean) =>
      archiveFn({ data: { companyId: companyId!, contactId, restore } }),
    onSuccess: async (_, restore) => {
      await qc.invalidateQueries({ queryKey: ["contact", companyId, contactId] });
      await qc.invalidateQueries({ queryKey: ["contacts", companyId] });
      toast.success(restore ? "Contact restored" : "Contact archived");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const personM = useMutation({
    mutationFn: () =>
      savePerson({
        data: {
          companyId: companyId!,
          contactId,
          firstName: personFirst,
          lastName: personLast,
          email: personEmail,
          isPrimary: true,
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["contact", companyId, contactId] });
      setPersonFirst("");
      setPersonLast("");
      setPersonEmail("");
      toast.success("Person added");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const groupsM = useMutation({
    mutationFn: () =>
      saveGroups({ data: { companyId: companyId!, contactId, groupIds: selectedGroups } }),
    onSuccess: () => toast.success("Groups updated"),
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const tagsM = useMutation({
    mutationFn: () => saveTags({ data: { companyId: companyId!, contactId, tagIds: selectedTags } }),
    onSuccess: () => toast.success("Tags updated"),
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (contactQ.isPending) return <LoadingState />;
  if (contactQ.isError || !c) {
    return <ErrorState title="Contact not found" description={friendlyAuthError(contactQ.error)} />;
  }

  const people = (contactQ.data?.people ?? []) as Array<{
    id: string;
    first_name: string;
    last_name: string;
    email: string | null;
    is_primary: boolean;
  }>;

  const isCustomer = kind === "customer" || kind === "both";
  const isSupplier = kind === "supplier" || kind === "both";
  const archived = Boolean(c.archived_at);

  return (
    <>
      <PageHeader
        title={String(c.name)}
        description={`${kind} · terms ${terms} days${accountNumber ? ` · #${accountNumber}` : ""}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {isCustomer ? (
              <Button variant="outline" size="sm" asChild>
                <Link to="/sales/invoices/new">New invoice</Link>
              </Button>
            ) : null}
            {isSupplier ? (
              <Button variant="outline" size="sm" asChild>
                <Link to="/purchases/bills/new">New bill</Link>
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={archiveM.isPending || !canManage}
              title={canManage ? undefined : "You do not have permission to archive contacts"}
              onClick={() => archiveM.mutate(archived)}
            >
              {archived ? "Restore" : "Archive"}
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link to="/contacts">Directory</Link>
            </Button>
          </div>
        }
      />

      {balQ.data ? (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label={`Receivables (${balQ.data.baseCurrency})`}
            value={fromMinorUnits(balQ.data.receivableMinor, balQ.data.baseCurrency)}
            hint={otherCurrencies(balQ.data.receivableByCurrency, balQ.data.baseCurrency)}
          />
          <Metric
            label="Overdue receivables"
            value={fromMinorUnits(balQ.data.overdueReceivableMinor, balQ.data.baseCurrency)}
          />
          <Metric
            label={`Payables (${balQ.data.baseCurrency})`}
            value={fromMinorUnits(balQ.data.payableMinor, balQ.data.baseCurrency)}
            hint={otherCurrencies(balQ.data.payableByCurrency, balQ.data.baseCurrency)}
          />
          <Metric
            label="Overdue payables"
            value={fromMinorUnits(balQ.data.overduePayableMinor, balQ.data.baseCurrency)}
          />
        </div>
      ) : null}

      <Tabs defaultValue="overview">
        <TabsList className="flex h-auto flex-wrap">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="edit">Edit</TabsTrigger>
          <TabsTrigger value="people">People</TabsTrigger>
          <TabsTrigger value="groups">Groups & tags</TabsTrigger>
          <TabsTrigger value="activity">Transactions</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 space-y-3 text-sm">
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">{kind}</Badge>
            {archived ? <Badge variant="secondary">Archived</Badge> : null}
          </div>
          <p>{email || "No email"} · {phone || "No phone"}</p>
          <p>Tax ID: {taxNumber || "—"} · Legal name: {legalName || "—"}</p>
          <p>
            Billing: {[billingLine1, billingCity, billingCountry].filter(Boolean).join(", ") || "—"}
          </p>
          {notes ? (
            <p className="rounded-md border bg-muted/40 p-3 text-muted-foreground">
              Internal notes: {notes}
            </p>
          ) : null}
        </TabsContent>

        <TabsContent value="edit" className="mt-4 max-w-2xl space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Role">
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="customer">Customer</SelectItem>
                  <SelectItem value="supplier">Supplier</SelectItem>
                  <SelectItem value="both">Customer & supplier</SelectItem>
                  <SelectItem value="employee">Employee</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Account number">
              <Input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} />
            </Field>
            <Field label="Legal / business name">
              <Input value={legalName} onChange={(e) => setLegalName(e.target.value)} />
            </Field>
            <Field label="Email">
              <Input value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Phone">
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
            <Field label="Tax / VAT ID">
              <Input value={taxNumber} onChange={(e) => setTaxNumber(e.target.value)} />
            </Field>
            <Field label="Payment terms (days)">
              <Input value={terms} onChange={(e) => setTerms(e.target.value)} />
            </Field>
            <Field label="Website">
              <Input value={website} onChange={(e) => setWebsite(e.target.value)} />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Billing line 1">
              <Input value={billingLine1} onChange={(e) => setBillingLine1(e.target.value)} />
            </Field>
            <Field label="City">
              <Input value={billingCity} onChange={(e) => setBillingCity(e.target.value)} />
            </Field>
            <Field label="Country">
              <Input value={billingCountry} onChange={(e) => setBillingCountry(e.target.value)} />
            </Field>
          </div>
          <Field label={`Internal notes (${notes.length}/4000)`}>
            <Textarea
              value={notes}
              maxLength={4000}
              rows={4}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>
          <p className="text-xs text-muted-foreground">
            Internal notes never appear on customer-facing documents automatically. Changing defaults
            does not rewrite posted invoices or bills.
          </p>
          <Button disabled={saveM.isPending || !name.trim()} onClick={() => saveM.mutate()}>
            Save changes
          </Button>
        </TabsContent>

        <TabsContent value="people" className="mt-4 space-y-4">
          <div className="grid max-w-xl gap-2 rounded-md border p-3 sm:grid-cols-3">
            <Input
              placeholder="First name"
              value={personFirst}
              onChange={(e) => setPersonFirst(e.target.value)}
            />
            <Input
              placeholder="Last name"
              value={personLast}
              onChange={(e) => setPersonLast(e.target.value)}
            />
            <Input
              placeholder="Email"
              value={personEmail}
              onChange={(e) => setPersonEmail(e.target.value)}
            />
            <Button
              size="sm"
              className="sm:col-span-3"
              disabled={personM.isPending || (!personFirst.trim() && !personEmail.trim())}
              onClick={() => personM.mutate()}
            >
              Add person
            </Button>
          </div>
          {people.length === 0 ? (
            <p className="text-sm text-muted-foreground">No additional people yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {people.map((p) => (
                <li key={p.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                  <span>
                    {p.first_name} {p.last_name}
                    {p.is_primary ? " · primary" : ""}
                    {p.email ? ` · ${p.email}` : ""}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      try {
                        await removePerson({ data: { companyId: companyId!, personId: p.id } });
                        await qc.invalidateQueries({ queryKey: ["contact", companyId, contactId] });
                      } catch (e) {
                        toast.error(friendlyAuthError(e));
                      }
                    }}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="groups" className="mt-4 grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-medium">Groups</h3>
            <div className="space-y-2">
              {((groupsQ.data ?? []) as Array<{ id: string; name: string; is_active: boolean }>)
                .filter((g) => g.is_active)
                .map((g) => (
                  <label key={g.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={selectedGroups.includes(g.id)}
                      onCheckedChange={(checked) => {
                        setSelectedGroups((prev) =>
                          checked ? [...prev, g.id] : prev.filter((id) => id !== g.id),
                        );
                      }}
                    />
                    {g.name}
                  </label>
                ))}
            </div>
            <Button size="sm" className="mt-3" disabled={groupsM.isPending} onClick={() => groupsM.mutate()}>
              Save groups
            </Button>
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium">Tags</h3>
            <div className="space-y-2">
              {((tagsQ.data ?? []) as Array<{ id: string; name: string; is_active: boolean }>)
                .filter((t) => t.is_active)
                .map((t) => (
                  <label key={t.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={selectedTags.includes(t.id)}
                      onCheckedChange={(checked) => {
                        setSelectedTags((prev) =>
                          checked ? [...prev, t.id] : prev.filter((id) => id !== t.id),
                        );
                      }}
                    />
                    {t.name}
                  </label>
                ))}
            </div>
            <Button size="sm" className="mt-3" disabled={tagsM.isPending} onClick={() => tagsM.mutate()}>
              Save tags
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              Create groups and tags under Contacts → Settings.
            </p>
          </div>
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          {balQ.isPending ? (
            <LoadingState />
          ) : balQ.isError ? (
            <ErrorState title="Could not load balances" description={friendlyAuthError(balQ.error)} />
          ) : (
            <>
              <h3 className="mb-2 text-sm text-muted-foreground">Sales invoices</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Number</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(
                    balQ.data!.invoices as Array<{
                      id: string;
                      invoice_date: string;
                      invoice_number: string | null;
                      status: string;
                      total_minor: number;
                      currency_code?: string | null;
                    }>
                  ).map((i) => (
                    <TableRow key={i.id}>
                      <TableCell>
                        <Link
                          to="/sales/invoices/$invoiceId"
                          params={{ invoiceId: i.id }}
                          className="underline-offset-2 hover:underline"
                        >
                          {i.invoice_date}
                        </Link>
                      </TableCell>
                      <TableCell>{i.invoice_number ?? "—"}</TableCell>
                      <TableCell>{i.status}</TableCell>
                      <TableCell className="text-right">
                        {fromMinorUnits(i.total_minor, i.currency_code ?? currency)}{" "}
                        {i.currency_code ?? ""}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <h3 className="mb-2 mt-6 text-sm text-muted-foreground">Purchase bills</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Number</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(
                    balQ.data!.bills as Array<{
                      id: string;
                      bill_date: string;
                      bill_number: string | null;
                      status: string;
                      total_minor: number;
                      currency_code?: string | null;
                    }>
                  ).map((b) => (
                    <TableRow key={b.id}>
                      <TableCell>
                        <Link
                          to="/purchases/bills/$billId"
                          params={{ billId: b.id }}
                          className="underline-offset-2 hover:underline"
                        >
                          {b.bill_date}
                        </Link>
                      </TableCell>
                      <TableCell>{b.bill_number ?? "—"}</TableCell>
                      <TableCell>{b.status}</TableCell>
                      <TableCell className="text-right">
                        {fromMinorUnits(b.total_minor, b.currency_code ?? currency)}{" "}
                        {b.currency_code ?? ""}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function otherCurrencies(
  rows: Array<{ currency: string; outstandingMinor: number }> | undefined,
  base: string,
): string | undefined {
  const others = (rows ?? []).filter((r) => r.currency !== base.toUpperCase());
  if (!others.length) return undefined;
  return `Also ${others.map((r) => `${fromMinorUnits(r.outstandingMinor, r.currency)} ${r.currency}`).join(", ")}`;
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string | undefined }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium tabular-nums">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
