import { useEffect, useState, type ReactNode } from "react";
import {
  Link,
  useNavigate,
  useRouteContext,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, LogOut, Menu, PanelLeftClose, PanelLeftOpen, UserRound } from "lucide-react";
import { NAV_GROUPS, navItems, type NavItem } from "@/lib/nav";
import { buildBreadcrumbs } from "@/lib/breadcrumbs";
import { cn } from "@/lib/utils";
import { initialsFrom } from "@/lib/auth-helpers";
import { supabase } from "@/integrations/supabase/client";
import { useActiveCompany } from "@/hooks/use-active-company";
import { CompanySwitcher } from "@/components/layout/CompanySwitcher";
import { GlobalSearch } from "@/components/layout/GlobalSearch";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { CreateNewMenu } from "@/components/create-new/CreateNewMenu";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";

const COLLAPSE_KEY = "linkbooks-sidebar-collapsed";

function UserMenu() {
  const { user } = useRouteContext({ from: "/_authenticated" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fullName = (user.user_metadata?.["full_name"] as string | undefined) ?? "";

  async function handleSignOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary outline-none transition-colors hover:bg-primary/20 focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11"
        >
          {initialsFrom(fullName, user.email)}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <div className="truncate text-sm font-medium">{fullName || "Your account"}</div>
          <div className="truncate text-xs text-muted-foreground">{user.email}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/profile">
            <UserRound className="size-4" />
            Profile
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleSignOut}>
          <LogOut className="size-4" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Brand({ collapsed }: { collapsed?: boolean }) {
  return (
    <Link
      to="/"
      aria-label="LinkBooks dashboard"
      className={cn(
        "flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        collapsed ? "justify-center" : "px-1",
      )}
    >
      <div className="grid size-8 shrink-0 place-items-center rounded-md bg-sidebar-primary text-sm font-bold text-sidebar-primary-foreground">
        LB
      </div>
      {collapsed ? null : (
        <div className="leading-tight">
          <div className="text-sm font-semibold text-sidebar-accent-foreground">LinkBooks</div>
          <div className="text-[11px] text-sidebar-foreground/70">Cloud accounting</div>
        </div>
      )}
    </Link>
  );
}

function NavLink({
  item,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  collapsed: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  const link = (
    <Link
      to={item.to}
      {...(item.to === "/settings" ? { search: { section: "overview" } } : {})}
      onClick={onNavigate}
      activeOptions={{ exact: item.to === "/" }}
      aria-label={collapsed ? item.label : undefined}
      className={cn(
        "group relative flex min-h-9 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/85 outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring pointer-coarse:min-h-11",
        collapsed && "justify-center px-0",
      )}
      activeProps={{
        className:
          "bg-sidebar-accent text-sidebar-accent-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-sidebar-primary",
      }}
    >
      <item.icon className="size-4 shrink-0" aria-hidden />
      {collapsed ? null : <span className="truncate">{item.label}</span>}
    </Link>
  );
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

function NavList({
  collapsed = false,
  onNavigate,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const main = NAV_GROUPS.filter((g) => g.id !== "footer");
  const footer = NAV_GROUPS.filter((g) => g.id === "footer");
  const renderGroup = (g: (typeof NAV_GROUPS)[number], index: number) => {
    const items = navItems.filter((n) => n.group === g.id);
    if (items.length === 0) return null;
    const headingId = `nav-group-${g.id}`;
    return (
      <div
        key={g.id}
        role="group"
        {...(g.label ? { "aria-labelledby": headingId } : {})}
        className={cn(index > 0 && "mt-4")}
      >
        {g.label ? (
          collapsed ? (
            <div className="mx-3 mb-1.5 border-t border-sidebar-border" aria-hidden />
          ) : (
            <div
              id={headingId}
              className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/55"
            >
              {g.label}
            </div>
          )
        ) : null}
        <div className="space-y-0.5">
          {items.map((item) => (
            <NavLink key={item.to} item={item} collapsed={collapsed} onNavigate={onNavigate} />
          ))}
        </div>
      </div>
    );
  };
  return (
    <TooltipProvider delayDuration={150}>
      <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col px-3 pb-3">
        <div className="min-h-0 flex-1 overflow-y-auto">{main.map(renderGroup)}</div>
        <div className="mt-2 border-t border-sidebar-border pt-3">{footer.map(renderGroup)}</div>
      </nav>
    </TooltipProvider>
  );
}

function SidebarFooter({ isDemo, collapsed }: { isDemo: boolean; collapsed?: boolean }) {
  if (collapsed) return null;
  return (
    <div className="border-t border-sidebar-border px-5 py-3 text-[11px] text-sidebar-foreground/70">
      {isDemo ? "Demo company · same posting engine as live books" : "Double-entry ledger enabled"}
    </div>
  );
}

/** Breadcrumb trail for the current route; ancestors link only when they are real routes. */
function Breadcrumbs() {
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const crumbs = buildBreadcrumbs(pathname);
  if (crumbs.length === 0) return null;
  const known = (path: string) =>
    Object.prototype.hasOwnProperty.call(router.routesByPath, path) ||
    Object.prototype.hasOwnProperty.call(router.routesByPath, `${path}/`);
  return (
    <nav aria-label="Breadcrumb" className="hidden min-w-0 lg:block">
      <ol className="flex items-center gap-1 text-sm text-muted-foreground">
        {crumbs.map((c, i) => (
          <li key={c.to} className="flex min-w-0 items-center gap-1">
            {i > 0 ? <ChevronRight className="size-3.5 shrink-0" aria-hidden /> : null}
            {!c.current && known(c.to) ? (
              <Link to={c.to as never} className="truncate rounded-sm hover:text-foreground">
                {c.label}
              </Link>
            ) : (
              <span
                className={cn("truncate", c.current && "font-medium text-foreground")}
                {...(c.current ? { "aria-current": "page" as const } : {})}
              >
                {c.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const { company, isPending } = useActiveCompany();
  const title = useRouterState({
    select: (s) => {
      const path = s.location.pathname;
      const match = navItems.find((n) => (n.to === "/" ? path === "/" : path.startsWith(n.to)));
      return match?.label ?? "LinkBooks";
    },
  });

  // Read the saved sidebar state after mount so server and first client render agree.
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* storage unavailable */
    }
  }, []);
  function toggleCollapsed() {
    setCollapsed((v) => {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, v ? "0" : "1");
      } catch {
        /* storage unavailable */
      }
      return !v;
    });
  }

  const isDemo = Boolean(company?.is_demo);

  return (
    <div className="min-h-screen bg-background">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <aside
        aria-label="Sidebar"
        className={cn(
          "fixed inset-y-0 left-0 z-40 hidden flex-col bg-sidebar transition-[width] duration-200 print:hidden lg:flex",
          collapsed ? "w-[4.5rem]" : "w-64",
        )}
      >
        <div
          className={cn(
            "flex h-14 shrink-0 items-center gap-1 px-3",
            collapsed ? "flex-col justify-center gap-0.5" : "justify-between",
          )}
        >
          <Brand collapsed={collapsed} />
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            className={cn(
              "size-8 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              collapsed && "hidden",
            )}
          >
            <PanelLeftClose className="size-4" />
          </Button>
        </div>
        {collapsed ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleCollapsed}
            aria-label="Expand sidebar"
            aria-expanded={false}
            className="mx-auto mb-2 size-8 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <PanelLeftOpen className="size-4" />
          </Button>
        ) : null}
        <CompanySwitcher collapsed={collapsed} />
        <NavList collapsed={collapsed} />
        <SidebarFooter isDemo={isDemo} collapsed={collapsed} />
      </aside>

      <div
        className={cn(
          "transition-[padding] duration-200 print:pl-0",
          collapsed ? "lg:pl-[4.5rem]" : "lg:pl-64",
        )}
      >
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-card/95 px-3 backdrop-blur print:hidden md:gap-3 md:px-6">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu">
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 border-0 bg-sidebar p-0">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <div className="flex h-full flex-col">
                <div className="flex h-14 shrink-0 items-center px-4">
                  <Brand />
                </div>
                <CompanySwitcher />
                <NavList onNavigate={() => setOpen(false)} />
                <SidebarFooter isDemo={isDemo} />
              </div>
            </SheetContent>
          </Sheet>

          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold md:hidden">{title}</div>
            <div className="flex items-center gap-4">
              <Breadcrumbs />
              <GlobalSearch className="lg:ml-auto lg:max-w-sm" />
            </div>
          </div>

          <CreateNewMenu />
          <ThemeToggle />
          <UserMenu />
        </header>

        {!isPending && isDemo ? (
          <div
            role="status"
            className="border-b border-warning/30 bg-warning-soft px-4 py-2 print:hidden md:px-6"
          >
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="warning">Demo Company</Badge>
              <span className="font-medium text-foreground">
                Sample data only — not real financial records.
              </span>
              <span className="text-muted-foreground">
                Same ledger engine and permissions as live organisations. Reset from Settings →
                Demo.
              </span>
            </div>
          </div>
        ) : null}

        <main
          id="main-content"
          tabIndex={-1}
          className={cn(
            "mx-auto w-full max-w-[1400px] px-4 py-6 outline-none md:px-6 md:py-8 print:max-w-none print:p-0",
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
