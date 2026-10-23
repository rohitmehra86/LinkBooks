# Decisions log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-10-23 | Work on branch `cto-master-programme` | Production safety; no force-push to Lovable main history |
| 2026-10-23 | Preserve top-level nav labels/paths | Directive §4; deep-link stability |
| 2026-10-23 | Demo volume docs = draft only | Prevent AR/AP UI/GL divergence |
| 2026-10-23 | Link canonical docs via `posted_journal_id` after seed post | Ageing already filters on this; must match GL |
| 2026-10-23 | Demote orphan authorised/paid docs without journals to draft (SQL) | No journal rewrite; preserves posted history |
| 2026-10-23 | INV-1003 stays draft until a real journal exists | Not in DEMO_JOURNAL_SPECS; do not invent AR |
| 2026-10-23 | Keep Create registry blocked items blocked until signed-in ledger proof | Honesty rule |
