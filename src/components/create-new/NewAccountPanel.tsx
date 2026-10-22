"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useActiveCompany } from "@/hooks/use-active-company";
import { AccountForm } from "@/components/accounting/AccountForm";

export function NewAccountPanel() {
  const { company } = useActiveCompany();
  const queryClient = useQueryClient();
  if (!company) return null;
  return (
    <AccountForm
      companyId={company.id}
      currency={company.base_currency}
      onSaved={(another) => {
        if (!another) void queryClient.invalidateQueries({ queryKey: ["accounts", company.id] });
      }}
    />
  );
}
