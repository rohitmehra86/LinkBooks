# Accounting reconciliation report

| Test | Expected | Actual | Pass | Notes |
|------|----------|--------|------|-------|
| Journal line balance (all posted) | debits=credits per journal | 0 unbalanced | **PASS** | Live SQL |
| Org TB sum of nets | 0 | 0 | **PASS** | Demo `25197bd0` |
| BS equation | A = L + E + NI | holds | **PASS** | From nets |
| Canonical demo unit tests | DEMO_EXPECTED | green | **PASS** | `demo.test.ts` |
| AR control vs open posted invoices | equal | 480000=480000 | **PASS** | After M1 repair |
| AP control vs open posted bills | equal | `25197bd0` GL 75000 / open 0; `78250720` GL 76000 / open 1000 | **FAIL/PARTIAL** | Open bill subledger understates AP GL — investigate COS/AP journals vs demoted bills in M1 follow-up |
| Authorised docs have journals | yes | orphans demoted | **PASS** | Repair |
| Period lock + lock dates | block posting | RPC+trigger | **PASS** | Schema |
| Idempotent post | same key → same journal | engine | **PASS** | Unit + RPC |
| Posted immutability | no silent edit | triggers | **PASS** | Schema |
| Volume shells in AR ageing | excluded | draft-only now | **PASS** | Seed fix |

## Root causes corrected
- Document/journal unlink in demo seed (metadata fix; no journal rewrite).
- Volume paid-without-journal shells (status policy).

## Remaining
- Automate AR/AP control vs subledger in Vitest against a fixture org.
- Cross-module E2E: invoice → receipt → bank match → TB.
- Second demo company dedupe.
