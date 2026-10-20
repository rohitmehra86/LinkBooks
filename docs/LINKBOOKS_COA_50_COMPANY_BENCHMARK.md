# LinkBooks — 50-company financial statement benchmark (CoA design evidence)

**Date checked:** 20 Oct 2026  
**Method:** Public annual reports / 10-K / investor presentations and official IR pages.  
**Limitation:** Published statements show aggregated FS lines, **not** each company’s internal general ledger. Used to identify relevant **categories**, industry revenue/cost patterns, and Balance Sheet / P&L presentation — not to copy enterprise GL depth into small-business defaults.

| # | Company | Industry family | Jurisdiction | Period / source (primary) | Observed FS categories informing LinkBooks |
|---|---------|-----------------|--------------|---------------------------|--------------------------------------------|
| 1 | Accenture | Professional services | IE / US listing | FY2025 10-K / IR | Consulting revenue, subcontract costs, wages, deferred revenue |
| 2 | Deloitte (global network) | Accounting / advisory | Multi | Transparency reports | Professional fees, partner equity (entity-specific) |
| 3 | PwC | Accounting | Multi | Global annual review | Assurance / tax / advisory revenue mix |
| 4 | Capgemini | Consulting / IT | FR | Universal Registration Document | Services revenue, personnel costs |
| 5 | Infosys | IT services | IN | Annual Report | Digital services, cost of sales, offshore delivery |
| 6 | Wipro | IT / BPO | IN | Annual Report | IT services, BPO, facilities |
| 7 | Amazon.com | E-commerce / marketplace | US | 10-K | Online stores, 3P seller services, fulfilment, AWS (segment) |
| 8 | Shopify | E-commerce platform | CA | Annual Report | Subscription + merchant solutions, partner ecosystem |
| 9 | eBay | Marketplace | US | 10-K | Marketplace GMV fees, advertising |
| 10 | Etsy | Marketplace | US | 10-K | Marketplace revenue, seller services |
| 11 | Walmart | Retail / marketplace | US | 10-K | Merchandise sales, cost of sales, occupancy |
| 12 | Alibaba Group | Digital commerce | CN / US listing | 20-F | China commerce, international, cloud |
| 13 | Simon Property | Real estate / retail | US | 10-K | Rental income, property opex, investment property |
| 14 | Prologis | Industrial REIT | US | 10-K | Rental revenues, property NOI |
| 15 | Airbnb | Short-term rental | US | 10-K | Service fees, host / guest, trust & safety |
| 16 | Marriott International | Hotels | US | 10-K | Rooms, F&B, franchise fees |
| 17 | Hilton | Hotels | US | 10-K | Franchise / management fees, owned hotels |
| 18 | Host Hotels | Lodging REIT | US | 10-K | Hotel ownership, room revenue |
| 19 | UnitedHealth Group | Healthcare | US | 10-K | Premiums, medical costs, services |
| 20 | HCA Healthcare | Hospitals | US | 10-K | Patient service revenue, supplies |
| 21 | Fresenius | Healthcare | DE | Annual Report | Products + services, medical supplies |
| 22 | CVS Health | Pharmacy / retail health | US | 10-K | Pharmacy, front store, insurance |
| 23 | IDEXX Laboratories | Vet diagnostics | US | 10-K | Companion animal diagnostics |
| 24 | Microsoft | Technology / SaaS | US | 10-K | Product / cloud / services, deferred revenue |
| 25 | Salesforce | SaaS | US | 10-K | Subscription revenue, unearned revenue |
| 26 | Adobe | Software / SaaS | US | 10-K | Creative Cloud subscriptions |
| 27 | Oracle | Software / cloud | US | 10-K | Cloud services, license |
| 28 | Autodesk | Software | US | 10-K | Subscription, deferred revenue |
| 29 | Vinci | Construction / concessions | FR | Universal Registration Document | Construction contracts, concessions |
| 30 | ACS / Hochtief | Construction | ES / DE | Annual Report | Construction revenue, WIP |
| 31 | Fluor | Engineering / construction | US | 10-K | EPC contracts, cost of services |
| 32 | Caterpillar | Industrial / manufacturing | US | 10-K | Machinery sales, COGS, inventory |
| 33 | Siemens | Industrial | DE | Annual Report | Industrial products, digital industries |
| 34 | Nestlé | Food manufacturing | CH | Annual Review | Product sales, COGS, brands |
| 35 | Toyota Motor | Automotive | JP | Annual Report | Vehicle sales, parts, financing |
| 36 | UPS | Logistics | US | 10-K | Package revenue, transportation expense |
| 37 | FedEx | Logistics | US | 10-K | Express / ground, fuel |
| 38 | DHL Group | Logistics | DE | Annual Report | Express, freight, supply chain |
| 39 | Coursera | Online education | US | 10-K | Consumer / enterprise learning |
| 40 | Pearson | Education | UK | Annual Report | Courseware, assessments |
| 41 | Disney | Media / entertainment | US | 10-K | Parks, media networks, studios |
| 42 | WPP | Advertising | UK | Annual Report | Agency fees, media buying |
| 43 | Netflix | Streaming | US | 10-K | Subscription revenue, content amortisation |
| 44 | McDonald’s | QSR | US | 10-K | Franchise revenues, company restaurants, food cost |
| 45 | Starbucks | Hospitality / food | US | 10-K | Company-operated stores, product sales |
| 46 | Compass Group | Catering | UK | Annual Report | Contract catering revenue |
| 47 | BP | Energy | UK | Annual Report | Upstream / downstream (segment) |
| 48 | Deere & Company | Agriculture equipment | US | 10-K | Equipment sales, receivables finance |
| 49 | World Vision International | Non-profit | Multi | Audited FS / accountability | Contributions, restricted funds, programme expense |
| 50 | The Church Pension Fund / related published FS samples | Religious / benefits | US | Public Form 990 / annual reports (where available) | Contributions, restricted net assets, programme / admin |

## Category → LinkBooks mapping (summary)

| Observed category | Canonical `fs_line` | Example catalogue keys | Core / recommended / optional |
|-------------------|---------------------|------------------------|-------------------------------|
| Cash & banks | `current_assets` | Level A `1000` | Core (system) |
| Trade receivables | `current_assets` | Level A `1100` AR control | Core |
| Inventory | `current_assets` | Level A `1150` | Core |
| Marketplace clearing | `current_assets` | `asset_clearing_marketplace` | Recommended (ecom) |
| Investment property / PPE | `non_current_assets` | `asset_investment_property`, Level A `1500` | Recommended / core |
| Trade payables | `current_liabilities` | Level A `2000` AP | Core |
| Deferred / unearned revenue | `current_liabilities` | `liab_deferred_revenue` | Recommended (SaaS/edu) |
| Borrowings / leases | `non_current_liabilities` | Level A `2500`, `liab_lease` | Core / optional |
| Equity / retained earnings | `equity` | Level A `3000`/`3200` | Core |
| Restricted net assets / funds | `restricted_net_assets` | `eq_restricted`, `eq_building_fund` | Recommended (church/NPO) |
| Product / marketplace sales | `revenue` | `rev_marketplace`, Level A `4000` | Recommended / core |
| Services / subscriptions | `revenue` | `rev_service`, `rev_subscription` | Recommended |
| Contributions / tithes | `contribution_income` | `inc_tithes`, `inc_missions` | Recommended (church) |
| Returns / discounts | `contra_revenue` | `contra_refunds` | Recommended (retail/ecom) |
| COGS / fulfilment / fees | `cost_of_sales` | `cogs_*`, Level A `5000` | Recommended / core |
| Operating expenses | `operating_expense` | `exp_*`, Level A `6000` | Recommended / core |
| Programme / missions spend | `program_expense` | `exp_ministry`, `exp_missions_spend` | Recommended (church) |
| Finance costs | `finance_cost` | `exp_interest` | Optional |

## Design rules taken from the benchmark

1. **Do not** clone Fortune-500 line-item depth into Simple CoA.
2. **Do** map every library account to a stable `fs_line` so P&L / BS stay consistent when names differ by industry.
3. **Do** use **tracking dimensions** (Fund, Mission, Ministry) for church/NPO detail instead of one account per missionary.
4. **Do** keep AR/AP/tax/bank/retained earnings as protected Level A system accounts.
5. Marketplace fee / fulfilment patterns from Amazon/Shopify inform e-com packs; deferred revenue from Microsoft/Salesforce informs SaaS; rental income from REITs/Airbnb informs property packs.

Official IR starting points (checked Oct 2026): company `.com` investor relations, SEC EDGAR (`sec.gov`), Companies House / LSE for UK issuers, and organisation accountability pages for NPOs.
