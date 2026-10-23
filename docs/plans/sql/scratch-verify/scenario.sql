\set ON_ERROR_STOP off
\set QUIET on
SET client_min_messages = warning;
-- fixtures
INSERT INTO auth.users VALUES ('00000000-0000-0000-0000-0000000000a1');
INSERT INTO public.companies (id, name) VALUES ('00000000-0000-0000-0000-0000000000c1', 'Co');
INSERT INTO public.company_members VALUES ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000a1','active','owner');
INSERT INTO public.role_permissions SELECT 'owner', p FROM unnest(ARRAY['banking.categorise','banking.reconcile','banking.import','banking.feeds.manage']) p;
INSERT INTO public.accounts (id, company_id, code, name) VALUES
 ('00000000-0000-0000-0000-00000000b001','00000000-0000-0000-0000-0000000000c1','1000','Bank A'),
 ('00000000-0000-0000-0000-00000000b002','00000000-0000-0000-0000-0000000000c1','1010','Bank B'),
 ('00000000-0000-0000-0000-00000000e001','00000000-0000-0000-0000-0000000000c1','6000','Expenses'),
 ('00000000-0000-0000-0000-00000000e002','00000000-0000-0000-0000-0000000000c1','4000','Sales');
INSERT INTO public.bank_accounts (id, company_id, name, currency_code, gl_account_id) VALUES
 ('00000000-0000-0000-0000-0000000000ba','00000000-0000-0000-0000-0000000000c1','A','GBP','00000000-0000-0000-0000-00000000b001'),
 ('00000000-0000-0000-0000-0000000000bb','00000000-0000-0000-0000-0000000000c1','B','GBP','00000000-0000-0000-0000-00000000b002');
SELECT set_config('app.uid','00000000-0000-0000-0000-0000000000a1', false);
\set co '00000000-0000-0000-0000-0000000000c1'
\set ba '00000000-0000-0000-0000-0000000000ba'
\set bb '00000000-0000-0000-0000-0000000000bb'
\set glA '00000000-0000-0000-0000-00000000b001'
\set exp '00000000-0000-0000-0000-00000000e001'
\set sales '00000000-0000-0000-0000-00000000e002'

\echo '--- T1 balances + statement lines'
-- two receipts in ledger (e.g. customer payments): 100.00 and 50.00; one payment out 30.00
SELECT public.post_journal(jsonb_build_object('company_id',:'co','journal_date','2026-01-05','currency_code','GBP','source_type','manual','idempotency_key','r1','lines',
  jsonb_build_array(jsonb_build_object('account_id',:'glA','debit_minor',10000,'credit_minor',0),jsonb_build_object('account_id',:'sales','debit_minor',0,'credit_minor',10000)))) AS j1 \gset
SELECT public.post_journal(jsonb_build_object('company_id',:'co','journal_date','2026-01-06','currency_code','GBP','source_type','manual','idempotency_key','r2','lines',
  jsonb_build_array(jsonb_build_object('account_id',:'glA','debit_minor',5000,'credit_minor',0),jsonb_build_object('account_id',:'sales','debit_minor',0,'credit_minor',5000)))) AS j2 \gset
SELECT public.post_journal(jsonb_build_object('company_id',:'co','journal_date','2026-01-07','currency_code','GBP','source_type','manual','idempotency_key','p1','lines',
  jsonb_build_array(jsonb_build_object('account_id',:'exp','debit_minor',3000,'credit_minor',0),jsonb_build_object('account_id',:'glA','debit_minor',0,'credit_minor',3000)))) AS j3 \gset
SELECT id AS l1 FROM public.journal_lines WHERE journal_id=:'j1' AND account_id=:'glA' \gset
SELECT id AS l2 FROM public.journal_lines WHERE journal_id=:'j2' AND account_id=:'glA' \gset
SELECT id AS l3 FROM public.journal_lines WHERE journal_id=:'j3' AND account_id=:'glA' \gset
SELECT public.account_balance_as_of(:'co',:'glA','2026-01-31') AS balance_expect_12000;

INSERT INTO public.bank_transactions (company_id,bank_account_id,txn_date,amount_minor,description,external_id) VALUES
 (:'co',:'ba','2026-01-06',15000,'DEPOSIT (banks two receipts)','s1'),
 (:'co',:'ba','2026-01-08',-3000,'PAYMENT','s2'),
 (:'co',:'ba','2026-01-09',-777,'FEE','s3');
SELECT id AS s1 FROM public.bank_transactions WHERE external_id='s1' \gset
SELECT id AS s2 FROM public.bank_transactions WHERE external_id='s2' \gset
SELECT id AS s3 FROM public.bank_transactions WHERE external_id='s3' \gset

\echo '--- T2 match: wrong total must fail'
SELECT public.match_bank_transaction(:'co',:'s1',ARRAY[:'l1'::uuid]);
\echo '--- T2 match: 1 statement line to 2 ledger lines (one-to-many)'
SELECT public.match_bank_transaction(:'co',:'s1',ARRAY[:'l1'::uuid,:'l2'::uuid]);
\echo '--- T2 match: already matched line must fail'
SELECT public.match_bank_transaction(:'co',:'s2',ARRAY[:'l1'::uuid]);
SELECT public.match_bank_transaction(:'co',:'s2',ARRAY[:'l3'::uuid]);
SELECT status, count(*) FROM public.bank_transactions GROUP BY status ORDER BY 1;

\echo '--- T3 complete must fail while uncategorised line s3 remains'
SELECT public.complete_reconciliation_session(:'co',:'ba','2026-01-31',12000,0,ARRAY[:'s1'::uuid,:'s2'::uuid],ARRAY[]::uuid[],NULL);
\echo '--- exclude s3 (as the app would) then wrong difference must fail'
UPDATE public.bank_transactions SET status='excluded' WHERE id=:'s3';
SELECT public.complete_reconciliation_session(:'co',:'ba','2026-01-31',12001,0,ARRAY[:'s1'::uuid,:'s2'::uuid],ARRAY[]::uuid[],NULL);
\echo '--- partial group tick must fail (s1 is linked to l1+l2 only, fine) / correct complete succeeds'
SELECT public.complete_reconciliation_session(:'co',:'ba','2026-01-31',12000,0,ARRAY[:'s1'::uuid,:'s2'::uuid],ARRAY[]::uuid[],'Jan');
SELECT status, count(*) FROM public.bank_transactions GROUP BY status ORDER BY 1;
SELECT opening_balance_minor, statement_balance_minor, cleared_total_minor, reconciled_balance_minor, status FROM public.reconciliation_sessions;
SELECT count(*) AS session_lines_expect_3 FROM public.reconciliation_session_lines;

\echo '--- T4 unmatch of a reconciled line must fail'
SELECT public.unmatch_bank_transaction(:'co',:'s2','oops');
\echo '--- T4 second session must continue from previous closing balance'
SELECT public.complete_reconciliation_session(:'co',:'ba','2026-02-28',500,0,ARRAY[]::uuid[],ARRAY[]::uuid[],NULL);

\echo '--- T5 void (reopen) latest session, lines go back to matched'
SELECT public.void_reconciliation_session(:'co',(SELECT id FROM public.reconciliation_sessions LIMIT 1),'redo');
SELECT status, count(*) FROM public.bank_transactions GROUP BY status ORDER BY 1;
SELECT status FROM public.reconciliation_sessions;
SELECT count(*) AS session_lines_expect_0 FROM public.reconciliation_session_lines;

\echo '--- T6 unmatch s2 (ledger payment l3 NOT created from bank => not reversed)'
SELECT public.unmatch_bank_transaction(:'co',:'s2','wrong match');
SELECT status FROM public.bank_transactions WHERE id=:'s2';
SELECT count(*) AS journals_expect_3 FROM public.journals;
SELECT public.unmatch_bank_transaction(:'co',:'s2','again') AS second_call_is_noop;

\echo '--- T7 unmatch a group (s1 to l1+l2): both links removed'
SELECT public.unmatch_bank_transaction(:'co',:'s1',NULL);
SELECT count(*) AS links_expect_0 FROM public.reconciliation_links;

\echo '--- T8 bank-coded journal (source_type bank_transaction) is reversed on unmatch, re-code works with new key'
SELECT public.post_journal(jsonb_build_object('company_id',:'co','journal_date','2026-01-09','currency_code','GBP','source_type','bank_transaction','source_id',:'s3','idempotency_key','bank_txn:s3:1','lines',
  jsonb_build_array(jsonb_build_object('account_id',:'exp','debit_minor',777,'credit_minor',0),jsonb_build_object('account_id',:'glA','debit_minor',0,'credit_minor',777)))) AS jc \gset
UPDATE public.bank_transactions SET status='uncategorised' WHERE id=:'s3';
SELECT id AS lc FROM public.journal_lines WHERE journal_id=:'jc' AND account_id=:'glA' \gset
INSERT INTO public.reconciliation_links (company_id,bank_transaction_id,journal_line_id) VALUES (:'co',:'s3',:'lc');
UPDATE public.bank_transactions SET status='matched' WHERE id=:'s3';
SELECT public.unmatch_bank_transaction(:'co',:'s3','miscoded');
SELECT status FROM public.bank_transactions WHERE id=:'s3';
SELECT (SELECT count(*) FROM public.journals WHERE reverses_journal_id=:'jc') AS reversal_expect_1;
SELECT public.account_balance_as_of(:'co',:'glA','2026-12-31') AS balance_expect_12000_after_reversal;

\echo '--- T9 many statement lines to ONE ledger line'
INSERT INTO public.bank_transactions (company_id,bank_account_id,txn_date,amount_minor,external_id) VALUES (:'co',:'ba','2026-02-01',6000,'m1'),(:'co',:'ba','2026-02-01',4000,'m2');
SELECT array_agg(id) AS mids FROM public.bank_transactions WHERE external_id IN ('m1','m2') \gset
SELECT public.match_bank_transactions_to_journal_line(:'co',:'mids'::uuid[],:'l1');
SELECT public.match_bank_transactions_to_journal_line(:'co',:'mids'::uuid[],:'l2');
SELECT status, count(*) FROM public.bank_transactions WHERE external_id IN ('m1','m2') GROUP BY 1;
SELECT public.unmatch_bank_transaction(:'co',(SELECT id FROM public.bank_transactions WHERE external_id='m1'),NULL);
SELECT status, count(*) FROM public.bank_transactions WHERE external_id IN ('m1','m2') GROUP BY 1;

\echo '--- T10 transfer (atomic)'
SELECT public.create_bank_transfer(:'co',:'ba',:'bb','2026-01-20',2500,'GBP','move');
SELECT public.create_bank_transfer(:'co',:'ba',:'ba','2026-01-20',2500,'GBP','same');
SELECT public.create_bank_transfer(:'co',:'ba',:'bb','2026-01-20',0,'GBP',NULL);
SELECT public.create_bank_transfer(:'co',:'ba',:'bb','2026-01-20',2500,'USD',NULL);
SELECT count(*) AS transfers_expect_1 FROM public.bank_transfers;
SELECT public.account_balance_as_of(:'co','00000000-0000-0000-0000-00000000b002','2026-12-31') AS bankB_expect_2500;

\echo '--- T11 coding history counter increments'
SELECT public.bump_bank_coding_history(:'co','acme','ACME LTD',:'exp','out');
SELECT public.bump_bank_coding_history(:'co','acme','ACME LTD 2',:'exp','out');
SELECT times_used AS expect_2 FROM public.bank_coding_history;

\echo '--- T12 permissions: user without role is rejected'
SELECT set_config('app.uid','00000000-0000-0000-0000-0000000000ff', false);
SELECT public.unmatch_bank_transaction(:'co',:'s3',NULL);
SELECT public.account_balance_as_of(:'co',:'glA',NULL);
