"use client";

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { registerAttachment } from "@/lib/documents/attachments.functions";
import {
  FILE_INPUT_ACCEPT,
  MAX_FILE_BYTES,
  formatFileSize,
  validateUpload,
} from "@/lib/documents/attachments";
import { uploadCompanyDocument } from "@/lib/documents/upload-client";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Create → Document upload. Files go to the private company-documents bucket and appear on the
 * Files page as "Unfiled" until they are attached to a record from that record's page.
 */
export function InboxPanel() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const queryClient = useQueryClient();
  const register = useServerFn(registerAttachment);
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);

  const saveM = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose a file");
      return uploadCompanyDocument({
        file,
        companyId: companyId!,
        entityType: "company",
        entityId: companyId!,
        register: register as never,
      });
    },
    onSuccess: async () => {
      setError(null);
      setSavedName(file?.name ?? null);
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      await queryClient.invalidateQueries({ queryKey: ["company-files", companyId] });
      toast.success("File uploaded to Files");
    },
    onError: (e) => setError(friendlyAuthError(e)),
  });

  if (!companyId) return null;
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        saveM.mutate();
      }}
    >
      <p className="text-sm text-muted-foreground">
        Files are private to this organisation and listed on the Files page. Malware scanning and
        OCR are not run. Up to {formatFileSize(MAX_FILE_BYTES)} per file.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {savedName ? (
        <p className="text-sm">
          Uploaded “{savedName}”. Find it on the{" "}
          <a className="underline" href="/files">
            Files
          </a>{" "}
          page.
        </p>
      ) : null}
      <Label htmlFor="inbox-file">File</Label>
      <Input
        id="inbox-file"
        ref={inputRef}
        type="file"
        accept={FILE_INPUT_ACCEPT}
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          setSavedName(null);
          if (f) {
            const check = validateUpload({
              fileName: f.name,
              sizeBytes: f.size,
              contentType: f.type,
            });
            if (!check.ok) {
              setError(check.error);
              setFile(null);
              e.target.value = "";
              return;
            }
          }
          setError(null);
          setFile(f);
        }}
      />
      <Button type="submit" disabled={saveM.isPending || !file}>
        {saveM.isPending ? "Uploading…" : "Upload"}
      </Button>
    </form>
  );
}
