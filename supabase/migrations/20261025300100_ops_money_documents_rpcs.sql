-- Wave 2 H (operations): atomic money documents (AR-30), refunds of overpayments, bad-debt write-off.
--
-- Contents
--   1. Internal helpers (ops_*): control-account lookup by role, FX gain/loss accounts, base conversion.
--   2. post_money_document(payload)  — sales receipt, receive money, customer / supplier refund, bank deposit,
--      credit-card payment, bank adjustment. One transaction: validation, credit consumption (row locks),
--      document + lines, ONE balanced journal through post_journal, link, audit.
--   3. void_money_document(payload)  — reverses the journal on a chosen date and restores every credit it used.
--   4. write_off_bad_debt(payload)   — credit note to a bad-debt expense account, applied to the invoice.
--
-- All functions: SECURITY DEFINER, search_path = public, auth.uid() + is_company_member +
-- has_company_permission, FOR UPDATE row locks, validation before any write, REVOKE from PUBLIC/anon,
-- GRANT to authenticated. Single posting engine: ledger entries only through post_journal / reverse_journal_on.
-- Additive and idempotent. Requires 20261022210000, 20261023190000, 20261024110000..110200, 20261025300000.

-- ---------------------------------------------------------------------------
-- 1. Helpers (not callable by clients)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ops_ap_control_account(_company_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id
  FROM public.accounts a
  WHERE a.company_id = _company_id
    AND a.is_active
    AND a.archived_at IS NULL
    AND (a.system_key = 'ap' OR a.code = '2000')
  ORDER BY (a.system_key = 'ap') DESC NULLS LAST, (a.code = '2000') DESC, a.created_at
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.ops_output_tax_account(_company_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT t.output_tax_account_id FROM public.company_tax_settings t
      WHERE t.company_id = _company_id AND t.output_tax_account_id IS NOT NULL),
    (SELECT a.id FROM public.accounts a
      WHERE a.company_id = _company_id AND a.code = '2100' AND a.is_active AND a.archived_at IS NULL)
  );
$$;

CREATE OR REPLACE FUNCTION public.ops_input_tax_account(_company_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT t.input_tax_account_id FROM public.company_tax_settings t
      WHERE t.company_id = _company_id AND t.input_tax_account_id IS NOT NULL),
    (SELECT a.id FROM public.accounts a
      WHERE a.company_id = _company_id AND a.code = '1200' AND a.is_active AND a.archived_at IS NULL)
  );
$$;

-- Realised FX gain ('gain', 7700) or loss ('loss', 7710). Seeds the system accounts when missing.
CREATE OR REPLACE FUNCTION public.ops_fx_account(_company_id UUID, _kind TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _code TEXT := CASE _kind WHEN 'gain' THEN '7700' WHEN 'loss' THEN '7710' ELSE NULL END;
  _id UUID;
BEGIN
  IF _code IS NULL THEN RAISE EXCEPTION 'Unknown FX account kind %', _kind; END IF;
  SELECT id INTO _id FROM public.accounts
  WHERE company_id = _company_id AND code = _code AND is_active AND archived_at IS NULL;
  IF _id IS NULL THEN
    PERFORM set_config('linkbooks.trusted', 'on', true);
    PERFORM public.seed_fx_accounts(_company_id);
    PERFORM set_config('linkbooks.trusted', 'off', true);
    SELECT id INTO _id FROM public.accounts
    WHERE company_id = _company_id AND code = _code AND is_active AND archived_at IS NULL;
  END IF;
  IF _id IS NULL THEN
    RAISE EXCEPTION 'Realised FX % account (%) is missing or inactive', _kind, _code;
  END IF;
  RETURN _id;
END;
$$;

-- Convert a foreign minor-unit amount to the company base currency (decimal-aware, half away from zero).
CREATE OR REPLACE FUNCTION public.ops_minor_to_base(
  _company_id UUID, _amount BIGINT, _currency TEXT, _rate NUMERIC
) RETURNS BIGINT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _base TEXT;
  _bd INT;
  _td INT;
BEGIN
  SELECT base_currency INTO _base FROM public.companies WHERE id = _company_id;
  IF upper(_currency) = upper(_base) THEN RETURN _amount; END IF;
  SELECT decimal_places INTO _bd FROM public.currency_decimals WHERE code::TEXT = _base;
  SELECT decimal_places INTO _td FROM public.currency_decimals WHERE code::TEXT = upper(_currency);
  RETURN round(_amount::NUMERIC * _rate * power(10::NUMERIC, COALESCE(_bd, 2) - COALESCE(_td, 2)))::BIGINT;
END;
$$;

-- Active, postable, non-control account of the company.
CREATE OR REPLACE FUNCTION public.ops_usable_account(_company_id UUID, _account_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = _account_id AND a.company_id = _company_id
      AND a.is_active AND a.archived_at IS NULL AND a.is_postable AND NOT a.is_control
  );
$$;

REVOKE ALL ON FUNCTION public.ops_ap_control_account(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ops_output_tax_account(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ops_input_tax_account(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ops_fx_account(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ops_minor_to_base(UUID, BIGINT, TEXT, NUMERIC) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ops_usable_account(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- Supplier overpayments (unallocated supplier payments) can now fund a supplier refund.
ALTER TABLE public.money_document_credit_uses
  DROP CONSTRAINT IF EXISTS money_document_credit_uses_source_kind_check;
ALTER TABLE public.money_document_credit_uses
  ADD CONSTRAINT money_document_credit_uses_source_kind_check
  CHECK (source_kind IN ('sales_credit_note', 'purchase_credit_note', 'sales_receipt', 'supplier_payment'));

CREATE INDEX IF NOT EXISTS money_document_credit_uses_source_idx
  ON public.money_document_credit_uses (source_kind, source_id);

-- ---------------------------------------------------------------------------
-- 2. post_money_document(payload jsonb)
--   payload: company_id, kind, document_date, idempotency_key,
--            [currency_code, fx_rate_to_base, contact_id, project_id, bank_account_id, counter_account_id,
--             settlement ('bank'|'undeposited'), net_minor, tax_minor, description, reference, memo,
--             adjustment_type, source_ids[]]
--   returns: {id, journal_id, replayed}
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_money_document(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company UUID;
  _kind TEXT;
  _perm TEXT;
  _date DATE;
  _idem TEXT;
  _base CHAR(3);
  _ccy CHAR(3);
  _fx NUMERIC(18, 8);
  _contact UUID;
  _project UUID;
  _bank UUID;
  _counter UUID;
  _settlement TEXT;
  _net BIGINT;
  _tax BIGINT;
  _total BIGINT;
  _desc TEXT;
  _ref TEXT;
  _memo TEXT;
  _adj TEXT;
  _sources UUID[];
  _existing RECORD;
  _doc UUID;
  _journal UUID;
  _lines JSONB := '[]'::JSONB;
  _deposit_status TEXT;
  _ar UUID;
  _ap UUID;
  _tax_acct UUID;
  _available BIGINT := 0;
  _left BIGINT;
  _take BIGINT;
  _pool RECORD;
  _src RECORD;
  _n INT;
  _contact_kind TEXT;
  _contact_active BOOLEAN;
  _acct_type TEXT;
  _bank_type TEXT;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;

  _company := NULLIF(payload->>'company_id', '')::UUID;
  IF _company IS NULL THEN RAISE EXCEPTION 'company_id is required'; END IF;
  IF NOT public.is_company_member(_company) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;

  _kind := payload->>'kind';
  IF _kind IS NULL OR _kind NOT IN (
    'sales_receipt', 'receive_money', 'customer_refund', 'supplier_refund',
    'bank_deposit', 'card_payment', 'bank_adjustment'
  ) THEN
    RAISE EXCEPTION 'Unknown money document kind';
  END IF;

  _perm := CASE
    WHEN _kind IN ('sales_receipt', 'customer_refund') THEN 'sales.payment'
    WHEN _kind = 'supplier_refund' THEN 'purchases.payment'
    ELSE 'banking.categorise'
  END;
  IF NOT public.has_company_permission(_company, _perm) THEN
    RAISE EXCEPTION 'You do not have permission to record this document';
  END IF;
  IF NOT (public.has_company_permission(_company, 'accounting.post')
          OR public.has_company_permission(_company, 'journals.manual')) THEN
    RAISE EXCEPTION 'You do not have permission to post to the ledger';
  END IF;

  _idem := NULLIF(left(trim(COALESCE(payload->>'idempotency_key', '')), 80), '');
  IF _idem IS NULL THEN RAISE EXCEPTION 'Idempotency key is required'; END IF;
  _date := NULLIF(payload->>'document_date', '')::DATE;
  IF _date IS NULL THEN RAISE EXCEPTION 'Document date is required'; END IF;

  -- Replay
  SELECT id, posted_journal_id INTO _existing
  FROM public.money_documents WHERE company_id = _company AND idempotency_key = _idem;
  IF FOUND THEN
    IF _existing.posted_journal_id IS NOT NULL THEN
      RETURN jsonb_build_object('id', _existing.id, 'journal_id', _existing.posted_journal_id, 'replayed', TRUE);
    END IF;
    RAISE EXCEPTION 'A previous attempt with this key did not finish. Use a new key.';
  END IF;

  SELECT base_currency INTO _base FROM public.companies WHERE id = _company;
  _ccy := upper(COALESCE(NULLIF(payload->>'currency_code', ''), _base));
  _fx := COALESCE(NULLIF(payload->>'fx_rate_to_base', '')::NUMERIC, 1);
  IF _ccy = _base THEN _fx := 1; END IF;
  IF _fx <= 0 THEN RAISE EXCEPTION 'Exchange rate must be positive'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.currency_decimals WHERE code::TEXT = _ccy) THEN
    RAISE EXCEPTION 'Unsupported currency %', _ccy;
  END IF;

  _contact := NULLIF(payload->>'contact_id', '')::UUID;
  _project := NULLIF(payload->>'project_id', '')::UUID;
  _bank := NULLIF(payload->>'bank_account_id', '')::UUID;
  _counter := NULLIF(payload->>'counter_account_id', '')::UUID;
  _settlement := CASE WHEN payload->>'settlement' = 'undeposited' THEN 'undeposited' ELSE 'bank' END;
  _net := COALESCE(NULLIF(payload->>'net_minor', '')::BIGINT, 0);
  _tax := COALESCE(NULLIF(payload->>'tax_minor', '')::BIGINT, 0);
  _desc := COALESCE(NULLIF(left(trim(COALESCE(payload->>'description', '')), 240), ''), 'Line');
  _ref := NULLIF(left(trim(COALESCE(payload->>'reference', '')), 80), '');
  _memo := NULLIF(left(trim(COALESCE(payload->>'memo', '')), 500), '');
  _adj := NULLIF(payload->>'adjustment_type', '');
  IF _net < 0 OR _tax < 0 THEN RAISE EXCEPTION 'Amounts cannot be negative'; END IF;

  IF _project IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = _project AND p.company_id = _company AND p.status NOT IN ('archived', 'completed')
  ) THEN
    RAISE EXCEPTION 'Project not found or no longer open';
  END IF;

  -- Contact (customer / supplier) when the kind needs one
  IF _contact IS NOT NULL THEN
    SELECT c.kind::TEXT, c.is_active INTO _contact_kind, _contact_active
    FROM public.contacts c WHERE c.id = _contact AND c.company_id = _company;
    IF _contact_kind IS NULL THEN RAISE EXCEPTION 'Contact not found in this organisation'; END IF;
  END IF;

  IF _bank IS NULL THEN RAISE EXCEPTION 'Choose the bank account'; END IF;

  -- ================= build lines per kind =================
  IF _kind IN ('sales_receipt', 'receive_money') THEN
    IF _counter IS NULL THEN RAISE EXCEPTION 'Choose the income account'; END IF;
    IF _kind = 'sales_receipt' THEN
      IF _contact IS NULL THEN RAISE EXCEPTION 'Choose a customer'; END IF;
      IF _contact_kind NOT IN ('customer', 'both') OR NOT _contact_active THEN
        RAISE EXCEPTION 'Contact is not an active customer';
      END IF;
    END IF;
    _total := _net + _tax;
    IF _net <= 0 THEN RAISE EXCEPTION 'Amount must be greater than zero'; END IF;
    IF _bank = _counter THEN RAISE EXCEPTION 'The income account and the payment account must be different'; END IF;
    IF _settlement = 'bank' THEN
      IF NOT public.sales_is_deposit_account(_company, _bank) THEN
        RAISE EXCEPTION 'The payment account must be an active bank or cash account';
      END IF;
    ELSE
      -- Undeposited funds: any active, postable, non-control asset account.
      IF NOT public.ops_usable_account(_company, _bank)
         OR NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = _bank AND a.account_type::TEXT = 'asset') THEN
        RAISE EXCEPTION 'The undeposited funds account must be an active asset account';
      END IF;
    END IF;
    IF NOT public.ops_usable_account(_company, _counter) THEN
      RAISE EXCEPTION 'The income account is inactive, not postable, or a control account';
    END IF;
    SELECT a.account_type::TEXT INTO _acct_type FROM public.accounts a WHERE a.id = _counter;
    IF _acct_type = 'asset' THEN
      RAISE EXCEPTION 'The income account cannot be an asset account. Use a bank transfer instead.';
    END IF;
    _lines := jsonb_build_array(
      jsonb_build_object('account_id', _bank, 'description',
        CASE _kind WHEN 'sales_receipt' THEN 'Sales receipt' ELSE 'Receive money' END,
        'debit_minor', _total, 'credit_minor', 0),
      jsonb_build_object('account_id', _counter, 'description', _desc, 'debit_minor', 0, 'credit_minor', _net)
    );
    IF _tax > 0 THEN
      _tax_acct := public.ops_output_tax_account(_company);
      IF _tax_acct IS NULL THEN
        RAISE EXCEPTION 'Output tax account is not configured. Set it in tax settings first.';
      END IF;
      _lines := _lines || jsonb_build_array(
        jsonb_build_object('account_id', _tax_acct, 'description', 'Output tax', 'debit_minor', 0, 'credit_minor', _tax));
    END IF;
    _deposit_status := CASE WHEN _settlement = 'undeposited' THEN 'undeposited' ELSE NULL END;

  ELSIF _kind IN ('customer_refund', 'supplier_refund') THEN
    IF _contact IS NULL THEN RAISE EXCEPTION 'Choose the contact'; END IF;
    IF _kind = 'customer_refund' AND (_contact_kind NOT IN ('customer', 'both')) THEN
      RAISE EXCEPTION 'Contact is not a customer';
    END IF;
    IF _kind = 'supplier_refund' AND (_contact_kind NOT IN ('supplier', 'both')) THEN
      RAISE EXCEPTION 'Contact is not a supplier';
    END IF;
    IF _net <= 0 THEN RAISE EXCEPTION 'Refund must be greater than zero'; END IF;
    IF _tax <> 0 THEN RAISE EXCEPTION 'A refund carries no tax'; END IF;
    _total := _net;
    IF NOT public.sales_is_deposit_account(_company, _bank) THEN
      RAISE EXCEPTION 'The refund must be paid from or into an active bank or cash account';
    END IF;

    -- Credit pool, oldest first, locked for the duration of the transaction.
    _left := _net;
    -- Lock every credit source of this contact first (UNION queries cannot take row locks themselves).
    IF _kind = 'customer_refund' THEN
      PERFORM 1 FROM public.sales_credit_notes
        WHERE company_id = _company AND contact_id = _contact ORDER BY id FOR UPDATE;
      PERFORM 1 FROM public.sales_receipts
        WHERE company_id = _company AND contact_id = _contact ORDER BY id FOR UPDATE;
    ELSE
      PERFORM 1 FROM public.purchase_credit_notes
        WHERE company_id = _company AND contact_id = _contact ORDER BY id FOR UPDATE;
      PERFORM 1 FROM public.supplier_payments
        WHERE company_id = _company AND contact_id = _contact ORDER BY id FOR UPDATE;
    END IF;
    IF _kind = 'customer_refund' THEN
      _ar := public.sales_ar_control_account(_company);
      IF _ar IS NULL THEN RAISE EXCEPTION 'Accounts receivable control account is missing'; END IF;
      FOR _pool IN
        SELECT 'sales_credit_note'::TEXT AS src_kind, id, total_minor - amount_allocated_minor AS remaining, credit_date AS d
        FROM public.sales_credit_notes
        WHERE company_id = _company AND contact_id = _contact AND currency_code = _ccy
          AND status IN ('authorised', 'partly_paid') AND total_minor - amount_allocated_minor > 0
        UNION ALL
        SELECT 'sales_receipt', id, unallocated_minor, receipt_date
        FROM public.sales_receipts
        WHERE company_id = _company AND contact_id = _contact AND currency_code = _ccy
          AND status = 'posted' AND unallocated_minor > 0
        ORDER BY d, id
      LOOP
        _available := _available + _pool.remaining;
      END LOOP;
    ELSE
      _ap := public.ops_ap_control_account(_company);
      IF _ap IS NULL THEN RAISE EXCEPTION 'Accounts payable control account is missing'; END IF;
      FOR _pool IN
        SELECT 'purchase_credit_note'::TEXT AS src_kind, id, total_minor - amount_allocated_minor AS remaining, credit_date AS d
        FROM public.purchase_credit_notes
        WHERE company_id = _company AND contact_id = _contact AND currency_code = _ccy
          AND status IN ('authorised', 'partly_paid') AND total_minor - amount_allocated_minor > 0
        UNION ALL
        SELECT 'supplier_payment', id, unallocated_minor, payment_date
        FROM public.supplier_payments
        WHERE company_id = _company AND contact_id = _contact AND currency_code = _ccy
          AND status = 'paid' AND unallocated_minor > 0
        ORDER BY d, id
      LOOP
        _available := _available + _pool.remaining;
      END LOOP;
    END IF;
    IF _net > _available THEN
      RAISE EXCEPTION 'Refund exceeds the available balance (% available in this currency)', _available;
    END IF;

    IF _kind = 'customer_refund' THEN
      _lines := jsonb_build_array(
        jsonb_build_object('account_id', _ar, 'description', 'Customer refund', 'debit_minor', _net, 'credit_minor', 0),
        jsonb_build_object('account_id', _bank, 'description', 'Customer refund', 'debit_minor', 0, 'credit_minor', _net));
    ELSE
      _lines := jsonb_build_array(
        jsonb_build_object('account_id', _bank, 'description', 'Supplier refund', 'debit_minor', _net, 'credit_minor', 0),
        jsonb_build_object('account_id', _ap, 'description', 'Supplier refund', 'debit_minor', 0, 'credit_minor', _net));
    END IF;

  ELSIF _kind = 'bank_deposit' THEN
    _sources := ARRAY(SELECT DISTINCT (jsonb_array_elements_text(COALESCE(payload->'source_ids', '[]'::JSONB)))::UUID);
    IF cardinality(_sources) = 0 THEN RAISE EXCEPTION 'Select at least one undeposited receipt'; END IF;
    IF NOT public.sales_is_deposit_account(_company, _bank) THEN
      RAISE EXCEPTION 'The deposit account must be an active bank or cash account';
    END IF;
    _total := 0;
    _n := 0;
    FOR _src IN
      SELECT id, bank_account_id, total_minor, currency_code, deposit_status, status, kind
      FROM public.money_documents
      WHERE company_id = _company AND id = ANY (_sources)
      ORDER BY id
      FOR UPDATE
    LOOP
      _n := _n + 1;
      IF _src.status <> 'posted' OR _src.kind NOT IN ('sales_receipt', 'receive_money') THEN
        RAISE EXCEPTION 'A selected document is not a posted receipt';
      END IF;
      IF _src.deposit_status IS DISTINCT FROM 'undeposited' THEN
        RAISE EXCEPTION 'A selected receipt is already deposited';
      END IF;
      IF _src.bank_account_id = _bank THEN
        RAISE EXCEPTION 'The deposit bank cannot be the undeposited funds account';
      END IF;
      IF NULLIF(payload->>'currency_code', '') IS NULL THEN
        _ccy := _src.currency_code;
      ELSIF _src.currency_code <> _ccy THEN
        RAISE EXCEPTION 'All receipts in one deposit must be in the same currency';
      END IF;
      _total := _total + _src.total_minor;
      _lines := _lines || jsonb_build_array(jsonb_build_object(
        'account_id', _src.bank_account_id, 'description', 'Bank deposit',
        'debit_minor', 0, 'credit_minor', _src.total_minor));
    END LOOP;
    IF _n <> cardinality(_sources) THEN RAISE EXCEPTION 'A selected receipt was not found'; END IF;
    IF _total <= 0 THEN RAISE EXCEPTION 'Amount must be greater than zero'; END IF;
    _lines := jsonb_build_array(jsonb_build_object(
      'account_id', _bank, 'description', 'Bank deposit', 'debit_minor', _total, 'credit_minor', 0)) || _lines;
    _net := _total;
    _tax := 0;

  ELSIF _kind = 'card_payment' THEN
    IF _counter IS NULL THEN RAISE EXCEPTION 'Choose the bank and the credit card'; END IF;
    IF _net <= 0 THEN RAISE EXCEPTION 'Payment must be greater than zero'; END IF;
    IF _bank = _counter THEN RAISE EXCEPTION 'Choose a bank account and a credit-card liability account'; END IF;
    IF NOT public.ops_usable_account(_company, _bank) OR NOT public.ops_usable_account(_company, _counter) THEN
      RAISE EXCEPTION 'An account is inactive, not postable, or a control account';
    END IF;
    SELECT a.account_type::TEXT INTO _acct_type FROM public.accounts a WHERE a.id = _counter;
    SELECT a.account_type::TEXT INTO _bank_type FROM public.accounts a WHERE a.id = _bank;
    IF _acct_type <> 'liability' THEN RAISE EXCEPTION 'The credit card account must be a liability'; END IF;
    IF _bank_type <> 'asset' THEN RAISE EXCEPTION 'The paying account must be a bank or cash asset account'; END IF;
    _total := _net;
    _tax := 0;
    _lines := jsonb_build_array(
      jsonb_build_object('account_id', _counter, 'description', 'Credit card payment', 'debit_minor', _net, 'credit_minor', 0),
      jsonb_build_object('account_id', _bank, 'description', 'Credit card payment', 'debit_minor', 0, 'credit_minor', _net));

  ELSE -- bank_adjustment
    IF _counter IS NULL OR _adj IS NULL THEN RAISE EXCEPTION 'Choose the bank, the offset account, and the adjustment type'; END IF;
    IF _adj NOT IN ('bank_fee', 'interest_income', 'interest_expense') THEN
      RAISE EXCEPTION 'Unknown adjustment type';
    END IF;
    IF _net <= 0 THEN RAISE EXCEPTION 'Adjustment must be greater than zero'; END IF;
    IF _bank = _counter THEN RAISE EXCEPTION 'The bank account and the offset account must be different'; END IF;
    IF NOT public.sales_is_deposit_account(_company, _bank) THEN
      RAISE EXCEPTION 'The bank account must be an active bank or cash account';
    END IF;
    IF NOT public.ops_usable_account(_company, _counter) THEN
      RAISE EXCEPTION 'The offset account is inactive, not postable, or a control account';
    END IF;
    _total := _net;
    _tax := 0;
    IF _adj = 'interest_income' THEN
      _lines := jsonb_build_array(
        jsonb_build_object('account_id', _bank, 'description', 'Bank interest', 'debit_minor', _net, 'credit_minor', 0),
        jsonb_build_object('account_id', _counter, 'description', 'Bank interest', 'debit_minor', 0, 'credit_minor', _net));
    ELSE
      _lines := jsonb_build_array(
        jsonb_build_object('account_id', _counter,
          'description', CASE _adj WHEN 'bank_fee' THEN 'Bank fee' ELSE 'Bank interest expense' END,
          'debit_minor', _net, 'credit_minor', 0),
        jsonb_build_object('account_id', _bank,
          'description', CASE _adj WHEN 'bank_fee' THEN 'Bank fee' ELSE 'Bank interest expense' END,
          'debit_minor', 0, 'credit_minor', _net));
    END IF;
  END IF;

  IF _total IS NULL OR _total <= 0 THEN RAISE EXCEPTION 'Amount must be greater than zero'; END IF;

  -- ================= writes =================
  INSERT INTO public.money_documents (
    company_id, kind, contact_id, project_id, document_date, reference, memo, currency_code, fx_rate_to_base,
    bank_account_id, counter_account_id, settlement, total_minor, tax_minor, status, deposit_status,
    adjustment_type, idempotency_key, created_by
  ) VALUES (
    _company, _kind, _contact, _project, _date, _ref, _memo, _ccy, _fx,
    _bank, _counter, _settlement, _total, _tax, 'posted', _deposit_status,
    _adj, _idem, _uid
  ) RETURNING id INTO _doc;

  IF _kind IN ('sales_receipt', 'receive_money') THEN
    INSERT INTO public.money_document_lines (company_id, document_id, line_no, description, account_id, net_minor, tax_minor, project_id)
    VALUES (_company, _doc, 1, _desc, _counter, _net, _tax, _project);
  END IF;

  IF _kind IN ('customer_refund', 'supplier_refund') THEN
    _left := _net;
    IF _kind = 'customer_refund' THEN
      FOR _pool IN
        SELECT 'sales_credit_note'::TEXT AS src_kind, id, total_minor - amount_allocated_minor AS remaining, credit_date AS d
        FROM public.sales_credit_notes
        WHERE company_id = _company AND contact_id = _contact AND currency_code = _ccy
          AND status IN ('authorised', 'partly_paid') AND total_minor - amount_allocated_minor > 0
        UNION ALL
        SELECT 'sales_receipt', id, unallocated_minor, receipt_date
        FROM public.sales_receipts
        WHERE company_id = _company AND contact_id = _contact AND currency_code = _ccy
          AND status = 'posted' AND unallocated_minor > 0
        ORDER BY d, id
      LOOP
        EXIT WHEN _left <= 0;
        _take := LEAST(_pool.remaining, _left);
        IF _pool.src_kind = 'sales_credit_note' THEN
          UPDATE public.sales_credit_notes
          SET amount_allocated_minor = amount_allocated_minor + _take,
              status = CASE WHEN amount_allocated_minor + _take >= total_minor
                            THEN 'paid'::public.sales_doc_status ELSE 'partly_paid'::public.sales_doc_status END,
              updated_at = now()
          WHERE id = _pool.id AND total_minor - amount_allocated_minor >= _take;
        ELSE
          UPDATE public.sales_receipts
          SET unallocated_minor = unallocated_minor - _take, updated_at = now()
          WHERE id = _pool.id AND unallocated_minor >= _take;
        END IF;
        IF NOT FOUND THEN RAISE EXCEPTION 'The credit balance changed while saving. Try again.'; END IF;
        INSERT INTO public.money_document_credit_uses (company_id, document_id, source_kind, source_id, amount_minor)
        VALUES (_company, _doc, _pool.src_kind, _pool.id, _take);
        _left := _left - _take;
      END LOOP;
    ELSE
      FOR _pool IN
        SELECT 'purchase_credit_note'::TEXT AS src_kind, id, total_minor - amount_allocated_minor AS remaining, credit_date AS d
        FROM public.purchase_credit_notes
        WHERE company_id = _company AND contact_id = _contact AND currency_code = _ccy
          AND status IN ('authorised', 'partly_paid') AND total_minor - amount_allocated_minor > 0
        UNION ALL
        SELECT 'supplier_payment', id, unallocated_minor, payment_date
        FROM public.supplier_payments
        WHERE company_id = _company AND contact_id = _contact AND currency_code = _ccy
          AND status = 'paid' AND unallocated_minor > 0
        ORDER BY d, id
      LOOP
        EXIT WHEN _left <= 0;
        _take := LEAST(_pool.remaining, _left);
        IF _pool.src_kind = 'purchase_credit_note' THEN
          UPDATE public.purchase_credit_notes
          SET amount_allocated_minor = amount_allocated_minor + _take,
              status = CASE WHEN amount_allocated_minor + _take >= total_minor
                            THEN 'paid'::public.purchase_doc_status ELSE 'partly_paid'::public.purchase_doc_status END,
              updated_at = now()
          WHERE id = _pool.id AND total_minor - amount_allocated_minor >= _take;
        ELSE
          UPDATE public.supplier_payments
          SET unallocated_minor = unallocated_minor - _take, updated_at = now()
          WHERE id = _pool.id AND unallocated_minor >= _take;
        END IF;
        IF NOT FOUND THEN RAISE EXCEPTION 'The credit balance changed while saving. Try again.'; END IF;
        INSERT INTO public.money_document_credit_uses (company_id, document_id, source_kind, source_id, amount_minor)
        VALUES (_company, _doc, _pool.src_kind, _pool.id, _take);
        _left := _left - _take;
      END LOOP;
    END IF;
    IF _left > 0 THEN RAISE EXCEPTION 'The credit balance changed while saving. Try again.'; END IF;
  END IF;

  IF _kind = 'bank_deposit' THEN
    FOR _src IN
      SELECT id, total_minor FROM public.money_documents
      WHERE company_id = _company AND id = ANY (_sources) ORDER BY id
    LOOP
      UPDATE public.money_documents
      SET deposit_status = 'deposited', deposited_in_id = _doc, updated_at = now()
      WHERE id = _src.id AND deposit_status = 'undeposited';
      IF NOT FOUND THEN RAISE EXCEPTION 'A selected receipt is already deposited'; END IF;
      INSERT INTO public.money_deposit_items (company_id, deposit_id, source_document_id, amount_minor)
      VALUES (_company, _doc, _src.id, _src.total_minor);
    END LOOP;
  END IF;

  _journal := public.post_journal(jsonb_build_object(
    'company_id', _company,
    'journal_date', _date,
    'memo', COALESCE(_memo, _desc),
    'currency_code', _ccy,
    'fx_rate_to_base', _fx,
    'source_type', 'other',
    'source_id', _doc,
    'idempotency_key', 'money_document:' || _idem,
    'lines', _lines
  ));

  UPDATE public.money_documents SET posted_journal_id = _journal, updated_at = now() WHERE id = _doc;

  PERFORM public.record_audit_event(
    _company, 'money_document.' || _kind, 'money_document', _doc,
    jsonb_build_object('journal_id', _journal, 'total_minor', _total, 'currency_code', _ccy)
  );

  RETURN jsonb_build_object('id', _doc, 'journal_id', _journal, 'replayed', FALSE);
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. void_money_document(payload jsonb)
--   payload: company_id, document_id, reason, [void_date]
--   returns: {id, void_journal_id}
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.void_money_document(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company UUID;
  _doc RECORD;
  _perm TEXT;
  _reason TEXT;
  _void_date DATE;
  _vj UUID;
  _use RECORD;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  _company := NULLIF(payload->>'company_id', '')::UUID;
  IF _company IS NULL THEN RAISE EXCEPTION 'company_id is required'; END IF;
  IF NOT public.is_company_member(_company) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  _reason := NULLIF(left(trim(COALESCE(payload->>'reason', '')), 300), '');
  IF _reason IS NULL THEN RAISE EXCEPTION 'A reason is required to void a document'; END IF;

  SELECT * INTO _doc FROM public.money_documents
  WHERE id = NULLIF(payload->>'document_id', '')::UUID AND company_id = _company FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document not found'; END IF;

  _perm := CASE
    WHEN _doc.kind IN ('sales_receipt', 'customer_refund') THEN 'sales.payment'
    WHEN _doc.kind = 'supplier_refund' THEN 'purchases.payment'
    ELSE 'banking.categorise'
  END;
  IF NOT public.has_company_permission(_company, _perm) THEN
    RAISE EXCEPTION 'You do not have permission to void this document';
  END IF;
  IF _doc.status = 'void' THEN RAISE EXCEPTION 'This document is already void'; END IF;
  IF _doc.posted_journal_id IS NULL THEN RAISE EXCEPTION 'This document was never posted'; END IF;
  IF _doc.deposit_status = 'deposited' THEN
    RAISE EXCEPTION 'This receipt has been banked. Void the bank deposit first.';
  END IF;

  _void_date := GREATEST(COALESCE(NULLIF(payload->>'void_date', '')::DATE, CURRENT_DATE), _doc.document_date);
  _vj := public.reverse_journal_on(_doc.posted_journal_id, _void_date, 'money_document:' || _doc.id::TEXT || ':void');

  IF _doc.kind = 'bank_deposit' THEN
    UPDATE public.money_documents
    SET deposit_status = 'undeposited', deposited_in_id = NULL, updated_at = now()
    WHERE company_id = _company AND deposited_in_id = _doc.id;
    DELETE FROM public.money_deposit_items WHERE company_id = _company AND deposit_id = _doc.id;
  END IF;

  IF _doc.kind IN ('customer_refund', 'supplier_refund') THEN
    FOR _use IN
      SELECT * FROM public.money_document_credit_uses
      WHERE company_id = _company AND document_id = _doc.id ORDER BY id
    LOOP
      IF _use.source_kind = 'sales_credit_note' THEN
        UPDATE public.sales_credit_notes
        SET amount_allocated_minor = amount_allocated_minor - _use.amount_minor,
            status = CASE WHEN status = 'void' THEN status
                          WHEN amount_allocated_minor - _use.amount_minor <= 0 THEN 'authorised'::public.sales_doc_status
                          WHEN amount_allocated_minor - _use.amount_minor >= total_minor THEN 'paid'::public.sales_doc_status
                          ELSE 'partly_paid'::public.sales_doc_status END,
            updated_at = now()
        WHERE id = _use.source_id AND amount_allocated_minor >= _use.amount_minor;
      ELSIF _use.source_kind = 'purchase_credit_note' THEN
        UPDATE public.purchase_credit_notes
        SET amount_allocated_minor = amount_allocated_minor - _use.amount_minor,
            status = CASE WHEN status = 'void' THEN status
                          WHEN amount_allocated_minor - _use.amount_minor <= 0 THEN 'authorised'::public.purchase_doc_status
                          WHEN amount_allocated_minor - _use.amount_minor >= total_minor THEN 'paid'::public.purchase_doc_status
                          ELSE 'partly_paid'::public.purchase_doc_status END,
            updated_at = now()
        WHERE id = _use.source_id AND amount_allocated_minor >= _use.amount_minor;
      ELSIF _use.source_kind = 'sales_receipt' THEN
        UPDATE public.sales_receipts SET unallocated_minor = unallocated_minor + _use.amount_minor, updated_at = now()
        WHERE id = _use.source_id AND status = 'posted';
      ELSIF _use.source_kind = 'supplier_payment' THEN
        UPDATE public.supplier_payments SET unallocated_minor = unallocated_minor + _use.amount_minor, updated_at = now()
        WHERE id = _use.source_id AND status = 'paid';
      END IF;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'The credit used by this refund can no longer be restored (it was changed or voided).';
      END IF;
    END LOOP;
    -- Keep the use rows as history but detach them from the void guard by deleting them.
    DELETE FROM public.money_document_credit_uses WHERE company_id = _company AND document_id = _doc.id;
  END IF;

  UPDATE public.money_documents
  SET status = 'void',
      deposit_status = CASE WHEN kind IN ('sales_receipt', 'receive_money') THEN NULL ELSE deposit_status END,
      void_journal_id = _vj, voided_at = now(), voided_by = _uid, void_reason = _reason, updated_at = now()
  WHERE id = _doc.id;

  PERFORM public.record_audit_event(
    _company, 'money_document.' || _doc.kind || '.void', 'money_document', _doc.id,
    jsonb_build_object('void_journal_id', _vj, 'reason', _reason, 'void_date', _void_date)
  );
  RETURN jsonb_build_object('id', _doc.id, 'void_journal_id', _vj);
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. write_off_bad_debt(payload jsonb)
--   payload: company_id, invoice_id, write_off_date, reason, [bad_debt_account_id], [amount_minor]
--   Raises a credit note against a bad-debt expense account and applies it to the invoice.
--   Tax is relieved pro rata (DR output tax), the rest goes to the bad-debt account.
--   returns: {credit_note_id, journal_id, written_off_minor, invoice_status}
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.write_off_bad_debt(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company UUID;
  _inv RECORD;
  _date DATE;
  _reason TEXT;
  _bad UUID;
  _outstanding BIGINT;
  _amount BIGINT;
  _tax BIGINT;
  _net BIGINT;
  _ar UUID;
  _tax_acct UUID;
  _number TEXT;
  _cn UUID;
  _journal UUID;
  _lines JSONB;
  _acct_type TEXT;
  _new_status public.sales_doc_status;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  _company := NULLIF(payload->>'company_id', '')::UUID;
  IF _company IS NULL THEN RAISE EXCEPTION 'company_id is required'; END IF;
  IF NOT public.is_company_member(_company) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT public.has_company_permission(_company, 'sales.void') THEN
    RAISE EXCEPTION 'You do not have permission to write off invoices';
  END IF;
  IF NOT (public.has_company_permission(_company, 'accounting.post')
          OR public.has_company_permission(_company, 'journals.manual')) THEN
    RAISE EXCEPTION 'You do not have permission to post to the ledger';
  END IF;

  _reason := NULLIF(left(trim(COALESCE(payload->>'reason', '')), 300), '');
  IF _reason IS NULL THEN RAISE EXCEPTION 'A reason is required to write off a debt'; END IF;
  _date := NULLIF(payload->>'write_off_date', '')::DATE;
  IF _date IS NULL THEN RAISE EXCEPTION 'Write-off date is required'; END IF;

  SELECT * INTO _inv FROM public.sales_invoices
  WHERE id = NULLIF(payload->>'invoice_id', '')::UUID AND company_id = _company FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF _inv.status NOT IN ('authorised', 'partly_paid') THEN
    RAISE EXCEPTION 'Only an open invoice (authorised or part paid) can be written off';
  END IF;
  IF _date < _inv.invoice_date THEN
    RAISE EXCEPTION 'Write-off date cannot be before the invoice date %', _inv.invoice_date;
  END IF;

  _outstanding := _inv.total_minor - _inv.amount_paid_minor - _inv.amount_credited_minor;
  IF _outstanding <= 0 THEN RAISE EXCEPTION 'Nothing is outstanding on this invoice'; END IF;
  _amount := COALESCE(NULLIF(payload->>'amount_minor', '')::BIGINT, _outstanding);
  IF _amount <= 0 THEN RAISE EXCEPTION 'Write-off amount must be positive'; END IF;
  IF _amount > _outstanding THEN
    RAISE EXCEPTION 'Write-off exceeds the outstanding balance of the invoice';
  END IF;

  -- Bad-debt account: explicit, or a company account flagged bad_debt / named "Bad debt".
  _bad := NULLIF(payload->>'bad_debt_account_id', '')::UUID;
  IF _bad IS NULL THEN
    SELECT a.id INTO _bad FROM public.accounts a
    WHERE a.company_id = _company AND a.is_active AND a.archived_at IS NULL AND a.is_postable
      AND NOT a.is_control AND a.account_type::TEXT = 'expense'
      AND (a.system_key = 'bad_debt' OR a.name ILIKE 'bad debt%')
    ORDER BY (a.system_key = 'bad_debt') DESC NULLS LAST, a.code
    LIMIT 1;
  END IF;
  IF _bad IS NULL THEN
    RAISE EXCEPTION 'Choose a bad debt expense account (none is set up in this organisation)';
  END IF;
  IF NOT public.ops_usable_account(_company, _bad) THEN
    RAISE EXCEPTION 'The bad debt account is inactive, not postable, or a control account';
  END IF;
  SELECT a.account_type::TEXT INTO _acct_type FROM public.accounts a WHERE a.id = _bad;
  IF _acct_type <> 'expense' THEN RAISE EXCEPTION 'The bad debt account must be an expense account'; END IF;

  _ar := public.sales_ar_control_account(_company);
  IF _ar IS NULL THEN RAISE EXCEPTION 'Accounts receivable control account is missing'; END IF;

  -- Pro-rata tax relief on the written-off gross amount.
  _tax := CASE WHEN _inv.total_minor > 0
               THEN round(_amount::NUMERIC * _inv.tax_minor / _inv.total_minor)::BIGINT ELSE 0 END;
  _net := _amount - _tax;
  IF _net <= 0 THEN RAISE EXCEPTION 'Write-off amount is too small after tax relief'; END IF;
  IF _tax > 0 THEN
    _tax_acct := public.ops_output_tax_account(_company);
    IF _tax_acct IS NULL THEN
      RAISE EXCEPTION 'Output tax account is not configured. Set it in tax settings first.';
    END IF;
  END IF;

  _number := public.allocate_document_number(_company, 'sales_credit_note');

  INSERT INTO public.sales_credit_notes (
    company_id, contact_id, credit_number, credit_date, currency_code, status,
    subtotal_minor, tax_minor, total_minor, amount_allocated_minor, memo, invoice_id,
    fx_rate_to_base, created_by, authorised_at, authorised_by
  ) VALUES (
    _company, _inv.contact_id, _number, _date, _inv.currency_code, 'authorised',
    _net, _tax, _amount, 0, 'Bad debt write-off: ' || _reason, _inv.id,
    _inv.fx_rate_to_base, _uid, now(), _uid
  ) RETURNING id INTO _cn;

  INSERT INTO public.sales_credit_note_lines (
    company_id, credit_note_id, line_order, description, account_id, quantity, unit_price_minor,
    discount_minor, tax_rate_bps, net_minor, tax_minor, gross_minor
  ) VALUES (
    _company, _cn, 1, 'Bad debt write-off ' || COALESCE(_inv.invoice_number, ''), _bad, 1, _net,
    0, CASE WHEN _tax > 0 THEN round(_tax::NUMERIC * 10000 / _net)::INT ELSE 0 END, _net, _tax, _amount
  );

  _lines := jsonb_build_array(
    jsonb_build_object('account_id', _bad, 'description', 'Bad debt write-off', 'debit_minor', _net, 'credit_minor', 0));
  IF _tax > 0 THEN
    _lines := _lines || jsonb_build_array(
      jsonb_build_object('account_id', _tax_acct, 'description', 'Output tax relief', 'debit_minor', _tax, 'credit_minor', 0));
  END IF;
  _lines := _lines || jsonb_build_array(
    jsonb_build_object('account_id', _ar, 'description', 'Bad debt write-off ' || COALESCE(_inv.invoice_number, ''),
                       'debit_minor', 0, 'credit_minor', _amount));

  _journal := public.post_journal(jsonb_build_object(
    'company_id', _company,
    'journal_date', _date,
    'memo', 'Bad debt write-off ' || COALESCE(_inv.invoice_number, ''),
    'currency_code', _inv.currency_code,
    'fx_rate_to_base', _inv.fx_rate_to_base,
    'source_type', 'sales_credit_note',
    'source_id', _cn,
    'idempotency_key', 'sales_credit_note:' || _cn::TEXT || ':authorise',
    'lines', _lines
  ));

  -- Apply the whole credit to the invoice.
  INSERT INTO public.sales_credit_allocations (company_id, credit_note_id, invoice_id, amount_minor, allocated_on, created_by)
  VALUES (_company, _cn, _inv.id, _amount, _date, _uid);

  UPDATE public.sales_credit_notes
  SET posted_journal_id = _journal, amount_allocated_minor = _amount, status = 'paid', updated_at = now()
  WHERE id = _cn;

  _new_status := public.sales_derive_invoice_status(
    _inv.total_minor, _inv.amount_paid_minor, _inv.amount_credited_minor + _amount);
  UPDATE public.sales_invoices
  SET amount_credited_minor = amount_credited_minor + _amount, status = _new_status, updated_at = now()
  WHERE id = _inv.id;

  PERFORM public.record_audit_event(
    _company, 'sales.invoice.bad_debt_written_off', 'sales_invoice', _inv.id,
    jsonb_build_object('credit_note_id', _cn, 'journal_id', _journal, 'amount_minor', _amount,
                       'tax_relief_minor', _tax, 'reason', _reason)
  );

  RETURN jsonb_build_object(
    'credit_note_id', _cn, 'journal_id', _journal, 'written_off_minor', _amount,
    'invoice_status', _new_status::TEXT
  );
END;
$$;

REVOKE ALL ON FUNCTION public.post_money_document(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_money_document(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.write_off_bad_debt(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_money_document(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_money_document(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.write_off_bad_debt(JSONB) TO authenticated;
