# Tax jurisdictions and limitations

**Status:** Configuration and ledger-derived tax *summaries* only.  
**Do not treat as regulatory compliance or a filing product.**

| Regime | Seed pack | Jurisdictions (indicative) | Supported in product | Explicitly NOT supported |
|--------|-----------|----------------------------|----------------------|---------------------------|
| `none` | — | Any | No tax lines required | — |
| `vat` | Standard 20% + Zero | GB (seed rates) | Rates/codes, inclusive/exclusive math, tax control report | MTD, VAT return boxes, partial exemption, reverse charge automation, OSS/IOSS |
| `gst` | Single standard stub | AU / NZ / SG (configure rate) | Same as VAT foundation | BAS, IR returns, GST groups, GST-free auto rules |
| `sales_tax` | None (manual) | US / CA | Manual rates/codes | Nexus, state/county matrices, remittance filings |
| `other` | None | Configured by org | Manual rates | Any government filing |

## Calculation rules (product)

- Tax stored as **basis points** (10_000 = 100%).
- Rounding: **half-up** on the tax component (exclusive) or on net extraction (inclusive).
- Effective dates on `tax_rates`; inactive or out-of-range rates must not be selected for new documents.
- Changing a rate **does not rewrite** posted journals.
- Tax report = sum of posted movements on mapped tax control accounts for the period.

## Cash basis flag

`company_tax_settings.tax_basis` stores `invoice` | `cash`. MVP tax *report* remains accrual (posted journal dates). Cash-basis box mapping is **not** implemented — flagged for compliance review before any filing claim.

## Foreign currency

Reports use journal amounts in the organisation base currency path as posted. Multi-currency revaluation reports are **not** implemented.
