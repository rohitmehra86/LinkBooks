import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { LoadingState } from "@/components/common/states";

type EditSearch = { files?: boolean };

/**
 * Legacy /edit URL — drafts are now edited inline on the bill document page.
 * Keep this route so bookmarks and older links still work.
 */
export const Route = createFileRoute("/_authenticated/purchases/bills/$billId/edit")({
  validateSearch: (s: Record<string, unknown>): EditSearch => {
    const out: EditSearch = {};
    if (s["files"] === true || s["files"] === "1" || s["files"] === "true") out.files = true;
    return out;
  },
  head: () => ({ meta: [{ title: "Edit bill — LinkBooks" }] }),
  component: EditBillRedirect,
});

function EditBillRedirect() {
  const { billId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();

  useEffect(() => {
    void navigate({
      to: "/purchases/bills/$billId",
      params: { billId },
      search: search.files ? { files: true } : {},
      replace: true,
    });
  }, [billId, navigate, search.files]);

  return <LoadingState />;
}
