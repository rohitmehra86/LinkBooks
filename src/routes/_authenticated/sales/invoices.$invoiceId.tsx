import { createFileRoute, Outlet } from "@tanstack/react-router";

// Layout route: the detail page lives in the index route so child routes (edit) can render.
export const Route = createFileRoute("/_authenticated/sales/invoices/$invoiceId")({
  component: () => <Outlet />,
});
