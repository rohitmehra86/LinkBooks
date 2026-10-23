import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { sanitiseSearchTerm } from "@/lib/search/sanitise";

export type GlobalSearchHit = {
  id: string;
  entity: "contact" | "invoice" | "bill" | "account" | "product" | "journal";
  title: string;
  subtitle: string;
  /** Route path of the specific record (never a list page when a detail page exists). */
  href: string;
  /** Search params for the route, when the record opens inside a list page. */
  search?: Record<string, string>;
  /** Present for documents so the client can format money in the user's locale. */
  amount_minor?: number;
  currency?: string;
};

export const globalSearch = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; q: string }) => {
    const q = (input.q ?? "").trim().slice(0, 80);
    if (q.length < 2) throw new Error("Type at least 2 characters");
    return { companyId: assertUuid(input.companyId), q };
  })
  .handler(async ({ data, context }): Promise<GlobalSearchHit[]> => {
    await assertCompanyMember(context.supabase, data.companyId);
    const safe = sanitiseSearchTerm(data.q);
    if (safe.length < 2) return [];
    const like = `%${safe}%`;
    const hits: GlobalSearchHit[] = [];
    const companyId = data.companyId;
    const sb = context.supabase;

    // Contacts first: their ids let invoices and bills be found by customer / supplier name.
    const contactsRes = await sb
      .from("contacts" as never)
      .select("id, name, email, kind" as never)
      .eq("company_id" as never, companyId as never)
      .or(`name.ilike."${like}",email.ilike."${like}"` as never)
      .limit(8);
    const contacts = (contactsRes.data ?? []) as unknown as Array<{
      id: string;
      name: string;
      email: string | null;
      kind: string;
    }>;
    const contactIds = contacts.map((c) => c.id);
    const byContact = contactIds.length ? `,contact_id.in.(${contactIds.join(",")})` : "";

    const journalNumber = /^\d{1,9}$/.test(safe) ? Number(safe) : null;
    const [invoices, bills, accounts, products, journals] = await Promise.all([
      sb
        .from("sales_invoices" as never)
        .select(
          "id, invoice_number, status, total_minor, currency_code, memo, contacts(name)" as never,
        )
        .eq("company_id" as never, companyId as never)
        .or(`invoice_number.ilike."${like}",memo.ilike."${like}"${byContact}` as never)
        .order("created_at" as never, { ascending: false } as never)
        .limit(8),
      sb
        .from("purchase_bills" as never)
        .select(
          "id, bill_number, supplier_invoice_number, status, total_minor, currency_code, memo, contacts(name)" as never,
        )
        .eq("company_id" as never, companyId as never)
        .or(
          `bill_number.ilike."${like}",supplier_invoice_number.ilike."${like}",memo.ilike."${like}"${byContact}` as never,
        )
        .order("created_at" as never, { ascending: false } as never)
        .limit(8),
      sb
        .from("accounts" as never)
        .select("id, code, name, account_type" as never)
        .eq("company_id" as never, companyId as never)
        .or(`code.ilike."${like}",name.ilike."${like}"` as never)
        .limit(8),
      sb
        .from("products" as never)
        .select("id, code, name, kind" as never)
        .eq("company_id" as never, companyId as never)
        .eq("is_active" as never, true as never)
        .or(`code.ilike."${like}",name.ilike."${like}"` as never)
        .limit(8),
      sb
        .from("journals" as never)
        .select("id, journal_number, memo, journal_date, status" as never)
        .eq("company_id" as never, companyId as never)
        .eq("status" as never, "posted" as never)
        .or(
          (journalNumber !== null
            ? `memo.ilike."${like}",journal_number.eq.${journalNumber}`
            : `memo.ilike."${like}"`) as never,
        )
        .limit(8),
    ]);

    for (const r of contacts) {
      hits.push({
        id: r.id,
        entity: "contact",
        title: r.name,
        subtitle: `${r.kind}${r.email ? ` · ${r.email}` : ""}`,
        href: `/contacts/${r.id}`,
      });
    }
    for (const r of (invoices.data ?? []) as unknown as Array<{
      id: string;
      invoice_number: string | null;
      status: string;
      total_minor: number;
      currency_code: string;
      memo: string | null;
      contacts: { name: string } | null;
    }>) {
      hits.push({
        id: r.id,
        entity: "invoice",
        title: r.invoice_number ?? "Invoice (draft)",
        subtitle: [r.contacts?.name, r.status, r.memo].filter(Boolean).join(" · "),
        href: `/sales/invoices/${r.id}`,
        amount_minor: r.total_minor,
        currency: r.currency_code,
      });
    }
    for (const r of (bills.data ?? []) as unknown as Array<{
      id: string;
      bill_number: string | null;
      supplier_invoice_number: string | null;
      status: string;
      total_minor: number;
      currency_code: string;
      memo: string | null;
      contacts: { name: string } | null;
    }>) {
      hits.push({
        id: r.id,
        entity: "bill",
        title: r.supplier_invoice_number ?? r.bill_number ?? "Bill (draft)",
        subtitle: [
          r.contacts?.name,
          r.supplier_invoice_number && r.bill_number ? `ref ${r.bill_number}` : null,
          r.status,
          r.memo,
        ]
          .filter(Boolean)
          .join(" · "),
        href: `/purchases/bills/${r.id}`,
        amount_minor: r.total_minor,
        currency: r.currency_code,
      });
    }
    for (const r of (accounts.data ?? []) as unknown as Array<{
      id: string;
      code: string;
      name: string;
      account_type: string;
    }>) {
      hits.push({
        id: r.id,
        entity: "account",
        title: `${r.code} — ${r.name}`,
        subtitle: `${r.account_type} · open account transactions`,
        href: "/reports/general-ledger",
        search: { account: r.id },
      });
    }
    if (!products.error) {
      for (const r of (products.data ?? []) as unknown as Array<{
        id: string;
        code: string | null;
        name: string;
        kind: string;
      }>) {
        hits.push({
          id: r.id,
          entity: "product",
          title: r.code ? `${r.code} — ${r.name}` : r.name,
          subtitle: r.kind,
          href: "/products-services",
        });
      }
    }
    for (const r of (journals.data ?? []) as unknown as Array<{
      id: string;
      journal_number: number;
      memo: string | null;
      journal_date: string;
      status: string;
    }>) {
      hits.push({
        id: r.id,
        entity: "journal",
        title: `Journal #${r.journal_number}`,
        subtitle: `${r.journal_date}${r.memo ? ` · ${r.memo}` : ""}`,
        href: "/accounting",
        search: { tab: "journals", journal: r.id },
      });
    }

    return hits.slice(0, 40);
  });
