# LinkBooks — Security & Permissions Matrix

## 1. Security layers

| Layer | Mechanism |
|-------|-----------|
| Identity | Supabase Auth JWT → `auth.uid()` |
| UX gate | `_authenticated` layout (redirect only) |
| Server | `requireSupabaseAuth` on all mutating/server reads |
| Authorisation | `has_company_permission(company_id, permission)` |
| Data | RLS on every tenant table using membership helpers |
| Admin | Service role only on server; never `VITE_*` |

**Invariant:** Changing `company_id` in a request cannot escalate — RLS returns empty / deny.

---

## 2. Roles (existing enum — keep)

| Role | Intent |
|------|--------|
| `owner` | Full control, billing, grant owner, archive company |
| `admin` | Settings, users, all books; no billing transfer of ownership |
| `accountant` | Full books + period tools; limited user admin |
| `bookkeeper` | Day-to-day documents + bank + journals |
| `staff` | Create drafts / expenses; limited post |
| `read_only` | View reports & lists |

Existing seed is **too coarse** (`accounting.view` / `accounting.post` only). Expand catalogue below via migration (additive rows to `role_permissions`).

---

## 3. Permission catalogue (target)

### Company & people
| Permission | owner | admin | accountant | bookkeeper | staff | read_only |
|------------|:-----:|:-----:|:----------:|:----------:|:-----:|:---------:|
| company.view | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| company.settings.edit | ✓ | ✓ | | | | |
| members.view | ✓ | ✓ | ✓ | ✓ | | |
| members.manage | ✓ | ✓ | | | | |
| members.grant_owner | ✓ | | | | | |
| billing.manage | ✓ | | | | | |
| audit.view | ✓ | ✓ | ✓ | ✓ | | ✓* |
| demo.reset | ✓ (demo only) | ✓ (demo) | | | | |

\* read_only: audit.view optional — **approval:** include or not.

### Sales
| Permission | owner | admin | accountant | bookkeeper | staff | read_only |
|------------|:-----:|:-----:|:----------:|:----------:|:-----:|:---------:|
| sales.view | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| sales.draft | ✓ | ✓ | ✓ | ✓ | ✓ | |
| sales.authorise | ✓ | ✓ | ✓ | ✓ | | |
| sales.void | ✓ | ✓ | ✓ | ✓ | | |
| sales.payment | ✓ | ✓ | ✓ | ✓ | | |

### Purchases
| Permission | owner | admin | accountant | bookkeeper | staff | read_only |
|------------|:-----:|:-----:|:----------:|:----------:|:-----:|:---------:|
| purchases.view | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| purchases.draft | ✓ | ✓ | ✓ | ✓ | ✓ | |
| purchases.authorise | ✓ | ✓ | ✓ | ✓ | | |
| purchases.payment | ✓ | ✓ | ✓ | ✓ | | |
| expenses.submit | ✓ | ✓ | ✓ | ✓ | ✓ | |
| expenses.approve | ✓ | ✓ | ✓ | | | |

### Banking
| Permission | owner | admin | accountant | bookkeeper | staff | read_only |
|------------|:-----:|:-----:|:----------:|:----------:|:-----:|:---------:|
| banking.view | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| banking.import | ✓ | ✓ | ✓ | ✓ | | |
| banking.categorise | ✓ | ✓ | ✓ | ✓ | ✓† | |
| banking.reconcile | ✓ | ✓ | ✓ | ✓ | | |
| banking.feeds.manage | ✓ | ✓ | | | | |

† staff: categorise drafts only if policy allows — **approval**.

### Accounting / periods / reports
| Permission | owner | admin | accountant | bookkeeper | staff | read_only |
|------------|:-----:|:-----:|:----------:|:----------:|:-----:|:---------:|
| accounting.view | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| accounting.post | ✓ | ✓ | ✓ | ✓ | | |
| journals.manual | ✓ | ✓ | ✓ | ✓ | | |
| accounts.manage | ✓ | ✓ | ✓ | | | |
| periods.lock | ✓ | ✓ | ✓ | | | |
| periods.unlock | ✓ | ✓ | | | | |
| reports.view | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| reports.export | ✓ | ✓ | ✓ | ✓ | | ✓ |

### Tax / contacts / products / AI / firm
| Permission | owner | admin | accountant | bookkeeper | staff | read_only |
|------------|:-----:|:-----:|:----------:|:----------:|:-----:|:---------:|
| tax.settings | ✓ | ✓ | ✓ | | | |
| contacts.manage | ✓ | ✓ | ✓ | ✓ | ✓ | |
| products.manage | ✓ | ✓ | ✓ | ✓ | | |
| ai.use | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ai.apply_suggestion | ✓ | ✓ | ✓ | ✓ | | |
| firm.manage | firm role | | | | | |
| firm.access_client | firm role | | | | | |

---

## 4. Firm access model

1. User is `firm_members` (firm roles: `firm_owner`, `firm_admin`, `firm_staff`).  
2. `firm_client_links` grants access_level: `view` | `bookkeep` | `full`.  
3. Link acceptance upserts `company_members` with mapped company role (`read_only` / `bookkeeper` / `accountant`).  
4. Revoking link suspends membership — RLS immediately denies.  
5. Firm users **never** read client rows without membership row.

---

## 5. RLS policy pattern (every new table)

```sql
-- SELECT
USING (public.is_company_member(company_id))
-- INSERT/UPDATE/DELETE
USING / WITH CHECK (
  public.is_company_member(company_id)
  AND public.has_company_permission(company_id, '<perm>')
)
```

Posted journals: no UPDATE/DELETE for clients; reverse via PostingEngine only (SECURITY DEFINER or controlled RPC).

---

## 6. Storage permissions

- Path must start with `company_id` the user belongs to.  
- MIME/size limits server-side.  
- No public buckets for financial attachments.

---

## 7. Organisation switching safety

1. Client sends intended `companyId` on server calls (or server uses last_company_id).  
2. Server verifies membership before query.  
3. On switch: update `last_company_id` → clear caches → full navigation refresh.  
4. Never trust client-only “active company” for authorisation.
