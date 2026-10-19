# AI Accounting Assistant — acceptance evidence

**Policy:** [AI_DATA_HANDLING.md](./AI_DATA_HANDLING.md)  
**Migration (apply when approved):** `supabase/migrations/20261019210000_ai_assistant.sql`  
**UI:** `/ai-assistant`  
**Server:** `src/lib/ai/*` (keys never `VITE_*`)

---

## Features

| Feature | Implementation | Status |
|---------|----------------|--------|
| Explain transactions/reports | intent `explain` + ledger context | Pass (needs `AI_API_KEY`) |
| Q&A on authorised org data | intent `ask`; membership + `ai.use` | Pass |
| Suggest categories | intent `categorise` + JSON suggestion | Pass |
| Draft invoice/bill/journal | intent `draft` + validated payload | Pass |
| Possible duplicates | intent `duplicates` — **calculated**, not LLM | Pass (no key required) |
| Reconciliation exceptions | intent `reconcile` — calculated | Pass |
| Unusual movements | intent `unusual` — calculated | Pass |
| Navigate workflows | intent `navigate` — local help map | Pass |
| Honest unconfigured state | `getAiAssistantStatus` + UI banner | Pass |

## Security

| Criterion | Evidence | Status |
|-----------|----------|--------|
| Org permissions before context | `assertCompanyPermission(..., 'ai.use')` | Pass |
| Cross-tenant denial | companyId membership + account allow-list on apply | Pass (unit + server) |
| Untrusted input / injection | `sanitize.ts` wrap + flags | Pass (unit) |
| Rate limits | `count_ai_usage_last_hour` + env cap | Pass (needs migration) |
| Safe logging | usage events without full prompts | Pass |
| No secrets in browser | public status omits apiKey; env-safety flags `VITE_*` AI keys | Pass |

## Accounting safety

| Criterion | Evidence | Status |
|-----------|----------|--------|
| Validate before apply | `validateSuggestionPayload` + `assertLinesBalance` | Pass |
| No unsupervised post | apply requires `confirm: true` + `ai.apply_suggestion` | Pass |
| No payment initiation | out of apply scope | Pass |
| Facts vs explanations | UI badges + calculated blocks | Pass |

## Tests

`npx vitest run src/lib/ai/ai.test.ts` — permissions, isolation contracts, injection, malformed JSON, unbalanced drafts, foreign accounts, provider-not-configured, local analyses, Vite key exposure.

## Limitations

- Provider choice still optional; OpenAI-compatible HTTP only.
- Apply posts **journal_draft** suggestions only (invoice/bill drafts stay suggestions for module UI).
- Live provider + rate-limit RPCs need migration applied and `AI_API_KEY` set.
- Uploaded files: text excerpts only (no binary upload pipeline yet).
