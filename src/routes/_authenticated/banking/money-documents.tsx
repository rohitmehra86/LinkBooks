import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listMoneyDocuments, voidMoneyDocument } from "@/lib/create-new/money-documents.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, EmptyState, ErrorState } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { roleHasPermission } from "@/lib/permissions";

export const Route = createFileRoute("/_authenticated/banking/money-documents")({
  head: () => ({ meta: [{ title: "Bank documents — LinkBooks" }] }),
  component: MoneyDocumentsPage,
});

const KIND_LABEL: Record<string, string> = {
  sales_receipt: "Sales receipt",
  customer_refund: "Customer refund",
  supplier_refund: "Supplier refund",
  receive_money: "Receive money",
  bank_deposit: "Bank deposit",
  card_payment: "Credit card payment",
  bank_adjustment: "Bank adjustment",
};

type Row = {
  id: string;
  kind: string;
  document_date: string;
  reference: string | null;
  memo: string | null;
  currency_code: string;
  total_minor: number;
  status: string;
  deposit_status: string | null;
  adjustment_type: string | null;
  void_reason: string | null;
  contacts: { name: string } | null;
};

export function MoneyDocumentsPage() {
  return <MoneyDocumentsInner />;
}

function MoneyDocumentsInner() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const qc = useQueryClient();
  const canPost = roleHasPermission(company?.role ?? "read_only", "accounting.post");
  const fetchDocs = useServerFn(listMoneyDocuments);
  const doVoid = useServerFn(voidMoneyDocument);
  const [kind, setKind] = useState("");
  const [voiding, setVoiding] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const docsQ = useQuery({
    queryKey: ["money-documents", companyId, kind],
    enabled: Boolean(companyId),
    queryFn: () => fetchDocs({ data: { companyId: companyId!, ...(kind ? { kind } : {}) } }),
  });

  const voidM = useMutation({
    mutationFn: (documentId: string) =>
      doVoid({ data: { companyId: companyId!, documentId, reason } }),
    onSuccess: async () => {
      toast.success("Document voided. A reversing journal was posted.");
      setVoiding(null);
      setReason("");
      await qc.invalidateQueries({ queryKey: ["money-documents", companyId] });
      await qc.invalidateQueries({ queryKey: ["undeposited", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  const rows = (docsQ.data ?? []) as unknown as Row[];

  return (
    <>
      <PageHeader
        title="Bank documents"
        description="Sales receipts, refunds, direct receipts, deposits, card payments and bank adjustments. Each one posts a single journal. Voiding posts a reversal and restores any credit it used."
        actions={
          <select
            aria-label="Filter by type"
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="">All types</option>
            {Object.entries(KIND_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        }
      />
      {docsQ.isPending ? (
        <LoadingState />
      ) : docsQ.isError ? (
        <ErrorState onRetry={() => void docsQ.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No bank documents yet"
          description="Use New → Sales receipt, Receive money, Bank deposit and similar actions. They appear here after they post."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Contact / reference</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} className={row.status === "void" ? "opacity-60" : undefined}>
                <TableCell>{row.document_date}</TableCell>
                <TableCell>{KIND_LABEL[row.kind] ?? row.kind}</TableCell>
                <TableCell>
                  {[row.contacts?.name, row.reference].filter(Boolean).join(" · ") ||
                    row.memo ||
                    "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {fromMinorUnits(row.total_minor, row.currency_code)}
                </TableCell>
                <TableCell className="space-x-1">
                  <Badge variant={row.status === "void" ? "destructive" : "secondary"}>
                    {row.status}
                  </Badge>
                  {row.deposit_status === "undeposited" ? (
                    <Badge variant="outline">undeposited</Badge>
                  ) : null}
                  {row.deposit_status === "deposited" ? (
                    <Badge variant="outline">banked</Badge>
                  ) : null}
                </TableCell>
                <TableCell className="text-right">
                  {row.status === "posted" && canPost ? (
                    voiding === row.id ? (
                      <div className="flex items-center justify-end gap-2">
                        <Input
                          autoFocus
                          className="h-8 w-48"
                          placeholder="Reason for voiding"
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                        />
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={!reason.trim() || voidM.isPending}
                          onClick={() => voidM.mutate(row.id)}
                        >
                          Confirm void
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setVoiding(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => setVoiding(row.id)}>
                        Void
                      </Button>
                    )
                  ) : row.void_reason ? (
                    <span className="text-xs text-muted-foreground">{row.void_reason}</span>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <p className="mt-4 text-xs text-muted-foreground">
        Banked receipts must be voided through their bank deposit first. See also{" "}
        <Link to="/banking/transfers" className="underline">
          Transfers
        </Link>
        .
      </p>
    </>
  );
}
