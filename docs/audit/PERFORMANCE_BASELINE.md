# Performance baseline (2026-10-23)

## Measurements taken
| Signal | Observation |
|--------|-------------|
| Vitest suite | ~2.1s / 236 tests after `npm install` |
| Demo bill list volume | ~371 purchase_bills rows (mostly draft shells) |
| Demo bank_transactions | ~420 rows |
| Client stack | TanStack Start SSR on Vercel — cold starts observed historically |

## Not yet profiled (M12)
- Lighthouse / Web Vitals on production
- Bundle size per route (code splitting opportunities)
- N+1 on aged reports with large open item sets
- Reconciliation virtualization under 10k statement lines

## Known contributors to slowness
1. Vercel serverless cold start
2. Large demo volume lists without aggressive virtualization everywhere
3. Multiple sequential serverFn round-trips on dense forms (New Bill)

## Guardrail
Do not delete demo volume without replacing with paginated generators; prefer draft-only shells (done in M1 seed fix).
