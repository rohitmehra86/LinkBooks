import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/states";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

export const Route = createFileRoute("/_authenticated/help")({
  head: () => ({
    meta: [
      { title: "Help — LinkBooks" },
      { name: "description", content: "Guides, answers and support for using LinkBooks." },
      { property: "og:title", content: "Help — LinkBooks" },
      { property: "og:description", content: "Guides, answers and support for using LinkBooks." },
    ],
  }),
  component: Help,
});

const faqs = [
  {
    q: "What is currently available?",
    a: "Sales, Purchases, Banking, Contacts, Accounting, Reports, Tax, Settings, Firm and AI (when configured) use the real ledger. Products & Services and Help remain shells and are labelled as such.",
  },
  {
    q: "What is Demo Company?",
    a: "A sample organisation that uses the same posting engine and permissions as live companies. Its data is fictional. Reset/reseed only affects that demo organisation.",
  },
  {
    q: "How does LinkBooks record transactions?",
    a: "Authorised documents and journals post balanced debit and credit entries through a single PostingEngine. Posted history is immutable; reverse instead of editing.",
  },
  {
    q: "Are dashboard figures real?",
    a: "Yes when they appear — they are derived from posted journal lines for the active organisation. Empty placeholders mean no ledger activity yet, not invented metrics.",
  },
];

function Help() {
  return (
    <>
      <PageHeader title="Help" description="Guides and answers about how LinkBooks works." />
      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle className="text-base">Frequently asked</CardTitle>
          <CardDescription>Short answers about the current build.</CardDescription>
        </CardHeader>
        <CardContent>
          <Accordion type="single" collapsible>
            {faqs.map((f, i) => (
              <AccordionItem key={f.q} value={`item-${i}`}>
                <AccordionTrigger className="text-left">{f.q}</AccordionTrigger>
                <AccordionContent className="text-muted-foreground">{f.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </CardContent>
      </Card>
    </>
  );
}
