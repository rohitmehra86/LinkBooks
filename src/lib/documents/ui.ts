import type { EmailTemplate } from "@/lib/documents/email-templates";

export const TEMPLATE_LABEL: Record<EmailTemplate, string> = {
  invoice: "Invoice",
  reminder: "Overdue reminder",
  statement: "Statement",
  receipt: "Payment receipt",
  quote: "Quote",
  credit_note: "Credit note",
  purchase_order: "Purchase order",
  remittance: "Remittance advice",
};

export const EMAIL_NOT_CONFIGURED_TEXT =
  "Email sending is not configured. Download the PDF, copy the link, or use your own email program.";

/** Triggers a browser download from a short-lived signed URL. */
export function openSignedDownload(url: string, fileName: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
