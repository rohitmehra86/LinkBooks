-- Wave 2 / I: journal source types for fixed-asset postings.
--
-- Kept in its own file because a new enum value cannot be used in the transaction that adds it.
-- The next migration (fixed_assets) only references these values at run time, after this commits.
-- Idempotent (IF NOT EXISTS). No data is touched.

ALTER TYPE public.journal_source_type ADD VALUE IF NOT EXISTS 'depreciation';
ALTER TYPE public.journal_source_type ADD VALUE IF NOT EXISTS 'asset_disposal';
