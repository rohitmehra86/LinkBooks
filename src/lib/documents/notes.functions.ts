import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertUuid } from "@/lib/company-validation";
import { assertEntityAccess } from "@/lib/documents/attachments.functions";
import { isAttachmentEntityType, type AttachmentEntityType } from "@/lib/documents/attachments";
import {
  activityDetail,
  notePreview,
  normaliseInternalNote,
} from "@/lib/documents/record-activity";

const MIGRATION_HINT =
  "Notes and activity need a database update that has not been applied yet (migration 20261025400400). Ask an administrator to apply the latest migrations.";

function entityInput(input: { companyId: string; entityType: string; entityId: string }) {
  if (!isAttachmentEntityType(input.entityType)) {
    throw new Error("Notes cannot be added to this record type.");
  }
  return {
    companyId: assertUuid(input.companyId),
    entityType: input.entityType as AttachmentEntityType,
    entityId: assertUuid(input.entityId, "record"),
  };
}

export type DocumentNote = {
  id: string;
  body: string;
  created_at: string;
  created_by: string | null;
  created_by_name: string;
};

export type DocumentActivity = {
  id: string;
  action: string;
  created_at: string;
  actor_user_id: string | null;
  actor_name: string;
  detail: string;
};

async function actorNames(
  supabase: Parameters<typeof assertEntityAccess>[0],
  ids: Array<string | null>,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (!unique.length) return names;
  const { data } = await supabase.from("profiles").select("id, full_name, email").in("id", unique);
  for (const profile of (data ?? []) as Array<{ id: string; full_name: string; email: string }>) {
    const name = profile.full_name?.trim() || profile.email?.trim() || "";
    if (name) names.set(profile.id, name);
  }
  return names;
}

function missingMigration(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === "42P01" ||
    error.code === "42883" ||
    /document_internal_notes|list_document_activity/i.test(error.message ?? "")
  );
}

export const listDocumentNotes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(entityInput)
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertEntityAccess(supabase, data.companyId, data.entityType, "view");
    const { data: rows, error } = await supabase
      .from("document_internal_notes" as never)
      .select("id, body, created_at, created_by" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("entity_type" as never, data.entityType as never)
      .eq("entity_id" as never, data.entityId as never)
      .order("created_at" as never, { ascending: false } as never);
    if (error) {
      if (missingMigration(error)) throw new Error(MIGRATION_HINT);
      throw new Error(error.message);
    }
    const list = (rows ?? []) as unknown as Array<{
      id: string;
      body: string;
      created_at: string;
      created_by: string | null;
    }>;
    const names = await actorNames(
      supabase,
      list.map((row) => row.created_by),
    );
    return list.map((row): DocumentNote => ({
      ...row,
      created_by_name: (row.created_by && names.get(row.created_by)) || "",
    }));
  });

export const addDocumentNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; entityType: string; entityId: string; body: string }) => {
      const base = entityInput(input);
      const note = normaliseInternalNote(input.body ?? "");
      if (!note.ok) throw new Error(note.error);
      return { ...base, body: note.body };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertEntityAccess(supabase, data.companyId, data.entityType, "manage");
    const { data: row, error } = await supabase
      .from("document_internal_notes" as never)
      .insert({
        company_id: data.companyId,
        entity_type: data.entityType,
        entity_id: data.entityId,
        body: data.body,
        created_by: userId,
      } as never)
      .select("id" as never)
      .single();
    if (error) {
      if (missingMigration(error)) throw new Error(MIGRATION_HINT);
      if (error.code === "42501") throw new Error("You do not have permission to add a note here.");
      throw new Error(error.message);
    }
    const id = (row as unknown as { id: string }).id;
    await (
      supabase as unknown as {
        rpc: (
          fn: string,
          args: Record<string, unknown>,
        ) => Promise<{ error: { message: string } | null }>;
      }
    ).rpc("record_audit_event", {
      _company_id: data.companyId,
      _action: "document.note.add",
      _entity_type: data.entityType,
      _entity_id: data.entityId,
      _details: { note_id: id, body_preview: notePreview(data.body) },
    });
    return { id };
  });

export const listDocumentActivity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(entityInput)
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertEntityAccess(supabase, data.companyId, data.entityType, "view");
    const { data: rows, error } = await (
      supabase as unknown as {
        rpc: (
          fn: string,
          args: Record<string, unknown>,
        ) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>;
      }
    ).rpc("list_document_activity", {
      _company_id: data.companyId,
      _entity_type: data.entityType,
      _entity_id: data.entityId,
    });
    if (error) {
      if (missingMigration(error)) throw new Error(MIGRATION_HINT);
      throw new Error(error.message);
    }
    const list = (rows ?? []) as Array<{
      id: string;
      action: string;
      created_at: string;
      actor_user_id: string | null;
      actor_name: string | null;
      details: unknown;
    }>;
    return list.map((row): DocumentActivity => ({
      id: row.id,
      action: row.action,
      created_at: row.created_at,
      actor_user_id: row.actor_user_id,
      actor_name: row.actor_name ?? "",
      detail: activityDetail(row.details),
    }));
  });
