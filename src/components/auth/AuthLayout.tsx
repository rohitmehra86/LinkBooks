import type { ReactNode } from "react";
import { BookCheck, Landmark, LockKeyhole, ShieldCheck } from "lucide-react";

/**
 * What LinkBooks actually does today, stated plainly. Keep every line verifiable in the product:
 * no customer counts, testimonials, certifications or uptime claims.
 */
const POINTS = [
  {
    icon: BookCheck,
    title: "Double-entry, always balanced",
    body: "Every invoice, bill and payment posts to a ledger that must balance before it saves.",
  },
  {
    icon: Landmark,
    title: "Bank feeds you can reconcile",
    body: "Import statements, match them to your books and keep an audit trail of each session.",
  },
  {
    icon: LockKeyhole,
    title: "Your organisation's data stays yours",
    body: "Access is enforced per organisation in the database, not just in the screen you see.",
  },
  {
    icon: ShieldCheck,
    title: "Locked periods, protected history",
    body: "Close a period and posted journals can't be quietly edited afterwards.",
  },
];

function Logo({ onDark }: { onDark?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <div
        className={
          onDark
            ? "grid size-9 place-items-center rounded-md bg-sidebar-primary text-sm font-bold text-sidebar-primary-foreground"
            : "grid size-9 place-items-center rounded-md bg-primary text-sm font-bold text-primary-foreground"
        }
      >
        LB
      </div>
      <div className="leading-tight">
        <div
          className={
            onDark
              ? "text-sm font-semibold text-sidebar-accent-foreground"
              : "text-sm font-semibold"
          }
        >
          LinkBooks
        </div>
        <div
          className={
            onDark ? "text-[11px] text-sidebar-foreground/70" : "text-[11px] text-muted-foreground"
          }
        >
          Cloud accounting
        </div>
      </div>
    </div>
  );
}

export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string | undefined;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-sidebar p-10 text-sidebar-foreground lg:flex xl:p-14">
        {/* Soft brand glow; decorative only. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 size-96 rounded-full bg-sidebar-primary/15 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-32 -left-16 size-80 rounded-full bg-sidebar-primary/10 blur-3xl"
        />
        <div className="relative">
          <Logo onDark />
        </div>

        <div className="relative max-w-md space-y-8">
          <div className="space-y-3">
            <h2 className="text-3xl font-semibold leading-tight tracking-tight text-sidebar-accent-foreground">
              Accounting records you can trust.
            </h2>
            <p className="text-sm leading-relaxed text-sidebar-foreground/80">
              Bookkeeping, bank reconciliation and financial reporting for small businesses and the
              accountants who look after them.
            </p>
          </div>
          <ul className="space-y-5">
            {POINTS.map((p) => (
              <li key={p.title} className="flex gap-3.5">
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-sidebar-accent text-sidebar-primary">
                  <p.icon className="size-4" aria-hidden />
                </span>
                <div>
                  <div className="text-sm font-medium text-sidebar-accent-foreground">
                    {p.title}
                  </div>
                  <div className="text-sm leading-relaxed text-sidebar-foreground/70">{p.body}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-sidebar-foreground/60">
          © {new Date().getFullYear()} LinkBooks
        </p>
      </aside>

      <main className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <Logo />
          </div>

          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle ? <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p> : null}

          <div className="mt-7">{children}</div>

          {footer ? <div className="mt-6 text-sm text-muted-foreground">{footer}</div> : null}
        </div>
      </main>
    </div>
  );
}
