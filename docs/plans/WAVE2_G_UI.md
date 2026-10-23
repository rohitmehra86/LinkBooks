# Wave 2-G: UI polish ("looks like a toy" → trustworthy finance product)

Presentation only. No accounting logic, server functions (`*.functions.ts`), SQL or migrations
were changed. Data hooks and queries are unchanged.

## What changed

### Design system (`src/styles.css`, `src/components/ui/*`)

- **One brand accent** (blue `--primary`) for actions, focus and selection. `--accent` is now the
  subtle hover/selected surface (it used to be a second, teal brand colour and made outline-button
  hovers turn teal).
- **Semantic tokens**: `money-in` / `money-out`, and soft status pairs `success|warning|info|destructive|neutral`
  each with `-soft` (background) and `-ink` (text). Utilities: `bg-success-soft text-success-ink`, `text-money-in`, …
- **Typography**: Inter (was IBM Plex Sans); IBM Plex Mono kept for codes only. Base size 14px.
  `.numeric` and `.money` utilities give tabular figures; `.money` also right-aligns and never wraps.
  Tables are tabular by default.
- **Shadows/radii/focus**: `shadow-card`, `shadow-raised`, `shadow-overlay`; one visible 2px focus ring
  (inputs also get a soft ring); validation via `aria-invalid`.
- **Dark mode parity**: every token has a dark value; `ThemeToggle` (light/dark/system) in the top bar,
  saved in `localStorage`, applied before first paint by an inline script (`src/lib/theme.ts`). Toasts follow the theme.
- **Accessibility**: skip link, `prefers-reduced-motion` support, `pointer-coarse:` 44px touch targets on
  buttons/inputs/selects/nav, checkbox hit area enlarged on touch, `aria-sort` on sortable headers.
  AA contrast of all token pairs (light + dark) is verified by `python3 scripts/check-contrast.py` (44 pairs, all ≥ 4.5:1).
- **Print**: sidebar/header/actions hidden (`print:hidden`), card chrome removed, table headers repeat,
  rows don't split.

### App shell (`src/components/layout/*`, `src/lib/nav.ts`)

- Sidebar with **grouped navigation** (Money, Records, Accounting, Practice, Tools; Settings/Help pinned),
  active indicator, **collapsible** (icons + tooltips; state remembered), organisation switcher with an
  **initials avatar** and a **Demo** badge, mobile **drawer** with the same content.
- Top bar: **breadcrumbs** (from the URL; ancestors link only when they are real routes), **Cmd/Ctrl+K command palette**
  (already existed; now shows create shortcuts + pages before typing, platform-aware shortcut hint, more create
  actions that point at real routes), Create menu (now uses the brand colour, was hard-coded black), theme toggle, user menu.
- Settings' own palette moved to **Ctrl/Cmd+Shift+K** so it no longer fights the global one.
- **Notifications bell: intentionally not added** – there is no cheap real data source (the only candidate is the
  full dashboard snapshot, which is too heavy to run on every page).

### Primitives (`src/components/common/*`) – see catalogue below

### Dashboard (`src/components/dashboard/DashboardWidgets.tsx`, `src/lib/dashboard/kpis.ts`)

KPI row (cash in bank, owed to you, bills to pay, net profit YTD with a real trend vs last full year),
cash in/out chart with totals, bank-account tiles with "Reconcile N items", ageing as proportional bars
(with a text legend, so colour is never the only cue), profit-and-loss mini chart (this year vs last),
approvals, to-do, watchlist, and a **getting-started checklist** shown only for a company with no ledger
activity yet; every tick is read from real records. Trends/KPIs are only shown when a real prior figure exists.
Multi-currency: headline numbers use the base currency and say when other currencies exist.

### Auth (`src/components/auth/AuthLayout.tsx`)

Split layout with four verifiable product points (balanced double-entry, bank reconciliation, per-organisation
data isolation in the database, period locks). No testimonials, customer counts, certifications or uptime claims.
Removed the stale "figures are demo data" footer on `/auth`. Inline errors use `role="alert"`.

## Component catalogue

| Component / helper                                                                 | File                                           | Use                                                                                                     |
| ---------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `PageHeader({title, description?, actions?, breadcrumbs?, meta?})`                 | `common/states.tsx`                            | Top of every page. Primary action last.                                                                 |
| `SectionHeader`                                                                    | `common/states.tsx`                            | Heading inside a page.                                                                                  |
| `EmptyState({title, description, action? \| actionLabel+onActionClick, compact?})` | `common/states.tsx`                            | "Nothing yet" + a CTA.                                                                                  |
| `LoadingState`, `ListSkeleton`, `CardGridSkeleton`, `ReportSkeleton`               | `common/states.tsx`                            | Loading placeholders with the same footprint as the loaded content.                                     |
| `ErrorState({onRetry, compact?})`                                                  | `common/states.tsx`                            | Inline error with retry.                                                                                |
| `StatCard({label, value, trend?, hint?, icon?, tone?, href?, loading?})`           | `common/stat-card.tsx`                         | KPI tile.                                                                                               |
| `StatusBadge({status, label?})`                                                    | `common/stat-card.tsx`                         | Draft / awaiting approval / awaiting payment / partly paid / paid / overdue / void, quotes, bank lines… |
| `Amount({tone})`                                                                   | `common/stat-card.tsx`                         | Tabular money figure (in/out/muted).                                                                    |
| `statusDisplay`, `effectiveStatus`                                                 | `lib/status-badge.ts`                          | Pure status → label/tone mapping (+ "overdue" promotion). Tested.                                       |
| `DataTableToolbar`                                                                 | `common/data-table-toolbar.tsx`                | Search, filters, column menu, density, export; swaps to a bulk-action bar when rows are selected.       |
| `useTablePrefs(key, columns)`                                                      | `hooks/use-table-prefs.ts`                     | Persisted hidden columns + density. Wrap the table in `data-density={density}`.                         |
| `TableCard`                                                                        | `common/table-card.tsx`                        | Bordered card frame for a table.                                                                        |
| `ListToolbar`, `SortHead`, `Pager`, `TableCard`                                    | `sales/ListKit.tsx`                            | List-page kit (now built on `DataTableToolbar`; `aria-sort`).                                           |
| `ConfirmDialog`                                                                    | `common/confirm-dialog.tsx`                    | Confirm voids/deletes/posts. `ConfirmButton` is a thin wrapper over it.                                 |
| `FormSection`, `FormField`, `FormActions`, `fieldA11y`                             | `common/form-layout.tsx`, `lib/field-a11y.ts`  | Sections, required marker, helper text, inline validation wired to `aria-describedby`.                  |
| `notify.success/error/info/warning`                                                | `lib/notify.ts`                                | Toast conventions (durations, plain-language errors).                                                   |
| `useTheme`, `ThemeToggle`                                                          | `hooks/use-theme.ts`, `layout/ThemeToggle.tsx` | Appearance.                                                                                             |
| `buildBreadcrumbs`                                                                 | `lib/breadcrumbs.ts`                           | URL → trail. Tested.                                                                                    |

### How to use (list page recipe)

```tsx
const fmt = useFormat();
<PageHeader title="Invoices" description="…" actions={<Button asChild><Link to="…">New invoice</Link></Button>} />
<ListToolbar state={state} onChange={patch} statuses={STATUSES} searchPlaceholder="Search…" onExport={…} />
{query.isPending ? <ListSkeleton /> : query.isError ? <ErrorState onRetry={() => query.refetch()} …/> :
 rows.length === 0 ? <EmptyState … action={<Button asChild>…</Button>} /> : (
  <TableCard><Table>…
    <TableCell><StatusBadge status={row.status} /></TableCell>
    <TableCell className="money">{fmt.money(row.total_minor, row.currency_code)}</TableCell>
  </Table></TableCard>)}
```

Forms: `<FormField label="Name" htmlFor="name" required error={errors.name} helper="…"><Input {...fieldA11y("name", { error: errors.name, helper: true, required: true })} /></FormField>`.

## Screens covered

- Shell on every authenticated page (sidebar, top bar, breadcrumbs, palette, theme, mobile drawer).
- Dashboard, `/auth`, `/forgot-password`, `/reset-password`.
- Lists: sales invoices, quotes, credit notes, receipts; purchases credit notes, expenses, payments, purchase orders;
  contacts; products & services; bank accounts; bank transactions; reports index; bills list (status badge only).
- Detail pages: status badges on invoice, quote, sales credit note, receipt, bill, supplier credit note, payment, expense.
- Banking money figures use tabular `.money`/`.numeric` (reconcile, reconciliation report, journal, transfers, import, rules, cash coding).
- Report loading skeleton (`ReportShell`), subnavs (Sales, Purchases, Banking) get aria labels and touch-sized targets.
- Every page benefits from the new `PageHeader`, `EmptyState`, `ErrorState`, `LoadingState`, `Card`, `Table`, `Badge`, `Button`, `Input`, `Select` styling.

## Not covered / known gaps

- Bills list (`bills.index.tsx`, ~1,500 lines) keeps its own bespoke toolbar/column chooser; only the status badge was swapped
  to avoid merge conflicts with the purchases work. `DataTableToolbar` + `useTablePrefs` are ready for it to adopt.
- `DataTableToolbar` column menu, density and bulk-action bar are built and tested at the helper level but not yet wired into a
  list page (the shared list kit uses search/filters/export only).
- Recurring, statements, settings sub-pages, accountant, firm, AI assistant, tax and help screens only get the global restyle
  (tokens, `PageHeader`, cards, tables); their ad-hoc markup was not replaced page by page.
- Document create/edit forms (`SalesDocumentEditor`, `bills.new`, etc.) were not migrated to `FormSection`/`FormField`.
  Only the product dialog got a required marker.
- Money in sales/purchase lists now goes through `useFormat` (locale, symbol, thousands). Other screens still using local
  `money()` helpers (e.g. banking reconcile) are aligned visually but not re-formatted.
- No notifications bell (see above). No landing/marketing page exists in the app; `/auth` is the public entry.
- The saved "collapsed sidebar" state is read after mount, so a user who collapses it sees one frame of the expanded layout on reload.
- No browser/visual regression run was possible here (no Supabase session in the sandbox): verification is `tsc`, `vitest`,
  `vite build`, eslint/prettier on touched files and the AA contrast script.
- Pre-existing prettier/eslint violations in files I did not need to reformat (`settings.tsx`, `sales/settings.tsx`,
  `EntityCombobox.tsx`, …) were left alone to keep diffs small.
