import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { friendlyAuthError } from "@/lib/auth-helpers";
import {
  getDocumentProject,
  listProjectOptions,
  setDocumentProject,
} from "@/lib/projects/projects.functions";
import type { TaggableKind } from "@/lib/projects/projects";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NONE = "__none__";

/**
 * Tags every line of a document (or a bank transaction) with a project. The tag is analytical only: it never
 * changes a ledger amount. Renders nothing until the projects migration is applied.
 * `lazy` shows a small button first, so lists do not run one query per row.
 */
export function ProjectTagControl({
  kind,
  documentId,
  disabled,
  lazy,
}: {
  kind: TaggableKind;
  documentId: string;
  disabled?: boolean;
  lazy?: boolean;
}) {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const qc = useQueryClient();
  const [opened, setOpened] = useState(!lazy);
  const fetchTag = useServerFn(getDocumentProject);
  const fetchProjects = useServerFn(listProjectOptions);
  const save = useServerFn(setDocumentProject);

  const tagQ = useQuery({
    queryKey: ["document-project", companyId, kind, documentId],
    enabled: Boolean(companyId && opened),
    queryFn: () => fetchTag({ data: { companyId: companyId!, kind, documentId } }),
  });
  const projectsQ = useQuery({
    queryKey: ["project-options", companyId],
    enabled: Boolean(companyId && opened),
    queryFn: () => fetchProjects({ data: { companyId: companyId! } }),
  });
  const mutation = useMutation({
    mutationFn: (projectId: string | null) =>
      save({ data: { companyId: companyId!, kind, documentId, projectId } }),
    onSuccess: async () => {
      toast.success("Project updated");
      await qc.invalidateQueries({ queryKey: ["document-project", companyId, kind, documentId] });
      await qc.invalidateQueries({ queryKey: ["project-profitability", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return null;
  if (!opened) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpened(true)}>
        Project
      </Button>
    );
  }
  if (tagQ.isPending || projectsQ.isPending) return null;
  if (tagQ.isError || projectsQ.isError || !tagQ.data?.available) return null;
  const projects = projectsQ.data ?? [];
  if (projects.length === 0 && !tagQ.data.projectId) return null;

  const current = tagQ.data.mixed ? "__mixed__" : (tagQ.data.projectId ?? NONE);
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Project</span>
      <Select
        value={current}
        disabled={disabled || mutation.isPending}
        onValueChange={(v) => {
          if (v === "__mixed__") return;
          mutation.mutate(v === NONE ? null : v);
        }}
      >
        <SelectTrigger aria-label="Project" className="h-8 w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>No project</SelectItem>
          {tagQ.data.mixed ? (
            <SelectItem value="__mixed__" disabled>
              Mixed (set per line)
            </SelectItem>
          ) : null}
          {projects.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.code} — {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
