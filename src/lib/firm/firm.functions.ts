import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertUuid } from "@/lib/company-validation";

const ACCESS_TO_ROLE: Record<string, string> = {
  view: "read_only",
  bookkeep: "bookkeeper",
  full: "accountant",
};

export const listMyFirms = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: memberships, error } = await context.supabase
      .from("firm_members" as never)
      .select("role, firm_id, firms(id, name, created_at)" as never)
      .eq("user_id" as never, context.userId as never);
    if (error) throw new Error(error.message);
    return (memberships ?? []).map((m) => {
      const row = m as {
        role: string;
        firm_id: string;
        firms: { id: string; name: string; created_at: string } | null;
      };
      return {
        firmId: row.firm_id,
        role: row.role,
        name: row.firms?.name ?? "Firm",
        createdAt: row.firms?.created_at ?? null,
      };
    });
  });

export const createFirm = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { name: string }) => {
    const name = (input.name ?? "").trim();
    if (name.length < 2) throw new Error("Firm name is required");
    return { name: name.slice(0, 120) };
  })
  .handler(async ({ data, context }) => {
    const { data: firm, error } = await context.supabase
      .from("firms" as never)
      .insert({ name: data.name, created_by: context.userId } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const firmId = (firm as { id: string }).id;
    const { error: mErr } = await context.supabase.from("firm_members" as never).insert({
      firm_id: firmId,
      user_id: context.userId,
      role: "owner",
    } as never);
    if (mErr) throw new Error(mErr.message);
    return { id: firmId };
  });

export const listFirmClients = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { firmId: string }) => ({ firmId: assertUuid(input.firmId) }))
  .handler(async ({ data, context }) => {
    const { data: member } = await context.supabase
      .from("firm_members" as never)
      .select("id" as never)
      .eq("firm_id" as never, data.firmId as never)
      .eq("user_id" as never, context.userId as never)
      .maybeSingle();
    if (!member) throw new Error("Not a member of this firm");

    const { data: links, error } = await context.supabase
      .from("firm_client_links" as never)
      .select("id, company_id, access_level, revoked_at, created_at, companies(name)" as never)
      .eq("firm_id" as never, data.firmId as never)
      .is("revoked_at" as never, null)
      .order("created_at" as never, { ascending: false });
    if (error) throw new Error(error.message);
    return (links ?? []) as Array<{
      id: string;
      company_id: string;
      access_level: string;
      companies: { name: string } | null;
    }>;
  });

/**
 * Link a client company the caller already owns/admins, and materialize company_membership
 * for all current firm members at the mapped role.
 */
export const linkFirmClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { firmId: string; companyId: string; accessLevel: string }) => {
      if (!["view", "bookkeep", "full"].includes(input.accessLevel)) {
        throw new Error("Invalid access level");
      }
      return {
        firmId: assertUuid(input.firmId),
        companyId: assertUuid(input.companyId),
        accessLevel: input.accessLevel,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { data: admin } = await context.supabase
      .from("firm_members" as never)
      .select("role" as never)
      .eq("firm_id" as never, data.firmId as never)
      .eq("user_id" as never, context.userId as never)
      .maybeSingle();
    if (!admin || !["owner", "admin"].includes((admin as { role: string }).role)) {
      throw new Error("Firm admin access required");
    }

    // Caller must be able to manage the company
    const { data: membership } = await context.supabase
      .from("company_members" as never)
      .select("role" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("user_id" as never, context.userId as never)
      .maybeSingle();
    const role = (membership as { role: string } | null)?.role;
    if (!role || !["owner", "admin"].includes(role)) {
      throw new Error("You must be an owner or admin of the client organisation to link it");
    }

    const { data: link, error } = await context.supabase
      .from("firm_client_links" as never)
      .upsert(
        {
          firm_id: data.firmId,
          company_id: data.companyId,
          access_level: data.accessLevel,
          linked_by: context.userId,
          revoked_at: null,
        } as never,
        { onConflict: "firm_id,company_id" } as never,
      )
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    const mappedRole = ACCESS_TO_ROLE[data.accessLevel] ?? "read_only";
    const { data: firmMembers } = await context.supabase
      .from("firm_members" as never)
      .select("user_id" as never)
      .eq("firm_id" as never, data.firmId as never);

    for (const fm of (firmMembers ?? []) as Array<{ user_id: string }>) {
      if (fm.user_id === context.userId) continue;
      const { error: upErr } = await context.supabase.from("company_members" as never).upsert(
        {
          company_id: data.companyId,
          user_id: fm.user_id,
          role: mappedRole,
        } as never,
        { onConflict: "company_id,user_id" } as never,
      );
      if (upErr) {
        // Do not invent success — surface membership failures
        throw new Error(`Could not grant firm member access: ${upErr.message}`);
      }
    }

    await context.supabase.rpc("record_audit_event" as never, {
      _company_id: data.companyId,
      _action: "firm.client_link",
      _entity_type: "firm_client_link",
      _entity_id: (link as { id: string }).id,
      _details: { firm_id: data.firmId, access_level: data.accessLevel },
    } as never);

    return { id: (link as { id: string }).id };
  });

export const revokeFirmClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { firmId: string; companyId: string }) => ({
    firmId: assertUuid(input.firmId),
    companyId: assertUuid(input.companyId),
  }))
  .handler(async ({ data, context }) => {
    const { data: admin } = await context.supabase
      .from("firm_members" as never)
      .select("role" as never)
      .eq("firm_id" as never, data.firmId as never)
      .eq("user_id" as never, context.userId as never)
      .maybeSingle();
    if (!admin || !["owner", "admin"].includes((admin as { role: string }).role)) {
      throw new Error("Firm admin access required");
    }

    const { error } = await context.supabase
      .from("firm_client_links" as never)
      .update({ revoked_at: new Date().toISOString() } as never)
      .eq("firm_id" as never, data.firmId as never)
      .eq("company_id" as never, data.companyId as never);
    if (error) throw new Error(error.message);

    // Remove non-owner firm members from company (preserve original owners/admins not from firm — best-effort)
    const { data: firmMembers } = await context.supabase
      .from("firm_members" as never)
      .select("user_id" as never)
      .eq("firm_id" as never, data.firmId as never);
    for (const fm of (firmMembers ?? []) as Array<{ user_id: string }>) {
      await context.supabase
        .from("company_members" as never)
        .delete()
        .eq("company_id" as never, data.companyId as never)
        .eq("user_id" as never, fm.user_id as never)
        .in("role" as never, ["read_only", "bookkeeper", "accountant"] as never);
    }

    await context.supabase.rpc("record_audit_event" as never, {
      _company_id: data.companyId,
      _action: "firm.client_revoke",
      _entity_type: "firm",
      _entity_id: data.firmId,
      _details: { firm_id: data.firmId },
    } as never);

    return { ok: true };
  });

/** Client activity for a linked company (audit slice) — firm members with company access. */
export const listFirmClientActivity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { firmId: string; companyId: string }) => ({
    firmId: assertUuid(input.firmId),
    companyId: assertUuid(input.companyId),
  }))
  .handler(async ({ data, context }) => {
    const { data: member } = await context.supabase
      .from("firm_members" as never)
      .select("id" as never)
      .eq("firm_id" as never, data.firmId as never)
      .eq("user_id" as never, context.userId as never)
      .maybeSingle();
    if (!member) throw new Error("Not a member of this firm");

    const { data: link } = await context.supabase
      .from("firm_client_links" as never)
      .select("id" as never)
      .eq("firm_id" as never, data.firmId as never)
      .eq("company_id" as never, data.companyId as never)
      .is("revoked_at" as never, null)
      .maybeSingle();
    if (!link) throw new Error("Client is not linked to this firm");

    const { data: rows, error } = await context.supabase
      .from("audit_events" as never)
      .select("id, action, entity_type, entity_id, created_at, actor_user_id" as never)
      .eq("company_id" as never, data.companyId as never)
      .order("created_at" as never, { ascending: false })
      .limit(40);
    if (error) throw new Error(error.message);
    return (rows ?? []) as Array<{
      id: string;
      action: string;
      entity_type: string;
      entity_id: string | null;
      created_at: string;
      actor_user_id: string | null;
    }>;
  });
