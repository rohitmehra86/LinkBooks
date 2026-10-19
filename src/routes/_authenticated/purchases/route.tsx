import { createFileRoute, Outlet } from "@tanstack/react-router";
import { PurchasesSubnav } from "@/components/purchases/PurchasesSubnav";

export const Route = createFileRoute("/_authenticated/purchases")({
  component: PurchasesLayout,
});

function PurchasesLayout() {
  return (
    <div>
      <PurchasesSubnav />
      <Outlet />
    </div>
  );
}
