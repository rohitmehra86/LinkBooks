# LinkBooks — Competitive Benchmark (Owner Audit)

| Field | Value |
|-------|-------|
| **Date** | 2026-10-19 |
| **LinkBooks reference** | Friend demo deploy; ledger MVP per [LINKBOOKS_FEATURE_CATALOG.md](./LINKBOOKS_FEATURE_CATALOG.md) |
| **Method** | Capability matrix vs 20 products; official marketing/docs cited where used; **unverified** = not confirmed from primary source in this audit pass |

### Legend (cell values)

| Symbol | Meaning |
|--------|---------|
| **N** | Native in product |
| **P** | Native but plan-tier restricted |
| **A** | Add-on module / paid extension |
| **3P** | Third-party / marketplace integration |
| **—** | Unavailable or not marketed |
| **?** | Unverified (do not rely on for sales claims) |

---

## Products in scope (20)

QuickBooks Online (QBO), Xero, Wave, Zoho Books, FreshBooks, Sage Accounting (cloud), FreeAgent, Kashoo, Akaunting, Odoo Accounting, Manager.io, ERPNext, MYOB, TallyPrime, Clear Books, AccountEdge, NetSuite, Sage Intacct, Patriot, ZarMoney.

---

## Capability matrix (high-level)

Rows reflect what SMB buyers typically compare. LinkBooks column is **evidence-based** from repo audit, not aspirations.

| Capability | LinkBooks | QBO | Xero | Wave | Zoho Books | FreshBooks | Sage Acct | FreeAgent | Kashoo | Akaunting | Odoo Acct | Manager.io | ERPNext | MYOB | TallyPrime | Clear Books | AccountEdge | NetSuite | Sage Intacct | Patriot | ZarMoney |
|------------|-----------|-----|------|------|------------|------------|-----------|-----------|--------|-----------|-----------|------------|---------|------|------------|-------------|-------------|-----------|----------|--------------|---------|----------|
| Double-entry GL | N | N | N | N | N | P | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N |
| AR invoicing | N* | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N |
| AP bills | N* | N | N | N | N | P | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N |
| Bank feeds (live) | — | N/3P | N/3P | N | N/3P | 3P | N/3P | N | 3P | 3P | 3P | — | 3P | N/3P | 3P | 3P | P | N | N | P | 3P |
| Bank reconcile | N† | N | N | N | N | P | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N |
| Multi-currency | P | P | P | P | P | P | P | P | P | P | N | P | N | P | P | P | P | N | N | P | P |
| Tax/VAT codes on lines | P‡ | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N |
| Inventory | — | P/A | P/A | — | P | — | P | — | — | P | N | N | N | P | N | — | P | N | P | — | P |
| Payroll | — | P/A | 3P | — | A | — | 3P | P | — | 3P | A | — | A | N/3P | — | 3P | 3P | N | 3P | N | 3P |
| Projects / job costing | — | P | P/A | — | P | N | P | P | — | P | N | P | N | P | P | P | P | N | N | — | P |
| Fixed assets | — | P/A | A | — | A | — | A | — | — | P | N | N | N | P | P | — | P | N | N | — | — |
| Accountant / firm portal | P | P | N | — | P | — | P | N | — | — | — | — | — | P | — | P | P | N | N | — | — |
| API / ecosystem | P | N | N | P | N | N | N | N | ? | N | N | — | N | N | 3P | ? | ? | N | N | ? | ? |
| Mobile apps | — | N | N | N | N | N | N | N | ? | ? | N | N | ? | N | N | ? | ? | N | N | ? | ? |
| AI-assisted bookkeeping | P§ | P/A | A | — | ? | ? | ? | ? | — | — | ? | — | — | ? | — | — | — | A | ? | — | — |

\* LinkBooks: implemented but incompletely verified (no live E2E).  
† CSV/rules/reconcile; no live feeds.  
‡ Tax rates exist; document lines use bps not code picker (gap G-017).  
§ Optional key; suggestions only; no auto-post.

**Sources (sample, not exhaustive):**  
- Xero features: [xero.com/accounting-software](https://www.xero.com/accounting-software/) (bank connections, invoicing, reporting).  
- Intuit QBO plans: [quickbooks.intuit.com/pricing](https://quickbooks.intuit.com/pricing/) (tiered features).  
- Zoho Books vs ecosystem: [zoho.com/books](https://www.zoho.com/books/) (invoicing, bills, banking).  
- Wave: [waveapps.com](https://www.waveapps.com/) (free accounting positioning; payments separate).  
Cells marked **?** were not re-validated line-by-line against each vendor’s 2026 pricing page in this pass.

---

## LinkBooks vs market — honest position

| Dimension | Assessment |
|-----------|------------|
| Feature breadth | **Below** QBO, Xero, Zoho, Sage, MYOB, NetSuite, Intacct |
| Ledger core | **Comparable design intent** (single posting RPC) but **less proven** operationally |
| Integrations | **Far behind** (no feeds, email, payments, payroll) |
| Time to value (demo) | **Potentially faster** for guided demo with fictional data |
| Compliance depth | **Not ready** (no filing, MTD, audit packs) |

---

## Ranked differentiator hypotheses (≥10)

Hypotheses for positioning and product bets — **not claims of unique invention**. Competitors may overlap; validate with user research before marketing.

| Rank | Hypothesis | Why it might matter | Risk / honesty |
|------|------------|---------------------|----------------|
| 1 | **Single atomic `post_journal` RPC** as the only write path to the GL | Reduces “shadow ledgers” common in bolt-on modules | Others also use centralized GL; benefit is **discipline**, not exclusivity |
| 2 | **Demo Company uses production posting rules** (`is_demo` does not fork math) | Trust in “try before buy” without fake numbers | Xero/QBO have demos too; must **prove** with live TB golden (G-012) |
| 3 | **Modern React SPA + Supabase RLS** stack vs legacy desktop (Tally, AccountEdge) | Faster iteration, lower ops for small team | Security depends on RLS proof (G-001) |
| 4 | **Open fork / self-host path potential** (Supabase + Vercel) vs locked SaaS | Appeal to advisors wanting data residency | Not productised; support burden |
| 5 | **AI as confirm-only assistant** not autonomous bookkeeper | Reduces liability vs “AI auto-categorise everything” hype | QBO/Xero adding AI; advantage is **conservative** posture if maintained |
| 6 | **Integer minor-unit money** end-to-end | Avoids float bugs in JS accounting apps | Industry standard pattern; not unique |
| 7 | **Nav-visible full product** with explicit shell labelling | Sets expectations vs silent stubs | Could backfire if nav oversells; Products shell is honest today |
| 8 | **UK-centric demo dataset (GBP, VAT regime flags)** without claiming MTD filing | Faster narrative for UK advisory friends | Narrow geography until localisation |
| 9 | **Firm route early** (basic) while incumbents gate firm mode on expensive tiers | Practice-led distribution | Feature depth far behind Xero Practice / QBO Accountant |
| 10 | **No per-seat upsell on AI** (bring your own key) | Cost control for micro-SMB | Support complexity; not enterprise-grade |
| 11 | **Lovable/Vercel velocity** for UI experiments | Faster friend-feedback loops | Not a buyer-facing differentiator alone |
| 12 | **Transparent audit pack** (this doc set) vs vendor marketing | Builds advisor trust for beta | Only valuable if kept current |

---

## When LinkBooks is **not** the right tool (today)

- Live bank feeds required day one  
- Payroll, inventory, or fixed assets on critical path  
- Statutory e-filing (MTD, IRS, etc.)  
- Multi-entity consolidation (Intacct/NetSuite class)  
- Customer expecting mature mobile + marketplace integrations  

---

## Related documents

- [LINKBOOKS_FEATURE_CATALOG.md](./LINKBOOKS_FEATURE_CATALOG.md)
- [LINKBOOKS_GAP_REGISTER.md](./LINKBOOKS_GAP_REGISTER.md)
- [LINKBOOKS_PRODUCTION_READINESS.md](./LINKBOOKS_PRODUCTION_READINESS.md)
