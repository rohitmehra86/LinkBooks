import { createFileRoute } from "@tanstack/react-router";
import { Package } from "lucide-react";
import { PageHeader } from "@/components/common/states";
import { CompanyEmptyState } from "@/components/common/company-empty";

export const Route = createFileRoute("/_authenticated/products-services")({
  head: () => ({
    meta: [
      { title: "Products & Services — LinkBooks" },
      {
        name: "description",
        content: "Reusable items with default accounts and tax rates for invoices and bills.",
      },
      { property: "og:title", content: "Products & Services — LinkBooks" },
      {
        property: "og:description",
        content: "Reusable items with default accounts and tax rates for invoices and bills.",
      },
    ],
  }),
  component: Items,
});

function Items() {
  return (
    <>
      <PageHeader
        title="Products & Services"
        description="Catalogue items with default accounts and tax — not fully wired yet."
      />
      <CompanyEmptyState
        icon={Package}
        title="Not available yet"
        description="This module is a shell. Demo Company does not invent a separate products ledger — use invoice and bill line descriptions for now."
      />
    </>
  );
}
