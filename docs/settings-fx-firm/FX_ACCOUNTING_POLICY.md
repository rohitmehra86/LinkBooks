# Multi-currency accounting policy (LinkBooks)

**Status:** Approved implementation policy for day-one multi-currency support.  
**Scope:** Transaction currency, organisation base currency, recorded exchange rates, deterministic rounding, realised / unrealised FX treatment, and reporting in base currency.  
**Non-goals:** Live market feeds, automatic silent rate refresh, rewriting posted journals, or per-line FX within a single journal.

---

## 1. Currencies

1. Each organisation has exactly one **base currency** (`companies.base_currency`). Changing base currency after any posted journal is **forbidden**.
2. Journals and source documents may use a **transaction currency** (`journals.currency_code`).
3. Organisations may enable additional currencies for UX (`company_currencies`). Enabling a currency does not create rates.

## 2. Exchange rates

1. Rates are stored in `exchange_rates` as: company, from_currency, to_currency, rate_date, rate (units of `to` per 1 unit of `from`), optional note, created_by, created_at.
2. Unique key: `(company_id, from_currency, to_currency, rate_date)`.
3. **Append-only for a given date:** `UPDATE` and `DELETE` of rate rows are rejected by trigger. To correct a mistaken unpublished rate for a date that has **no** posted journals using that pair/date, an administrator may insert a superseding rate only by using a **different** `rate_date`, or by using the explicit `void_exchange_rate` path which marks `voided_at` without changing `rate` (voided rates are ignored for lookup).
4. Posted journals store `fx_rate_to_base` **on the journal**. That snapshot is immutable with the journal. Changing or voiding a table rate **never** alters historical journals.
5. Lookup for a new post: most recent non-voided rate on or before the journal date for `(txn_currency → base)`. If currencies are equal, rate = `1`. If missing, post is rejected.

## 3. Rounding

1. All monetary amounts use integer **minor units** in the transaction currency.
2. Conversion to base minor units:  
   `base_minor = round_half_up(txn_minor * rate / 10^(txn_decimals - base_decimals))` when decimal places differ; for equal decimals (common ISO currencies with 2 places):  
   `base_minor = round_half_up(txn_minor * rate)`.
3. Journal lines remain balanced in **transaction** currency. Reporting aggregates convert each line via the journal’s stored `fx_rate_to_base`.
4. Any residual ≤ 1 minor unit from tax/document rounding continues to use the system Rounding account (existing engine rule). FX conversion does not unbalance the transaction-currency journal.

## 4. Realised foreign exchange

1. **Definition:** Gain or loss recognised when a foreign-currency monetary item is settled at a rate different from the rate used when the item was recognised.
2. **Treatment:** Settlement adapters (e.g. customer/supplier payment) compute:  
   `fx = settle_base − original_base` for the settled portion.  
   - Positive → credit FX gain (income)  
   - Negative → debit FX loss (expense)  
   using system accounts `7700` / `7710` (or company overrides).
3. Realised FX posts as an additional balanced journal (or lines on the settlement journal) via `PostingEngine` only.
4. Historical settlement journals are never rewritten if rates tables change later.

## 5. Unrealised foreign exchange

1. **Definition:** Period-end revaluation of open foreign-currency monetary balances (AR/AP/bank in foreign currency) to the closing rate.
2. **Treatment:** A dedicated **revaluation** journal posts the difference to unrealised FX gain/loss and the balance-sheet control accounts. Source type `fx_revaluation`.
3. Revaluation is **explicit** (user or scheduled job triggers it). It does not run silently on rate insert.
4. Reversing the prior period’s unrealised journal (or posting the net movement) is the supported pattern; never mutate prior revaluation lines.

## 6. Reporting

1. Trial Balance, P&L, and Balance Sheet present figures in **base currency** using each journal’s stored `fx_rate_to_base`.
2. Optional “transaction currency” views may show original amounts but are secondary.
3. FX gain/loss accounts appear in P&L like other income/expense.

## 7. Demo Company

`is_demo` does **not** change FX rules, rounding, or posting. Demo reset deletes only that company’s transactional data and reseeds masters; it cannot target non-demo companies.

## 8. Audit

Rate create/void, base-currency change attempts, revaluation posts, and settings changes write `audit_events` with actor, company, action, entity refs — never secrets or raw credentials.
