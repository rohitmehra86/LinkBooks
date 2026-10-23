import type { ReactNode } from "react";

/** Card frame for a data table: rounded border, clipped corners, no double borders. */
export function TableCard({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-xl border bg-card shadow-card">{children}</div>;
}
