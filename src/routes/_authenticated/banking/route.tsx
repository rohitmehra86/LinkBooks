import { createFileRoute, Outlet } from "@tanstack/react-router";
import { BankingSubnav } from "@/components/banking/BankingSubnav";

export const Route = createFileRoute("/_authenticated/banking")({
  component: BankingLayout,
});

function BankingLayout() {
  return (
    <div>
      <BankingSubnav />
      <Outlet />
    </div>
  );
}
