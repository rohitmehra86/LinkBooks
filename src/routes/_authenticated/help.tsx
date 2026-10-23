import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader, EmptyState } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GLOSSARY, HELP_ARTICLES, searchHelp } from "@/lib/help/articles";

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

function Help() {
  const [q, setQ] = useState("");
  const articles = useMemo(() => searchHelp(q), [q]);
  const topics = [...new Set(articles.map((a) => a.topic))];

  return (
    <>
      <PageHeader
        title="Help centre"
        description="Step-by-step guides for the things you do most, written for what LinkBooks does today."
      />

      <div className="mb-6 max-w-md space-y-2">
        <Label htmlFor="help-search">Search help</Label>
        <Input
          id="help-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Reconcile, invoice, tax return, shortcut…"
        />
      </div>

      {articles.length === 0 ? (
        <EmptyState title="Nothing matches" description="Try a shorter search term." />
      ) : (
        <div className="space-y-8">
          {topics.map((topic) => (
            <section key={topic} aria-labelledby={`help-${topic}`} className="space-y-3">
              <h2
                id={`help-${topic}`}
                className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {topic}
              </h2>
              <div className="grid gap-4 md:grid-cols-2">
                {articles
                  .filter((a) => a.topic === topic)
                  .map((a) => (
                    <Card key={a.id}>
                      <CardHeader>
                        <CardTitle className="text-base">{a.title}</CardTitle>
                        <CardDescription>{a.summary}</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <ol className="list-decimal space-y-1.5 pl-5 text-sm">
                          {a.steps.map((s) => (
                            <li key={s}>{s}</li>
                          ))}
                        </ol>
                        {a.link ? (
                          <Button size="sm" variant="outline" asChild>
                            <Link to={a.link.to}>{a.link.label}</Link>
                          </Button>
                        ) : null}
                      </CardContent>
                    </Card>
                  ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <Card className="mt-8 max-w-3xl">
        <CardHeader>
          <CardTitle className="text-base">Glossary</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="space-y-3 text-sm">
            {GLOSSARY.map((g) => (
              <div key={g.term}>
                <dt className="font-medium">
                  <Badge variant="secondary">{g.term}</Badge>
                </dt>
                <dd className="mt-1 text-muted-foreground">{g.meaning}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <p className="mt-6 max-w-3xl text-sm text-muted-foreground">
        Need something that is not covered here? Ask your accountant, or the administrator of your
        organisation. LinkBooks has no live chat; none is implied.
      </p>
      <p className="sr-only">{HELP_ARTICLES.length} articles</p>
    </>
  );
}
