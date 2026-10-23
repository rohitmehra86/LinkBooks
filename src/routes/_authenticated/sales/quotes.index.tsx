import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { convertQuoteToInvoice, exportQuotesCsv, listQuotes } from "@/lib/sales/sales.functions";
import { isQuoteConvertible } from "@/lib/sales/quote-status";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import {
  ListToolbar,
  Pager,
  SortHead,
  downloadCsv,
  initialListState,
  useDebounced,
  type ListState,
} from "@/components/sales/ListKit";
import { money } from "@/components/sales/sales-form-utils";
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

export const Route = createFileRoute("/_authenticated/sales/quotes/")({
  head: () => ({ meta: [{ title: "Quotes — LinkBooks" }] }),
  component: QuotesList,
});

const STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "accepted", label: "Accepted" },
  { value: "declined", label: "Declined" },
  { value: "expired", label: "Expired" },
  { value: "converted", label: "Converted" },
  { value: "void", label: "Void" },
];

function QuotesList() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const navigate = useNavigate();
  const fetchQuotes = useServerFn(listQuotes);
  const exportCsv = useServerFn(exportQuotesCsv);
  const convert = useServerFn(convertQuoteToInvoice);
  const qc = useQueryClient();
  const [state, setState] = useState<ListState>(initialListState("quote_date"));
  const patch = (p: Partial<ListState>) => setState((s) => ({ ...s, ...p }));
  const q = useDebounced(state.q);

  const filters = () => ({
    companyId: companyId!,
    q,
    ...(state.status !== "all" ? { status: state.status } : {}),
    ...(state.from ? { from: state.from } : {}),
    ...(state.to ? { to: state.to } : {}),
    sort: state.sort,
    dir: state.dir,
  });

  const query = useQuery({
    queryKey: ["sales-quotes", companyId, q, state],
    enabled: Boolean(companyId),
    placeholderData: keepPreviousData,
    queryFn: () =>
      fetchQuotes({ data: { ...filters(), page: state.page, pageSize: state.pageSize } }),
  });

  const convertM = useMutation({
    mutationFn: (quoteId: string) => convert({ data: { companyId: companyId!, quoteId } }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["sales-quotes", companyId] });
      toast.success("Quote converted to draft invoice");
      navigate({ to: "/sales/invoices/$invoiceId", params: { invoiceId: r.invoiceId } });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });
  const exporter = useMutation({
    mutationFn: () => exportCsv({ data: filters() }),
    onSuccess: (r) => {
      downloadCsv(r.filename, r.csv);
      toast.success(`Exported ${r.rowCount} quotes`);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  const rows = query.data?.rows ?? [];
  const today = query.data?.today ?? "";

  return (
    <>
      <PageHeader
        title="Quotes"
        description="Quotes do not post to the ledger until converted and the invoice is authorised."
        actions={
          <Button size="sm" asChild>
            <Link to="/sales/quotes/new">New quote</Link>
          </Button>
        }
      />
      <ListToolbar
        state={state}
        onChange={patch}
        statuses={STATUSES}
        searchPlaceholder="Search number, memo or customer"
        onExport={() => exporter.mutate()}
        exporting={exporter.isPending}
      />
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState
          title="Could not load quotes"
          description={friendlyAuthError(query.error)}
          onRetry={() => query.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState title="No quotes" description="No quotes match — create one for a customer." />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <SortHead label="Number" column="quote_number" state={state} onChange={patch} />
                <SortHead label="Date" column="quote_date" state={state} onChange={patch} />
                <SortHead label="Expires" column="expiry_date" state={state} onChange={patch} />
                <TableHead>Customer</TableHead>
                <SortHead label="Status" column="status" state={state} onChange={patch} />
                <SortHead
                  label="Total"
                  column="total_minor"
                  state={state}
                  onChange={patch}
                  className="text-right"
                />
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((qt) => {
                const can = isQuoteConvertible(qt, today);
                return (
                  <TableRow key={qt.id}>
                    <TableCell>
                      <Link
                        className="underline-offset-2 hover:underline"
                        to="/sales/quotes/$quoteId"
                        params={{ quoteId: qt.id }}
                      >
                        {qt.quote_number ?? qt.id.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell>{qt.quote_date}</TableCell>
                    <TableCell>{qt.expiry_date ?? "—"}</TableCell>
                    <TableCell>{qt.contacts?.name ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{qt.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {money(qt.total_minor, qt.currency_code)}
                    </TableCell>
                    <TableCell className="space-x-2 text-right">
                      {can.ok ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={convertM.isPending}
                          onClick={() => convertM.mutate(qt.id)}
                        >
                          Convert
                        </Button>
                      ) : qt.converted_invoice_id ? (
                        <Link
                          className="text-sm underline"
                          to="/sales/invoices/$invoiceId"
                          params={{ invoiceId: qt.converted_invoice_id }}
                        >
                          View invoice
                        </Link>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <Pager total={query.data?.total ?? 0} state={state} onChange={patch} />
        </>
      )}
    </>
  );
}
