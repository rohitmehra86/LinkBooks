import { permissionsForRole } from "@/lib/permissions";
import {
  CREATE_ACTIONS,
  CREATE_GROUP_LABEL,
  type CreateAction,
} from "@/lib/create-new/registry";

export function actionIsRunnable(action: CreateAction, role: string | null | undefined): boolean {
  if (action.availability !== "ready") return false;
  return permissionsForRole(role).includes(action.permission);
}

export function searchCreateActions(query: string, role: string | null | undefined): CreateAction[] {
  const needle = query.trim().toLowerCase();
  return CREATE_ACTIONS.filter((action) => {
    if (!needle) return true;
    const haystack = [action.label, action.id, CREATE_GROUP_LABEL[action.group], ...action.aliases]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  }).map((action) => action);
}

export function runnableCreateActions(role: string | null | undefined): CreateAction[] {
  return CREATE_ACTIONS.filter((action) => actionIsRunnable(action, role));
}
