/**
 * Pure helpers for New Bill form: due dates, tax modes, dirty tracking, attachments.
 */

import { addDaysIso } from "@/lib/sales/line-helpers";
import { computeLineAmounts, sumLines, type LineComputed } from "@/lib/purchases/line-math";
import type { TaxTreatment } from "@/lib/tax/tax-math";

export type TaxCalculationMode = "exclusive" | "inclusive" | "none";

export type PaymentTermCalc = {
  days: number;
  calculation_method: "days_after_bill_date" | "due_on_receipt" | "days_after_month_end";
};

/** Last day of the month containing `isoDate` (YYYY-MM-DD). */
export function endOfMonthIso(isoDate: string): string {
  const [y, m] = isoDate.split("-").map(Number);
  if (!y || !m) throw new Error("Invalid date");
  const last = new Date(Date.UTC(y, m, 0));
  return last.toISOString().slice(0, 10);
}

export function calculateDueDate(
  billDate: string,
  term: PaymentTermCalc | null | undefined,
): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(billDate)) throw new Error("Invalid bill date");
  if (!term) return billDate;
  const method = term.calculation_method ?? "days_after_bill_date";
  const days = Math.max(0, Math.floor(Number(term.days) || 0));
  if (method === "due_on_receipt") return billDate;
  if (method === "days_after_month_end") {
    return addDaysIso(endOfMonthIso(billDate), days);
  }
  return addDaysIso(billDate, days);
}

export function treatmentForMode(mode: TaxCalculationMode): TaxTreatment {
  return mode === "inclusive" ? "inclusive" : "exclusive";
}

export function effectiveTaxBps(mode: TaxCalculationMode, taxRateBps: number): number {
  if (mode === "none") return 0;
  return Math.min(10000, Math.max(0, Math.floor(Number(taxRateBps) || 0)));
}

export function computeBillLine(
  input: {
    quantity: number;
    unitPriceMinor: number;
    discountMinor?: number;
    taxRateBps?: number;
  },
  mode: TaxCalculationMode,
): LineComputed {
  return computeLineAmounts({
    quantity: input.quantity,
    unit_price_minor: input.unitPriceMinor,
    discount_minor: input.discountMinor ?? 0,
    tax_rate_bps: effectiveTaxBps(mode, input.taxRateBps ?? 0),
    treatment: treatmentForMode(mode),
  });
}

export function computeBillTotals(
  lines: Array<{
    quantity: number;
    unitPriceMinor: number;
    discountMinor?: number;
    taxRateBps?: number;
  }>,
  mode: TaxCalculationMode,
) {
  const computed = lines.map((l) => computeBillLine(l, mode));
  return sumLines(computed);
}

/** Max attachment size: 20 MB. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export const ATTACHMENT_ACCEPT_EXTENSIONS = [
  "pdf",
  "jpg",
  "jpeg",
  "png",
  "heic",
  "heif",
  "gif",
  "bmp",
  "tif",
  "tiff",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "xlsm",
  "csv",
  "tsv",
  "ppt",
  "pptx",
  "xml",
  "txt",
  "rtf",
  "odt",
  "ods",
  "odp",
  "zip",
  "7z",
  "rar",
] as const;

const MIME_BY_EXT: Record<string, string[]> = {
  pdf: ["application/pdf"],
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  png: ["image/png"],
  heic: ["image/heic", "image/heif"],
  heif: ["image/heic", "image/heif"],
  gif: ["image/gif"],
  bmp: ["image/bmp"],
  tif: ["image/tiff"],
  tiff: ["image/tiff"],
  doc: ["application/msword"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  xls: ["application/vnd.ms-excel"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  xlsm: ["application/vnd.ms-excel.sheet.macroEnabled.12"],
  csv: ["text/csv", "text/plain", "application/vnd.ms-excel"],
  tsv: ["text/tab-separated-values", "text/plain"],
  ppt: ["application/vnd.ms-powerpoint"],
  pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  xml: ["application/xml", "text/xml"],
  txt: ["text/plain"],
  rtf: ["application/rtf", "text/rtf"],
  odt: ["application/vnd.oasis.opendocument.text"],
  ods: ["application/vnd.oasis.opendocument.spreadsheet"],
  odp: ["application/vnd.oasis.opendocument.presentation"],
  zip: ["application/zip", "application/x-zip-compressed"],
  "7z": ["application/x-7z-compressed"],
  rar: ["application/vnd.rar", "application/x-rar-compressed"],
};

export function extensionOf(fileName: string): string {
  const parts = fileName.toLowerCase().split(".");
  return parts.length > 1 ? (parts.pop() ?? "") : "";
}

export function validateAttachmentFile(input: {
  fileName: string;
  sizeBytes: number;
  contentType?: string | null;
}): { ok: true; ext: string } | { ok: false; error: string } {
  if (input.sizeBytes <= 0) return { ok: false, error: "File is empty" };
  if (input.sizeBytes > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: "Max file size: 20 MB" };
  }
  const ext = extensionOf(input.fileName);
  if (
    !ATTACHMENT_ACCEPT_EXTENSIONS.includes(ext as (typeof ATTACHMENT_ACCEPT_EXTENSIONS)[number])
  ) {
    return { ok: false, error: `Unsupported file type .${ext || "(none)"}` };
  }
  const ct = (input.contentType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
  if (ct && ct !== "application/octet-stream") {
    const allowed = MIME_BY_EXT[ext] ?? [];
    if (allowed.length && !allowed.includes(ct)) {
      return { ok: false, error: `File content type ${ct} does not match .${ext}` };
    }
  }
  return { ok: true, ext };
}

export function canPreviewAttachment(fileName: string, contentType?: string | null): boolean {
  const ext = extensionOf(fileName);
  const ct = (contentType ?? "").toLowerCase();
  if (["pdf", "jpg", "jpeg", "png", "gif", "bmp", "txt", "csv", "tsv"].includes(ext)) return true;
  if (ct.startsWith("image/") || ct === "application/pdf" || ct.startsWith("text/")) return true;
  return false;
}

export const CANCEL_UNSAVED_MESSAGE =
  "You have unsaved changes. Would you like to save this bill before leaving?";

export type CancelDialogChoice = "save_exit" | "discard" | "continue";

/** Snapshot for dirty detection — only genuine user edits. */
export type BillFormSnapshot = {
  contactId: string;
  billDate: string;
  dueDate: string;
  dueDateManualOverride: boolean;
  paymentTermId: string;
  supplierInvoiceNumber: string;
  memo: string;
  currencyCode: string;
  taxCalculation: TaxCalculationMode;
  addressLine1: string;
  addressLine2: string;
  addressCity: string;
  addressRegion: string;
  addressPostal: string;
  addressCountry: string;
  lines: Array<{
    productId: string;
    description: string;
    accountId: string;
    quantity: string;
    unitPrice: string;
    discount: string;
    taxRateBps: string;
    taxCodeId: string;
    classOptionId: string;
    locationOptionId: string;
    projectOptionId: string;
    customerContactId: string;
    isBillable: boolean;
  }>;
  attachmentIds: string[];
  internalNoteDraft: string;
};

export function billFormSnapshotsEqual(a: BillFormSnapshot, b: BillFormSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function hasUnsavedBillChanges(
  current: BillFormSnapshot,
  baseline: BillFormSnapshot | null,
): boolean {
  if (!baseline) return false;
  return !billFormSnapshotsEqual(current, baseline);
}
