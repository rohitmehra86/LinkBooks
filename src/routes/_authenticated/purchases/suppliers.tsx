import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listSuppliers, upsertSupplier } from "@/lib/purchases/purchases.functions";
import { useCanDo } from "@/hooks/use-can";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/purchases/suppliers")({
  head: () => ({ meta: [{ title: "Suppliers — LinkBooks" }] }),
  component: SuppliersPage,
});

function SuppliersPage() {
  const { company } = useActiveCompany();
  const fetchSuppliers = useServerFn(listSuppliers);
  const saveSupplier = useServerFn(upsertSupplier);
  const queryClient = useQueryClient();
  const companyId = company?.id;
  const [q, setQ] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [terms, setTerms] = useState("30");
  const canManage = useCanDo("contacts.manage");
  // "0" is valid (due on receipt) and must not turn into 30 days.
  const termsDays = terms.trim() === "" ? NaN : Number(terms);
  const termsValid = Number.isInteger(termsDays) && termsDays >= 0 && termsDays <= 3650;

  const query = useQuery({
    queryKey: ["suppliers", companyId, q],
    enabled: Boolean(companyId),
    queryFn: () => fetchSuppliers({ data: { companyId: companyId!, ...(q ? { q } : {}) } }),
  });

  const mutation = useMutation({
    mutationFn: () =>
      saveSupplier({
        data: {
          companyId: companyId!,
          name,
          email,
          paymentTermsDays: termsDays,
        },
      }),
    onSuccess: async () => {
      setName("");
      setEmail("");
      await queryClient.invalidateQueries({ queryKey: ["suppliers", companyId] });
      toast.success("Supplier saved");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  return (
    <>
      <PageHeader
        title="Suppliers"
        description="Supplier contacts, payment terms and tax identifiers used on bills and payments."
      />

      <div className="mb-6 grid max-w-xl gap-3 rounded-md border border-border p-4">
        <div className="space-y-2">
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Email</Label>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Payment terms (days)</Label>
          <Input
            value={terms}
            inputMode="numeric"
            aria-invalid={!termsValid}
            onChange={(e) => setTerms(e.target.value)}
          />
          {!termsValid ? (
            <p className="text-xs text-destructive">Enter whole days from 0 to 3650</p>
          ) : null}
        </div>
        <Button
          size="sm"
          disabled={mutation.isPending || name.trim().length < 1 || !termsValid || !canManage}
          title={canManage ? undefined : "You do not have permission to manage suppliers"}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          Add supplier
        </Button>
      </div>

      <Input
        className="mb-4 max-w-xs"
        placeholder="Search suppliers"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState
          title="Could not load suppliers"
          description={friendlyAuthError(query.error)}
          onRetry={() => query.refetch()}
        />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState title="No suppliers" description="Add a supplier to create bills." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Terms</TableHead>
              <TableHead>Tax #</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(
              query.data as Array<{
                id: string;
                name: string;
                email: string | null;
                payment_terms_days: number;
                tax_number: string | null;
              }>
            ).map((s) => (
              <TableRow key={s.id}>
                <TableCell>{s.name}</TableCell>
                <TableCell>{s.email ?? "—"}</TableCell>
                <TableCell>{s.payment_terms_days} days</TableCell>
                <TableCell>{s.tax_number ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
