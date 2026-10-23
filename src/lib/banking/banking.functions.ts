import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { requireAccountInCompany } from "@/lib/purchases/accounts";
import { postBankTransfer, voidPostedDocument } from "@/lib/sales/posting";
import { codeBankTransactionOnce } from "@/lib/banking/coding-server";
import { chunk } from "@/lib/banking/fetch-all";
import { DB_UPDATE_MESSAGE, isMissingSchema, recordAudit, tryRpc } from "@/lib/banking/rpc";
import {
  ledgerBalanceAsOf,
  loadBankAccount,
  loadBankTxn,
  type AnyClient,
} from "@/lib/banking/server-helpers";
import {
  directionFromAmount,
  normalizePayee,
  rankCodingSuggestions,
} from "@/lib/banking/suggestions";
import { applyTxnFilter, normaliseTxnFilter } from "@/lib/banking/txn-filter";

export type BankTxnLink = {
  journalLineId: string;
  journalId: string | null;
  journalNumber: number | null;
  sourceType: string | null;
  reversed: boolean;
};

export type BankTxnListRow = {
  id: string;
  bank_account_id: string;
  txn_date: string;
  amount_minor: number;
  description: string | null;
  external_id: string | null;
  status: string;
  created_at: string;
  exclude_reason: string | null;
  excluded_at: string | null;
  payee_normalized: string | null;
  reference: string | null;
  payee: string | null;
  contact_id: string | null;
  contact_name: string | null;
  links: BankTxnLink[];
  /** First link (previous single-link shape) */
  link: {
    journal_line_id: string;
    journal_id: string | null;
    journal_number: number | null;
  } | null;
};

export type BankTransferListRow = {
  id: string;
  transfer_date: string;
  amount_minor: number;
  currency_code: string;
  memo: string | null;
  status: string;
  posted_journal_id: string | null;
  from_bank_account_id: string;
  to_bank_account_id: string;
  from_name: string;
  to_name: string;
  created_at: string;
  /** Set for cross-currency transfers (BK-10). */
  to_amount_minor: number | null;
  to_currency_code: string | null;
  fx_difference_minor: number;
};

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export const listBankAccounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; includeInactive?: boolean }) => ({
    companyId: assertUuid(input.companyId),
    includeInactive: input.includeInactive === true,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    let q = context.supabase
      .from("bank_accounts" as never)
      .select(
        "id, name, currency_code, gl_account_id, is_active, created_at, accounts(code, name)" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("name" as never);
    if (!data.includeInactive) q = q.eq("is_active" as never, true as never);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    const { data: feeds } = await context.supabase
      .from("bank_feed_connections" as never)
      .select("bank_account_id, provider, status, last_sync_at, last_error" as never)
      .eq("company_id" as never, data.companyId as never);

    const feedMap = new Map(
      ((feeds ?? []) as unknown as Array<{ bank_account_id: string; status: string }>).map((f) => [
        f.bank_account_id,
        f,
      ]),
    );

    return (
      (rows ?? []) as unknown as Array<{
        id: string;
        name: string;
        currency_code: string;
        gl_account_id: string;
        is_active: boolean;
        created_at: string;
        accounts: { code: string; name: string } | null;
      }>
    ).map((r) => ({
      ...r,
      feed: feedMap.get(r.id) ?? { status: "disconnected", provider: null },
    }));
  });

/** Rename or archive/restore a bank account (BK-16). Archiving hides it from pickers; history is kept. */
export const updateBankAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; id: string; name?: string; isActive?: boolean }) => {
    const name = input.name === undefined ? undefined : input.name.trim().slice(0, 120);
    if (name !== undefined && !name) throw new Error("Account name is required");
    if (name === undefined && input.isActive === undefined) throw new Error("Nothing to update");
    return {
      companyId: assertUuid(input.companyId),
      id: assertUuid(input.id),
      name,
      isActive: input.isActive,
    };
  })
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyPermission(supabase, data.companyId, "banking.feeds.manage");
    const patch: Record<string, unknown> = {};
    if (data.name !== undefined) patch["name"] = data.name;
    if (data.isActive !== undefined) patch["is_active"] = data.isActive;
    const { data: row, error } = await supabase
      .from("bank_accounts" as never)
      .update(patch as never)
      .eq("id" as never, data.id as never)
      .eq("company_id" as never, data.companyId as never)
      .select("id" as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    // No row back = the UPDATE policy is not installed yet (or the account is not in this company).
    if (!row) throw new Error(DB_UPDATE_MESSAGE);
    await recordAudit(supabase, {
      companyId: data.companyId,
      action: data.isActive === false ? "bank_account.archive" : "bank_account.update",
      entityType: "bank_account",
      entityId: data.id,
      details: patch,
    });
    return { ok: true as const };
  });

/** Account cards on /banking: statement balance (last reconciliation), ledger balance, unreconciled count. */
export const getBankAccountSummaries = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyMember(supabase, data.companyId);
    const { data: accounts, error } = await supabase
      .from("bank_accounts" as never)
      .select("id, name, currency_code, gl_account_id, is_active" as never)
      .eq("company_id" as never, data.companyId as never)
      .order("name" as never);
    if (error) throw new Error(error.message);

    const today = new Date().toISOString().slice(0, 10);
    const list = (accounts ?? []) as unknown as Array<{
      id: string;
      name: string;
      currency_code: string;
      gl_account_id: string;
      is_active: boolean;
    }>;
    return Promise.all(
      list.map(async (a) => {
        const count = async (status: string) => {
          const { count: c } = await supabase
            .from("bank_transactions" as never)
            .select("id" as never, { count: "exact", head: true })
            .eq("company_id" as never, data.companyId as never)
            .eq("bank_account_id" as never, a.id as never)
            .eq("status" as never, status as never);
          return c ?? 0;
        };
        const [uncategorised, matched, ledger, lastSession] = await Promise.all([
          count("uncategorised"),
          count("matched"),
          ledgerBalanceAsOf(supabase, data.companyId, a.gl_account_id, today),
          supabase
            .from("reconciliation_sessions" as never)
            .select("statement_date, statement_balance_minor" as never)
            .eq("company_id" as never, data.companyId as never)
            .eq("bank_account_id" as never, a.id as never)
            .eq("status" as never, "completed" as never)
            .order("statement_date" as never, { ascending: false })
            .order("created_at" as never, { ascending: false })
            .limit(1)
            .maybeSingle(),
        ]);
        const ls = lastSession.data as unknown as {
          statement_date: string;
          statement_balance_minor: number;
        } | null;
        return {
          id: a.id,
          name: a.name,
          currencyCode: a.currency_code,
          isActive: a.is_active,
          ledgerBalanceMinor: Number(ledger),
          lastStatementBalanceMinor: ls ? ls.statement_balance_minor : null,
          lastStatementDate: ls ? ls.statement_date : null,
          uncategorisedCount: uncategorised,
          matchedCount: matched,
          unreconciledCount: uncategorised + matched,
        };
      }),
    );
  });

export const createBankAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; name: string; currencyCode: string; glAccountId: string }) => {
      const name = (input.name ?? "").trim();
      if (!name) throw new Error("Account name is required");
      return {
        companyId: assertUuid(input.companyId),
        name,
        currencyCode: (input.currencyCode ?? "").toUpperCase().slice(0, 3),
        glAccountId: assertUuid(input.glAccountId, "GL account"),
      };
    },
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "banking.feeds.manage");
    await requireAccountInCompany(context.supabase, data.companyId, data.glAccountId);
    const { data: row, error } = await context.supabase
      .from("bank_accounts" as never)
      .insert({
        company_id: data.companyId,
        name: data.name,
        currency_code: data.currencyCode,
        gl_account_id: data.glAccountId,
      } as never)
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505")
        throw new Error("This GL account is already linked to a bank account");
      throw new Error(error.message);
    }
    return { id: (row as { id: string }).id };
  });

export const listBankTransactions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      bankAccountId?: string;
      status?: string;
      /** unreconciled = uncategorised + matched; all = no status filter */
      statusGroup?: string;
      q?: string;
      dateFrom?: string;
      dateTo?: string;
      direction?: string;
      page?: number;
      pageSize?: number;
    }) => ({
      companyId: assertUuid(input.companyId),
      filter: normaliseTxnFilter({
        bankAccountId: input.bankAccountId ? assertUuid(input.bankAccountId) : null,
        status: input.status ?? null,
        statusGroup: input.statusGroup ?? null,
        q: input.q ?? null,
        dateFrom: input.dateFrom ?? null,
        dateTo: input.dateTo ?? null,
        direction: input.direction ?? null,
      }),
      page: Math.max(0, Math.round(Number(input.page ?? 0)) || 0),
      pageSize: Math.min(200, Math.max(10, Math.round(Number(input.pageSize ?? 50)) || 50)),
    }),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyMember(supabase, data.companyId);
    const pageSize = data.pageSize;
    const from = data.page * pageSize;

    const COLUMNS_NEW =
      "id, bank_account_id, txn_date, amount_minor, description, external_id, status, created_at, exclude_reason, excluded_at, payee_normalized, reference, payee, contact_id";
    const COLUMNS_OLD =
      "id, bank_account_id, txn_date, amount_minor, description, external_id, status, created_at, exclude_reason, excluded_at, payee_normalized";
    const run = (columns: string, extras: boolean) =>
      applyTxnFilter(
        supabase
          .from("bank_transactions" as never)
          .select(columns as never, { count: "exact" })
          .eq("company_id" as never, data.companyId as never),
        data.filter,
        extras,
      )
        // Deterministic order: without the id tie-break rows can repeat or vanish across pages.
        .order("txn_date" as never, { ascending: false })
        .order("id" as never, { ascending: false })
        .range(from, from + pageSize - 1);
    let res = await run(COLUMNS_NEW, true);
    if (res.error && isMissingSchema(res.error)) res = await run(COLUMNS_OLD, false);
    if (res.error) throw new Error(res.error.message);

    const rows = (res.data ?? []) as unknown as Array<Record<string, unknown> & { id: string }>;
    const ids = rows.map((r) => r.id);

    type LinkInfo = BankTxnLink;
    const linksByTxn = new Map<string, LinkInfo[]>();
    if (ids.length) {
      const { data: links, error: lErr } = await supabase
        .from("reconciliation_links" as never)
        .select("bank_transaction_id, journal_line_id" as never)
        .eq("company_id" as never, data.companyId as never)
        .in("bank_transaction_id" as never, ids as never);
      if (lErr) throw new Error(lErr.message);
      const linkRows = (links ?? []) as unknown as Array<{
        bank_transaction_id: string;
        journal_line_id: string;
      }>;
      const lineIds = [...new Set(linkRows.map((l) => l.journal_line_id))];
      const lineInfo = new Map<string, Omit<LinkInfo, "journalLineId">>();
      for (const part of chunk(lineIds, 150)) {
        const { data: lines, error: jErr } = await supabase
          .from("journal_lines" as never)
          .select(
            "id, journal_id, journals!inner(journal_number, source_type, reversed_by_journal_id)" as never,
          )
          .in("id" as never, part as never);
        if (jErr) throw new Error(jErr.message);
        for (const l of (lines ?? []) as unknown as Array<{
          id: string;
          journal_id: string;
          journals: {
            journal_number: number;
            source_type: string;
            reversed_by_journal_id: string | null;
          };
        }>) {
          lineInfo.set(l.id, {
            journalId: l.journal_id,
            journalNumber: l.journals.journal_number,
            sourceType: l.journals.source_type,
            reversed: l.journals.reversed_by_journal_id !== null,
          });
        }
      }
      for (const l of linkRows) {
        const info = lineInfo.get(l.journal_line_id);
        const entry: LinkInfo = {
          journalLineId: l.journal_line_id,
          journalId: info?.journalId ?? null,
          journalNumber: info?.journalNumber ?? null,
          sourceType: info?.sourceType ?? null,
          reversed: info?.reversed ?? false,
        };
        const list = linksByTxn.get(l.bank_transaction_id);
        if (list) list.push(entry);
        else linksByTxn.set(l.bank_transaction_id, [entry]);
      }
    }

    // Contact names (only when the coded contact column exists)
    const contactIds = [
      ...new Set(
        rows.map((r) => r["contact_id"]).filter((x): x is string => typeof x === "string"),
      ),
    ];
    const contactNames = new Map<string, string>();
    if (contactIds.length) {
      const { data: cs } = await supabase
        .from("contacts" as never)
        .select("id, name" as never)
        .in("id" as never, contactIds as never);
      for (const c of (cs ?? []) as unknown as Array<{ id: string; name: string }>) {
        contactNames.set(c.id, c.name);
      }
    }

    return {
      rows: rows.map((r): BankTxnListRow => {
        const links = linksByTxn.get(r.id) ?? [];
        const first = links[0] ?? null;
        return {
          ...(r as unknown as BankTxnListRow),
          reference: (r["reference"] as string | null | undefined) ?? null,
          payee: (r["payee"] as string | null | undefined) ?? null,
          contact_id: (r["contact_id"] as string | null | undefined) ?? null,
          contact_name: contactNames.get(String(r["contact_id"] ?? "")) ?? null,
          links,
          // Previous single-link shape kept for existing callers
          link: first
            ? {
                journal_line_id: first.journalLineId,
                journal_id: first.journalId,
                journal_number: first.journalNumber,
              }
            : null,
        };
      }),
      total: res.count ?? 0,
      page: data.page,
      pageSize,
    };
  });

export const categoriseTransaction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      bankTransactionId: string;
      offsetAccountId: string;
      description?: string;
    }) => ({
      companyId: assertUuid(input.companyId),
      bankTransactionId: assertUuid(input.bankTransactionId),
      offsetAccountId: assertUuid(input.offsetAccountId),
      description: (input.description ?? "").trim().slice(0, 500) || undefined,
    }),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyPermission(supabase, data.companyId, "banking.categorise");
    const txn = await loadBankTxn(supabase, data.companyId, data.bankTransactionId);
    const result = await codeBankTransactionOnce(supabase, context.userId, {
      companyId: data.companyId,
      bankTransactionId: data.bankTransactionId,
      splits: [
        {
          accountId: data.offsetAccountId,
          amountMinor: Math.abs(txn.amount_minor),
          description: data.description ?? null,
        },
      ],
      treatment: "inclusive",
      memo: data.description ?? null,
    });
    return { journalId: result.journalId };
  });

export const createTransfer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      fromBankAccountId: string;
      toBankAccountId: string;
      transferDate: string;
      amountMinor: number;
      currencyCode: string;
      /** Amount received in the destination account's currency (required when the currencies differ). */
      toAmountMinor?: number | null;
      memo?: string;
    }) => {
      if (!isIsoDate(input.transferDate)) throw new Error("Transfer date must be YYYY-MM-DD");
      const amount = Math.round(Number(input.amountMinor));
      if (!Number.isSafeInteger(amount) || !(amount > 0))
        throw new Error("Transfer amount must be positive");
      const toAmount = input.toAmountMinor == null ? null : Math.round(Number(input.toAmountMinor));
      if (toAmount !== null && (!Number.isSafeInteger(toAmount) || !(toAmount > 0)))
        throw new Error("Received amount must be positive");
      return {
        toAmountMinor: toAmount,
        companyId: assertUuid(input.companyId),
        fromBankAccountId: assertUuid(input.fromBankAccountId),
        toBankAccountId: assertUuid(input.toBankAccountId),
        transferDate: input.transferDate,
        amountMinor: amount,
        currencyCode: (input.currencyCode ?? "").toUpperCase(),
        memo: (input.memo ?? "").trim().slice(0, 500) || null,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyPermission(supabase, data.companyId, "banking.categorise");
    if (data.fromBankAccountId === data.toBankAccountId) {
      throw new Error("Source and destination accounts must differ");
    }
    const from = await loadBankAccount(supabase, data.companyId, data.fromBankAccountId);
    const to = await loadBankAccount(supabase, data.companyId, data.toBankAccountId);
    if (!from.is_active || !to.is_active) throw new Error("Both bank accounts must be active");
    if (from.currency_code !== data.currencyCode) {
      throw new Error("Transfer currency must be the source account's currency");
    }
    if (from.currency_code !== to.currency_code) {
      // BK-10: two currencies, an amount on each side, and the difference posted to FX gain/loss.
      if (data.toAmountMinor === null) {
        throw new Error(`Enter the amount received in ${to.currency_code}`);
      }
      const fx = await tryRpc<{ id: string; journal_id: string }>(
        supabase,
        "create_bank_transfer_fx",
        {
          payload: {
            company_id: data.companyId,
            from_bank_account_id: data.fromBankAccountId,
            to_bank_account_id: data.toBankAccountId,
            transfer_date: data.transferDate,
            from_amount_minor: data.amountMinor,
            to_amount_minor: data.toAmountMinor,
            memo: data.memo,
          },
        },
      );
      if (!fx.available) {
        throw new Error(
          `${DB_UPDATE_MESSAGE} (create_bank_transfer_fx). Cross-currency transfers need it.`,
        );
      }
      return { id: fx.data.id, journalId: fx.data.journal_id };
    }

    // Preferred: one database transaction creates the journal and the transfer row together.
    const rpc = await tryRpc<{ id: string; journal_id: string }>(supabase, "create_bank_transfer", {
      _company_id: data.companyId,
      _from_bank_account_id: data.fromBankAccountId,
      _to_bank_account_id: data.toBankAccountId,
      _transfer_date: data.transferDate,
      _amount_minor: data.amountMinor,
      _currency_code: data.currencyCode,
      _memo: data.memo,
    });
    if (rpc.available) return { id: rpc.data.id, journalId: rpc.data.journal_id };

    // Fallback until the RPC is installed: row first (it supplies the journal's source id), then post.
    // If posting fails the row is removed so no transfer exists without a journal.
    const { data: inserted, error } = await supabase
      .from("bank_transfers" as never)
      .insert({
        company_id: data.companyId,
        from_bank_account_id: data.fromBankAccountId,
        to_bank_account_id: data.toBankAccountId,
        transfer_date: data.transferDate,
        amount_minor: data.amountMinor,
        currency_code: data.currencyCode,
        memo: data.memo,
        status: "posted",
        created_by: context.userId,
      } as never)
      .select("id" as never)
      .single();
    if (error) throw new Error(error.message);
    const transferId = (inserted as unknown as { id: string }).id;

    let journalId: string;
    try {
      journalId = await postBankTransfer(context.supabase, {
        company_id: data.companyId,
        transfer_id: transferId,
        transfer_date: data.transferDate,
        currency_code: data.currencyCode,
        from_gl_account_id: from.gl_account_id,
        to_gl_account_id: to.gl_account_id,
        amount_minor: data.amountMinor,
        ...(data.memo ? { memo: data.memo } : {}),
      });
    } catch (e) {
      await supabase
        .from("bank_transfers" as never)
        .delete()
        .eq("id" as never, transferId as never);
      throw e;
    }
    await supabase
      .from("bank_transfers" as never)
      .update({ posted_journal_id: journalId } as never)
      .eq("id" as never, transferId as never);
    return { id: transferId, journalId };
  });

export const listStatementImports = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await context.supabase
      .from("bank_statement_imports" as never)
      .select(
        "id, filename, row_count, imported_count, duplicate_count, error_count, status, error_summary, created_at, bank_account_id" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("created_at" as never, { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const voidTransfer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; transferId: string }) => ({
    companyId: assertUuid(input.companyId),
    transferId: assertUuid(input.transferId),
  }))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyPermission(supabase, data.companyId, "banking.reconcile");
    const { data: t, error } = await supabase
      .from("bank_transfers" as never)
      .select("id, status, posted_journal_id" as never)
      .eq("id" as never, data.transferId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!t) throw new Error("Transfer not found");
    const tr = t as { status: string; posted_journal_id: string | null };
    if (tr.status === "void") throw new Error("Transfer already void");
    if (!tr.posted_journal_id) throw new Error("Transfer has no journal");
    const journalId = await voidPostedDocument(
      supabase,
      tr.posted_journal_id,
      `bank_transfer:${data.transferId}:void`,
    );
    await supabase
      .from("bank_transfers" as never)
      .update({ status: "void", void_journal_id: journalId } as never)
      .eq("id" as never, data.transferId as never);
    return { journalId };
  });

export const getBankingWorkspaceCounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; bankAccountId?: string }) => ({
    companyId: assertUuid(input.companyId),
    bankAccountId: input.bankAccountId ? assertUuid(input.bankAccountId) : null,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const statuses = ["uncategorised", "matched", "reconciled", "excluded"] as const;
    const base = { uncategorised: 0, matched: 0, reconciled: 0, excluded: 0 };
    for (const status of statuses) {
      let q = context.supabase
        .from("bank_transactions" as never)
        .select("id" as never, { count: "exact", head: true })
        .eq("company_id" as never, data.companyId as never)
        .eq("status" as never, status as never);
      if (data.bankAccountId) q = q.eq("bank_account_id" as never, data.bankAccountId as never);
      const { count } = await q;
      base[status] = count ?? 0;
    }
    return {
      ...base,
      unreconciled: base.uncategorised + base.matched,
      posted: base.matched + base.reconciled,
      all: base.uncategorised + base.matched + base.reconciled + base.excluded,
    };
  });

export const excludeBankTransaction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; bankTransactionId: string; reason?: string }) => ({
    companyId: assertUuid(input.companyId),
    bankTransactionId: assertUuid(input.bankTransactionId),
    reason: (input.reason ?? "").trim().slice(0, 500) || null,
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyPermission(supabase, data.companyId, "banking.categorise");
    const txn = await loadBankTxn(supabase, data.companyId, data.bankTransactionId);
    if (txn.status === "matched" || txn.status === "reconciled") {
      throw new Error("Cannot exclude a matched or reconciled transaction. Unmatch it first.");
    }
    if (txn.status === "excluded") return { ok: true as const, already: true };
    const { error: uErr } = await supabase
      .from("bank_transactions" as never)
      .update({
        status: "excluded",
        exclude_reason: data.reason,
        excluded_at: new Date().toISOString(),
        excluded_by: context.userId,
      } as never)
      .eq("id" as never, data.bankTransactionId as never)
      .eq("company_id" as never, data.companyId as never);
    if (uErr) throw new Error(uErr.message);
    await recordAudit(supabase, {
      companyId: data.companyId,
      action: "bank_transaction.exclude",
      entityType: "bank_transaction",
      entityId: data.bankTransactionId,
      details: { reason: data.reason },
    });
    return { ok: true as const, already: false };
  });

export const restoreBankTransaction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; bankTransactionId: string }) => ({
    companyId: assertUuid(input.companyId),
    bankTransactionId: assertUuid(input.bankTransactionId),
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyPermission(supabase, data.companyId, "banking.categorise");
    const txn = await loadBankTxn(supabase, data.companyId, data.bankTransactionId);
    if (txn.status !== "excluded") throw new Error("Only excluded transactions can be restored");
    const { count } = await supabase
      .from("reconciliation_links" as never)
      .select("id" as never, { count: "exact", head: true })
      .eq("bank_transaction_id" as never, data.bankTransactionId as never);
    if ((count ?? 0) > 0) {
      throw new Error("Cannot restore: a journal link already exists for this statement line");
    }
    const { error: uErr } = await supabase
      .from("bank_transactions" as never)
      .update({
        status: "uncategorised",
        exclude_reason: null,
        excluded_at: null,
        excluded_by: null,
      } as never)
      .eq("id" as never, data.bankTransactionId as never)
      .eq("company_id" as never, data.companyId as never);
    if (uErr) throw new Error(uErr.message);
    await recordAudit(supabase, {
      companyId: data.companyId,
      action: "bank_transaction.restore",
      entityType: "bank_transaction",
      entityId: data.bankTransactionId,
    });
    return { ok: true as const };
  });

export const bulkCategoriseTransactions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      bankTransactionIds: string[];
      offsetAccountId: string;
      taxCodeId?: string | null;
      contactId?: string | null;
    }) => ({
      companyId: assertUuid(input.companyId),
      bankTransactionIds: [
        ...new Set((input.bankTransactionIds ?? []).map((id) => assertUuid(id))),
      ].slice(0, 200),
      offsetAccountId: assertUuid(input.offsetAccountId),
      taxCodeId: input.taxCodeId ? assertUuid(input.taxCodeId) : null,
      contactId: input.contactId ? assertUuid(input.contactId) : null,
    }),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyPermission(supabase, data.companyId, "banking.categorise");
    if (!data.bankTransactionIds.length) throw new Error("Select at least one transaction");

    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const id of data.bankTransactionIds) {
      try {
        const txn = await loadBankTxn(supabase, data.companyId, id);
        if (txn.status !== "uncategorised") throw new Error(`Status is ${txn.status}`);
        await codeBankTransactionOnce(supabase, context.userId, {
          companyId: data.companyId,
          bankTransactionId: id,
          splits: [
            {
              accountId: data.offsetAccountId,
              amountMinor: Math.abs(txn.amount_minor),
              taxCodeId: data.taxCodeId,
            },
          ],
          treatment: "inclusive",
          contactId: data.contactId,
        });
        results.push({ id, ok: true });
      } catch (e) {
        results.push({ id, ok: false, error: e instanceof Error ? e.message : "Failed" });
      }
    }
    return {
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  });

export const suggestBankCoding = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; bankTransactionId: string }) => ({
    companyId: assertUuid(input.companyId),
    bankTransactionId: assertUuid(input.bankTransactionId),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: txn, error } = await context.supabase
      .from("bank_transactions" as never)
      .select("id, description, amount_minor, status" as never)
      .eq("id" as never, data.bankTransactionId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!txn) throw new Error("Transaction not found");
    const t = txn as { description: string | null; amount_minor: number; status: string };

    const { data: history } = await context.supabase
      .from("bank_coding_history" as never)
      .select(
        "payee_normalized, offset_account_id, direction, times_used, accounts(code, name)" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .limit(100);
    const { data: rules } = await context.supabase
      .from("bank_rules" as never)
      .select(
        "id, name, match_field, match_pattern, match_type, offset_account_id, priority, is_active, accounts(code, name)" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .eq("is_active" as never, true as never);

    const suggestions = rankCodingSuggestions({
      description: t.description,
      amountMinor: t.amount_minor,
      history: (
        (history ?? []) as Array<{
          payee_normalized: string;
          offset_account_id: string;
          direction: "in" | "out";
          times_used: number;
          accounts: { code: string; name: string } | null;
        }>
      ).map((h) => ({
        payee_normalized: h.payee_normalized,
        offset_account_id: h.offset_account_id,
        direction: h.direction,
        times_used: h.times_used,
        account_code: h.accounts?.code ?? null,
        account_name: h.accounts?.name ?? null,
      })),
      rules: (
        (rules ?? []) as Array<{
          id: string;
          name: string;
          match_field: string;
          match_pattern: string;
          match_type: string;
          offset_account_id: string;
          priority: number;
          is_active: boolean;
          accounts: { code: string; name: string } | null;
        }>
      ).map((r) => ({
        id: r.id,
        name: r.name,
        match_field: r.match_field,
        match_pattern: r.match_pattern,
        match_type: r.match_type,
        offset_account_id: r.offset_account_id,
        priority: r.priority,
        is_active: r.is_active,
        account_code: r.accounts?.code ?? null,
        account_name: r.accounts?.name ?? null,
      })),
    });

    return {
      status: t.status,
      payeeNormalized: normalizePayee(t.description),
      externalResearchAvailable: false,
      externalResearchNote:
        "No external search/AI provider is configured. Suggestions use this organisation’s coding history and bank rules only.",
      suggestions,
    };
  });

export const listBankTransfers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyMember(supabase, data.companyId);
    const { data: rows, error } = await supabase
      .from("bank_transfers" as never)
      .select(
        "id, transfer_date, amount_minor, currency_code, memo, status, posted_journal_id, from_bank_account_id, to_bank_account_id, created_at" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("transfer_date" as never, { ascending: false })
      .order("id" as never, { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    // FX columns (BK-10) are optional until the banking migration is applied.
    const fxById = new Map<
      string,
      {
        to_amount_minor: number | null;
        to_currency_code: string | null;
        fx_difference_minor: number;
      }
    >();
    const fxRes = await supabase
      .from("bank_transfers" as never)
      .select("id, to_amount_minor, to_currency_code, fx_difference_minor" as never)
      .eq("company_id" as never, data.companyId as never)
      .order("transfer_date" as never, { ascending: false })
      .order("id" as never, { ascending: false })
      .limit(100);
    if (!fxRes.error) {
      for (const r of (fxRes.data ?? []) as unknown as Array<Record<string, unknown>>) {
        fxById.set(String(r["id"]), {
          to_amount_minor: r["to_amount_minor"] == null ? null : Number(r["to_amount_minor"]),
          to_currency_code: (r["to_currency_code"] as string | null) ?? null,
          fx_difference_minor: Number(r["fx_difference_minor"] ?? 0),
        });
      }
    } else if (!isMissingSchema(fxRes.error)) throw new Error(fxRes.error.message);
    const { data: accs } = await supabase
      .from("bank_accounts" as never)
      .select("id, name, currency_code" as never)
      .eq("company_id" as never, data.companyId as never);
    const names = new Map(
      ((accs ?? []) as unknown as Array<{ id: string; name: string; currency_code: string }>).map(
        (a) => [a.id, a],
      ),
    );
    return ((rows ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
      ...(r as unknown as BankTransferListRow),
      to_amount_minor: fxById.get(String(r["id"]))?.to_amount_minor ?? null,
      to_currency_code: fxById.get(String(r["id"]))?.to_currency_code ?? null,
      fx_difference_minor: fxById.get(String(r["id"]))?.fx_difference_minor ?? 0,
      from_name: names.get(String(r["from_bank_account_id"]))?.name ?? "Unknown account",
      to_name: names.get(String(r["to_bank_account_id"]))?.name ?? "Unknown account",
      currency_code: String(
        r["currency_code"] ?? names.get(String(r["from_bank_account_id"]))?.currency_code ?? "",
      ),
    })) as BankTransferListRow[];
  });
