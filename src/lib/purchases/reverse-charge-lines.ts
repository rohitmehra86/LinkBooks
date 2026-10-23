import { computeBillLine, type TaxCalculationMode } from "@/lib/purchases/bill-form-helpers";

export type TaxCodeInfo = { treatment: string; recoverable: boolean };

type Lookup = {
  from: (table: string) => unknown;
};

/** Treatment and recoverability for the given tax code ids of one company. */
export async function loadTaxCodeInfo(
  supabase: unknown,
  companyId: string,
  ids: string[],
): Promise<Map<string, TaxCodeInfo>> {
  const map = new Map<string, TaxCodeInfo>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return map;
  const qb = (supabase as Lookup).from("tax_codes") as {
    select: (c: string) => {
      eq: (
        c: string,
        v: string,
      ) => {
        in: (
          c: string,
          v: string[],
        ) => PromiseLike<{
          data: Array<{
            id: string;
            treatment: string | null;
            is_recoverable: boolean | null;
          }> | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
  const { data, error } = await qb
    .select("id, treatment, is_recoverable")
    .eq("company_id", companyId)
    .in("id", unique);
  if (error) throw new Error(error.message);
  for (const r of data ?? []) {
    map.set(r.id, {
      treatment: r.treatment ?? "standard",
      recoverable: r.is_recoverable !== false,
    });
  }
  return map;
}

type EditableLine = {
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  taxRateBps: number;
  taxCodeId: string | null;
  net_minor: bigint;
  tax_minor: bigint;
  gross_minor: bigint;
};

/**
 * Bill lines on a reverse-charge code carry no supplier tax: the payable is the net amount.
 * Amounts are recomputed at a zero rate (so an inclusive price is not split), while the code's
 * rate stays on the line for the buyer's self-assessment.
 */
export function applyReverseChargeToLines<T extends EditableLine>(
  lines: T[],
  codes: Map<string, TaxCodeInfo>,
  mode: TaxCalculationMode,
): T[] {
  return lines.map((l) => {
    const info = l.taxCodeId ? codes.get(l.taxCodeId) : undefined;
    if (info?.treatment !== "reverse_charge") return l;
    const computed = computeBillLine(
      {
        quantity: l.quantity,
        unitPriceMinor: l.unitPriceMinor,
        discountMinor: l.discountMinor,
        taxRateBps: 0,
      },
      mode,
    );
    return { ...l, ...computed };
  });
}
