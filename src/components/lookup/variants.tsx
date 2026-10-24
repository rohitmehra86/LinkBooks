"use client";

import { useMemo } from "react";
import { LookupSelect, type LookupSelectProps } from "@/components/lookup/LookupSelect";
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
  | "renderCreate"
  | "onCreated"
  | "search"
  | "onSearchChange"
  | "clientFilter"
  | "hasMore"
  | "onLoadMore"
  | "loadingMore"
>;

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

export function AccountLookup({
  accounts,
  purpose = "posting",
  bankGlIds,
  productKind,
  ...props
}: Shared & {
  accounts: AccountLookupRecord[];
  purpose?: AccountLookupPurpose;
  bankGlIds?: ReadonlySet<string>;
  productKind?: string;
}) {
  const options = useMemo(
    () => accounts.map((row) => toAccountLookupOption(row, purpose, { bankGlIds, productKind })),
    [accounts, purpose, bankGlIds, productKind],
  );
  return (
    <Variant
      options={options}
      searchPlaceholder="Search account code or name"
      emptyText="No accounts match"
      props={props}
    />
  );
}

export function ContactLookup({
  contacts,
  ...props
}: Shared & { contacts: ContactLookupRecord[] }) {
  const options = useMemo(() => contacts.map(toContactLookupOption), [contacts]);
  return (
    <Variant
      options={options}
      searchPlaceholder="Search contact name or code"
      emptyText="No contacts match"
      props={props}
    />
  );
}

export function ProductLookup({
  products,
  ...props
}: Shared & { products: ProductLookupRecord[] }) {
  const options = useMemo(() => products.map(toProductLookupOption), [products]);
  return (
    <Variant
      options={options}
      searchPlaceholder="Search SKU, name or description"
      emptyText="No products match"
      props={props}
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
  return (
    <Variant
      options={options}
      searchPlaceholder="Search tax name, code or rate"
      emptyText="No tax codes match"
      props={props}
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
  return (
    <Variant
      options={options}
      searchPlaceholder="Search bank account or currency"
      emptyText="No bank accounts match"
      props={props}
    />
  );
}
