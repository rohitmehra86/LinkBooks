import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SalesSubnav } from "@/components/sales/SalesSubnav";

export const Route = createFileRoute("/_authenticated/sales")({
  component: SalesLayout,
});

function SalesLayout() {
  return (
    <div>
      <SalesSubnav />
      <Outlet />
    </div>
  );
}
