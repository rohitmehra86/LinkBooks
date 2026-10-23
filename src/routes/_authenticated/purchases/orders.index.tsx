import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  convertPurchaseOrderToBill,
  listPurchaseOrders,
} from "@/lib/purchases/purchases.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { ListToolbar, useListSearch } from "@/components/common/ListTools";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type OrderRow = {
  id: string;
  order_date: string;
  status: string;
  total_minor: number;
  billed_bill_id: string | null;
  contacts: { name: string } | null;
};

export const Route = createFileRoute("/_authenticated/purchases/orders/")({
  component: OrdersList,
});

function OrdersList() {
  const { company } = useActiveCompany();
  const navigate = useNavigate();
  const fetch = useServerFn(listPurchaseOrders);
  const convert = useServerFn(convertPurchaseOrderToBill);
  const queryClient = useQueryClient();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const query = useQuery({
    queryKey: ["orders", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetch({ data: { companyId: companyId! } }),
  });
  const rows = (query.data ?? []) as OrderRow[];
  const list = useListSearch(rows, (o) => `${o.order_date} ${o.contacts?.name ?? ""} ${o.status}`);

  const convertMutation = useMutation({
    mutationFn: (orderId: string) => convert({ data: { companyId: companyId!, orderId } }),
    onSuccess: async (r) => {
      await queryClient.invalidateQueries({ queryKey: ["orders", companyId] });
      await queryClient.invalidateQueries({ queryKey: ["bills", companyId] });
      toast.success("Converted to draft bill (no ledger post until bill is authorised)");
      navigate({ to: "/purchases/bills/$billId", params: { billId: r.billId } });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  return (
    <>
      <PageHeader
        title="Purchase orders"
        description="POs never post AP or expense. Convert to a draft bill when ready — posting happens only when the bill is authorised."
        actions={
          <Button size="sm" asChild>
            <Link to="/purchases/orders/new">New order</Link>
          </Button>
        }
      />
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState title="Could not load orders" description={friendlyAuthError(query.error)} />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState title="No purchase orders" description="Create a PO for a supplier." />
      ) : (
        <>
          <ListToolbar
            query={list.query}
            onQuery={list.setQuery}
            shown={list.filtered.length}
            total={rows.length}
            placeholder="Search orders"
            exportCsv={{
              company: company?.name ?? "",
              title: "Purchase orders",
              currency,
              headers: ["Date", "Supplier", "Status", "Total"],
              rows: list.filtered.map((r) => [
                r.order_date,
                r.contacts?.name ?? "",
                r.status,
                fromMinorUnits(BigInt(r.total_minor), currency),
              ]),
            }}
          />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.filtered.map((o) => (
                <TableRow key={o.id}>
                  <TableCell>{o.order_date}</TableCell>
                  <TableCell>{o.contacts?.name ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {o.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {fromMinorUnits(BigInt(o.total_minor), currency)}
                  </TableCell>
                  <TableCell>
                    {!o.billed_bill_id && o.status !== "cancelled" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={convertMutation.isPending}
                        onClick={() => convertMutation.mutate(o.id)}
                      >
                        Convert to bill
                      </Button>
                    ) : o.billed_bill_id ? (
                      <Link
                        className="text-sm underline"
                        to="/purchases/bills/$billId"
                        params={{ billId: o.billed_bill_id }}
                      >
                        View bill
                      </Link>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </>
  );
}
