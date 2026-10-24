import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Paperclip } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { useCan } from "@/hooks/use-can";
import { friendlyAuthError } from "@/lib/auth-helpers";
import {
  deleteAttachment,
  getAttachmentDownload,
  listAttachments,
  registerAttachment,
} from "@/lib/documents/attachments.functions";
import {
  FILE_INPUT_ACCEPT,
  MAX_FILE_BYTES,
  formatFileSize,
  validateUpload,
  type AttachmentEntityType,
} from "@/lib/documents/attachments";
import {
  addDocumentNote,
  listDocumentActivity,
  listDocumentNotes,
} from "@/lib/documents/notes.functions";
import {
  activityActionLabel,
  activityEmptyMessage,
  entityManagePermissions,
  entityViewPermissions,
  notePlaceholder,
  notesEmptyMessage,
  normaliseInternalNote,
  type NoteAudience,
} from "@/lib/documents/record-activity";
import { downloadBase64, uploadCompanyDocument } from "@/lib/documents/upload-client";
import { openSignedDownload } from "@/lib/documents/ui";
import { canPreviewAttachment } from "@/lib/purchases/bill-form-helpers";
import { LoadingState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

export type DocumentRecordHandle = {
  /** Store queued files and the note draft against a record that now has an id. */
  flush: (entityId: string) => Promise<void>;
};

type PendingFile = { key: string; file: File };

/**
 * Attachments, internal notes and activity history.
 * Same layout as a new bill. Notes stay off printed and emailed documents.
 * Before the record has an id, files and the note draft wait here and flush() stores them.
 */
export const DocumentRecordPanel = forwardRef<
  DocumentRecordHandle,
  {
    entityType: AttachmentEntityType;
    entityId: string | null;
    audience: NoteAudience;
  }
>(function DocumentRecordPanel({ entityType, entityId, audience }, ref) {
  const { company } = useActiveCompany();
  const companyId = company?.id ?? null;
  const { can } = useCan();
  const queryClient = useQueryClient();
  const fetchFiles = useServerFn(listAttachments);
  const register = useServerFn(registerAttachment);
  const fetchDownload = useServerFn(getAttachmentDownload);
  const removeFile = useServerFn(deleteAttachment);
  const fetchNotes = useServerFn(listDocumentNotes);
  const addNote = useServerFn(addDocumentNote);
  const fetchActivity = useServerFn(listDocumentActivity);

  const [pending, setPending] = useState<PendingFile[]>([]);
  const [draft, setDraft] = useState("");
  const pendingRef = useRef(pending);
  const draftRef = useRef(draft);
  pendingRef.current = pending;
  draftRef.current = draft;

  const canView =
    entityViewPermissions(entityType).length === 0 ||
    entityViewPermissions(entityType).some((permission) => can(permission));
  const canManage = entityManagePermissions(entityType).some((permission) => can(permission));
  const fileKey = ["attachments", companyId, entityType, entityId];
  const noteKey = ["document-notes", companyId, entityType, entityId];
  const activityKey = ["document-activity", companyId, entityType, entityId];

  const filesQ = useQuery({
    queryKey: fileKey,
    enabled: Boolean(companyId && entityId && canView),
    queryFn: () => fetchFiles({ data: { companyId: companyId!, entityType, entityId: entityId! } }),
  });
  const notesQ = useQuery({
    queryKey: noteKey,
    enabled: Boolean(companyId && entityId && canView),
    queryFn: () => fetchNotes({ data: { companyId: companyId!, entityType, entityId: entityId! } }),
  });
  const activityQ = useQuery({
    queryKey: activityKey,
    enabled: Boolean(companyId && entityId && canView),
    queryFn: () =>
      fetchActivity({ data: { companyId: companyId!, entityType, entityId: entityId! } }),
  });

  async function refresh(id: string) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["attachments", companyId, entityType, id] }),
      queryClient.invalidateQueries({ queryKey: ["document-notes", companyId, entityType, id] }),
      queryClient.invalidateQueries({ queryKey: ["document-activity", companyId, entityType, id] }),
    ]);
  }

  async function storeFiles(id: string, files: PendingFile[]) {
    if (!companyId) throw new Error("Select an organisation first.");
    for (const item of files) {
      await uploadCompanyDocument({
        file: item.file,
        companyId,
        entityType,
        entityId: id,
        register: register as never,
      });
      setPending((current) => current.filter((row) => row.key !== item.key));
      pendingRef.current = pendingRef.current.filter((row) => row.key !== item.key);
    }
  }

  async function storeDraft(id: string) {
    if (!companyId) throw new Error("Select an organisation first.");
    const raw = draftRef.current;
    if (!raw.trim()) return;
    const note = normaliseInternalNote(raw);
    if (!note.ok) throw new Error(note.error);
    await addNote({ data: { companyId, entityType, entityId: id, body: note.body } });
    draftRef.current = "";
    setDraft("");
  }

  useImperativeHandle(ref, () => ({
    flush: async (id: string) => {
      await storeFiles(id, [...pendingRef.current]);
      await storeDraft(id);
      await refresh(id);
    },
  }));

  function queueFiles(list: FileList | File[]) {
    const next: PendingFile[] = [];
    for (const file of Array.from(list)) {
      const check = validateUpload({
        fileName: file.name,
        sizeBytes: file.size,
        contentType: file.type,
      });
      if (!check.ok) {
        toast.error(check.error);
        continue;
      }
      next.push({ key: crypto.randomUUID(), file });
    }
    if (!next.length) return;
    if (!entityId) {
      const merged = [...pendingRef.current, ...next];
      pendingRef.current = merged;
      setPending(merged);
      return;
    }
    void storeFiles(entityId, next)
      .then(() => refresh(entityId))
      .catch((error) => toast.error(friendlyAuthError(error)));
  }

  const addNoteM = useMutation({
    mutationFn: async () => {
      if (!entityId) return;
      await storeDraft(entityId);
      await refresh(entityId);
    },
    onError: (error) => toast.error(friendlyAuthError(error)),
  });

  async function openFile(attachmentId: string, preview: boolean) {
    try {
      const file = await fetchDownload({ data: { companyId: companyId!, attachmentId } });
      if (file.kind === "url") {
        if (preview) window.open(file.url, "_blank", "noopener,noreferrer");
        else openSignedDownload(file.url, file.fileName);
        return;
      }
      if (preview) {
        const bin = atob(file.contentBase64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const url = URL.createObjectURL(
          new Blob([bytes], { type: file.contentType || "application/octet-stream" }),
        );
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      downloadBase64(file.fileName, file.contentType, file.contentBase64);
    } catch (error) {
      toast.error(friendlyAuthError(error));
    }
  }

  const notes = notesQ.data ?? [];
  const activity = activityQ.data ?? [];

  return (
    <div className="space-y-4 print:hidden" data-testid="document-record-panel">
      <div className="space-y-2 rounded-md border border-border p-4">
        <div className="flex items-center gap-2">
          <Paperclip className="size-4" />
          <Label>Attachments</Label>
        </div>
        <p className="text-sm font-medium">Max file size: 20 MB</p>
        {canManage ? (
          <div
            className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              queueFiles(event.dataTransfer.files);
            }}
          >
            Drag and drop files here, or{" "}
            <label className="cursor-pointer underline">
              browse
              <input
                type="file"
                className="sr-only"
                multiple
                accept={FILE_INPUT_ACCEPT}
                aria-label="Attach files"
                onChange={(event) => {
                  if (event.target.files) queueFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </label>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            You can view files. Adding files is not available for your role.
          </p>
        )}
        <ul className="space-y-1 text-sm">
          {(filesQ.data ?? []).map((file) => (
            <li key={file.id} className="flex flex-wrap items-center gap-2">
              <span>
                {file.file_name}{" "}
                <span className="text-muted-foreground">({formatFileSize(file.size_bytes)})</span>
              </span>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={() =>
                  void openFile(file.id, canPreviewAttachment(file.file_name, file.content_type))
                }
              >
                {canPreviewAttachment(file.file_name, file.content_type) ? "Preview" : "Download"}
              </Button>
              {canManage ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (!confirm(`Remove ${file.file_name}?`)) return;
                    void removeFile({ data: { companyId: companyId!, attachmentId: file.id } })
                      .then(() => (entityId ? refresh(entityId) : undefined))
                      .catch((error) => toast.error(friendlyAuthError(error)));
                  }}
                >
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
          {pending.map((item) => (
            <li key={item.key} className="flex items-center gap-2 text-muted-foreground">
              {item.file.name} (pending save){" "}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  const next = pendingRef.current.filter((row) => row.key !== item.key);
                  pendingRef.current = next;
                  setPending(next);
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        {filesQ.isError ? (
          <p className="text-sm text-destructive">{friendlyAuthError(filesQ.error)}</p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Limit {MAX_FILE_BYTES / (1024 * 1024)} MB per file.
        </p>
      </div>

      <Tabs defaultValue="notes">
        <TabsList>
          <TabsTrigger value="notes">Internal notes</TabsTrigger>
          <TabsTrigger value="activity">Activity history</TabsTrigger>
        </TabsList>
        <TabsContent value="notes" className="space-y-2">
          {canManage ? (
            <Textarea
              aria-label="Internal note"
              placeholder={notePlaceholder(audience)}
              value={draft}
              onChange={(event) => {
                draftRef.current = event.target.value;
                setDraft(event.target.value);
              }}
              rows={3}
            />
          ) : null}
          {canManage && entityId ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={addNoteM.isPending || !draft.trim()}
              onClick={() => addNoteM.mutate()}
            >
              Add note
            </Button>
          ) : null}
          {entityId && notesQ.isLoading ? (
            <LoadingState />
          ) : notesQ.isError ? (
            <p className="text-sm text-destructive">{friendlyAuthError(notesQ.error)}</p>
          ) : notes.length > 0 ? (
            <ul className="space-y-2 text-sm">
              {notes.map((note) => (
                <li key={note.id} className="rounded border border-border p-2">
                  <p className="whitespace-pre-wrap">{note.body}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {new Date(note.created_at).toLocaleString()} · {note.created_by_name || "—"}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{notesEmptyMessage(Boolean(entityId))}</p>
          )}
        </TabsContent>
        <TabsContent value="activity">
          {!entityId ? (
            <p className="text-sm text-muted-foreground">{activityEmptyMessage(false)}</p>
          ) : activityQ.isPending ? (
            <LoadingState />
          ) : activityQ.isError ? (
            <p className="text-sm text-destructive">{friendlyAuthError(activityQ.error)}</p>
          ) : activity.length === 0 ? (
            <p className="text-sm text-muted-foreground">{activityEmptyMessage(true)}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1">Date &amp; time</th>
                  <th>User</th>
                  <th>Action</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {activity.map((row) => (
                  <tr key={row.id} className="border-t">
                    <td className="whitespace-nowrap py-1">
                      {new Date(row.created_at).toLocaleString()}
                    </td>
                    <td>{row.actor_name || "—"}</td>
                    <td>{activityActionLabel(row.action)}</td>
                    <td className="max-w-xs truncate text-muted-foreground">{row.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
});
