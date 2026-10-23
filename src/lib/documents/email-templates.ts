/**
 * E-mail templates. Pure: render subject / plain text / HTML from plain data.
 * Every value that reaches HTML is escaped; links must be http(s).
 */
import { formatDate, formatMoney } from "@/lib/format/format";
import type { DocumentKind } from "@/lib/documents/types";

export const EMAIL_TEMPLATES = [
  "invoice",
  "reminder",
  "statement",
  "receipt",
  "quote",
  "credit_note",
  "purchase_order",
  "remittance",
] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

export function isEmailTemplate(v: unknown): v is EmailTemplate {
  return typeof v === "string" && (EMAIL_TEMPLATES as readonly string[]).includes(v);
}

/** The template a document kind is normally sent with. Reminders are chosen explicitly. */
export function defaultTemplateFor(kind: DocumentKind): EmailTemplate | null {
  switch (kind) {
    case "sales_invoice":
      return "invoice";
    case "sales_quote":
      return "quote";
    case "sales_receipt":
      return "receipt";
    case "sales_credit_note":
      return "credit_note";
    case "purchase_order":
      return "purchase_order";
    case "supplier_remittance":
      return "remittance";
    // Bills and supplier credit notes are received documents: nothing is sent to anyone.
    default:
      return null;
  }
}

export type EmailInput = {
  companyName: string;
  partyName: string;
  /** "Invoice", "Quote" ... shown in the subject. */
  documentLabel: string;
  documentNumber: string | null;
  currency: string;
  totalMinor: number;
  /** Outstanding amount; null when not applicable. */
  dueMinor: number | null;
  issueDate: string | null;
  dueDate: string | null;
  daysOverdue: number;
  /** Public read-only link to the document, when one exists. */
  link: string | null;
  /** Optional sender note, added before the sign-off. */
  customMessage: string | null;
  locale: string | null;
  dateFormat: string | null;
  bankDetails: string | null;
  /** Statement summary (statement template only). */
  statement?: {
    from: string | null;
    to: string | null;
    rows: Array<{ currency: string; openingMinor: number; closingMinor: number }>;
  };
};

export type RenderedEmail = { subject: string; text: string; html: string };

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function safeHttpLink(url: string | null | undefined): string | null {
  const u = (url ?? "").trim();
  return /^https?:\/\/[^\s<>"']+$/i.test(u) ? u : null;
}

function ref(i: EmailInput): string {
  return i.documentNumber ? `${i.documentLabel} ${i.documentNumber}` : i.documentLabel;
}

function paragraphs(i: EmailInput, kind: EmailTemplate): string[] {
  const m = (n: number) => formatMoney(n, i.currency, i.locale);
  const d = (s: string | null) => formatDate(s, i.locale, i.dateFormat);
  const hi = `Hello ${i.partyName},`;
  const link = safeHttpLink(i.link);
  const viewLine = link ? `View it online: ${link}` : null;
  const out: Array<string | null> = [hi];
  switch (kind) {
    case "invoice":
      out.push(
        `Please find ${ref(i)} from ${i.companyName} for ${m(i.totalMinor)}${
          i.dueDate ? `, due on ${d(i.dueDate)}` : ""
        }.`,
        viewLine,
        i.bankDetails ? `Payment details:\n${i.bankDetails}` : null,
      );
      break;
    case "reminder":
      out.push(
        i.daysOverdue > 0
          ? `This is a reminder that ${ref(i)} from ${i.companyName} was due on ${d(i.dueDate)} and is ${i.daysOverdue} day${
              i.daysOverdue === 1 ? "" : "s"
            } overdue. The outstanding amount is ${m(i.dueMinor ?? i.totalMinor)}.`
          : `This is a reminder that ${ref(i)} from ${i.companyName} is due on ${d(i.dueDate)}. The outstanding amount is ${m(
              i.dueMinor ?? i.totalMinor,
            )}.`,
        viewLine,
        i.bankDetails ? `Payment details:\n${i.bankDetails}` : null,
        "If you have already paid, please ignore this message and accept our thanks.",
      );
      break;
    case "statement": {
      const rows = i.statement?.rows ?? [];
      const period =
        i.statement?.from || i.statement?.to
          ? ` for ${i.statement?.from ? d(i.statement.from) : "the start"} to ${i.statement?.to ? d(i.statement.to) : "today"}`
          : "";
      out.push(
        `Here is your account statement${period} from ${i.companyName}.`,
        rows.length
          ? rows
              .map(
                (r) =>
                  `${r.currency}: opening balance ${formatMoney(r.openingMinor, r.currency, i.locale)}, closing balance ${formatMoney(
                    r.closingMinor,
                    r.currency,
                    i.locale,
                  )}`,
              )
              .join("\n")
          : "There is no activity to show.",
        viewLine,
      );
      break;
    }
    case "receipt":
      out.push(
        `Thank you. We have received your payment of ${m(i.totalMinor)}${i.issueDate ? ` on ${d(i.issueDate)}` : ""}.`,
        viewLine,
      );
      break;
    case "quote":
      out.push(
        `Please find ${ref(i)} from ${i.companyName} for ${m(i.totalMinor)}.`,
        viewLine,
        "Reply to this email to accept or ask for changes.",
      );
      break;
    case "credit_note":
      out.push(
        `${ref(i)} from ${i.companyName} for ${m(i.totalMinor)} has been issued to your account.`,
        viewLine,
      );
      break;
    case "purchase_order":
      out.push(`Please find ${ref(i)} from ${i.companyName} for ${m(i.totalMinor)}.`, viewLine);
      break;
    case "remittance":
      out.push(
        `${i.companyName} has paid ${m(i.totalMinor)}${i.issueDate ? ` on ${d(i.issueDate)}` : ""}.`,
        viewLine,
      );
      break;
  }
  if (i.customMessage && i.customMessage.trim()) out.push(i.customMessage.trim());
  out.push(`Kind regards,\n${i.companyName}`);
  return out.filter((p): p is string => Boolean(p));
}

export function renderSubject(kind: EmailTemplate, i: EmailInput): string {
  switch (kind) {
    case "reminder":
      return `Reminder: ${ref(i)} from ${i.companyName}${i.daysOverdue > 0 ? " is overdue" : ""}`;
    case "statement":
      return `Statement from ${i.companyName}`;
    case "receipt":
      return `Payment received${i.documentNumber ? ` (${i.documentNumber})` : ""} — ${i.companyName}`;
    case "remittance":
      return `Remittance advice from ${i.companyName}`;
    default:
      return `${ref(i)} from ${i.companyName}`;
  }
}

export function renderEmail(kind: EmailTemplate, i: EmailInput): RenderedEmail {
  const paras = paragraphs(i, kind);
  const subject = renderSubject(kind, i);
  const text = paras.join("\n\n");
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;line-height:1.5">${paras
    .map((p) => `<p style="margin:0 0 14px">${linkify(escapeHtml(p)).replace(/\n/g, "<br>")}</p>`)
    .join("")}</body></html>`;
  return { subject, text, html };
}

/** Turn already-escaped http(s) URLs into anchors. */
function linkify(escaped: string): string {
  return escaped.replace(/https?:\/\/[^\s<]+/g, (url) => {
    const safe = safeHttpLink(url.replace(/&amp;/g, "&"));
    return safe ? `<a href="${escapeHtml(safe)}">${escapeHtml(safe)}</a>` : url;
  });
}

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

export function isValidEmail(s: string): boolean {
  return s.length <= 254 && EMAIL_RE.test(s.trim());
}

/** Split "a@x.com, b@y.com" into trimmed recipients; invalid ones are returned separately. */
export function parseRecipients(raw: string): { valid: string[]; invalid: string[] } {
  const parts = raw
    .split(/[\s,;]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    if (isValidEmail(p)) {
      if (!valid.some((v) => v.toLowerCase() === p.toLowerCase())) valid.push(p);
    } else invalid.push(p);
  }
  return { valid, invalid };
}

/** mailto: link (fallback when no provider is configured). Body is truncated for URL limits. */
export function buildMailto(input: { to: string; subject: string; body: string }): string {
  const body = input.body.length > 1500 ? `${input.body.slice(0, 1500)}…` : input.body;
  const params = `subject=${encodeURIComponent(input.subject)}&body=${encodeURIComponent(body)}`;
  return `mailto:${encodeURIComponent(input.to).replace(/%40/g, "@").replace(/%2C/g, ",")}?${params}`;
}
