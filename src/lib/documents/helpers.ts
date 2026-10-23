/** Pure helpers for printable documents. No I/O. */
import type { PrintLine, PrintMark, PrintTaxRow } from "@/lib/documents/types";

export const DEFAULT_ACCENT = "#0F766E";

/** Valid #RRGGBB or the default accent. Used before putting a colour into CSS. */
export function safeAccentColor(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  return /^#[0-9A-Fa-f]{6}$/.test(v) ? v.toUpperCase() : DEFAULT_ACCENT;
}

/** Black or white, whichever reads better on the accent colour (WCAG luminance). */
export function readableTextOn(hex: string): "#000000" | "#FFFFFF" {
  const h = safeAccentColor(hex).slice(1);
  const ch = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const lum = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  return lum > 0.35 ? "#000000" : "#FFFFFF";
}

/** Join non-empty address parts into display lines; "city, region postal" share one line. */
export function addressLines(parts: {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postal?: string | null;
  country?: string | null;
}): string[] {
  const clean = (s: string | null | undefined) => (s ?? "").trim();
  const out: string[] = [];
  if (clean(parts.line1)) out.push(clean(parts.line1));
  if (clean(parts.line2)) out.push(clean(parts.line2));
  const cityLine = [
    clean(parts.city),
    [clean(parts.region), clean(parts.postal)].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");
  if (cityLine) out.push(cityLine);
  if (clean(parts.country)) out.push(clean(parts.country));
  return out;
}

/** Split a free-text multi-line address into trimmed non-empty lines (max 8). */
export function textToLines(text: string | null | undefined, max = 8): string[] {
  return (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, max);
}

/** One row per tax rate, rates descending. Amounts are sums of the printed lines. */
export function buildTaxSummary(
  lines: Pick<PrintLine, "taxRateBps" | "netMinor" | "taxMinor">[],
): PrintTaxRow[] {
  const byRate = new Map<number, PrintTaxRow>();
  for (const l of lines) {
    const row = byRate.get(l.taxRateBps) ?? { rateBps: l.taxRateBps, netMinor: 0, taxMinor: 0 };
    row.netMinor += l.netMinor;
    row.taxMinor += l.taxMinor;
    byRate.set(l.taxRateBps, row);
  }
  return [...byRate.values()].sort((a, b) => b.rateBps - a.rateBps);
}

/** Tax % for display: 2000 -> "20%", 1250 -> "12.5%". */
export function formatRatePercent(bps: number): string {
  const n = Math.round(Number(bps) || 0) / 100;
  return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

/** Quantity without trailing zeros: "2.000000" -> "2", "1.5" -> "1.5". */
export function formatQuantity(q: number | string): string {
  const n = Number(q);
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n * 1e6) / 1e6);
}

/**
 * The corner stamp. Void and draft always win. "PAID" only for documents that are
 * actually settled (status paid, or nothing outstanding on a posted invoice / bill).
 */
export function documentMark(input: {
  kind: string;
  status: string;
  outstandingMinor: number | null;
  totalMinor: number;
}): PrintMark | null {
  const s = input.status;
  if (s === "void" || s === "cancelled") return "VOID";
  if (s === "draft") return "DRAFT";
  const settleable = input.kind === "sales_invoice" || input.kind === "purchase_bill";
  if (settleable) {
    if (s === "paid") return "PAID";
    if (
      (s === "authorised" || s === "partly_paid") &&
      input.totalMinor > 0 &&
      input.outstandingMinor !== null &&
      input.outstandingMinor <= 0
    ) {
      return "PAID";
    }
  }
  return null;
}

/** "Payment terms: 30 days" style line from invoice and due dates (both ISO). */
export function paymentTermsText(issueDate: string, dueDate: string | null): string | null {
  if (!dueDate) return null;
  const a = Date.parse(`${issueDate.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${dueDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const days = Math.round((b - a) / 86_400_000);
  if (days < 0) return null;
  if (days === 0) return "Due on receipt";
  return `Payment terms: ${days} day${days === 1 ? "" : "s"} from the invoice date`;
}

/** Days overdue (positive) for an ISO due date and "today"; 0 when not overdue. */
export function daysOverdue(dueDate: string, today: string): number {
  const a = Date.parse(`${dueDate.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${today.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/** A safe file name for downloads / the browser's "Save as PDF" title. */
export function documentFileName(label: string, number: string | null, id: string): string {
  const raw = `${label}-${number ?? id.slice(0, 8)}`;
  return raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
