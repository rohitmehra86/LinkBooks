# LinkBooks — New Bill module upgrade (completion)

## Access

**Purchases → Bills → New bill** — `/purchases/bills/new`

## Features delivered

1. **Supplier** — searchable directory; Quick add (name only); Add supplier details (full contact fields); duplicate-name guard; transaction-only address snapshot populated from contact.
2. **Bill header** — date, due date, payment terms catalogue (+ create term), supplier invoice #, memo, currency (org-enabled), tax exclusive / inclusive / none.
3. **Due dates** — calculated from terms; manual override with clear badge and “Return to automatic calculation”.
4. **Duplicate detection** — soft check by supplier + invoice # with link to existing bill and acknowledge-to-continue override.
5. **Lines** — catalogue item/service, free-text expense lines, qty/price/discount, account, tax codes, class/location/project, billable; add 1/5/10/15/20; delete; drag + move up/down; order persisted via `line_no`.
6. **Totals** — subtotal / tax / total / base-currency equivalent using shared tax math + FX rates.
7. **Attachments** — “Max file size: 20 MB”; drag/browse; type/size validation; preview/download/remove; stored in `document_attachments.content_base64` (org-scoped RLS).
8. **Actions** — Save draft (no journal); Save & authorise (shared posting engine); Save & add another; Cancel three-option dialog; Clear with confirm; Make recurring; Print document (not UI screenshot).
9. **Notes / activity** — internal notes table; audit events via `record_audit_event`.

## Cancel workflow

Exact message: *You have unsaved changes. Would you like to save this bill before leaving?*

| Choice | Behaviour |
|--------|-----------|
| Save & Exit | Validate + save; navigate only on success; errors keep form data |
| Discard Changes | Leave without writing; existing saved drafts untouched |
| Continue Editing | Close dialog; keep all entered data |

No dialog when the form is not dirty (baseline captured after defaults apply).

## Schema

Migration `supabase/migrations/20261020260000_bills_new_upgrade.sql`:

- Bill address snapshot, tax_calculation, payment_term_id, due_date_manual_override, fx_rate_to_base, duplicate_override
- `company_payment_terms`, `bill_internal_notes`
- Attachment `content_base64` + 20 MB check
- Line tracking / billable columns
- Soft unique index for supplier invoice (allows override)

## Accounting

Drafts do not post. Authorise uses `postBillAuthorisation` → `postJournal` with idempotency key `purchase_bill:{id}:authorise`, including FX rate when foreign currency.

## Tests

- `src/lib/purchases/bill-form-helpers.test.ts` — due dates, tax modes, attachments, cancel dirty detection
- Existing `line-math.test.ts` still green

## Known limitations

- Customer picker on lines is wired for persistence but not yet populated with a customer contacts query (column saves when set).
- Attachment bytes live in Postgres (`content_base64`); object storage can replace later without changing the UI contract.
- Edit bill route still a thinner form; new create flow is the full upgrade surface.
- PO quantity matching uses existing Orders convert flow; New Bill shows policy banner when `purchases_require_po` is set.
