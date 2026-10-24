"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  LookupSelect,
  type LookupCreateContext,
  type LookupSelectProps,
} from "@/components/lookup/LookupSelect";
import { useActiveCompany } from "@/hooks/use-active-company";
import { useCan } from "@/hooks/use-can";
import type { AccountKind } from "@/lib/accounting/account-kinds";
import {
  toAccountLookupOption,
  toBankLookupOption,
  toContactLookupOption,
  toProductLookupOption,
  toTaxLookupOption,
  toTrackingLookupOption,
  type AccountLookupPurpose,
  type AccountLookupRecord,
  type BankLookupRecord,
  type ContactLookupRecord,
  type ProductLookupRecord,
  type TaxLookupRecord,
  type TrackingLookupRecord,
} from "@/lib/lookup/eligibility";
import type { Permission } from "@/lib/permissions";

type Shared = Pick<
  LookupSelectProps,
  | "value"
  | "onChange"
  | "placeholder"
  | "disabled"
  | "loading"
  | "error"
  | "onRetry"
  | "allowClear"
  | "required"
  | "invalid"
  | "id"
  | "ariaLabel"
  | "describedBy"
  | "className"
  | "companyId"
  | "onCreate"
  | "createLabel"
  | "canCreate"
  | "createTitle"
  | "createStack"
  | "renderCreate"
  | "onCreated"
  | "search"
  | "onSearchChange"
  | "clientFilter"
  | "hasMore"
  | "onLoadMore"
  | "loadingMore"
>;

type ContactKind = "customer" | "supplier" | "both";

function Variant({
  options,
  searchPlaceholder,
  emptyText,
  props,
}: {
  options: LookupSelectProps["options"];
  searchPlaceholder: string;
  emptyText: string;
  props: Shared;
}) {
  return (
    <LookupSelect
      {...props}
      options={options}
      searchPlaceholder={searchPlaceholder}
      emptyText={emptyText}
    />
  );
}

function useDefaultCreate(permission: Permission, props: Shared) {
  const { company } = useActiveCompany();
  const { can, ready } = useCan();
  const companyId = props.companyId || company?.id || "";
  const currency = company?.base_currency || "GBP";
  const offered =
    ready &&
    Boolean(companyId) &&
    can(permission) &&
    props.canCreate !== false &&
    !props.renderCreate &&
    !props.onCreate;
  return { companyId, currency, offered };
}

function withDefaultCreate(
  props: Shared,
  offered: boolean,
  createTitle: string,
  renderCreate: (ctx: LookupCreateContext) => ReactNode,
): Shared {
  if (!offered) return props;
  return { ...props, createTitle: props.createTitle ?? createTitle, renderCreate };
}

function LazyForm({
  load,
  render,
}: {
  load: () => Promise<typeof import("./create-forms")>;
  render: (forms: typeof import("./create-forms")) => ReactNode;
}) {
  const [forms, setForms] = useState<typeof import("./create-forms") | null>(null);
  useEffect(() => {
    let live = true;
    void load().then((mod) => {
      if (live) setForms(mod);
    });
    return () => {
      live = false;
    };
  }, [load]);
  if (!forms) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return render(forms);
}

function accountCreateKind(
  purpose: AccountLookupPurpose,
  createKind?: AccountKind,
): AccountKind | undefined {
  if (createKind) return createKind;
  if (purpose === "income") return "revenue";
  if (purpose === "expense") return "expense";
  if (purpose === "bank") return "bank";
  return undefined;
}

function contactCreateKind(contacts: ContactLookupRecord[], createKind?: ContactKind): ContactKind {
  if (createKind) return createKind;
  const kinds = new Set(
    contacts
      .map((row) => (row.kind ?? row.contact_type ?? "").toLowerCase())
      .filter((kind) => kind === "customer" || kind === "supplier" || kind === "both"),
  );
  const customerSide = [...kinds].every((kind) => kind === "customer" || kind === "both");
  const supplierSide = [...kinds].every((kind) => kind === "supplier" || kind === "both");
  if (kinds.size > 0 && customerSide && !supplierSide) return "customer";
  if (kinds.size > 0 && supplierSide && !customerSide) return "supplier";
  return "both";
}

export function AccountLookup({
  accounts,
  purpose = "posting",
  bankGlIds,
  productKind,
  createKind,
  ...props
}: Shared & {
  accounts: AccountLookupRecord[];
  purpose?: AccountLookupPurpose;
  bankGlIds?: ReadonlySet<string>;
  productKind?: string;
  createKind?: AccountKind;
}) {
  const options = useMemo(
    () => accounts.map((row) => toAccountLookupOption(row, purpose, { bankGlIds, productKind })),
    [accounts, purpose, bankGlIds, productKind],
  );
  const create = useDefaultCreate("accounts.manage", props);
  const initialKind = accountCreateKind(purpose, createKind);
  return (
    <Variant
      options={options}
      searchPlaceholder="Search account code or name"
      emptyText="No accounts match"
      props={withDefaultCreate(props, create.offered, "New account", (ctx) => (
        <LazyForm
          load={() => import("./create-forms")}
          render={(forms) => (
            <forms.AccountCreateForm
              companyId={create.companyId}
              currency={create.currency}
              ctx={ctx}
              {...(initialKind ? { initialKind } : {})}
            />
          )}
        />
      ))}
    />
  );
}

export function ContactLookup({
  contacts,
  createKind,
  ...props
}: Shared & { contacts: ContactLookupRecord[]; createKind?: ContactKind }) {
  const options = useMemo(() => contacts.map(toContactLookupOption), [contacts]);
  const create = useDefaultCreate("contacts.manage", props);
  const kind = contactCreateKind(contacts, createKind);
  return (
    <Variant
      options={options}
      searchPlaceholder="Search contact name or code"
      emptyText="No contacts match"
      props={withDefaultCreate(
        props,
        create.offered,
        kind === "supplier" ? "New supplier" : kind === "customer" ? "New customer" : "New contact",
        (ctx) => (
          <LazyForm
            load={() => import("./create-forms")}
            render={(forms) => (
              <forms.ContactCreateForm companyId={create.companyId} kind={kind} ctx={ctx} />
            )}
          />
        ),
      )}
    />
  );
}

export function ProductLookup({
  products,
  priceRole = "sales",
  ...props
}: Shared & { products: ProductLookupRecord[]; priceRole?: "sales" | "purchase" }) {
  const options = useMemo(() => products.map(toProductLookupOption), [products]);
  const create = useDefaultCreate("products.manage", props);
  return (
    <Variant
      options={options}
      searchPlaceholder="Search SKU, name or description"
      emptyText="No products match"
      props={withDefaultCreate(props, create.offered, "New product or service", (ctx) => (
        <LazyForm
          load={() => import("./create-forms")}
          render={(forms) => (
            <forms.ProductCreateForm
              companyId={create.companyId}
              currency={create.currency}
              priceRole={priceRole}
              ctx={ctx}
            />
          )}
        />
      ))}
    />
  );
}

export function TaxLookup({
  taxes,
  today,
  usage,
  ...props
}: Shared & {
  taxes: TaxLookupRecord[];
  today: string;
  usage?: "sales" | "purchases" | "both";
}) {
  const options = useMemo(
    () => taxes.map((row) => toTaxLookupOption(row, today, usage)),
    [taxes, today, usage],
  );
  const create = useDefaultCreate("tax.settings", props);
  const appliesTo = usage ?? "both";
  return (
    <Variant
      options={options}
      searchPlaceholder="Search tax name, code or rate"
      emptyText="No tax codes match"
      props={withDefaultCreate(props, create.offered, "New tax code", (ctx) => (
        <LazyForm
          load={() => import("./create-forms")}
          render={(forms) => (
            <forms.TaxCodeCreateForm companyId={create.companyId} appliesTo={appliesTo} ctx={ctx} />
          )}
        />
      ))}
    />
  );
}

export function TrackingLookup({
  records,
  ...props
}: Shared & { records: TrackingLookupRecord[] }) {
  const options = useMemo(() => records.map(toTrackingLookupOption), [records]);
  return (
    <Variant
      options={options}
      searchPlaceholder="Search class, location or project"
      emptyText="No tracking options match"
      props={props}
    />
  );
}

export function BankLookup({
  accounts,
  excludeId,
  requiredCurrency,
  ...props
}: Shared & {
  accounts: BankLookupRecord[];
  excludeId?: string | undefined;
  requiredCurrency?: string | null | undefined;
}) {
  const options = useMemo(
    () => accounts.map((row) => toBankLookupOption(row, { excludeId, requiredCurrency })),
    [accounts, excludeId, requiredCurrency],
  );
  const create = useDefaultCreate("banking.feeds.manage", props);
  return (
    <Variant
      options={options}
      searchPlaceholder="Search bank account or currency"
      emptyText="No bank accounts match"
      props={withDefaultCreate(props, create.offered, "New bank account", (ctx) => (
        <LazyForm
          load={() => import("./create-forms")}
          render={(forms) => (
            <forms.BankAccountCreateForm
              companyId={create.companyId}
              currency={requiredCurrency || create.currency}
              ctx={ctx}
            />
          )}
        />
      ))}
    />
  );
}
