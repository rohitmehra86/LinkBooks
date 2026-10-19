-- Extended Chart of Accounts (current / non-current sections) + demo period coverage.
-- Additive. Does not disable RLS. Safe to re-run via IF NOT EXISTS / ON CONFLICT.

-- ---------------------------------------------------------------------------
-- Richer default CoA (Xero-like sections via subtype)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.seed_default_chart_of_accounts(_company_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF current_setting('linkbooks.trusted', true) IS DISTINCT FROM 'on'
     AND (auth.uid() IS NULL OR NOT public.is_company_member(_company_id)) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;

  -- Always upsert missing system accounts (does not wipe custom accounts)
  INSERT INTO public.accounts (company_id, code, name, account_type, normal_balance, subtype, is_system, is_postable, is_control)
  VALUES
    -- Current assets
    (_company_id, '1000', 'Bank', 'asset', 'debit', 'current_asset', true, true, false),
    (_company_id, '1100', 'Accounts Receivable', 'asset', 'debit', 'current_asset', true, true, true),
    (_company_id, '1150', 'Inventory', 'asset', 'debit', 'current_asset', true, true, false),
    (_company_id, '1200', 'VAT Recoverable / Other Current Assets', 'asset', 'debit', 'current_asset', true, true, false),
    (_company_id, '1300', 'Prepayments', 'asset', 'debit', 'current_asset', true, true, false),
    -- Non-current assets
    (_company_id, '1500', 'Property, Plant & Equipment', 'asset', 'debit', 'non_current_asset', true, true, false),
    (_company_id, '1510', 'Accumulated Depreciation', 'asset', 'credit', 'non_current_asset', true, true, false),
    -- Current liabilities
    (_company_id, '2000', 'Accounts Payable', 'liability', 'credit', 'current_liability', true, true, true),
    (_company_id, '2100', 'Tax Payable', 'liability', 'credit', 'current_liability', true, true, true),
    (_company_id, '2200', 'Accruals', 'liability', 'credit', 'current_liability', true, true, false),
    (_company_id, '2300', 'Other Current Liabilities', 'liability', 'credit', 'current_liability', true, true, false),
    -- Non-current liabilities
    (_company_id, '2500', 'Long-term Loans', 'liability', 'credit', 'non_current_liability', true, true, false),
    -- Equity
    (_company_id, '3000', 'Owner Equity', 'equity', 'credit', 'equity', true, true, false),
    (_company_id, '3100', 'Opening Balance Equity', 'equity', 'credit', 'equity', true, true, false),
    (_company_id, '3200', 'Retained Earnings', 'equity', 'credit', 'equity', true, false, false),
    -- Income
    (_company_id, '4000', 'Sales Revenue', 'income', 'credit', 'income', true, true, false),
    (_company_id, '4100', 'Other Income', 'income', 'credit', 'income', true, true, false),
    -- Expenses
    (_company_id, '5000', 'Cost of Sales', 'expense', 'debit', 'cogs', true, true, false),
    (_company_id, '6000', 'Operating Expenses', 'expense', 'debit', 'expense', true, true, false),
    (_company_id, '6100', 'Bank Fees', 'expense', 'debit', 'expense', true, true, false),
    (_company_id, '6200', 'Depreciation Expense', 'expense', 'debit', 'expense', true, true, false),
    (_company_id, '6900', 'Rounding', 'expense', 'debit', 'expense', true, true, false)
  ON CONFLICT (company_id, code) DO UPDATE SET
    name = EXCLUDED.name,
    subtype = EXCLUDED.subtype,
    account_type = EXCLUDED.account_type,
    normal_balance = EXCLUDED.normal_balance,
    is_system = EXCLUDED.is_system,
    is_postable = EXCLUDED.is_postable,
    is_control = EXCLUDED.is_control,
    updated_at = now();
END;
$$;

GRANT EXECUTE ON FUNCTION public.seed_default_chart_of_accounts(UUID) TO authenticated;

-- Refresh subtypes on legacy codes for all companies that already have the short CoA
UPDATE public.accounts SET subtype = 'current_asset', updated_at = now()
WHERE code IN ('1000','1100','1150','1200','1300') AND account_type = 'asset';
UPDATE public.accounts SET subtype = 'non_current_asset', updated_at = now()
WHERE code IN ('1500','1510') AND account_type = 'asset';
UPDATE public.accounts SET subtype = 'current_liability', updated_at = now()
WHERE code IN ('2000','2100','2200','2300') AND account_type = 'liability';
UPDATE public.accounts SET subtype = 'non_current_liability', updated_at = now()
WHERE code IN ('2500') AND account_type = 'liability';
UPDATE public.accounts SET subtype = 'equity', updated_at = now()
WHERE code IN ('3000','3100','3200') AND account_type = 'equity';
UPDATE public.accounts SET subtype = 'income', updated_at = now()
WHERE code IN ('4000','4100') AND account_type = 'income';
UPDATE public.accounts SET subtype = 'cogs', updated_at = now()
WHERE code IN ('5000') AND account_type = 'expense';
UPDATE public.accounts SET subtype = 'expense', updated_at = now()
WHERE code IN ('6000','6100','6200','6900') AND account_type = 'expense';

-- Remap legacy subtype labels
UPDATE public.accounts SET subtype = 'current_asset', updated_at = now()
WHERE subtype IN ('bank','receivable','inventory','prepayment','current') AND account_type = 'asset';
UPDATE public.accounts SET subtype = 'current_liability', updated_at = now()
WHERE subtype IN ('payable','tax','accrual','current') AND account_type = 'liability';
UPDATE public.accounts SET subtype = 'non_current_asset', updated_at = now()
WHERE subtype IN ('fixed','depreciation') AND account_type = 'asset';

-- ---------------------------------------------------------------------------
-- Ensure an open period covers [from,to] for demo / posting (no overlap fail)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_accounting_period_coverage(
  _company_id UUID,
  _from DATE,
  _to DATE,
  _name TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _pid UUID;
  _start DATE := LEAST(_from, _to);
  _end DATE := GREATEST(_from, _to);
BEGIN
  IF current_setting('linkbooks.trusted', true) IS DISTINCT FROM 'on'
     AND (auth.uid() IS NULL OR NOT public.is_company_member(_company_id)) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF _start IS NULL OR _end IS NULL THEN
    RAISE EXCEPTION 'Period dates required';
  END IF;

  SELECT id INTO _pid
  FROM public.accounting_periods
  WHERE company_id = _company_id
    AND start_date <= _start
    AND end_date >= _end
    AND status = 'open'
  LIMIT 1;

  IF _pid IS NOT NULL THEN
    RETURN _pid;
  END IF;

  -- Expand an existing open period if possible (same company, open only)
  UPDATE public.accounting_periods
  SET start_date = LEAST(start_date, _start),
      end_date = GREATEST(end_date, _end),
      name = COALESCE(_name, name)
  WHERE company_id = _company_id
    AND status = 'open'
    AND id = (
      SELECT id FROM public.accounting_periods
      WHERE company_id = _company_id AND status = 'open'
      ORDER BY start_date
      LIMIT 1
    )
  RETURNING id INTO _pid;

  IF _pid IS NOT NULL THEN
    RETURN _pid;
  END IF;

  INSERT INTO public.accounting_periods (company_id, name, start_date, end_date, status)
  VALUES (
    _company_id,
    COALESCE(_name, 'FY covering ' || _start::TEXT || ' to ' || _end::TEXT),
    _start,
    _end,
    'open'
  )
  RETURNING id INTO _pid;

  RETURN _pid;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_accounting_period_coverage(UUID, DATE, DATE, TEXT) TO authenticated;

-- Improve reset: re-seed extended CoA + expand period for demo FY window
CREATE OR REPLACE FUNCTION public.reset_demo_company(_company_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  is_d BOOLEAN;
BEGIN
  SELECT is_demo INTO is_d FROM public.companies WHERE id = _company_id;
  IF NOT FOUND OR NOT is_d THEN
    RAISE EXCEPTION 'reset_demo_company denied: company is not a demo company';
  END IF;
  IF NOT public.has_company_permission(_company_id, 'demo.reset') THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;

  PERFORM set_config('linkbooks.trusted', 'on', true);

  DELETE FROM public.journal_lines WHERE journal_id IN (
    SELECT id FROM public.journals WHERE company_id = _company_id
  );
  DELETE FROM public.journals WHERE company_id = _company_id;
  DELETE FROM public.audit_events WHERE company_id = _company_id;

  BEGIN DELETE FROM public.bank_transactions WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.bank_transfers WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.bank_rules WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.reconciliation_links WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.bank_statement_imports WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_receipt_allocations WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_credit_allocations WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_credit_note_lines WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_invoice_lines WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_recurring_invoice_lines WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_recurring_invoices WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_receipts WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_credit_notes WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_invoices WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_quote_lines WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_quotes WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.supplier_payment_allocations WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.purchase_credit_allocations WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.purchase_credit_note_lines WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.purchase_bill_lines WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.purchase_order_lines WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.employee_expense_claims WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.supplier_payments WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.purchase_credit_notes WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.purchase_expenses WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.purchase_bills WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.purchase_orders WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.recurring_bills WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.purchase_payments WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.contacts WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.exchange_rates WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.document_sequences WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.ai_suggestions WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;

  PERFORM public.seed_default_chart_of_accounts(_company_id);
  PERFORM public.seed_default_accounting_periods(_company_id);
  -- Cover full demo sample window (Apr FY start through next Mar) + calendar buffer
  PERFORM public.ensure_accounting_period_coverage(
    _company_id,
    DATE '2026-04-01',
    DATE '2027-03-31',
    'Demo FY 2026/27'
  );
  BEGIN
    PERFORM public.seed_fx_accounts(_company_id);
  EXCEPTION WHEN undefined_function THEN NULL;
  END;

  INSERT INTO public.document_sequences (company_id, document_type, prefix, next_number, padding)
  VALUES
    (_company_id, 'invoice', 'INV-', 1001, 4),
    (_company_id, 'bill', 'BILL-', 2001, 4),
    (_company_id, 'quote', 'QU-', 5001, 4),
    (_company_id, 'credit_note', 'SCN-', 1, 4),
    (_company_id, 'purchase_order', 'PO-', 3001, 4)
  ON CONFLICT DO NOTHING;

  INSERT INTO public.audit_events (company_id, actor_user_id, action, entity_type, entity_id, details)
  VALUES (_company_id, auth.uid(), 'demo.reset', 'company', _company_id, '{"scope":"demo_only"}'::jsonb);

  PERFORM set_config('linkbooks.trusted', 'off', true);
END;
$$;
