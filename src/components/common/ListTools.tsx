import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { csvFilename, downloadCsv, toCsv, type CsvCell } from "@/lib/reports/csv";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Case-insensitive match: every word of the query must appear in the row's searchable text. */
export function matchesQuery(text: string, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = text.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Search box state for a list that is already loaded in the browser. */
export function useListSearch<T>(rows: readonly T[], textOf: (row: T) => string) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () => rows.filter((r) => matchesQuery(textOf(r), query)),
    // textOf is a stable inline mapper at every call site; rows and query drive the result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, query],
  );
  return { query, setQuery, filtered };
}

/**
 * Search plus CSV export for the rows currently shown. The export is exactly the filtered rows, so
 * it can be used to check a list against a statement or reconciliation.
 */
export function ListToolbar({
  query,
  onQuery,
  shown,
  total,
  placeholder,
  exportCsv,
}: {
  query: string;
  onQuery: (q: string) => void;
  shown: number;
  total: number;
  placeholder: string;
  exportCsv?: {
    company: string;
    title: string;
    currency: string;
    headers: string[];
    rows: CsvCell[][];
  };
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 print:hidden">
      <Input
        className="max-w-xs"
        aria-label={placeholder}
        placeholder={placeholder}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
      />
      <span className="text-sm text-muted-foreground">
        {shown === total ? `${total} rows` : `${shown} of ${total} rows`}
      </span>
      {exportCsv ? (
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={shown === 0}
          onClick={() => {
            const text = toCsv(
              {
                company: exportCsv.company,
                report: exportCsv.title,
                period: "All dates",
                currency: exportCsv.currency,
              },
              exportCsv.headers,
              exportCsv.rows,
            );
            downloadCsv(csvFilename(exportCsv.title, new Date().toISOString().slice(0, 10)), text);
          }}
        >
          <Download className="mr-1 size-4" /> Export CSV
        </Button>
      ) : null}
    </div>
  );
}
