import { describe, expect, it } from "vitest";
import { CREATE_ACTIONS } from "@/lib/create-new/registry";
import { actionIsRunnable, runnableCreateActions, searchCreateActions } from "@/lib/create-new/menu";
import { readCreatePrefs, rememberAction, toggleFavourite, writeCreatePrefs } from "@/lib/create-new/preferences";

describe("create new registry", () => {
  it("lists the 29 specified commands once", () => {
    expect(CREATE_ACTIONS).toHaveLength(29);
    expect(new Set(CREATE_ACTIONS.map((action) => action.id)).size).toBe(29);
  });

  it("keeps verified commands runnable and holds the rest", () => {
    const blocked = CREATE_ACTIONS.filter((action) => action.availability !== "ready").map((action) => action.id);
    expect(blocked).toEqual(["project"]);
    expect(CREATE_ACTIONS.every((action) => action.component)).toBe(true);
    expect(runnableCreateActions("owner")).toHaveLength(28);
    expect(runnableCreateActions("read_only")).toHaveLength(1);
  });

  it("hides a ready action when the role lacks permission", () => {
    const invoice = CREATE_ACTIONS.find((action) => action.id === "invoice");
    expect(invoice && actionIsRunnable(invoice, "owner")).toBe(true);
    expect(invoice && actionIsRunnable(invoice, "read_only")).toBe(false);
    expect(runnableCreateActions("read_only").some((action) => action.id === "invoice")).toBe(false);
  });

  it("searches labels and aliases", () => {
    const hits = searchCreateActions("spend", "owner").map((action) => action.id);
    expect(hits).toContain("expense");
    expect(searchCreateActions("estimate", "owner").map((action) => action.id)).toContain("quote");
  });
});

describe("create new preferences", () => {
  it("stores favourites and recent actions per user", () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => memory.set(k, v),
    };
    const next = rememberAction(toggleFavourite({ favourites: [], recent: [] }, "bill"), "bill");
    writeCreatePrefs(storage, "user-1", next);
    expect(readCreatePrefs(storage, "user-1")).toEqual({ favourites: ["bill"], recent: ["bill"] });
    expect(readCreatePrefs(storage, "user-2")).toEqual({ favourites: [], recent: [] });
  });
});
