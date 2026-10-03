import type { WorkspaceRole, WorkspaceSession } from "@/components/app-shell/session-context";

/** Presentation identity only; every private request is still authorized by the server. */
export function workspaceOwnerScope(session: WorkspaceSession | undefined, role: WorkspaceRole, deployment = "same-origin") {
  if (!session?.authenticated || !session.context?.tenantId || !session.user?.id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(session.user.id) ||
    !session.user.email || session.context.actorId !== session.user.email) return "";
  return JSON.stringify([deployment, session.user.id, session.context.tenantId, session.context.actorId, role]);
}
