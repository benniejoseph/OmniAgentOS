import type {
  StudioProject,
  StudioProjectProfileInput,
  StudioFlow,
} from "@/lib/studio/contracts";

/** `undefined` means all flows; unassigned is a filter, never a project ID. */
export type StudioProjectScope = string | undefined;
export function validStudioId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9:_-]{1,160}$/.test(value);
}
export function readStudioProjectScope(value: unknown): StudioProjectScope {
  return validStudioId(value) && value !== "all" ? value : undefined;
}
/** Project links from Work may still contain the legacy project identity. */
export function resolveStudioProjectScope(
  scope: StudioProjectScope,
  projects: readonly StudioProject[],
): StudioProjectScope {
  if (!scope || scope === "unassigned") return scope;
  return (
    projects.find(
      (project) => project.id === scope || project.legacyProjectId === scope,
    )?.id || scope
  );
}
export function studioScopeProjectId(scope: StudioProjectScope) {
  return scope && scope !== "unassigned" ? scope : undefined;
}
export function studioScopeMatches(
  projectId: string | null | undefined,
  scope: StudioProjectScope,
) {
  return !scope || (scope === "unassigned" ? !projectId : projectId === scope);
}
export function studioScopeUrl(scope: StudioProjectScope, flowId?: string) {
  const params = new URLSearchParams();
  if (scope) params.set("project", scope);
  if (flowId) params.set("flow", flowId);
  return `/app/studio${params.size ? `?${params}` : ""}`;
}
export function studioScopeStorageKey(
  owner: string,
  scope: StudioProjectScope,
) {
  return `asael:studio-last-flow:${owner}:${scope || "all"}`;
}
export function studioCreateStorageKey(
  owner: string,
  scope: StudioProjectScope,
) {
  return `asael:studio-create:${owner}:${scope || "all"}`;
}
export function studioFlowsPath(scope: StudioProjectScope) {
  return `/api/studio/flows${scope ? `?projectId=${encodeURIComponent(scope)}` : ""}`;
}
export function readStudioProjects(value: unknown): StudioProject[] {
  if (!Array.isArray(value))
    throw new Error("Projects could not be read. Retry the list.");
  return value.map((project) => {
    if (
      !project ||
      !validStudioId(project.id) ||
      typeof project.title !== "string" ||
      (project.profile &&
        (project.profile.projectId !== project.id ||
          !Number.isInteger(project.profile.revision) ||
          project.profile.revision < 1))
    )
      throw new Error(
        "The project list is incomplete. Refresh before editing brand details.",
      );
    return project as StudioProject;
  });
}
export function studioProjectName(
  projects: readonly StudioProject[],
  projectId?: string | null,
) {
  return projectId
    ? projects.find((project) => project.id === projectId)?.title ||
        "Project unavailable"
    : "Unassigned";
}
export type StudioFlowProjectAction =
  | "duplicate"
  | "archive"
  | "apply-project-profile"
  | "assign-project";
export type PendingStudioFlowAction = {
  key: string;
  flowId: string;
  body: {
    action: StudioFlowProjectAction;
    revision: number;
    projectId?: string | null;
    retainReferences?: boolean;
  };
};
export function readPendingStudioFlowAction(
  value: unknown,
  flowId: string,
): PendingStudioFlowAction | undefined {
  const receipt = value as PendingStudioFlowAction | undefined;
  if (
    !receipt ||
    receipt.flowId !== flowId ||
    !validStudioId(receipt.key) ||
    !receipt.body ||
    ![
      "duplicate",
      "archive",
      "apply-project-profile",
      "assign-project",
    ].includes(receipt.body.action) ||
    !Number.isInteger(receipt.body.revision) ||
    receipt.body.revision < 1 ||
    (receipt.body.projectId !== undefined &&
      receipt.body.projectId !== null &&
      !validStudioId(receipt.body.projectId)) ||
    (receipt.body.retainReferences !== undefined &&
      typeof receipt.body.retainReferences !== "boolean")
  )
    return;
  return receipt;
}

/** A lost assignment receipt is the only reason an unassigned URL can load an assigned flow. */
export function resolveStudioFlowScope(
  flow: Pick<StudioFlow, "id" | "projectId" | "revision">,
  requestedScope: StudioProjectScope,
  projects: readonly StudioProject[],
  storedReceipt?: unknown,
) {
  const scope = resolveStudioProjectScope(requestedScope, projects);
  const projectId = resolveStudioProjectScope(
    flow.projectId || undefined,
    projects,
  );
  const pending = readPendingStudioFlowAction(storedReceipt, flow.id);
  const recoveringAssignment =
    scope === "unassigned" &&
    pending?.body.action === "assign-project" &&
    Boolean(pending.body.projectId) &&
    pending.body.revision < flow.revision &&
    resolveStudioProjectScope(pending.body.projectId || undefined, projects) ===
      projectId;
  if (!studioScopeMatches(projectId, scope) && !recoveringAssignment)
    throw new Error(
      "This flow belongs to another project. Return to saved flows and choose its project.",
    );
  return { scope, pending, recoveringAssignment };
}

export function studioEditableProfile(
  profile: StudioProjectProfileInput,
): StudioProjectProfileInput {
  return {
    category: profile.category,
    brandName: profile.brandName,
    audience: profile.audience,
    contentPillars: profile.contentPillars
      .map((value) => value.trim())
      .filter(Boolean),
    voice: profile.voice,
    visualStyle: profile.visualStyle,
    guidelines: profile.guidelines,
    channels: profile.channels.map(({ platform, handle, url }) => ({
      platform,
      handle,
      ...(url ? { url } : {}),
    })),
  };
}
