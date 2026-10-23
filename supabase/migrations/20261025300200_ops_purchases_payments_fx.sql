-- Wave 2 H (ops) — purchases: atomic supplier payments with realised FX, batch payments, payment reversal,
-- attachment protection, SQL duplicate-contact finder.
--
--   P-06  supplier payments carry fx_rate_to_base; AP is cleared at each bill's own rate and the difference
--         to the bank amount is posted to realised FX gain (7700) / loss (7710). One journal, via post_journal.
--   P-34  attachments of posted / paid / void bills can no longer be deleted by clients.
--   C-09  find_duplicate_contacts(): set-based duplicate finder (no 2,000-row cap, no O(n^2) loop).
--   New   record_supplier_payment / record_supplier_payment_batch / reverse_supplier_payment (atomic).
--
-- Additive and idempotent. Requires 20261025300100 (ops helpers) and the purchases module migrations.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.supplier_payments
  ADD COLUMN IF NOT EXISTS fx_rate_to_base NUMERIC(18, 8) NOT NULL DEFAULT 1 CHECK (fx_rate_to_base > 0),
  ADD COLUMN IF NOT EXISTS realised_fx_minor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS void_journal_id UUID REFERENCES public.journals(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS batch_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS supplier_payments_idem_uidx
  ON public.supplier_payments (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS supplier_payments_batch_idx
  ON public.supplier_payments (company_id, batch_key) WHERE batch_key IS NOT NULL;

ALTER TABLE public.purchase_credit_notes
  ADD COLUMN IF NOT EXISTS fx_rate_to_base NUMERIC(18, 8) NOT NULL DEFAULT 1 CHECK (fx_rate_to_base > 0);

-- ---------------------------------------------------------------------------
-- 2. Internal worker: ops_record_supplier_payment
--    Not callable by clients. Caller has already authenticated and checked permission.
--    _p: contact_id, [currency_code], [fx_rate_to_base], [amount_minor], [reference], [memo],
--        [idempotency_key], [allocations: [{bill_id, amount_minor}]]
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ops_record_supplier_payment(
  _uid UUID, _company UUID, _p JSONB, _date DATE, _bank UUID, _batch_key TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _base TEXT;
  _ccy TEXT;
  _fx NUMERIC;
  _contact UUID := NULLIF(_p->>'contact_id', '')::UUID;
  _amount BIGINT;
  _alloc JSONB;
  _alloc_total BIGINT := 0;
  _unalloc BIGINT;
  _idem TEXT := NULLIF(left(trim(COALESCE(_p->>'idempotency_key', '')), 100), '');
  _ref TEXT := NULLIF(left(trim(COALESCE(_p->>'reference', '')), 80), '');
  _memo TEXT := NULLIF(left(trim(COALESCE(_p->>'memo', '')), 500), '');
  _existing RECORD;
  _bill RECORD;
  _bill_id UUID;
  _a BIGINT;
  _seen UUID[] := ARRAY[]::UUID[];
  _ap UUID;
  _carry_total BIGINT := 0;
  _carry BIGINT;
  _rate NUMERIC;
  _bank_base BIGINT;
  _fx_diff BIGINT := 0;
  _pay UUID;
  _journal UUID;
  _lines JSONB;
  _contact_kind TEXT;
  _contact_active BOOLEAN;
  _journal_ccy TEXT;
BEGIN
  SELECT base_currency INTO _base FROM public.companies WHERE id = _company;
  _ccy := upper(COALESCE(NULLIF(_p->>'currency_code', ''), _base));
  _fx := NULLIF(_p->>'fx_rate_to_base', '')::NUMERIC;
  IF _ccy = upper(_base) THEN
    _fx := 1;
  ELSIF _fx IS NULL THEN
    -- No rate given: settle at the rate of the first bill being paid (no FX effect), else the stored rate table.
    SELECT b.fx_rate_to_base INTO _fx
    FROM jsonb_array_elements(COALESCE(_p->'allocations', '[]'::JSONB)) e
    JOIN public.purchase_bills b ON b.id = (e->>'bill_id')::UUID AND b.company_id = _company
    WHERE b.fx_rate_to_base IS NOT NULL
    LIMIT 1;
    IF _fx IS NULL THEN
      _fx := public.lookup_fx_rate_to_base(_company, _ccy::CHAR(3), _date);
    END IF;
  END IF;
  IF _fx IS NULL OR _fx <= 0 THEN RAISE EXCEPTION 'Exchange rate must be positive'; END IF;

  -- Idempotent replay
  IF _idem IS NOT NULL THEN
    SELECT id, posted_journal_id INTO _existing
    FROM public.supplier_payments WHERE company_id = _company AND idempotency_key = _idem;
    IF FOUND THEN
      RETURN jsonb_build_object('id', _existing.id, 'journal_id', _existing.posted_journal_id, 'replayed', TRUE);
    END IF;
  END IF;

  IF _contact IS NULL THEN RAISE EXCEPTION 'Choose a supplier'; END IF;
  SELECT kind::TEXT, is_active INTO _contact_kind, _contact_active
  FROM public.contacts WHERE id = _contact AND company_id = _company;
  IF NOT FOUND THEN RAISE EXCEPTION 'Supplier not found in this organisation'; END IF;
  IF _contact_kind NOT IN ('supplier', 'both') OR NOT _contact_active THEN
    RAISE EXCEPTION 'Contact is not an active supplier';
  END IF;

  FOR _alloc IN SELECT * FROM jsonb_array_elements(COALESCE(_p->'allocations', '[]'::JSONB)) LOOP
    _a := COALESCE(NULLIF(_alloc->>'amount_minor', '')::BIGINT, 0);
    IF _a <= 0 THEN RAISE EXCEPTION 'Allocation amounts must be positive whole minor units'; END IF;
    _alloc_total := _alloc_total + _a;
  END LOOP;
  _amount := COALESCE(NULLIF(_p->>'amount_minor', '')::BIGINT, _alloc_total);
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;
  IF _alloc_total > _amount THEN RAISE EXCEPTION 'Allocations exceed the payment amount'; END IF;
  _unalloc := _amount - _alloc_total;

  IF _bank IS NULL OR NOT public.sales_is_deposit_account(_company, _bank) THEN
    RAISE EXCEPTION 'The payment account must be an active bank or cash account';
  END IF;
  _ap := public.ops_ap_control_account(_company);
  IF _ap IS NULL THEN RAISE EXCEPTION 'Accounts payable control account is not set up'; END IF;

  -- Validate and lock every bill BEFORE writing anything (sorted lock order avoids deadlocks).
  FOR _bill_id IN
    SELECT DISTINCT (e->>'bill_id')::UUID
    FROM jsonb_array_elements(COALESCE(_p->'allocations', '[]'::JSONB)) e
    ORDER BY 1
  LOOP
    PERFORM 1 FROM public.purchase_bills WHERE id = _bill_id AND company_id = _company FOR UPDATE;
  END LOOP;

  _lines := '[]'::JSONB;
  FOR _alloc IN SELECT * FROM jsonb_array_elements(COALESCE(_p->'allocations', '[]'::JSONB)) LOOP
    _bill_id := NULLIF(_alloc->>'bill_id', '')::UUID;
    IF _bill_id IS NULL THEN RAISE EXCEPTION 'Each allocation needs a bill'; END IF;
    IF _bill_id = ANY (_seen) THEN RAISE EXCEPTION 'A bill can only appear once per payment'; END IF;
    _seen := _seen || _bill_id;
    _a := (_alloc->>'amount_minor')::BIGINT;
    SELECT * INTO _bill FROM public.purchase_bills WHERE id = _bill_id AND company_id = _company;
    IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found in this organisation'; END IF;
    IF _bill.contact_id <> _contact THEN RAISE EXCEPTION 'Bill % belongs to a different supplier', COALESCE(_bill.bill_number, _bill_id::TEXT); END IF;
    IF _bill.status::TEXT NOT IN ('authorised', 'partly_paid') THEN
      RAISE EXCEPTION 'Bill % is not open for payment (status %)', COALESCE(_bill.bill_number, _bill_id::TEXT), _bill.status;
    END IF;
    IF upper(_bill.currency_code::TEXT) <> _ccy THEN
      RAISE EXCEPTION 'Bill % is in %, the payment is in %', COALESCE(_bill.bill_number, _bill_id::TEXT), _bill.currency_code, _ccy;
    END IF;
    IF _a > _bill.total_minor - _bill.amount_paid_minor - _bill.amount_credited_minor THEN
      RAISE EXCEPTION 'Allocation to bill % exceeds its outstanding balance', COALESCE(_bill.bill_number, _bill_id::TEXT);
    END IF;
    -- AP carrying amount at the bill's own rate (unknown rate: use the payment rate, no FX effect)
    _rate := COALESCE(_bill.fx_rate_to_base, _fx);
    _carry := public.ops_minor_to_base(_company, _a, _ccy, _rate);
    _carry_total := _carry_total + _carry;
  END LOOP;

  IF _ccy = upper(_base) THEN
    _carry_total := _amount;
    _bank_base := _amount;
    _journal_ccy := upper(_base);
  ELSE
    -- Unallocated part (supplier prepayment) is carried at the payment rate: no FX effect.
    IF _unalloc > 0 THEN
      _carry_total := _carry_total + public.ops_minor_to_base(_company, _unalloc, _ccy, _fx);
    END IF;
    _bank_base := public.ops_minor_to_base(_company, _amount, _ccy, _fx);
    _fx_diff := _carry_total - _bank_base;           -- > 0 gain (we paid less base than carried), < 0 loss
    _journal_ccy := upper(_base);
  END IF;

  INSERT INTO public.supplier_payments (
    company_id, contact_id, payment_date, bank_account_id, currency_code, amount_minor, unallocated_minor,
    reference, memo, status, fx_rate_to_base, realised_fx_minor, idempotency_key, batch_key, created_by
  ) VALUES (
    _company, _contact, _date, _bank, _ccy, _amount, _unalloc,
    _ref, _memo, 'draft', _fx, _fx_diff, _idem, _batch_key, _uid
  ) RETURNING id INTO _pay;

  FOR _alloc IN SELECT * FROM jsonb_array_elements(COALESCE(_p->'allocations', '[]'::JSONB)) LOOP
    _bill_id := (_alloc->>'bill_id')::UUID;
    _a := (_alloc->>'amount_minor')::BIGINT;
    INSERT INTO public.supplier_payment_allocations (company_id, payment_id, bill_id, amount_minor)
    VALUES (_company, _pay, _bill_id, _a);
    UPDATE public.purchase_bills
    SET amount_paid_minor = amount_paid_minor + _a,
        status = (CASE WHEN amount_paid_minor + _a + amount_credited_minor >= total_minor
                       THEN 'paid' ELSE 'partly_paid' END)::public.purchase_doc_status,
        updated_at = now()
    WHERE id = _bill_id;
  END LOOP;

  _lines := jsonb_build_array(
    jsonb_build_object('account_id', _ap, 'description', COALESCE(_memo, 'Supplier payment'),
                       'debit_minor', _carry_total, 'credit_minor', 0),
    jsonb_build_object('account_id', _bank, 'description', COALESCE(_memo, 'Bank'),
                       'debit_minor', 0, 'credit_minor', _bank_base)
  );
  IF _fx_diff > 0 THEN   -- gain: credit
    _lines := _lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.ops_fx_account(_company, 'gain'), 'description', 'Realised FX gain',
      'debit_minor', 0, 'credit_minor', _fx_diff));
  ELSIF _fx_diff < 0 THEN -- loss: debit
    _lines := _lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.ops_fx_account(_company, 'loss'), 'description', 'Realised FX loss',
      'debit_minor', -_fx_diff, 'credit_minor', 0));
  END IF;

  _journal := public.post_journal(jsonb_build_object(
    'company_id', _company,
    'journal_date', _date,
    'memo', COALESCE(_memo, 'Supplier payment')
            || CASE WHEN _ccy <> upper(_base)
                    THEN ' (' || _ccy || ' ' || _amount::TEXT || ' minor units at ' || _fx::TEXT || ')' ELSE '' END,
    'currency_code', _journal_ccy,
    'fx_rate_to_base', 1,
    'source_type', 'supplier_payment',
    'source_id', _pay,
    'idempotency_key', 'supplier_payment:' || _pay::TEXT || ':post',
    'lines', _lines
  ));

  UPDATE public.supplier_payments
  SET status = 'paid', posted_journal_id = _journal, updated_at = now()
  WHERE id = _pay;

  PERFORM public.record_audit_event(
    _company, 'supplier_payment.post', 'supplier_payment', _pay,
    jsonb_build_object('journal_id', _journal, 'amount_minor', _amount, 'currency_code', _ccy,
                       'fx_rate_to_base', _fx, 'realised_fx_minor', _fx_diff,
                       'bill_ids', to_jsonb(_seen), 'batch_key', _batch_key)
  );
  RETURN jsonb_build_object('id', _pay, 'journal_id', _journal, 'replayed', FALSE,
                            'unallocated_minor', _unalloc, 'realised_fx_minor', _fx_diff);
END;
$$;

REVOKE ALL ON FUNCTION public.ops_record_supplier_payment(UUID, UUID, JSONB, DATE, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. record_supplier_payment(payload)
--    payload: company_id, contact_id, payment_date, bank_account_id, [currency_code], [fx_rate_to_base],
--             [amount_minor], [reference], [memo], [idempotency_key], allocations[{bill_id, amount_minor}]
--    returns: {id, journal_id, replayed, unallocated_minor, realised_fx_minor}
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_supplier_payment(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company UUID := NULLIF(payload->>'company_id', '')::UUID;
  _date DATE := NULLIF(payload->>'payment_date', '')::DATE;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF _company IS NULL THEN RAISE EXCEPTION 'company_id is required'; END IF;
  IF NOT public.is_company_member(_company) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT public.has_company_permission(_company, 'purchases.payment') THEN
    RAISE EXCEPTION 'You do not have permission to record supplier payments';
  END IF;
  IF _date IS NULL THEN RAISE EXCEPTION 'Payment date is required'; END IF;
  RETURN public.ops_record_supplier_payment(
    _uid, _company, payload, _date, NULLIF(payload->>'bank_account_id', '')::UUID, NULL
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. record_supplier_payment_batch(payload)
--    payload: company_id, payment_date, bank_account_id, [memo], batch_key,
--             payments[{contact_id, [currency_code], [fx_rate_to_base], [reference], allocations[...]}]
--    All payments post in ONE transaction: if any fails nothing is posted. Replay-safe per batch_key.
--    returns: {batch_key, count, payments:[{id, journal_id, ...}]}
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_supplier_payment_batch(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company UUID := NULLIF(payload->>'company_id', '')::UUID;
  _date DATE := NULLIF(payload->>'payment_date', '')::DATE;
  _bank UUID := NULLIF(payload->>'bank_account_id', '')::UUID;
  _batch TEXT := NULLIF(left(trim(COALESCE(payload->>'batch_key', '')), 80), '');
  _memo TEXT := NULLIF(left(trim(COALESCE(payload->>'memo', '')), 500), '');
  _item JSONB;
  _i INT := 0;
  _out JSONB := '[]'::JSONB;
  _n INT;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF _company IS NULL THEN RAISE EXCEPTION 'company_id is required'; END IF;
  IF NOT public.is_company_member(_company) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT public.has_company_permission(_company, 'purchases.payment') THEN
    RAISE EXCEPTION 'You do not have permission to record supplier payments';
  END IF;
  IF _date IS NULL THEN RAISE EXCEPTION 'Payment date is required'; END IF;
  IF _batch IS NULL THEN RAISE EXCEPTION 'A batch key is required'; END IF;
  _n := jsonb_array_length(COALESCE(payload->'payments', '[]'::JSONB));
  IF _n = 0 THEN RAISE EXCEPTION 'Select at least one bill to pay'; END IF;
  IF _n > 100 THEN RAISE EXCEPTION 'A batch can contain at most 100 payments'; END IF;

  FOR _item IN SELECT * FROM jsonb_array_elements(payload->'payments') LOOP
    _i := _i + 1;
    _item := _item
      || jsonb_build_object('idempotency_key', _batch || ':' || _i::TEXT)
      || CASE WHEN _memo IS NOT NULL AND NOT (_item ? 'memo') THEN jsonb_build_object('memo', _memo) ELSE '{}'::JSONB END;
    _out := _out || jsonb_build_array(public.ops_record_supplier_payment(_uid, _company, _item, _date, _bank, _batch));
  END LOOP;
  RETURN jsonb_build_object('batch_key', _batch, 'count', _i, 'payments', _out);
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. reverse_supplier_payment(payload)
--    payload: company_id, payment_id, [reason], [void_date]
--    Restores bill balances, reverses the journal on void_date, marks the payment void.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reverse_supplier_payment(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company UUID := NULLIF(payload->>'company_id', '')::UUID;
  _pay RECORD;
  _alloc RECORD;
  _reason TEXT := NULLIF(left(trim(COALESCE(payload->>'reason', '')), 300), '');
  _date DATE;
  _vj UUID;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF _company IS NULL THEN RAISE EXCEPTION 'company_id is required'; END IF;
  IF NOT public.is_company_member(_company) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT public.has_company_permission(_company, 'purchases.payment') THEN
    RAISE EXCEPTION 'You do not have permission to reverse supplier payments';
  END IF;

  SELECT * INTO _pay FROM public.supplier_payments
  WHERE id = NULLIF(payload->>'payment_id', '')::UUID AND company_id = _company FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF _pay.status::TEXT = 'void' THEN RAISE EXCEPTION 'Payment is already voided'; END IF;
  IF _pay.posted_journal_id IS NULL THEN RAISE EXCEPTION 'Payment has no posted journal to reverse'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.money_document_credit_uses u
    JOIN public.money_documents d ON d.id = u.document_id
    WHERE u.source_kind = 'supplier_payment' AND u.source_id = _pay.id AND d.status <> 'void'
  ) THEN
    RAISE EXCEPTION 'This payment has been refunded. Void the refund first.';
  END IF;

  _date := GREATEST(COALESCE(NULLIF(payload->>'void_date', '')::DATE, CURRENT_DATE), _pay.payment_date);

  FOR _alloc IN
    SELECT a.bill_id, a.amount_minor FROM public.supplier_payment_allocations a
    WHERE a.payment_id = _pay.id ORDER BY a.bill_id
  LOOP
    PERFORM 1 FROM public.purchase_bills WHERE id = _alloc.bill_id FOR UPDATE;
  END LOOP;
  FOR _alloc IN
    SELECT a.bill_id, a.amount_minor FROM public.supplier_payment_allocations a WHERE a.payment_id = _pay.id
  LOOP
    UPDATE public.purchase_bills
    SET amount_paid_minor = GREATEST(0, amount_paid_minor - _alloc.amount_minor),
        status = (CASE
                   WHEN status::TEXT = 'void' THEN status::TEXT
                   WHEN GREATEST(0, amount_paid_minor - _alloc.amount_minor) + amount_credited_minor >= total_minor THEN 'paid'
                   WHEN GREATEST(0, amount_paid_minor - _alloc.amount_minor) + amount_credited_minor > 0 THEN 'partly_paid'
                   ELSE 'authorised' END)::public.purchase_doc_status,
        updated_at = now()
    WHERE id = _alloc.bill_id;
  END LOOP;
  DELETE FROM public.supplier_payment_allocations WHERE payment_id = _pay.id;

  _vj := public.reverse_journal_on(_pay.posted_journal_id, _date, 'supplier_payment:' || _pay.id::TEXT || ':void');

  UPDATE public.supplier_payments
  SET status = 'void', unallocated_minor = 0, void_journal_id = _vj, void_reason = _reason,
      voided_at = now(), updated_at = now()
  WHERE id = _pay.id;

  PERFORM public.record_audit_event(
    _company, 'supplier_payment.reverse', 'supplier_payment', _pay.id,
    jsonb_build_object('void_journal_id', _vj, 'reason', _reason, 'void_date', _date)
  );
  RETURN jsonb_build_object('id', _pay.id, 'void_journal_id', _vj);
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. P-34: protect the source documents of posted bills
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_bill_attachment_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _status TEXT;
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN RETURN OLD; END IF;
  IF OLD.entity_type = 'purchase_bill' THEN
    SELECT status::TEXT INTO _status FROM public.purchase_bills WHERE id = OLD.entity_id;
    IF _status IS NOT NULL AND _status NOT IN ('draft', 'awaiting_approval') THEN
      RAISE EXCEPTION 'Attachments of a posted, paid or void bill are part of the audit trail and cannot be deleted';
    END IF;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS guard_bill_attachment_delete ON public.document_attachments;
CREATE TRIGGER guard_bill_attachment_delete
  BEFORE DELETE ON public.document_attachments
  FOR EACH ROW EXECUTE FUNCTION public.guard_bill_attachment_delete();

-- ---------------------------------------------------------------------------
-- 7. C-09: set-based duplicate contact finder (same scoring as duplicateScore() in contact-helpers.ts)
--    Candidate pairs come from hash joins on each normalised key, so it scales past 2,000 contacts.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.find_duplicate_contacts(_company_id UUID, _limit INT DEFAULT 50)
RETURNS TABLE (
  a_id UUID, a_name TEXT, a_email TEXT, a_phone TEXT, a_tax_number TEXT, a_account_number TEXT,
  b_id UUID, b_name TEXT, b_email TEXT, b_phone TEXT, b_tax_number TEXT, b_account_number TEXT,
  score INT, reasons TEXT[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  RETURN QUERY
  WITH c AS (
    SELECT id, name, email, phone, tax_number, account_number,
           NULLIF(regexp_replace(lower(trim(name)), '\s+', ' ', 'g'), '') AS k_name,
           NULLIF(lower(trim(email)), '') AS k_email,
           CASE WHEN length(regexp_replace(COALESCE(phone, ''), '\D', '', 'g')) >= 7
                THEN regexp_replace(phone, '\D', '', 'g') END AS k_phone,
           NULLIF(lower(trim(tax_number)), '') AS k_tax,
           NULLIF(lower(trim(account_number)), '') AS k_acct
    FROM public.contacts
    WHERE company_id = _company_id AND is_active
  ),
  pairs AS (
    SELECT x.id AS xi, y.id AS yi, 50 AS pts, 'Same name'::TEXT AS why FROM c x JOIN c y ON x.k_name = y.k_name AND x.id < y.id
    UNION ALL
    SELECT x.id, y.id, 40, 'Same email' FROM c x JOIN c y ON x.k_email = y.k_email AND x.id < y.id
    UNION ALL
    SELECT x.id, y.id, 30, 'Same phone' FROM c x JOIN c y ON x.k_phone = y.k_phone AND x.id < y.id
    UNION ALL
    SELECT x.id, y.id, 45, 'Same tax ID' FROM c x JOIN c y ON x.k_tax = y.k_tax AND x.id < y.id
    UNION ALL
    SELECT x.id, y.id, 60, 'Same account number' FROM c x JOIN c y ON x.k_acct = y.k_acct AND x.id < y.id
  ),
  scored AS (
    SELECT xi, yi, SUM(pts)::INT AS total, array_agg(why ORDER BY pts DESC) AS why_list
    FROM pairs GROUP BY xi, yi
    HAVING SUM(pts) >= 40
  )
  SELECT ca.id, ca.name, ca.email, ca.phone, ca.tax_number, ca.account_number,
         cb.id, cb.name, cb.email, cb.phone, cb.tax_number, cb.account_number,
         s.total, s.why_list
  FROM scored s
  JOIN c ca ON ca.id = s.xi
  JOIN c cb ON cb.id = s.yi
  ORDER BY s.total DESC, ca.name
  LIMIT GREATEST(1, LEAST(COALESCE(_limit, 50), 500));
END;
$$;

CREATE INDEX IF NOT EXISTS contacts_company_active_idx ON public.contacts (company_id) WHERE is_active;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.record_supplier_payment(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_supplier_payment_batch(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reverse_supplier_payment(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.find_duplicate_contacts(UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_supplier_payment(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_supplier_payment_batch(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_supplier_payment(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.find_duplicate_contacts(UUID, INT) TO authenticated;
