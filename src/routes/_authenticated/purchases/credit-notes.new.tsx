import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import {
  getBill,
  listBills,
  listSuppliers,
  saveAndAuthoriseCreditNote,
} from "@/lib/purchases/purchases.functions";
import { parseMinorOrThrow, tryParseMinor } from "@/lib/purchases/money-input";
import {
  billAcceptsCredit,
  billOutstandingMinor,
  linesFromBill,
  suggestedAllocationMinor,
  type BillForCredit,
  type CreditFormLine,
} from "@/lib/purchases/credit-lines";
import { DEFAULT_CURRENCY_DECIMALS, fromMinorUnits } from "@/lib/accounting/money";
import { useCan } from "@/hooks/use-can";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, EmptyState } from "@/components/common/states";
import { AccountLookup, ContactLookup, LookupSelect } from "@/components/lookup";
import { AccountCreateForm, ContactCreateForm } from "@/components/lookup/create-forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/_authenticated/purchases/credit-notes/new")({
  validateSearch: (s: Record<string, unknown>): { billId?: string } =>
    typeof s["billId"] === "string" && s["billId"] ? { billId: s["billId"] } : {},
  component: NewCreditNote,
});

let lineKeySeed = 0;
const newKey = () => `l${++lineKeySeed}`;
const blankLine = (): CreditFormLine => ({
  key: newKey(),
  description: "",
  accountId: "",
  net: "0.00",
  tax: "0.00",
});

export function NewCreditNote() {
  const { company } = useActiveCompany();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const queryClient = useQueryClient();
  const fetchSuppliers = useServerFn(listSuppliers);
  const fetchAccounts = useServerFn(listAccounts);
  const fetchBills = useServerFn(listBills);
  const fetchBill = useServerFn(getBill);
  const save = useServerFn(saveAndAuthoriseCreditNote);
  const { can } = useCan();
  const companyId = company?.id;
  const baseCurrency = company?.base_currency ?? "GBP";
  const today = new Date().toISOString().slice(0, 10);

  const [contactId, setContactId] = useState("");
  const [creditDate, setCreditDate] = useState(today);
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<CreditFormLine[]>([blankLine()]);
  const [billId, setBillId] = useState(search.billId ?? "");
  const [fxRate, setFxRate] = useState("");
  const [billCurrency, setBillCurrency] = useState<string | null>(null);

  const suppliersQ = useQuery({
    queryKey: ["suppliers", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchSuppliers({ data: { companyId: companyId! } }),
  });
  const accountsQ = useQuery({
    queryKey: ["accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });
  const billsQ = useQuery({
    queryKey: ["credit-note-bills", companyId, contactId],
    enabled: Boolean(companyId && contactId),
    queryFn: () => fetchBills({ data: { companyId: companyId!, contactId, limit: 100 } }),
  });
  const openBills = (billsQ.data?.rows ?? []).filter(
    (b) => billAcceptsCredit(b.status) && b.balance_due_minor > 0,
  );

  // Arriving from a bill (?billId=) fills the supplier and lines once.
  const prefillQ = useQuery({
    queryKey: ["credit-note-prefill", companyId, search.billId],
    enabled: Boolean(companyId && search.billId),
    queryFn: () => fetchBill({ data: { companyId: companyId!, billId: search.billId! } }),
  });

  const supplierCurrency = (
    (suppliersQ.data ?? []) as Array<{ id: string; default_currency: string | null }>
  ).find((x) => x.id === contactId)?.default_currency;
  const currency = (billCurrency || supplierCurrency || baseCurrency).toUpperCase();
  const foreign = currency !== baseCurrency.toUpperCase();

  const billToCredit = (b: NonNullable<typeof prefillBill>): BillForCredit => ({
    id: b.id,
    status: b.status,
    currency_code: b.currency_code,
    fx_rate_to_base: b.fx_rate_to_base,
    total_minor: b.total_minor,
    amount_paid_minor: b.amount_paid_minor,
    amount_credited_minor: b.amount_credited_minor,
    lines: (b.purchase_bill_lines ?? []).map((l) => ({
      description: l.description,
      account_id: l.account_id ?? null,
      net_minor: l.net_minor,
      tax_minor: l.tax_minor,
    })),
  });

  const applyBill = (bill: BillForCredit & { contact_id?: string }) => {
    setBillId(bill.id);
    setBillCurrency(bill.currency_code);
    setFxRate(
      bill.fx_rate_to_base && bill.fx_rate_to_base !== 1 ? String(bill.fx_rate_to_base) : "",
    );
    const d = DEFAULT_CURRENCY_DECIMALS[(bill.currency_code ?? baseCurrency).toUpperCase()] ?? 2;
    const copied = linesFromBill(bill, d, newKey);
    if (copied.length) setLines(copied);
  };

  const prefillBill = prefillQ.data;
  const prefilled = useRef(false);
  useEffect(() => {
    if (!prefillBill || prefilled.current) return;
    prefilled.current = true;
    setContactId(prefillBill.contact_id);
    applyBill(billToCredit(prefillBill));
    // applyBill only sets state; it is intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillBill]);

  const chooseBill = async (id: string) => {
    if (id === "__none__") {
      setBillId("");
      setBillCurrency(null);
      return;
    }
    try {
      const b = await fetchBill({ data: { companyId: companyId!, billId: id } });
      applyBill(billToCredit(b));
    } catch (e) {
      toast.error(friendlyAuthError(e));
    }
  };

  const accounts = (
    (accountsQ.data ?? []) as Array<{
      id: string;
      code: string;
      name: string;
      is_postable: boolean;
      is_active: boolean;
    }>
  ).filter((a) => a.is_active && a.is_postable);

  const update = (key: string, patch: Partial<CreditFormLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const parsed = lines.map((l) => ({
    net: tryParseMinor(l.net || "0", currency),
    tax: tryParseMinor(l.tax || "0", currency),
  }));
  const anyInvalid = parsed.some((p) => p.net === null || p.tax === null);
  const totalMinor = parsed.reduce((sum, p) => sum + Number((p.net ?? 0n) + (p.tax ?? 0n)), 0);
  const incomplete = lines.some((l) => !l.description.trim() || !l.accountId);
  const fxInvalid = foreign && fxRate.trim() !== "" && !(Number(fxRate) > 0);

  const chosenBill = openBills.find((b) => b.id === billId);
  const allocateMinor = chosenBill
    ? suggestedAllocationMinor(totalMinor, {
        id: chosenBill.id,
        status: chosenBill.status,
        currency_code: chosenBill.currency_code,
        fx_rate_to_base: chosenBill.fx_rate_to_base,
        total_minor: chosenBill.total_minor,
        amount_paid_minor: chosenBill.amount_paid_minor,
        amount_credited_minor: chosenBill.amount_credited_minor,
        lines: [],
      })
    : 0;

  const mutation = useMutation({
    mutationFn: (authorise: boolean) =>
      save({
        data: {
          companyId: companyId!,
          contactId,
          creditDate,
          currencyCode: currency,
          ...(memo.trim() ? { memo } : {}),
          authorise,
          ...(foreign && fxRate.trim() ? { fxRateToBase: Number(fxRate) } : {}),
          ...(authorise && chosenBill && allocateMinor > 0
            ? { allocations: [{ billId: chosenBill.id, amountMinor: allocateMinor }] }
            : {}),
          lines: lines.map((l) => ({
            description: l.description,
            accountId: l.accountId,
            netMinor: Number(parseMinorOrThrow(l.net || "0", currency, "Net amount")),
            taxMinor: Number(parseMinorOrThrow(l.tax || "0", currency, "Tax")),
          })),
        },
      }),
    onSuccess: async (r) => {
      await queryClient.invalidateQueries({ queryKey: ["credits", companyId] });
      await queryClient.invalidateQueries({ queryKey: ["bills", companyId] });
      toast.success(r.journalId ? "Credit note authorised and posted" : "Draft credit note saved");
      if (r.allocationError) toast.error(`Not applied to the bill: ${r.allocationError}`);
      navigate({
        to: "/purchases/credit-notes/$creditNoteId",
        params: { creditNoteId: r.id },
      });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (suppliersQ.isPending || accountsQ.isPending) return <LoadingState />;

  const blocked =
    mutation.isPending || anyInvalid || incomplete || fxInvalid || !contactId || totalMinor <= 0;

  return (
    <>
      <PageHeader
        title="New credit note"
        description="Reduce AP and reverse expense/tax on authorise. Pick a bill to copy its lines and apply the credit to it."
      />
      <div className="grid max-w-3xl gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Supplier</Label>
            <ContactLookup
              ariaLabel="Supplier"
              contacts={((suppliersQ.data ?? []) as Array<{ id: string; name: string }>).map(
                (supplier) => ({ ...supplier, kind: "supplier" }),
              )}
              value={contactId}
              companyId={companyId}
              placeholder="Select supplier"
              allowClear={false}
              canCreate={can("contacts.manage")}
              createTitle="New supplier"
              renderCreate={
                can("contacts.manage")
                  ? (ctx) => <ContactCreateForm companyId={companyId} kind="supplier" ctx={ctx} />
                  : undefined
              }
              onChange={(v) => {
                setContactId(v);
                setBillId("");
                setBillCurrency(null);
              }}
            />
          </div>
          <div className="space-y-2">
            <Label>Date</Label>
            <Input type="date" value={creditDate} onChange={(e) => setCreditDate(e.target.value)} />
          </div>
        </div>

        <div className="space-y-2">
          <Label>Credit from a bill (optional)</Label>
          <LookupSelect
            ariaLabel="Credit from bill"
            disabled={!contactId}
            allowClear={false}
            value={billId || "__none__"}
            onChange={(v) => void chooseBill(v)}
            placeholder={contactId ? "Not linked to a bill" : "Choose a supplier first"}
            searchPlaceholder="Search bill reference or date"
            options={[
              { id: "__none__", label: "Not linked to a bill" },
              ...openBills.map((b) => ({
                id: b.id,
                label: b.display_reference ?? b.bill_number ?? b.id.slice(0, 8),
                description: `${b.bill_date} — owes ${fromMinorUnits(b.balance_due_minor, b.currency_code)}`,
                meta: b.currency_code,
                keywords: `${b.display_reference ?? ""} ${b.bill_number ?? ""} ${b.bill_date}`,
              })),
            ]}
          />
          {chosenBill ? (
            <p className="text-xs text-muted-foreground">
              On authorise, {fromMinorUnits(allocateMinor, currency)} {currency} is applied to this
              bill (it still owes{" "}
              {fromMinorUnits(
                billOutstandingMinor({
                  total_minor: chosenBill.total_minor,
                  amount_paid_minor: chosenBill.amount_paid_minor,
                  amount_credited_minor: chosenBill.amount_credited_minor,
                }),
                currency,
              )}
              ).
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label>Lines ({currency})</Label>
          {lines.map((l, i) => (
            <div key={l.key} className="grid gap-2 sm:grid-cols-[1fr_14rem_7rem_7rem_auto]">
              <Input
                aria-label={`Line ${i + 1} description`}
                placeholder="Description"
                value={l.description}
                onChange={(e) => update(l.key, { description: e.target.value })}
              />
              <AccountLookup
                ariaLabel={`Line ${i + 1} account`}
                accounts={accounts}
                value={l.accountId}
                onChange={(v) => update(l.key, { accountId: v })}
                companyId={companyId}
                placeholder="Account"
                allowClear={false}
                canCreate={can("accounts.manage")}
                createTitle="New account"
                renderCreate={
                  can("accounts.manage")
                    ? (ctx) => (
                        <AccountCreateForm
                          companyId={companyId}
                          currency={currency}
                          initialKind="expense"
                          ctx={ctx}
                        />
                      )
                    : undefined
                }
              />
              <Input
                aria-label={`Line ${i + 1} net`}
                value={l.net}
                inputMode="decimal"
                aria-invalid={tryParseMinor(l.net || "0", currency) === null}
                onChange={(e) => update(l.key, { net: e.target.value })}
              />
              <Input
                aria-label={`Line ${i + 1} tax`}
                value={l.tax}
                inputMode="decimal"
                aria-invalid={tryParseMinor(l.tax || "0", currency) === null}
                onChange={(e) => update(l.key, { tax: e.target.value })}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={lines.length === 1}
                onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
              >
                Remove
              </Button>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setLines((ls) => [...ls, blankLine()])}
            >
              Add line
            </Button>
            <span className="text-sm">
              Credit total{" "}
              <strong className="tabular-nums">
                {fromMinorUnits(totalMinor, currency)} {currency}
              </strong>
            </span>
          </div>
          <p className="text-xs text-muted-foreground">Columns: description, account, net, tax.</p>
        </div>

        {foreign ? (
          <div className="space-y-2">
            <Label>
              Exchange rate ({currency} to {baseCurrency})
            </Label>
            <Input
              value={fxRate}
              inputMode="decimal"
              placeholder="Leave blank to use the stored rate"
              aria-invalid={fxInvalid}
              onChange={(e) => setFxRate(e.target.value)}
            />
          </div>
        ) : null}

        <div className="space-y-2">
          <Label>Memo</Label>
          <Input value={memo} maxLength={500} onChange={(e) => setMemo(e.target.value)} />
        </div>

        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={blocked || !can("purchases.draft")}
            onClick={() => mutation.mutate(false)}
          >
            Save draft
          </Button>
          <Button
            size="sm"
            disabled={blocked || !can("purchases.authorise")}
            onClick={() => mutation.mutate(true)}
          >
            {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Authorise & post
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/purchases/credit-notes">Cancel</Link>
          </Button>
        </div>
      </div>
    </>
  );
}
