import { describe, expect, it } from "vitest";
import { ATTACHMENT_ENTITIES, ATTACHMENT_ENTITY_TYPES } from "@/lib/documents/attachments";
import {
  NOTE_MAX_LENGTH,
  activityActionLabel,
  activityDetail,
  activityEmptyMessage,
  entityManagePermissions,
  entityViewPermissions,
  moneyRecordKinds,
  moneyRecordMeta,
  normaliseInternalNote,
  notePlaceholder,
  notePreview,
  notesEmptyMessage,
} from "@/lib/documents/record-activity";

describe("internal notes", () => {
  it("trims a note and rejects an empty one", () => {
    expect(normaliseInternalNote("  Kept on the record.  ")).toEqual({
      ok: true,
      body: "Kept on the record.",
    });
    expect(normaliseInternalNote("   ")).toEqual({
      ok: false,
      error: "Write a note before saving.",
    });
  });

  it("caps a note at 4000 characters", () => {
    expect(normaliseInternalNote("a".repeat(NOTE_MAX_LENGTH)).ok).toBe(true);
    const tooLong = normaliseInternalNote("a".repeat(NOTE_MAX_LENGTH + 1));
    expect(tooLong).toEqual({ ok: false, error: "Notes are limited to 4000 characters." });
  });

  it("tells the user a note is not printed", () => {
    expect(notePlaceholder("customer")).toBe("Internal note (not printed on customer documents)");
    expect(notePlaceholder("supplier")).toBe("Internal note (not printed on supplier documents)");
    expect(notePlaceholder("internal")).toBe("Internal note (not printed on documents)");
    const preview = notePreview(`${"word ".repeat(40)}end`);
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(160);
  });

  it("explains when history starts", () => {
    expect(notesEmptyMessage(false)).toBe("Notes are saved with this draft.");
    expect(notesEmptyMessage(true)).toBe("No notes yet.");
    expect(activityEmptyMessage(false)).toBe("Activity appears after the first save.");
    expect(activityEmptyMessage(true)).toBe("No activity yet.");
  });
});

describe("activity rows", () => {
  it("labels note and file events and keeps a short detail", () => {
    expect(activityActionLabel("document.note.add")).toBe("Note added");
    expect(activityActionLabel("document.attachment.upload")).toBe("File added");
    expect(activityActionLabel("document.attachment.delete")).toBe("File removed");
    expect(activityDetail({ file_name: "invoice.pdf", size_bytes: 12 })).toBe("invoice.pdf");
    expect(activityDetail({ body_preview: "Called the supplier", actor_name: "Ada" })).toBe(
      "Called the supplier",
    );
    expect(activityDetail({ journal_id: "abc", posted: true })).toBe(
      "journal_id: abc · posted: true",
    );
    expect(activityDetail(null)).toBe("");
  });
});

describe("record permissions", () => {
  it("registers every document that can hold notes, files and activity", () => {
    for (const entityType of ATTACHMENT_ENTITY_TYPES) {
      const info = ATTACHMENT_ENTITIES[entityType];
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.manage.length).toBeGreaterThan(0);
      expect(info.path("00000000-0000-4000-8000-000000000000").startsWith("/")).toBe(true);
    }
    expect(entityViewPermissions("sales_invoice")).toEqual(["sales.view"]);
    expect(entityManagePermissions("sales_invoice")).toContain("sales.draft");
    expect(entityViewPermissions("product")).toEqual([
      "products.manage",
      "sales.view",
      "purchases.view",
    ]);
    expect(entityManagePermissions("purchase_expense")).toEqual(["purchases.draft"]);
    expect(entityViewPermissions("contact")).toEqual([]);
  });

  it("maps each money document kind onto its own permission and table kind", () => {
    const kinds = moneyRecordKinds();
    expect(kinds).toEqual([
      "sales_receipt",
      "customer_refund",
      "supplier_refund",
      "receive_money",
      "bank_deposit",
      "card_payment",
      "bank_adjustment",
    ]);
    const types = new Set<string>();
    for (const kind of kinds) {
      const meta = moneyRecordMeta(kind);
      expect(meta).not.toBeNull();
      types.add(meta!.entityType);
      expect(ATTACHMENT_ENTITIES[meta!.entityType].table).toBe("money_documents");
      expect(ATTACHMENT_ENTITIES[meta!.entityType].kind).toBe(kind);
      expect(entityManagePermissions(meta!.entityType).length).toBeGreaterThan(0);
    }
    expect(types.size).toBe(kinds.length);
    expect(moneyRecordMeta("invoice")).toBeNull();
    expect(moneyRecordMeta("card_payment")?.audience).toBe("internal");
    expect(moneyRecordMeta("sales_receipt")?.audience).toBe("customer");
    expect(moneyRecordMeta("supplier_refund")?.audience).toBe("supplier");
  });
});
