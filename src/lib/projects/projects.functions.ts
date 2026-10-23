import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { callRpc, isMissingRpc, isMissingSchema, type RpcClient } from "@/lib/banking/rpc";
import {
  KIND_LINE_TABLES,
  TAGGABLE_KINDS,
  summariseTags,
  type ProjectProfitRow,
  type TaggableKind,
} from "@/lib/projects/projects";

type Any = RpcClient & {
  from: (t: string) => {
    select: (c: string) => {
      eq: (
        c: string,
        v: string,
      ) => {
        eq: (
          c: string,
          v: string,
        ) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
      };
    };
  };
};

function assertKind(kind: string): TaggableKind {
  if (!(TAGGABLE_KINDS as readonly string[]).includes(kind))
    throw new Error("Unsupported document kind");
  return kind as TaggableKind;
}

export type ProjectOption = { id: string; code: string; name: string; status: string };

/** Projects that can still be tagged (not archived/completed). Read-only. */
export const listProjectOptions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }): Promise<ProjectOption[]> => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await context.supabase
      .from("projects" as never)
      .select("id, code, name, status" as never)
      .eq("company_id" as never, data.companyId as never)
      .order("code" as never, { ascending: true });
    if (error) throw new Error(error.message);
    return ((rows ?? []) as unknown as ProjectOption[]).filter(
      (p) => p.status !== "archived" && p.status !== "completed",
    );
  });

/** Current tag of a document: one project, mixed lines, or none. `available:false` before the migration. */
export const getDocumentProject = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; kind: string; documentId: string }) => ({
    companyId: assertUuid(input.companyId),
    kind: assertKind(input.kind),
    documentId: assertUuid(input.documentId, "document"),
  }))
  .handler(
    async ({
      data,
      context,
    }): Promise<{ available: boolean; projectId: string | null; mixed: boolean }> => {
      await assertCompanyMember(context.supabase, data.companyId);
      const spec = KIND_LINE_TABLES[data.kind];
      const supabase = context.supabase as unknown as Any;
      const res = await (spec.fk
        ? supabase
            .from(spec.table)
            .select("project_id")
            .eq("company_id", data.companyId)
            .eq(spec.fk, data.documentId)
        : supabase
            .from(spec.table)
            .select("project_id")
            .eq("company_id", data.companyId)
            .eq("id", data.documentId));
      if (res.error) {
        if (isMissingSchema(res.error)) return { available: false, projectId: null, mixed: false };
        throw new Error(res.error.message);
      }
      const ids = ((res.data ?? []) as Array<{ project_id: string | null }>).map(
        (r) => r.project_id,
      );
      return { available: true, ...summariseTags(ids) };
    },
  );

export const setDocumentProject = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; kind: string; documentId: string; projectId: string | null }) => ({
      companyId: assertUuid(input.companyId),
      kind: assertKind(input.kind),
      documentId: assertUuid(input.documentId, "document"),
      projectId: input.projectId ? assertUuid(input.projectId, "project") : null,
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const res = await callRpc<{ tagged: number }>(
      context.supabase as unknown as RpcClient,
      "set_document_project",
      {
        payload: {
          company_id: data.companyId,
          kind: data.kind,
          document_id: data.documentId,
          project_id: data.projectId,
        },
      },
    );
    return { tagged: Number(res?.tagged ?? 0) };
  });

export const getProjectProfitability = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; from?: string | null; to?: string | null }) => {
    const iso = (s: string | null | undefined) => {
      if (!s) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error("Dates must be YYYY-MM-DD");
      return s;
    };
    return { companyId: assertUuid(input.companyId), from: iso(input.from), to: iso(input.to) };
  })
  .handler(async ({ data, context }): Promise<{ available: boolean; rows: ProjectProfitRow[] }> => {
    await assertCompanyPermission(context.supabase, data.companyId, "reports.view");
    const { data: rows, error } = await (context.supabase as unknown as RpcClient).rpc(
      "project_profitability" as never,
      { _company_id: data.companyId, _from: data.from, _to: data.to } as never,
    );
    if (error) {
      if (isMissingRpc(error)) return { available: false, rows: [] };
      throw new Error(error.message);
    }
    return {
      available: true,
      rows: ((rows ?? []) as Array<Record<string, unknown>>).map((r) => ({
        projectId: String(r["project_id"]),
        code: String(r["code"]),
        name: String(r["name"]),
        status: String(r["status"]),
        budgetMinor: r["budget_minor"] == null ? null : Number(r["budget_minor"]),
        revenueMinor: Number(r["revenue_minor"] ?? 0),
        costMinor: Number(r["cost_minor"] ?? 0),
        profitMinor: Number(r["profit_minor"] ?? 0),
        unconvertedDocuments: Number(r["unconverted_documents"] ?? 0),
      })),
    };
  });
