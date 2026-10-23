import type { CSSProperties } from "react";
import { formatDate, formatMoney } from "@/lib/format/format";
import { formatQuantity, formatRatePercent, readableTextOn } from "@/lib/documents/helpers";
import type { DocumentBranding, PrintDocument } from "@/lib/documents/types";

/**
 * Print stylesheet shared by every printable document (invoice, bill, statement ...).
 * "Save as PDF" in the browser print dialog produces the PDF; there is no server-side renderer.
 */
export const PRINT_CSS = `
.doc-sheet { font-size: 13px; line-height: 1.45; color: #111827; background: #fff; }
.doc-sheet table { border-collapse: collapse; width: 100%; }
.doc-sheet th, .doc-sheet td { padding: 6px 8px; vertical-align: top; }
.doc-sheet thead th { text-align: left; font-weight: 600; border-bottom: 2px solid var(--doc-accent); }
.doc-sheet tbody td { border-bottom: 1px solid #e5e7eb; }
.doc-sheet .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.doc-sheet thead { display: table-header-group; }
.doc-sheet tr, .doc-sheet .doc-keep { break-inside: avoid; page-break-inside: avoid; }
@media print {
  @page { size: A4; margin: 14mm; }
  html, body { background: #fff !important; }
  .doc-sheet { -webkit-print-color-adjust: exact; print-color-adjust: exact; font-size: 11.5px; box-shadow: none !important; border: 0 !important; padding: 0 !important; max-width: none !important; }
}
`;

type Props = {
  document: PrintDocument;
  branding: DocumentBranding;
  locale: string;
  dateFormat: string | null;
};

const MARK_COLOUR: Record<string, string> = {
  PAID: "#047857",
  VOID: "#b91c1c",
  DRAFT: "#6b7280",
};

export function DocumentSheet({ document: doc, branding, locale, dateFormat }: Props) {
  const m = (minor: number) => formatMoney(minor, doc.currency, locale);
  const d = (iso: string | null) => (iso ? formatDate(iso, locale, dateFormat) : "");
  const accent = branding.accentColor;
  const style = { "--doc-accent": accent } as CSSProperties;
  const hasDiscount = doc.lines.some((l) => l.discountMinor > 0);
  const multiCurrency = doc.fxRateToBase !== null && doc.currency !== doc.baseCurrency;

  return (
    <article
      className="doc-sheet relative mx-auto max-w-[820px] rounded-md border border-border p-8 shadow-sm"
      style={style}
      data-testid="document-sheet"
    >
      <style>{PRINT_CSS}</style>

      {doc.mark ? (
        <div
          aria-label={`${doc.mark} document`}
          className="pointer-events-none absolute right-8 top-24 -rotate-12 rounded border-4 px-4 py-1 text-3xl font-bold tracking-widest opacity-70"
          style={{ color: MARK_COLOUR[doc.mark] ?? "#6b7280", borderColor: MARK_COLOUR[doc.mark] }}
        >
          {doc.mark}
        </div>
      ) : null}

      <header className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          {branding.logoUrl ? (
            <img
              src={branding.logoUrl}
              alt={`${branding.displayName} logo`}
              className="mb-2 max-h-16 max-w-[220px] object-contain"
            />
          ) : null}
          <p className="text-lg font-semibold">{branding.displayName}</p>
          {branding.legalName && branding.legalName !== branding.displayName ? (
            <p className="text-gray-600">{branding.legalName}</p>
          ) : null}
          {branding.letterheadLine ? <p>{branding.letterheadLine}</p> : null}
          {branding.addressLines.map((l, i) => (
            <p key={i} className="text-gray-700">
              {l}
            </p>
          ))}
          {branding.taxNumber ? (
            <p className="text-gray-700">Tax no. {branding.taxNumber}</p>
          ) : null}
          {branding.email ? <p className="text-gray-700">{branding.email}</p> : null}
          {branding.phone ? <p className="text-gray-700">{branding.phone}</p> : null}
        </div>
        <div className="shrink-0 text-right">
          <h1
            className="inline-block rounded px-3 py-1 text-xl font-semibold uppercase tracking-wide"
            style={{ background: accent, color: readableTextOn(accent) }}
          >
            {doc.title}
          </h1>
          {doc.number ? <p className="mt-2 font-medium">No. {doc.number}</p> : null}
          <p className="text-gray-700">Date {d(doc.issueDate)}</p>
          {doc.dueDate ? <p className="text-gray-700">Due {d(doc.dueDate)}</p> : null}
          {doc.expiryDate ? <p className="text-gray-700">Valid until {d(doc.expiryDate)}</p> : null}
          {doc.reference ? <p className="text-gray-700">Ref {doc.reference}</p> : null}
          {doc.extraMeta.map((e, i) => (
            <p key={i} className="text-gray-700">
              {e.label} {e.amountMinor !== undefined ? m(e.amountMinor) : (e.value ?? "")}
            </p>
          ))}
        </div>
      </header>

      <section className="doc-keep mt-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          {doc.party.roleLabel}
        </p>
        <p className="font-medium">{doc.party.name}</p>
        {doc.party.addressLines.map((l, i) => (
          <p key={i}>{l}</p>
        ))}
        {doc.party.email ? <p>{doc.party.email}</p> : null}
        {doc.party.phone ? <p>{doc.party.phone}</p> : null}
        {doc.party.taxNumber ? <p>Tax no. {doc.party.taxNumber}</p> : null}
      </section>

      {doc.paymentAmountMinor !== null ? (
        <section className="doc-keep mt-6 rounded border border-gray-200 p-3">
          <p className="text-xs uppercase tracking-wide text-gray-500">Amount</p>
          <p className="text-2xl font-semibold">{m(doc.paymentAmountMinor)}</p>
        </section>
      ) : null}

      {doc.showLines ? (
        <table className="mt-6">
          <thead>
            <tr>
              <th>Description</th>
              <th className="num">Qty</th>
              <th className="num">Unit price</th>
              {hasDiscount ? <th className="num">Discount</th> : null}
              <th className="num">Tax</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {doc.lines.map((l, i) => (
              <tr key={i}>
                <td className="whitespace-pre-line">{l.description}</td>
                <td className="num">{formatQuantity(l.quantity)}</td>
                <td className="num">{m(l.unitPriceMinor)}</td>
                {hasDiscount ? (
                  <td className="num">{l.discountMinor > 0 ? m(l.discountMinor) : "—"}</td>
                ) : null}
                <td className="num">{formatRatePercent(l.taxRateBps)}%</td>
                <td className="num">{m(l.netMinor)}</td>
              </tr>
            ))}
            {doc.lines.length === 0 ? (
              <tr>
                <td colSpan={hasDiscount ? 6 : 5} className="text-gray-500">
                  No lines.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      ) : null}

      {doc.showLines ? (
        <div className="doc-keep mt-4 flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-[240px] flex-1">
            {doc.taxSummary.length > 0 ? (
              <table aria-label="Tax summary" className="max-w-[360px] text-xs">
                <thead>
                  <tr>
                    <th>Tax rate</th>
                    <th className="num">Net</th>
                    <th className="num">Tax</th>
                  </tr>
                </thead>
                <tbody>
                  {doc.taxSummary.map((t) => (
                    <tr key={t.rateBps}>
                      <td>{formatRatePercent(t.rateBps)}%</td>
                      <td className="num">{m(t.netMinor)}</td>
                      <td className="num">{m(t.taxMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
          <div className="w-full max-w-[280px] space-y-1">
            <TotalRow label="Subtotal" value={m(doc.totals.subtotalMinor)} />
            <TotalRow label="Tax" value={m(doc.totals.taxMinor)} />
            <TotalRow label="Total" value={m(doc.totals.totalMinor)} bold accent={accent} />
            {doc.totals.paidMinor > 0 ? (
              <TotalRow label="Paid" value={`− ${m(doc.totals.paidMinor)}`} />
            ) : null}
            {doc.totals.creditedMinor > 0 ? (
              <TotalRow label="Credited" value={`− ${m(doc.totals.creditedMinor)}`} />
            ) : null}
            {doc.totals.dueMinor !== null ? (
              <TotalRow label="Amount due" value={m(doc.totals.dueMinor)} bold accent={accent} />
            ) : null}
            {multiCurrency ? (
              <p className="pt-1 text-right text-xs text-gray-500">
                Exchange rate 1 {doc.currency} = {doc.fxRateToBase} {doc.baseCurrency}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {doc.allocations.length > 0 ? (
        <section className="doc-keep mt-6">
          <h2 className="mb-1 text-sm font-semibold">{doc.allocationsTitle ?? "Applied to"}</h2>
          <table>
            <thead>
              <tr>
                <th>Document</th>
                <th>Date</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {doc.allocations.map((a, i) => (
                <tr key={i}>
                  <td>{a.label}</td>
                  <td>{d(a.date)}</td>
                  <td className="num">{m(a.amountMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {doc.paymentTermsText ? (
        <p className="doc-keep mt-5 text-gray-700">
          <span className="font-semibold">Payment terms:</span> {doc.paymentTermsText}
        </p>
      ) : null}

      {doc.showPaymentDetails && (branding.bankDetails || branding.paymentInstructions) ? (
        <section className="doc-keep mt-4 rounded border border-gray-200 p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Payment details
          </p>
          {branding.bankDetails ? (
            <p className="whitespace-pre-line">{branding.bankDetails}</p>
          ) : null}
          {branding.paymentInstructions ? (
            <p className="mt-1 whitespace-pre-line text-gray-700">{branding.paymentInstructions}</p>
          ) : null}
        </section>
      ) : null}

      {doc.notes ? (
        <section className="doc-keep mt-4">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Notes</p>
          <p className="whitespace-pre-line">{doc.notes}</p>
        </section>
      ) : null}

      {branding.footerText ? (
        <footer className="doc-keep mt-8 border-t border-gray-200 pt-3 text-xs text-gray-600">
          <p className="whitespace-pre-line">{branding.footerText}</p>
        </footer>
      ) : null}
    </article>
  );
}

function TotalRow({
  label,
  value,
  bold,
  accent,
}: {
  label: string;
  value: string;
  bold?: boolean;
  accent?: string;
}) {
  return (
    <div
      className={`flex justify-between gap-4 ${bold ? "border-t pt-1 font-semibold" : ""}`}
      style={bold && accent ? { borderColor: accent } : undefined}
    >
      <span>{label}</span>
      <span className="num">{value}</span>
    </div>
  );
}
