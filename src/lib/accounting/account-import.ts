import { isAccountKind, type AccountKind } from "@/lib/accounting/account-kinds";
import { externalTypeToKind } from "@/lib/accounting/account-suggest";

export type ChartImportRow = {
  code: string;
  name: string;
  accountKind: AccountKind;
  description: string;
  parentCode: string;
  detailType: string;
  isHeader: boolean;
  currencyCode: string;
};

export type ChartImportIssue = { row: number; message: string };

const HEADER_ALIASES: Record<string, keyof ChartImportRow | "type"> = {
  code: "code",
  "account code": "code",
  "account number": "code",
  "*code": "code",
  name: "name",
  "account name": "name",
  "*name": "name",
  type: "type",
  "account type": "type",
  "*type": "type",
  kind: "accountKind",
  "account kind": "accountKind",
  description: "description",
  "detail type": "detailType",
  "parent code": "parentCode",
  parent: "parentCode",
  currency: "currencyCode",
  "currency code": "currencyCode",
  header: "isHeader",
};

export function parseChartCsv(text: string): {
  rows: ChartImportRow[];
  issues: ChartImportIssue[];
} {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length < 2)
    return { rows: [], issues: [{ row: 1, message: "The file needs a header and one account." }] };
  const headers = splitCsvLine(lines[0] ?? "").map((cell) => cell.trim().toLowerCase());
  const columns = headers.map((header) => HEADER_ALIASES[header] ?? null);
  if (
    !columns.includes("code") ||
    !columns.includes("name") ||
    !(columns.includes("type") || columns.includes("accountKind"))
  ) {
    return {
      rows: [],
      issues: [{ row: 1, message: "Map columns for code, name, and account type." }],
    };
  }
  const rows: ChartImportRow[] = [];
  const issues: ChartImportIssue[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const cells = splitCsvLine(lines[index] ?? "");
    const draft: ChartImportRow = {
      code: "",
      name: "",
      accountKind: "expense",
      description: "",
      parentCode: "",
      detailType: "",
      isHeader: false,
      currencyCode: "",
    };
    let typeText = "";
    columns.forEach((column, cellIndex) => {
      const value = (cells[cellIndex] ?? "").trim();
      if (column === "type") typeText = value;
      else if (column === "isHeader") draft.isHeader = /^(1|true|yes)$/i.test(value);
      else if (column === "accountKind" && isAccountKind(value)) draft.accountKind = value;
      else if (column && column !== "accountKind") draft[column] = value;
    });
    if (!draft.code && !draft.name) continue;
    const kind = isAccountKind(typeText) ? typeText : externalTypeToKind(typeText);
    if (kind) draft.accountKind = kind;
    if (!draft.code || draft.code.length > 10)
      issues.push({ row: index + 1, message: "Code must be 1 to 10 characters." });
    if (!draft.name || draft.name.length > 150)
      issues.push({ row: index + 1, message: "Name must be 1 to 150 characters." });
    if (!kind && !isAccountKind(draft.accountKind)) {
      issues.push({ row: index + 1, message: `Unrecognised account type “${typeText}”.` });
    } else if (!kind && typeText && !isAccountKind(typeText)) {
      issues.push({ row: index + 1, message: `Unrecognised account type “${typeText}”.` });
    }
    if (draft.currencyCode && !/^[A-Za-z]{3}$/.test(draft.currencyCode)) {
      issues.push({ row: index + 1, message: "Currency must be a 3-letter code." });
    }
    rows.push(draft);
  }
  return { rows, issues };
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else current += char;
  }
  cells.push(current);
  return cells;
}

export function chartRowsToCsv(
  rows: readonly { code: string; name: string; accountKind: string; description: string }[],
): string {
  const header = "Code,Name,Account type,Description";
  const body = rows.map((row) =>
    [row.code, row.name, row.accountKind, row.description].map(csvCell).join(","),
  );
  return [header, ...body].join("\n");
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
