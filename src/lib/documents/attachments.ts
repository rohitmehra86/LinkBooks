/**
 * Document attachments: entity registry, validation and storage paths. Pure.
 * `can_access_attachment` and `document_entity_exists` in migration 20261025400400
 * mirror ATTACHMENT_ENTITIES (table, kind, view, manage).
 */
import { extensionOf, validateAttachmentFile } from "@/lib/purchases/bill-form-helpers";
import type { Permission } from "@/lib/permissions";

export const COMPANY_DOCUMENTS_BUCKET = "company-documents";
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export const ATTACHMENT_ENTITY_TYPES = [
  "sales_invoice",
  "sales_quote",
  "sales_credit_note",
  "sales_receipt",
  "purchase_bill",
  "purchase_order",
  "purchase_credit_note",
  "contact",
  "journal",
  "company",
  "purchase_expense",
  "product",
  "recurring_journal",
  "project",
  "bank_transfer",
  "money_sales_receipt",
  "money_customer_refund",
  "money_supplier_refund",
  "money_receive",
  "money_deposit",
  "money_card_payment",
  "money_adjustment",
] as const;
export type AttachmentEntityType = (typeof ATTACHMENT_ENTITY_TYPES)[number];

export function isAttachmentEntityType(v: unknown): v is AttachmentEntityType {
  return typeof v === "string" && (ATTACHMENT_ENTITY_TYPES as readonly string[]).includes(v);
}

type EntityInfo = {
  label: string;
  /** Table that proves the entity exists in the company (null = the company itself). */
  table: string | null;
  /** When set, the row must also have this `kind` (money documents share one table). */
  kind?: string;
  /** Single view permission. Ignored when viewAny is set. Null means any member. */
  view: Permission | null;
  /** Any one of these may view. Use when the record is shared across modules. */
  viewAny?: Permission[];
  /** Any one of these lets the user add / remove files and notes. */
  manage: Permission[];
  /** App route for "open record" links. */
  path: (id: string) => string;
};

export const ATTACHMENT_ENTITIES: Record<AttachmentEntityType, EntityInfo> = {
  sales_invoice: {
    label: "Invoice",
    table: "sales_invoices",
    view: "sales.view",
    manage: ["sales.draft"],
    path: (id) => `/sales/invoices/${id}`,
  },
  sales_quote: {
    label: "Quote",
    table: "sales_quotes",
    view: "sales.view",
    manage: ["sales.draft"],
    path: (id) => `/sales/quotes/${id}`,
  },
  sales_credit_note: {
    label: "Credit note",
    table: "sales_credit_notes",
    view: "sales.view",
    manage: ["sales.draft"],
    path: (id) => `/sales/credit-notes/${id}`,
  },
  sales_receipt: {
    label: "Receipt",
    table: "sales_receipts",
    view: "sales.view",
    manage: ["sales.draft"],
    path: (id) => `/sales/receipts/${id}`,
  },
  purchase_bill: {
    label: "Bill",
    table: "purchase_bills",
    view: "purchases.view",
    manage: ["purchases.draft"],
    path: (id) => `/purchases/bills/${id}`,
  },
  purchase_order: {
    label: "Purchase order",
    table: "purchase_orders",
    view: "purchases.view",
    manage: ["purchases.draft"],
    path: () => `/purchases/orders`,
  },
  purchase_credit_note: {
    label: "Supplier credit note",
    table: "purchase_credit_notes",
    view: "purchases.view",
    manage: ["purchases.draft"],
    path: (id) => `/purchases/credit-notes/${id}`,
  },
  contact: {
    label: "Contact",
    table: "contacts",
    view: null,
    manage: ["contacts.manage"],
    path: (id) => `/contacts/${id}`,
  },
  journal: {
    label: "Journal",
    table: "journals",
    view: "accounting.view",
    manage: ["accounting.post"],
    path: () => `/accounting`,
  },
  company: {
    label: "Unfiled",
    table: null,
    view: null,
    manage: ["sales.draft", "purchases.draft", "accounting.post"],
    path: () => `/files`,
  },
  purchase_expense: {
    label: "Expense",
    table: "purchase_expenses",
    view: "purchases.view",
    manage: ["purchases.draft"],
    path: (id) => `/purchases/expenses/${id}`,
  },
  product: {
    label: "Product",
    table: "products",
    view: null,
    viewAny: ["products.manage", "sales.view", "purchases.view"],
    manage: ["products.manage"],
    path: () => `/products-services`,
  },
  recurring_journal: {
    label: "Recurring journal",
    table: "recurring_journal_templates",
    view: "accounting.view",
    manage: ["journals.manual"],
    path: () => `/accounting`,
  },
  project: {
    label: "Project",
    table: "projects",
    view: null,
    viewAny: ["accounting.view", "accounts.manage"],
    manage: ["accounts.manage"],
    path: () => `/projects`,
  },
  bank_transfer: {
    label: "Bank transfer",
    table: "bank_transfers",
    view: "banking.view",
    manage: ["banking.categorise"],
    path: () => `/banking/transfers`,
  },
  money_sales_receipt: {
    label: "Sales receipt",
    table: "money_documents",
    kind: "sales_receipt",
    view: "sales.view",
    manage: ["sales.payment"],
    path: () => `/banking/money-documents`,
  },
  money_customer_refund: {
    label: "Customer refund",
    table: "money_documents",
    kind: "customer_refund",
    view: "sales.view",
    manage: ["sales.payment"],
    path: () => `/banking/money-documents`,
  },
  money_supplier_refund: {
    label: "Supplier refund",
    table: "money_documents",
    kind: "supplier_refund",
    view: "purchases.view",
    manage: ["purchases.payment"],
    path: () => `/banking/money-documents`,
  },
  money_receive: {
    label: "Receive money",
    table: "money_documents",
    kind: "receive_money",
    view: "banking.view",
    manage: ["banking.categorise"],
    path: () => `/banking/money-documents`,
  },
  money_deposit: {
    label: "Bank deposit",
    table: "money_documents",
    kind: "bank_deposit",
    view: "banking.view",
    manage: ["banking.categorise"],
    path: () => `/banking/money-documents`,
  },
  money_card_payment: {
    label: "Credit card payment",
    table: "money_documents",
    kind: "card_payment",
    view: "banking.view",
    manage: ["banking.categorise"],
    path: () => `/banking/money-documents`,
  },
  money_adjustment: {
    label: "Bank adjustment",
    table: "money_documents",
    kind: "bank_adjustment",
    view: "banking.view",
    manage: ["banking.categorise"],
    path: () => `/banking/money-documents`,
  },
};

/** Legacy / other entity types that may already exist in the table (shown read-only labels). */
export function entityLabel(entityType: string): string {
  if (isAttachmentEntityType(entityType)) return ATTACHMENT_ENTITIES[entityType].label;
  if (entityType === "recurring_bill") return "Recurring bill";
  if (entityType === "inbox_document") return "Inbox";
  return entityType.replace(/_/g, " ");
}

export function entityPath(entityType: string, entityId: string): string | null {
  return isAttachmentEntityType(entityType) ? ATTACHMENT_ENTITIES[entityType].path(entityId) : null;
}

// Archives and macro-enabled workbooks are not accepted for the Files area.
const BLOCKED_EXTENSIONS = new Set(["zip", "7z", "rar", "xlsm", "xml"]);

export const FILE_INPUT_ACCEPT = [
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".heic",
  ".csv",
  ".txt",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
].join(",");

/** Same rules as bill attachments, minus archives / macros, plus webp. */
export function validateUpload(input: {
  fileName: string;
  sizeBytes: number;
  contentType?: string | null;
}): { ok: true; ext: string } | { ok: false; error: string } {
  const name = input.fileName.trim();
  if (!name) return { ok: false, error: "File name is required" };
  const ext = extensionOf(name);
  if (BLOCKED_EXTENSIONS.has(ext))
    return { ok: false, error: `Files of type .${ext} are not accepted` };
  if (ext === "webp") {
    if (input.sizeBytes <= 0) return { ok: false, error: "File is empty" };
    if (input.sizeBytes > MAX_FILE_BYTES) return { ok: false, error: "Max file size: 20 MB" };
    const ct = (input.contentType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
    if (ct && ct !== "image/webp" && ct !== "application/octet-stream") {
      return { ok: false, error: `File content type ${ct} does not match .webp` };
    }
    return { ok: true, ext };
  }
  return validateAttachmentFile({ ...input, fileName: name });
}

/** File name safe for a storage key: no path separators or control / odd characters. */
export function safeStorageName(fileName: string): string {
  const cleaned = fileName
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+/, "");
  const base = cleaned.slice(-120);
  return base || "file";
}

export function buildStoragePath(input: {
  companyId: string;
  entityType: AttachmentEntityType;
  entityId: string;
  uniqueId: string;
  fileName: string;
}): string {
  return `${input.companyId}/${input.entityType}/${input.entityId}/${input.uniqueId}-${safeStorageName(input.fileName)}`;
}

/** Parse a storage path back into its parts, or null when it is not one of ours. */
export function parseStoragePath(
  path: string,
): { companyId: string; entityType: string; entityId: string; file: string } | null {
  const m = /^([0-9a-f-]{36})\/([a-z_]+)\/([0-9a-f-]{36})\/([^/]+)$/i.exec(path);
  if (!m) return null;
  return { companyId: m[1]!, entityType: m[2]!, entityId: m[3]!, file: m[4]! };
}

export function formatFileSize(bytes: number | null | undefined): string {
  const n = Number(bytes ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
