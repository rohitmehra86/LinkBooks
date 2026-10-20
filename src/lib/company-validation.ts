/** Pure validators shared by server functions and unit tests. */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: unknown, label = "company"): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new Error(`Invalid ${label} id`);
  return value;
}

export type CreateCompanyInput = {
  name: string;
  legal_name?: string;
  country_code: string;
  base_currency: string;
  fiscal_year_end_month: number;
  fiscal_year_end_day: number;
  timezone: string;
};

export function validateCompanyInput(input: CreateCompanyInput): CreateCompanyInput {
  const name = (input?.name ?? "").trim();
  if (name.length < 2 || name.length > 160) throw new Error("Enter a company name (2–160 characters).");
  const country_code = (input.country_code ?? "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(country_code)) throw new Error("Choose a country.");
  const base_currency = (input.base_currency ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(base_currency)) throw new Error("Choose a base currency.");
  const m = Number(input.fiscal_year_end_month);
  const d = Number(input.fiscal_year_end_day);
  if (!Number.isInteger(m) || m < 1 || m > 12) throw new Error("Choose a financial year end month.");
  // Leap year so 29 Feb is a valid year-end day.
  const maxDay = new Date(2024, m, 0).getDate();
  if (!Number.isInteger(d) || d < 1 || d > maxDay) throw new Error("Choose a valid financial year end day.");
  const timezone = (input.timezone ?? "").trim();
  if (!timezone || timezone.length > 64) throw new Error("Choose a time zone.");
  const legal_name = (input.legal_name ?? "").trim().slice(0, 200);
  return {
    name,
    legal_name,
    country_code,
    base_currency,
    fiscal_year_end_month: m,
    fiscal_year_end_day: d,
    timezone,
  };
}

export const TAX_REGIMES = ["none", "vat", "gst", "sales_tax", "other"] as const;
export type TaxRegime = (typeof TAX_REGIMES)[number];

export function validateTaxRegime(value: unknown): TaxRegime {
  return TAX_REGIMES.includes(value as TaxRegime) ? (value as TaxRegime) : "none";
}
