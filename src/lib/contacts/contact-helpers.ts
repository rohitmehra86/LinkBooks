/** Pure contact helpers — no I/O. */

export type ContactKind = "customer" | "supplier" | "both" | "employee";

export function normalizeContactName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isCustomerKind(kind: string): boolean {
  return kind === "customer" || kind === "both";
}

export function isSupplierKind(kind: string): boolean {
  return kind === "supplier" || kind === "both";
}

export function dueDateFromTerms(invoiceDateIso: string, termsDays: number): string {
  const d = new Date(`${invoiceDateIso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error("Invalid date");
  d.setUTCDate(d.getUTCDate() + Math.max(0, Math.floor(termsDays)));
  return d.toISOString().slice(0, 10);
}

/** Escape CSV cell; prefix formula-like values with apostrophe. */
export function csvEscape(value: string | number | null | undefined): string {
  const raw = value == null ? "" : String(value);
  const safe =
    raw.startsWith("=") || raw.startsWith("+") || raw.startsWith("-") || raw.startsWith("@")
      ? `'${raw}`
      : raw;
  if (/[",\n\r]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

export function buildContactsCsv(
  rows: Array<Record<string, string | number | null | undefined>>,
  columns: string[],
): string {
  const header = columns.map(csvEscape).join(",");
  const body = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(",")).join("\n");
  return `${header}\n${body}\n`;
}

export function parseContactsCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const headers = parseLine(lines[0]!).map((h) => h.trim().toLowerCase());
  const rows = lines.slice(1).map(parseLine);
  return { headers, rows };
}

export function contactImportTemplateCsv(): string {
  return buildContactsCsv(
    [
      {
        name: "Acme Ltd",
        kind: "customer",
        email: "billing@acme.example",
        phone: "+44 20 0000 0000",
        tax_number: "GB123",
        payment_terms_days: 30,
        account_number: "C1001",
        notes: "",
      },
    ],
    [
      "name",
      "kind",
      "email",
      "phone",
      "tax_number",
      "payment_terms_days",
      "account_number",
      "notes",
    ],
  );
}

/** Score potential duplicate pair (higher = more likely). */
export function duplicateScore(a: {
  name: string;
  email?: string | null;
  phone?: string | null;
  tax_number?: string | null;
  account_number?: string | null;
}, b: {
  name: string;
  email?: string | null;
  phone?: string | null;
  tax_number?: string | null;
  account_number?: string | null;
}): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  if (normalizeContactName(a.name) === normalizeContactName(b.name)) {
    score += 50;
    reasons.push("Same name");
  }
  const ae = (a.email ?? "").trim().toLowerCase();
  const be = (b.email ?? "").trim().toLowerCase();
  if (ae && be && ae === be) {
    score += 40;
    reasons.push("Same email");
  }
  const ap = (a.phone ?? "").replace(/\D/g, "");
  const bp = (b.phone ?? "").replace(/\D/g, "");
  if (ap.length >= 7 && ap === bp) {
    score += 30;
    reasons.push("Same phone");
  }
  const at = (a.tax_number ?? "").trim().toLowerCase();
  const bt = (b.tax_number ?? "").trim().toLowerCase();
  if (at && bt && at === bt) {
    score += 45;
    reasons.push("Same tax ID");
  }
  const aa = (a.account_number ?? "").trim().toLowerCase();
  const ba = (b.account_number ?? "").trim().toLowerCase();
  if (aa && ba && aa === ba) {
    score += 60;
    reasons.push("Same account number");
  }
  return { score, reasons };
}
