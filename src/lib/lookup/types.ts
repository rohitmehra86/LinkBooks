/** A selectable record. Selection is always the unique `id`, never the display text. */
export type LookupOption = {
  id: string;
  label: string;
  code?: string | null | undefined;
  name?: string | null | undefined;
  description?: string | null | undefined;
  keywords?: string | null | undefined;
  group?: string | null | undefined;
  /** Short status such as Inactive, Not postable, or a tax effective-date state. */
  status?: string | null | undefined;
  /** Secondary metadata shown beside the label (price, currency, rate). */
  meta?: string | null | undefined;
  disabled?: boolean | undefined;
  disabledReason?: string | null | undefined;
  /** When set, the option is hidden unless it matches the active organisation. */
  companyId?: string | null | undefined;
};

export type LookupGroup = {
  heading: string | null;
  items: LookupOption[];
};

export type DuplicateMatch = {
  option: LookupOption;
  exact: boolean;
};
