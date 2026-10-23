import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Mail, Printer } from "lucide-react";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listCustomers } from "@/lib/sales/sales.functions";
import { getCustomerStatement } from "@/lib/sales/sales-statements.functions";
import { money } from "@/components/sales/sales-form-utils";
import { useCan } from "@/hooks/use-can";
import { useFormat } from "@/hooks/use-format";
import { getDocumentBranding, getDocumentDelivery } from "@/lib/documents/documents.functions";
import { renderEmail } from "@/lib/documents/email-templates";
import { EmailDocumentDialog } from "@/components/documents/EmailDocumentDialog";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { EntityCombobox } from "@/components/common/EntityCombobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/sales/statements")({
  head: () => ({ meta: [{ title: "Customer statements — LinkBooks" }] }),
  component: Statements,
});

export function Statements() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const fetchCustomers = useServerFn(listCustomers);
  const fetchStatement = useServerFn(getCustomerStatement);
  const [contactId, setContactId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [emailOpen, setEmailOpen] = useState(false);
  const { can } = useCan();
  const fmt = useFormat();
  const queryClient = useQueryClient();
  const fetchBranding = useServerFn(getDocumentBranding);
  const fetchDelivery = useServerFn(getDocumentDelivery);

  const customersQ = useQuery({
    queryKey: ["customers", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchCustomers({ data: { companyId: companyId! } }),
  });
  const stmtQ = useQuery({
    queryKey: ["customer-statement", companyId, contactId, from, to],
    enabled: Boolean(companyId && contactId),
    queryFn: () =>
      fetchStatement({
        data: {
          companyId: companyId!,
          contactId,
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
        },
      }),
  });

  const brandingQ = useQuery({
    queryKey: ["document-branding", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchBranding({ data: { companyId: companyId! } }),
  });
  const deliveryQ = useQuery({
    queryKey: ["document-delivery", companyId, "customer_statement", contactId],
    enabled: Boolean(companyId && contactId),
    queryFn: () =>
      fetchDelivery({
        data: { companyId: companyId!, kind: "customer_statement", id: contactId },
      }),
  });

  const customerOptions = useMemo(
    () =>
      ((customersQ.data ?? []) as Array<{ id: string; name: string }>).map((c) => ({
        value: c.id,
        label: c.name,
      })),
    [customersQ.data],
  );

  const customerName =
    ((customersQ.data ?? []) as Array<{ id: string; name: string }>).find((c) => c.id === contactId)
      ?.name ?? "Customer";

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  return (
    <>
      <PageHeader
        title="Customer statements"
        description="Chronological activity from posted invoices, receipts and credit notes, with a running balance. Print or save as PDF, or email the statement."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={!contactId || !stmtQ.data}
              onClick={() => setEmailOpen(true)}
            >
              <Mail className="mr-1 size-4" /> Email…
            </Button>
            <Button variant="outline" size="sm" onClick={() => window.print()}>
              <Printer className="mr-1 size-4" /> Print / PDF
            </Button>
          </>
        }
      />
      <div className="mb-6 flex flex-wrap gap-3">
        <div className="w-64 space-y-1">
          <Label>Customer</Label>
          <EntityCombobox
            options={customerOptions}
            value={contactId}
            onChange={setContactId}
            placeholder="Search customers"
            allowClear={false}
          />
        </div>
        <div className="space-y-1">
          <Label>From</Label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>To</Label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
      {!contactId ? (
        <EmptyState
          title="Choose a customer"
          description="Select a customer to view their statement."
        />
      ) : stmtQ.isPending ? (
        <LoadingState />
      ) : stmtQ.isError ? (
        <ErrorState title="Could not load statement" description={friendlyAuthError(stmtQ.error)} />
      ) : (
        <div className="space-y-6 print:space-y-3">
          <div className="flex items-start gap-4">
            {brandingQ.data?.branding.logoUrl ? (
              <img
                src={brandingQ.data.branding.logoUrl}
                alt="Company logo"
                className="max-h-14 max-w-[180px] object-contain"
              />
            ) : null}
            <div>
              <h2 className="text-lg font-semibold">
                {brandingQ.data?.branding.displayName ?? company?.name ?? "Organisation"}
              </h2>
              {(brandingQ.data?.branding.addressLines ?? []).map((l, i) => (
                <p key={i} className="text-sm text-muted-foreground">
                  {l}
                </p>
              ))}
              {brandingQ.data?.branding.taxNumber ? (
                <p className="text-sm text-muted-foreground">
                  Tax no. {brandingQ.data.branding.taxNumber}
                </p>
              ) : null}
              <p className="mt-1 text-sm text-muted-foreground">
                Statement for {customerName}
                {stmtQ.data.from || stmtQ.data.to
                  ? ` · ${stmtQ.data.from ?? "start"} to ${stmtQ.data.to ?? "today"}`
                  : ""}
              </p>
            </div>
          </div>
          {stmtQ.data.currencies.length === 0 ? (
            <EmptyState title="No activity" description="No posted activity for this customer." />
          ) : null}
          {stmtQ.data.currencies.map((c) => {
            const pos = stmtQ.data.position.find((p) => p.currency_code === c.currency_code);
            return (
              <section key={c.currency_code} className="space-y-2">
                <h3 className="text-sm font-medium">{c.currency_code}</h3>
                <div className="flex flex-wrap gap-4 text-sm">
                  <span>
                    Opening balance{" "}
                    <strong>{money(c.opening_balance_minor, c.currency_code)}</strong>
                  </span>
                  <span>
                    Closing balance{" "}
                    <strong>{money(c.closing_balance_minor, c.currency_code)}</strong>
                  </span>
                  {pos ? (
                    <>
                      <span>
                        Invoices outstanding today{" "}
                        <strong>{money(pos.outstandingMinor, c.currency_code)}</strong>
                      </span>
                      <span>
                        Unapplied credits{" "}
                        <strong>{money(pos.unappliedCreditMinor, c.currency_code)}</strong>
                      </span>
                      <span>
                        Unallocated receipts{" "}
                        <strong>{money(pos.unappliedReceiptMinor, c.currency_code)}</strong>
                      </span>
                    </>
                  ) : null}
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Reference</TableHead>
                      <TableHead className="text-right">Debit</TableHead>
                      <TableHead className="text-right">Credit</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell colSpan={5} className="text-muted-foreground">
                        Opening balance
                      </TableCell>
                      <TableCell className="text-right">
                        {money(c.opening_balance_minor, c.currency_code)}
                      </TableCell>
                    </TableRow>
                    {c.lines.map((l) => (
                      <TableRow key={`${l.type}-${l.id}-${l.date}`}>
                        <TableCell>{l.date}</TableCell>
                        <TableCell className="capitalize">{l.type.replace("_", " ")}</TableCell>
                        <TableCell>{l.reference ?? l.id.slice(0, 8)}</TableCell>
                        <TableCell className="text-right">
                          {l.debit_minor ? money(l.debit_minor, c.currency_code) : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {l.credit_minor ? money(l.credit_minor, c.currency_code) : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {money(l.balance_minor, c.currency_code)}
                        </TableCell>
                      </TableRow>
                    ))}
                    {c.lines.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground">
                          No posted activity in this period.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </section>
            );
          })}
          <p className="text-xs text-muted-foreground">
            Opening balance is everything owed before the start date. Each currency is shown on its
            own and never added to another.
          </p>
          {brandingQ.data?.branding.bankDetails ? (
            <p className="whitespace-pre-line text-xs">
              <span className="font-semibold">Payment details:</span>{" "}
              {brandingQ.data.branding.bankDetails}
            </p>
          ) : null}
          {deliveryQ.data && !deliveryQ.data.emailConfigured ? (
            <p className="text-xs text-muted-foreground print:hidden">
              Email sending is not configured. Download the PDF, copy the link, or use your own
              email program.
            </p>
          ) : null}
          {deliveryQ.data && deliveryQ.data.history.length > 0 ? (
            <div className="print:hidden">
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Send history
              </h3>
              <ul className="divide-y divide-border rounded border border-border text-sm">
                {deliveryQ.data.history.map((h) => (
                  <li key={h.id} className="flex flex-wrap justify-between gap-2 px-3 py-2">
                    <span>
                      to {h.to_addresses.join(", ")}
                      {h.error ? <span className="text-destructive"> — {h.error}</span> : null}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {h.status === "sent" ? "Sent" : "Failed"} · {fmt.dateTime(h.created_at)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
      {contactId && stmtQ.data && deliveryQ.data && brandingQ.data ? (
        <EmailDocumentDialog
          open={emailOpen}
          onOpenChange={setEmailOpen}
          companyId={companyId}
          kind="customer_statement"
          id={contactId}
          title={`Email statement to ${customerName}`}
          templates={["statement"]}
          defaultTemplate="statement"
          defaultTo={
            ((customersQ.data ?? []) as Array<{ id: string; email?: string | null }>).find(
              (c) => c.id === contactId,
            )?.email ?? ""
          }
          emailConfigured={deliveryQ.data.emailConfigured}
          blockedReason={deliveryQ.data.blockedReason}
          canSend={can("sales.draft")}
          extra={{
            ...(stmtQ.data.from ? { from: stmtQ.data.from } : {}),
            ...(stmtQ.data.to ? { toDate: stmtQ.data.to } : {}),
          }}
          preview={(t, message) => {
            const r = renderEmail(t, {
              companyName: brandingQ.data.branding.displayName,
              partyName: customerName,
              documentLabel: "Statement",
              documentNumber: null,
              currency: fmt.baseCurrency,
              totalMinor: 0,
              dueMinor: null,
              issueDate: null,
              dueDate: null,
              daysOverdue: 0,
              link: null,
              customMessage: message.trim() || null,
              locale: brandingQ.data.locale,
              dateFormat: brandingQ.data.dateFormat,
              bankDetails: brandingQ.data.branding.bankDetails,
              statement: {
                from: stmtQ.data.from ?? null,
                to: stmtQ.data.to ?? null,
                rows: stmtQ.data.currencies.map((c) => ({
                  currency: c.currency_code,
                  openingMinor: c.opening_balance_minor,
                  closingMinor: c.closing_balance_minor,
                })),
              },
            });
            return { subject: r.subject, body: r.text };
          }}
          onSent={() =>
            void queryClient.invalidateQueries({
              queryKey: ["document-delivery", companyId, "customer_statement", contactId],
            })
          }
        />
      ) : null}
    </>
  );
}
