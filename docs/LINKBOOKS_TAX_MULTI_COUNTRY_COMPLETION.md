# LinkBooks Multi-Country Tax Framework — Completion Report

## Working routes

| Route | Role |
|-------|------|
| `/tax` | Registration, rates, codes, GL mappings, country packs (tabs) |
| `/reports` → Tax Summary | Control-account tax movements (internal, not a statutory return) |
| `/settings` | Regime / registration overlap preserved |
| `/accountant` | Tax adjustment journals |

## Schema / migration

`supabase/migrations/20261020250000_tax_multi_country.sql`

- Treatments on rates/codes (`standard`, `reduced`, `zero_rated`, `exempt`, `outside_scope`, `no_tax`, `reverse_charge`)
- Registration dates, applied pack metadata, non-recoverable account mapping
- Optional `tax_code_id` on invoice/bill lines
- `company_tax_pack_applications` audit
- `seed_country_tax_pack` (idempotent; never overwrites existing codes)

## Country packs (verification status)

| Pack | Status | Filing |
|------|--------|--------|
| GB VAT | draft_config | not_implemented |
| AU/NZ/SG GST | draft_config | not_implemented |
| ZA/AE VAT | draft_config | not_implemented |
| US sales tax | generic_unverified (manual) | not_implemented |
| CA GST/HST | generic_unverified (manual) | not_implemented |
| IN GST | generic_unverified scaffold | not_implemented |
| Generic VAT/GST | generic_unverified | not_implemented |

No pack claims MTD, BAS, GSTN, IRS, or electronic filing.

## Calculation & posting

- Shared `computeTaxLine` used by sales and purchases (purchases now support inclusive via treatment).
- Sales/purchases posting resolve **output/input tax accounts** from organisation mappings, falling back to CoA 2100/1200.
- Historical posted amounts unchanged when settings/rates change.

## Tests run

- `country-packs.test.ts`, `tax-math.test.ts`, `line-math.test.ts` — pass
- Production build — see delivery commit

## Preserved

Existing `/tax` rates/codes CRUD, basis-point math, tax adjustment journals, Tax Summary report disclaimer, Demo Company posting path.

## Outstanding acceptance criteria

| Item | Status |
|------|--------|
| Document-line tax code pickers in sales/purchases UI | Schema ready; UI still primarily bps |
| Multi-component compound rates (CGST/SGST) | Scaffold only for India |
| Cash-basis tax report | Setting stored; report still journal-date based |
| Statutory return boxes / e-filing | Explicitly not implemented |
| Automatic US/CA jurisdiction rates | Requires external provider |
| Rate immutability when referenced by posted docs | Soft: new versions via effective dates; no hard block on edit yet |
