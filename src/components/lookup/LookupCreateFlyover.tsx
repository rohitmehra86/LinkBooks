"use client";

import type { ReactNode } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { DuplicateMatch } from "@/lib/lookup/types";
import { cn } from "@/lib/utils";

export function LookupCreateFlyover({
  open,
  title,
  description,
  duplicates,
  stack = 1,
  onOpenChange,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  duplicates?: DuplicateMatch[];
  /** Higher values sit above an already-open flyover. */
  stack?: number;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={cn("w-full overflow-y-auto sm:max-w-xl", stack > 0 && "z-[70]")}
        style={{ zIndex: 60 + stack * 10 }}
      >
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description ? <SheetDescription>{description}</SheetDescription> : null}
        </SheetHeader>
        {duplicates && duplicates.length > 0 ? (
          <div className="mt-4 rounded-md border bg-muted/40 p-3 text-sm" role="status">
            <p className="font-medium">Possible duplicate</p>
            <ul className="mt-1 space-y-1 text-muted-foreground">
              {duplicates.map((match) => (
                <li key={match.option.id}>
                  {match.option.label}
                  {match.exact ? " — exact match" : " — similar record"}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              Saving still goes through the organisation&apos;s normal checks.
            </p>
          </div>
        ) : null}
        <div className="mt-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
