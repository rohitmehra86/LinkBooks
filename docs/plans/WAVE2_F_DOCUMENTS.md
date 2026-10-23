# Wave 2-F — Documents & communication

Branch `wave2-F-documents` (base 516360f). Nothing here is applied to live Supabase; apply the migrations first.

## What changed

**Printable documents** (`src/lib/documents/*`, `src/components/documents/DocumentSheet.tsx`)
- Kinds: sales invoice, credit note, quote, receipt / payment advice, purchase bill, purchase order, supplier credit note, supplier remittance advice, plus the customer statement page.
- Pure mappers (`mappers.ts`) turn DB rows into one `PrintDocument` model; one `DocumentSheet` renders them.
- Branding: logo, name, address, tax number, e-mail/phone, accent colour, bank details, payment terms, notes, footer.
- Tax summary table, document-currency amounts with the exchange rate shown, PAID / VOID / DRAFT marks, page-break CSS (`@page A4`, repeated table header, no split rows).
- "Tax invoice" title only when the company has a tax number.
- Delivery is **print-to-PDF** from the browser (`/documents/print/$kind/$id`). No server-side PDF: no PDF library is installed and a headless browser is a heavy native dependency.

**Branding settings** — `/documents/branding` (company.settings.edit). Logo upload goes to the existing private `org-logos` bucket, with a live preview on sample data. Linked from Settings → Documents.

**E-mail** (`email-provider.server.ts`, `documents.functions.ts`)
- Sends through Resend **only if** `RESEND_API_KEY` and `EMAIL_FROM` are set. Otherwise nothing is sent or recorded and the UI says "Email sending is not configured. Download the PDF, copy the link, or use your own email program."
- Templates: invoice, reminder, statement, receipt, quote, credit note, purchase order, remittance. Content is HTML-escaped.
- `mailto:` fallback ("Open in my email program") always available.
- Send history on every document (`email_outbox`, written only through the `record_email_outbox` RPC, which checks permissions).
- Demo Company: sending is blocked (external integration), everything else works.
- No PDF attachment: the e-mail has a summary, bank details and (invoices) an online link.

**Reminders** — `/sales/reminders`: overdue invoices, whether the next reminder is due under the schedule (first after N days, repeat every N, max count), manual batch send (≤ 20), schedule settings (`company_reminder_settings`). Nothing is sent automatically.

**Attachments** — private bucket `company-documents` (20 MB, mime allow-list), `document_attachments` extended. `AttachmentsPanel` on invoices, quotes, credit notes, receipts, supplier credit notes, contacts and journals: type/size validation, upload, signed-URL download, delete (permission checked in UI, server, RLS and Storage policy). Bills keep their existing attachment UI.
- `/files`: organisation-wide list with search, record-type filter, paging, upload, download, delete.
- Create → **Document upload** (`document_upload`) is unblocked: it uploads to Files as "Unfiled". `menu.test.ts` updated legitimately (blocked = `project` only; owner runnable = 28).

**Online invoice link** — `/share/invoice/$token` (public, outside `_authenticated`). Only the SHA-256 of a 64-hex token is stored; the anon-callable RPC `get_shared_invoice` returns one non-draft invoice, no contact details. Revocable, optional expiry, view counter. The page states that online payment is not available. Pages are `noindex` with `no-referrer`.

**Customer statements** — `/sales/statements` now shows branding, running balance per currency, print / PDF, e-mail (statement template) and history.

## Migrations — apply in this order
1. `20261025200000_document_branding_fields.sql`
2. `20261025200100_company_documents_storage.sql`
3. `20261025200200_email_outbox_reminders.sql`
4. `20261025200300_document_share_links.sql`

All idempotent. RPCs are SECURITY DEFINER with `set search_path = public`, check `auth.uid()` + membership / permission, `REVOKE ... FROM PUBLIC, anon`, `GRANT ... TO authenticated` (except `get_shared_invoice`, anon by design).
Until applied, the app degrades with an "apply the latest migrations" message instead of failing.

## Environment
| Variable | Needed for |
|---|---|
| `RESEND_API_KEY`, `EMAIL_FROM` | Sending e-mail (both required) |
| `APP_BASE_URL` (optional) | Origin used in online links; falls back to the request origin |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | Public invoice page (already used elsewhere) |
| `SUPABASE_SERVICE_ROLE_KEY` (optional) | Logo on the public invoice page; without it the page shows no logo |

## Manual verification
1. Apply the migrations. Settings → Documents → **document branding page**: upload a logo, set accent, address, tax number, bank details, footer; save.
2. Open an authorised invoice → **Print / Save as PDF** → check logo, marks, tax summary, bank details, page breaks on a long invoice; save as PDF.
3. Without `RESEND_API_KEY`: **Email…** shows the "not configured" notice, Send is disabled, **Open in my email program** opens a prefilled message.
4. With the key set (non-demo company): send invoice; check history row and "Sent" badge. Send a reminder on an overdue invoice.
5. **Create online link**: copy it, open in a private window (no sign-in), then **Revoke links** and reload: "This link is not valid".
6. Upload a PDF to an invoice, download it, delete it. As a read-only user the Upload / Delete controls are absent and a direct call is refused.
7. `/files`: search, filter, upload "Unfiled", paging. Create → Document upload.
8. `/sales/reminders`: schedule saved, due rows selectable, batch send reports per-invoice result.
9. `/sales/statements`: choose a customer, print, e-mail.

## Verification results
`tsc --noEmit` clean, `vitest run` 93 files all passing, `vite build` OK. ESLint clean for touched files (the repo has unrelated pre-existing prettier lint noise elsewhere).

## Open items / not done
- No server-side PDF and no PDF attached to e-mails (print-to-PDF only).
- No scheduler: reminders are sent manually. Needs a cron / queue.
- No online payment: no payment provider is integrated; the link page is read-only.
- Each e-mailed invoice creates a new non-expiring link; links can be revoked per invoice.
- Attachments cannot be re-filed from "Unfiled" to another record; bills keep their older attachment UI (separate list).
- Supplier statements and purchase-order e-mailing UI (no PO detail page exists) are not built.
- Logos replaced before saving leave an unreferenced object in `org-logos` (saved replacements are cleaned up).
- `uploadInboxDocument` / `inbox_documents` code is left in place but unused by the UI.
