import { useState, type ReactNode } from "react";
import { Link, useNavigate, useRouteContext, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Menu, Bell, LogOut, UserRound } from "lucide-react";
import { navItems } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { initialsFrom } from "@/lib/auth-helpers";
import { supabase } from "@/integrations/supabase/client";
import { useActiveCompany } from "@/hooks/use-active-company";
import { CompanySwitcher } from "@/components/layout/CompanySwitcher";
import { GlobalSearch } from "@/components/layout/GlobalSearch";
import { CreateNewMenu } from "@/components/create-new/CreateNewMenu";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";

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
          className="grid size-9 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground outline-none ring-ring focus-visible:ring-2"
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

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-5 py-5">
      <div className="grid size-8 place-items-center rounded-md bg-sidebar-primary text-sm font-bold text-sidebar-primary-foreground">
        LB
      </div>
      <div className="leading-tight">
        <div className="text-sm font-semibold text-sidebar-accent-foreground">LinkBooks</div>
        <div className="text-[11px] text-sidebar-foreground/70">Cloud accounting</div>
      </div>
    </div>
  );
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-6">
      {navItems.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          {...(item.to === "/settings" ? { search: { section: "overview" } } : {})}
          onClick={onNavigate}
          activeOptions={{ exact: item.to === "/" }}
          className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          activeProps={{
            className:
              "bg-sidebar-accent text-sidebar-accent-foreground shadow-[inset_2px_0_0_var(--sidebar-primary)]",
          }}
        >
          <item.icon className="size-4 shrink-0" />
          <span className="truncate">{item.label}</span>
        </Link>
      ))}
    </nav>
  );
}

function SidebarFooter({ isDemo }: { isDemo: boolean }) {
  return (
    <div className="border-t border-sidebar-border px-5 py-4 text-[11px] text-sidebar-foreground/70">
      {isDemo ? "Demo company · same posting engine as live books" : "Double-entry ledger enabled"}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { company, isPending } = useActiveCompany();
  const title = useRouterState({
    select: (s) => {
      const path = s.location.pathname;
      const match = navItems.find((n) => (n.to === "/" ? path === "/" : path.startsWith(n.to)));
      return match?.label ?? "LinkBooks";
    },
  });

  const isDemo = Boolean(company?.is_demo);

  return (
    <div className="min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col bg-sidebar lg:flex">
        <Brand />
        <NavList />
        <SidebarFooter isDemo={isDemo} />
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-card/95 px-4 backdrop-blur md:px-6">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu">
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 border-0 bg-sidebar p-0">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <div className="flex h-full flex-col">
                <Brand />
                <NavList onNavigate={() => setOpen(false)} />
                <SidebarFooter isDemo={isDemo} />
              </div>
            </SheetContent>
          </Sheet>

          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold md:hidden">{title}</div>
            <GlobalSearch />
          </div>

          <CompanySwitcher />

          <CreateNewMenu />

          <Button variant="ghost" size="icon" aria-label="Notifications" disabled title="Notifications arrive later">
            <Bell className="size-5" />
          </Button>

          <UserMenu />
        </header>

        {!isPending && isDemo ? (
          <div
            role="status"
            className="border-b border-warning/30 bg-warning/15 px-4 py-2.5 md:px-6"
          >
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge className="bg-warning text-warning-foreground hover:bg-warning">
                Demo Company
              </Badge>
              <span className="font-medium text-foreground">
                Sample data only — not real financial records.
              </span>
              <span className="text-muted-foreground">
                Same ledger engine and permissions as live organisations. Reset from Settings → Demo.
              </span>
            </div>
          </div>
        ) : null}

        <main className={cn("mx-auto w-full max-w-[1400px] px-4 py-6 md:px-6 md:py-8")}>
          {children}
        </main>
      </div>
    </div>
  );
}
