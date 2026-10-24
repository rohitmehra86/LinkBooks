"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listCustomers } from "@/lib/sales/sales.functions";
import { createProject } from "@/lib/create-new/money-documents.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ContactLookup } from "@/components/lookup";
import { Label } from "@/components/ui/label";

export function ProjectPanel() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const qc = useQueryClient();
  const save = useServerFn(createProject);
  const fetchCustomers = useServerFn(listCustomers);
  const customersQ = useQuery({
    queryKey: ["customers", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchCustomers({ data: { companyId: companyId! } }),
  });
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [contactId, setContactId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [budget, setBudget] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const saveM = useMutation({
    mutationFn: () =>
      save({
        data: {
          companyId: companyId!,
          code,
          name,
          ...(contactId ? { contactId } : {}),
          ...(startDate ? { startDate } : {}),
          ...(endDate ? { endDate } : {}),
          ...(budget ? { budget, currencyCode: company?.base_currency ?? "GBP" } : {}),
          description,
          status: "active",
        },
      }),
    onSuccess: async () => {
      setError(null);
      toast.success("Project saved");
      await qc.invalidateQueries({ queryKey: ["project-profitability", companyId] });
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
        A project belongs to this organisation. It is separate from tracking dimensions.
      </p>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Label>Code</Label>
      <Input required value={code} onChange={(e) => setCode(e.target.value)} />
      <Label>Name</Label>
      <Input required value={name} onChange={(e) => setName(e.target.value)} />
      <Label>Customer</Label>
      <ContactLookup
        ariaLabel="Customer"
        contacts={(customersQ.data ?? []) as Array<{ id: string; name: string }>}
        value={contactId}
        onChange={setContactId}
        companyId={companyId}
        placeholder="None"
        allowClear
      />
      <Label>Start</Label>
      <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
      <Label>End</Label>
      <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
      <Label>Budget</Label>
      <Input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
      <Label>Description</Label>
      <Input value={description} onChange={(e) => setDescription(e.target.value)} />
      <Button type="submit" disabled={saveM.isPending}>
        {saveM.isPending ? "Saving…" : "Save project"}
      </Button>
    </form>
  );
}
