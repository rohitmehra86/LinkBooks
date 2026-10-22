"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { uploadInboxDocument } from "@/lib/create-new/money-documents.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function InboxPanel() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const upload = useServerFn(uploadInboxDocument);
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const saveM = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose a file");
      const contentBase64 = await fileToBase64(file);
      return upload({
        data: {
          companyId: companyId!,
          fileName: file.name,
          contentType: file.type,
          contentBase64,
          sizeBytes: file.size,
          note,
        },
      });
    },
    onSuccess: (result) => {
      setError(null);
      setSaved(result.scanStatus);
      toast.success("Document stored in the inbox");
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
        Files stay in this organisation. Malware scanning is not configured, so the document is stored as not scanned. OCR is not run.
      </p>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {saved ? <p className="text-sm">Saved. Scan status: {saved}. Processing status: inbox.</p> : null}
      <Label>File</Label>
      <Input
        type="file"
        accept=".pdf,image/*,.png,.jpg,.jpeg,.webp,.csv,.txt"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      <Label>Note</Label>
      <Input value={note} onChange={(e) => setNote(e.target.value)} />
      <Button type="submit" disabled={saveM.isPending || !file}>{saveM.isPending ? "Uploading…" : "Upload"}</Button>
    </form>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result ?? "");
      resolve(value.includes(",") ? value.split(",")[1] ?? "" : value);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
