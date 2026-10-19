import { assertLinesBalance, type JournalLineDraft } from "@/lib/accounting/money";

export type AiSuggestionType =
  | "journal_draft"
  | "category_suggestion"
  | "invoice_draft"
  | "bill_draft"
  | "note";

export type ParsedAiSuggestion = {
  type: AiSuggestionType;
  title: string;
  payload: Record<string, unknown>;
};

const TYPES: AiSuggestionType[] = [
  "journal_draft",
  "category_suggestion",
  "invoice_draft",
  "bill_draft",
  "note",
];

export function extractJsonSuggestion(markdown: string): ParsedAiSuggestion | null {
  const match = markdown.match(/```json\s*([\s\S]*?)```/i);
  if (!match?.[1]) return null;
  try {
    const obj = JSON.parse(match[1]) as Record<string, unknown>;
    const type = obj["type"] as AiSuggestionType;
    if (!TYPES.includes(type)) return null;
    const titleRaw = obj["title"];
    const title = typeof titleRaw === "string" ? titleRaw.slice(0, 200) : type;
    const payloadRaw = obj["payload"];
    const payload =
      payloadRaw && typeof payloadRaw === "object" && !Array.isArray(payloadRaw)
        ? (payloadRaw as Record<string, unknown>)
        : {};
    return { type, title, payload };
  } catch {
    return null;
  }
}

export type ValidationResult = {
  ok: boolean;
  errors: string[];
  normalized?: {
    type: AiSuggestionType;
    title: string;
    lines?: JournalLineDraft[];
    payload: Record<string, unknown>;
  };
};

/** Deterministic validation — AI output never bypasses this. */
export function validateSuggestionPayload(
  suggestion: ParsedAiSuggestion,
  opts: { allowedAccountIds: Set<string> },
): ValidationResult {
  const errors: string[] = [];

  if (suggestion.type === "journal_draft") {
    const rawLines = suggestion.payload["lines"];
    if (!Array.isArray(rawLines) || rawLines.length < 2) {
      return { ok: false, errors: ["journal_draft requires at least two lines"] };
    }
    const lines: JournalLineDraft[] = [];
    for (const [i, row] of rawLines.entries()) {
      if (!row || typeof row !== "object") {
        errors.push(`Line ${i + 1}: invalid`);
        continue;
      }
      const r = row as Record<string, unknown>;
      const account_id = String(r["account_id"] ?? "");
      if (!opts.allowedAccountIds.has(account_id)) {
        errors.push(`Line ${i + 1}: account not in this organisation's chart`);
      }
      const debit_minor = Number(r["debit_minor"] ?? 0);
      const credit_minor = Number(r["credit_minor"] ?? 0);
      if (!Number.isFinite(debit_minor) || !Number.isFinite(credit_minor)) {
        errors.push(`Line ${i + 1}: amounts must be finite numbers`);
      }
      const descRaw = r["description"];
      const line: JournalLineDraft = {
        account_id,
        debit_minor,
        credit_minor,
      };
      if (typeof descRaw === "string") {
        line.description = descRaw.slice(0, 200);
      }
      lines.push(line);
    }
    if (errors.length) return { ok: false, errors };
    try {
      assertLinesBalance(lines);
    } catch (e) {
      return { ok: false, errors: [e instanceof Error ? e.message : "Unbalanced journal"] };
    }
    return {
      ok: true,
      errors: [],
      normalized: { type: "journal_draft", title: suggestion.title, lines, payload: { lines } },
    };
  }

  if (suggestion.type === "category_suggestion") {
    const account_id = String(suggestion.payload["account_id"] ?? "");
    if (!opts.allowedAccountIds.has(account_id)) {
      errors.push("category account not in this organisation's chart");
    }
    const bank_transaction_id = suggestion.payload["bank_transaction_id"];
    if (bank_transaction_id != null && typeof bank_transaction_id !== "string") {
      errors.push("bank_transaction_id must be a string uuid when present");
    }
    if (errors.length) return { ok: false, errors };
    return {
      ok: true,
      errors: [],
      normalized: {
        type: "category_suggestion",
        title: suggestion.title,
        payload: {
          account_id,
          bank_transaction_id: bank_transaction_id ?? null,
          rationale: String(suggestion.payload["rationale"] ?? "").slice(0, 500),
        },
      },
    };
  }

  if (suggestion.type === "invoice_draft" || suggestion.type === "bill_draft") {
    const lines = suggestion.payload["lines"];
    if (!Array.isArray(lines) || lines.length < 1) {
      return { ok: false, errors: [`${suggestion.type} requires at least one line`] };
    }
    return {
      ok: true,
      errors: [],
      normalized: {
        type: suggestion.type,
        title: suggestion.title,
        payload: {
          contact_name: String(suggestion.payload["contact_name"] ?? "").slice(0, 160),
          lines: lines.slice(0, 50),
          memo: String(suggestion.payload["memo"] ?? "").slice(0, 500),
        },
      },
    };
  }

  return {
    ok: true,
    errors: [],
    normalized: { type: "note", title: suggestion.title, payload: suggestion.payload },
  };
}

/** Reject apply of malformed / injection-shaped payloads. */
export function assertSafeApplyConfirm(confirm: unknown): asserts confirm is true {
  if (confirm !== true) {
    throw new Error("Consequential AI actions require explicit confirm: true");
  }
}
