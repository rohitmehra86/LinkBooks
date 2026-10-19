import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";

export type GlobalSearchHit = {
  id: string;
  entity: "contact" | "invoice" | "bill" | "account" | "product" | "journal";
  title: string;
  subtitle: string;
  href: string;
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
    const safe = data.q.replace(/[%_,]/g, " ").trim();
    const like = `%${safe}%`;
    const hits: GlobalSearchHit[] = [];
    const companyId = data.companyId;

    const [contacts, invoices, bills, accounts, products, journals] = await Promise.all([
      context.supabase
        .from("contacts" as never)
        .select("id, name, email, kind" as never)
        .eq("company_id" as never, companyId as never)
        .or(`name.ilike."${like}",email.ilike."${like}"` as never)
        .limit(8),
      context.supabase
        .from("sales_invoices" as never)
        .select("id, invoice_number, status, total_minor, memo" as never)
        .eq("company_id" as never, companyId as never)
        .or(`invoice_number.ilike."${like}",memo.ilike."${like}"` as never)
        .limit(8),
      context.supabase
        .from("purchase_bills" as never)
        .select("id, bill_number, status, total_minor, memo" as never)
        .eq("company_id" as never, companyId as never)
        .or(`bill_number.ilike."${like}",memo.ilike."${like}"` as never)
        .limit(8),
      context.supabase
        .from("accounts" as never)
        .select("id, code, name, account_type" as never)
        .eq("company_id" as never, companyId as never)
        .or(`code.ilike."${like}",name.ilike."${like}"` as never)
        .limit(8),
      context.supabase
        .from("products" as never)
        .select("id, code, name, kind" as never)
        .eq("company_id" as never, companyId as never)
        .eq("is_active" as never, true as never)
        .or(`code.ilike."${like}",name.ilike."${like}"` as never)
        .limit(8),
      context.supabase
        .from("journals" as never)
        .select("id, journal_number, memo, journal_date, status" as never)
        .eq("company_id" as never, companyId as never)
        .eq("status" as never, "posted" as never)
        .ilike("memo" as never, like as never)
        .limit(8),
    ]);

    for (const r of (contacts.data ?? []) as Array<{
      id: string;
      name: string;
      email: string | null;
      kind: string;
    }>) {
      hits.push({
        id: r.id,
        entity: "contact",
        title: r.name,
        subtitle: `${r.kind}${r.email ? ` · ${r.email}` : ""}`,
        href: `/contacts/${r.id}`,
      });
    }
    for (const r of (invoices.data ?? []) as Array<{
      id: string;
      invoice_number: string | null;
      status: string;
      total_minor: number;
      memo: string | null;
    }>) {
      hits.push({
        id: r.id,
        entity: "invoice",
        title: r.invoice_number ?? "Invoice",
        subtitle: `${r.status} · ${(r.total_minor / 100).toFixed(2)}${r.memo ? ` · ${r.memo}` : ""}`,
        href: `/sales/invoices/${r.id}`,
      });
    }
    for (const r of (bills.data ?? []) as Array<{
      id: string;
      bill_number: string | null;
      status: string;
      total_minor: number;
      memo: string | null;
    }>) {
      hits.push({
        id: r.id,
        entity: "bill",
        title: r.bill_number ?? "Bill",
        subtitle: `${r.status} · ${(r.total_minor / 100).toFixed(2)}${r.memo ? ` · ${r.memo}` : ""}`,
        href: `/purchases/bills/${r.id}`,
      });
    }
    for (const r of (accounts.data ?? []) as Array<{
      id: string;
      code: string;
      name: string;
      account_type: string;
    }>) {
      hits.push({
        id: r.id,
        entity: "account",
        title: `${r.code} — ${r.name}`,
        subtitle: r.account_type,
        href: `/accounting`,
      });
    }
    if (!products.error) {
      for (const r of (products.data ?? []) as Array<{
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
          href: `/products-services`,
        });
      }
    }
    for (const r of (journals.data ?? []) as Array<{
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
        href: `/accounting`,
      });
    }

    return hits.slice(0, 40);
  });
