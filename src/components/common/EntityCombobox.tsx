"use client";

import type { ComponentProps } from "react";
import { LookupSelect } from "@/components/lookup/LookupSelect";
import type { LookupOption } from "@/lib/lookup/types";

/** @deprecated Prefer `LookupOption` from `@/components/lookup`. Kept for existing forms. */
export type EntityOption = {
  value: string;
  label: string;
  description?: string;
  keywords?: string;
  group?: string;
};

type Props = {
  options: EntityOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  loading?: boolean;
  allowClear?: boolean;
  className?: string;
  clientFilter?: boolean;
  search?: string;
  onSearchChange?: (q: string) => void;
  "aria-label"?: string;
  onAddNew?: (() => void) | undefined;
  addNewLabel?: string | undefined;
  canAddNew?: boolean | undefined;
  id?: string;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
  companyId?: string | null | undefined;
  error?: string | null;
  onRetry?: () => void;
  renderCreate?: ComponentProps<typeof LookupSelect>["renderCreate"];
  createTitle?: string;
  onCreated?: ((option: LookupOption) => void) | undefined;
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;
};

/**
 * Record lookup used by existing sales and purchase forms.
 * Implemented on LookupSelect so search, grouping, keyboard and create behaviour stay consistent.
 */
export function EntityCombobox({
  options,
  value,
  onChange,
  placeholder,
  searchPlaceholder,
  emptyText,
  disabled,
  loading,
  allowClear,
  className,
  clientFilter,
  search,
  onSearchChange,
  "aria-label": ariaLabel,
  onAddNew,
  addNewLabel,
  canAddNew,
  id,
  required,
  invalid,
  describedBy,
  companyId,
  error,
  onRetry,
  renderCreate,
  createTitle,
  onCreated,
  hasMore,
  onLoadMore,
  loadingMore,
}: Props) {
  const lookupOptions: LookupOption[] = options.map((option) => ({
    id: option.value,
    label: option.label,
    description: option.description,
    keywords: option.keywords,
    group: option.group,
  }));

  return (
    <LookupSelect
      options={lookupOptions}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      emptyText={emptyText}
      disabled={disabled}
      loading={loading}
      allowClear={allowClear}
      className={className}
      clientFilter={clientFilter}
      search={search}
      onSearchChange={onSearchChange}
      ariaLabel={ariaLabel}
      onCreate={onAddNew}
      createLabel={addNewLabel}
      canCreate={canAddNew}
      id={id}
      required={required}
      invalid={invalid}
      describedBy={describedBy}
      companyId={companyId}
      error={error}
      onRetry={onRetry}
      renderCreate={renderCreate}
      createTitle={createTitle}
      onCreated={onCreated}
      hasMore={hasMore}
      onLoadMore={onLoadMore}
      loadingMore={loadingMore}
    />
  );
}
