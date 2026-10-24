/**
 * Internal notes and activity history for any attachment-backed record.
 * Pure: the server functions and the record footer both use these rules.
 * Notes are never copied onto printed or emailed customer/supplier documents.
 */
import { ATTACHMENT_ENTITIES, type AttachmentEntityType } from "@/lib/documents/attachments";
import type { Permission } from "@/lib/permissions";

export const NOTE_MAX_LENGTH = 4000;

export type NoteAudience = "customer" | "supplier" | "internal";

export function normaliseInternalNote(
  raw: string,
): { ok: true; body: string } | { ok: false; error: string } {
  const body = raw.trim();
  if (!body) return { ok: false, error: "Write a note before saving." };
  if (body.length > NOTE_MAX_LENGTH) {
    return { ok: false, error: "Notes are limited to 4000 characters." };
  }
  return { ok: true, body };
}

export function notePlaceholder(audience: NoteAudience): string {
  if (audience === "customer") return "Internal note (not printed on customer documents)";
  if (audience === "supplier") return "Internal note (not printed on supplier documents)";
  return "Internal note (not printed on documents)";
}

export function notesEmptyMessage(hasRecord: boolean): string {
  return hasRecord ? "No notes yet." : "Notes are saved with this draft.";
}

export function activityEmptyMessage(hasRecord: boolean): string {
  return hasRecord ? "No activity yet." : "Activity appears after the first save.";
}

const ACTION_LABELS: Record<string, string> = {
  "document.note.add": "Note added",
  "document.attachment.upload": "File added",
  "document.attachment.delete": "File removed",
  "bill.note.add": "Note added",
  "bill.draft.create": "Draft created",
  "bill.draft.update": "Draft updated",
  "bill.authorise": "Authorised",
  "project.create": "Project created",
  "recurring_journal.save": "Template saved",
};

export function activityActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replaceAll("_", " ").replaceAll(".", " · ");
}

/** One readable line for the activity table. Internal actor names are not repeated here. */
export function activityDetail(details: unknown): string {
  if (details == null) return "";
  if (typeof details === "string") return details.slice(0, 240);
  if (typeof details !== "object" || Array.isArray(details)) return "";
  const record = details as Record<string, unknown>;
  const fileName = record["file_name"];
  const preview = record["body_preview"];
  if (typeof fileName === "string" && fileName.trim()) return fileName;
  if (typeof preview === "string" && preview.trim()) return preview;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (key === "actor_name") continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}: ${value}`);
    }
  }
  return parts.join(" · ").slice(0, 240);
}

export function notePreview(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}…` : trimmed;
}

/** Permissions that allow reading notes, files and activity. Empty means any member. */
export function entityViewPermissions(entityType: AttachmentEntityType): Permission[] {
  const info = ATTACHMENT_ENTITIES[entityType];
  if (info.viewAny && info.viewAny.length > 0) return info.viewAny;
  return info.view ? [info.view] : [];
}

export function entityManagePermissions(entityType: AttachmentEntityType): Permission[] {
  return ATTACHMENT_ENTITIES[entityType].manage;
}

const MONEY_RECORDS: Record<string, { entityType: AttachmentEntityType; audience: NoteAudience }> =
  {
    sales_receipt: { entityType: "money_sales_receipt", audience: "customer" },
    customer_refund: { entityType: "money_customer_refund", audience: "customer" },
    supplier_refund: { entityType: "money_supplier_refund", audience: "supplier" },
    receive_money: { entityType: "money_receive", audience: "internal" },
    bank_deposit: { entityType: "money_deposit", audience: "internal" },
    card_payment: { entityType: "money_card_payment", audience: "internal" },
    bank_adjustment: { entityType: "money_adjustment", audience: "internal" },
  };

export function moneyRecordMeta(
  kind: string,
): { entityType: AttachmentEntityType; audience: NoteAudience } | null {
  return MONEY_RECORDS[kind] ?? null;
}

export function moneyRecordKinds(): string[] {
  return Object.keys(MONEY_RECORDS);
}
