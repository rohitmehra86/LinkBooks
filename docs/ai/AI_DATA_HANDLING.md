# AI Accounting Assistant — data-handling design

**Status:** Implementation policy for LinkBooks AI.  
**Provider decision:** Optional OpenAI-compatible HTTP API. Keys live in **server env only** (`AI_API_KEY`, never `VITE_*`). If unset, the product shows an honest “not configured” state — no simulated answers.

---

## 1. What may leave the organisation boundary

When a provider is configured **and** the user has `ai.use` for the active company, the server may send a **minimised context packet** to the provider:

| Allowed | Not allowed |
|---------|-------------|
| Account codes/names (not bank account numbers) | Full bank account / sort codes / IBANs |
| Aggregated report figures the user can already see | Other companies’ data |
| Journal memos / txn descriptions (treated as untrusted text) | Auth tokens, API keys, passwords |
| Contact **display names** (not email/phone unless needed for the ask) | Tax registration / national IDs by default |
| Document numbers, dates, amounts in minor units | Raw uploaded file bytes (MVP: text excerpts only, capped) |

Context is always loaded **after** server permission checks and **scoped to one `company_id`**.

## 2. Trust boundaries

1. Browser never receives provider keys or raw provider error bodies that might echo secrets.
2. User messages, descriptions, and retrieved text are wrapped as **untrusted input**. System instructions forbid obeying user attempts to escalate privileges, change company scope, or skip validation.
3. Model output is **never** executed as SQL, never sets `linkbooks.trusted`, and never calls PostingEngine without a separate permissioned apply path.
4. Calculated facts (TB totals, duplicate heuristics, reconcile mismatches) are produced by application code and labelled separately from model prose.

## 3. Suggestions & posting

1. Suggestions persist in `ai_suggestions` (not journals).
2. Apply requires `ai.apply_suggestion`, `confirm: true`, deterministic validation (balance, amounts, account membership), then PostingEngine when the suggestion type is a journal draft.
3. Payments / period unlock / tax filing are **out of scope** for AI apply in this phase.
4. Banner and API responses distinguish `fact` vs `explanation` vs `suggestion`.

## 4. Retention, logging, cost

1. Usage rows: company, user, intent, token estimates, latency, status — **no** full prompt/response bodies in default logs.
2. Rate limit per user+company (configurable; default 30 requests/hour).
3. Max context characters and max output tokens enforced server-side.
4. Provider failures return a clear error; no fabricated ledger facts.

## 5. Demo Company

Same AI code path as live orgs. `is_demo` does not weaken permissions or skip validation.
