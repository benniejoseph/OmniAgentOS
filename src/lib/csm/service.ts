import "server-only";

import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { showWorkspaceLibraryItemService } from "@/lib/app-services/library";
import { listProjectsService, showProjectService } from "@/lib/app-services/projects";
import type { WorkspaceLibraryItem } from "@/lib/library/contracts";
import { redactSensitive } from "@/lib/security/context";
import { CsmError, clientProfileSchema, csmProfileWriteSchema, csmSourceDeleteSchema, csmSourceWriteSchema, type CsmSnapshot, type CsmSourceLink } from "./contracts";
import { csmProjectAccess, readCsmContext, writeCsmContext, type CsmStoredContext } from "./store";

const readContract = { operation: "app.csm.context.show", action: "read", resourceType: "project", accessMode: "read" as const, eventContract: "app_service.read" };
const writeContract = { operation: "app.csm.context.write", action: "write.memory", resourceType: "shared_memory", accessMode: "mutation" as const, eventContract: "csm.context.saved" };

export async function listCsmClients(caller: AppServiceCaller) {
  const authorized = authorizeAppServiceCall(caller, readContract);
  const result = await listProjectsService(caller, { limit: 100 });
  const clients = [];
  for (let offset = 0; offset < result.data.projects.length; offset += 5) {
    const batch = await Promise.all(result.data.projects.slice(offset, offset + 5).map(async (project) => {
      const access = await csmProjectAccess(caller, project.id);
      const stored = await readCsmContext(access);
      return stored ? { project, profile: stored.snapshot.profile, sourceCount: stored.snapshot.sourceLinks.length, revision: stored.revision } : null;
    }));
    clients.push(...batch.filter((client) => client !== null));
  }
  return completeAppServiceCall(authorized, { clients, truncated: result.data.projects.length === 100 }, { resourceCount: clients.length });
}

export async function showCsmProject(caller: AppServiceCaller, projectId: string) {
  const authorized = authorizeAppServiceCall(caller, readContract);
  const { project, access } = await requireProject(caller, projectId);
  const stored = await readCsmContext(access);
  const resolved = await resolveCsmSources(caller, stored?.snapshot.sourceLinks || []);
  return completeAppServiceCall(authorized, {
    project, profile: stored?.snapshot.profile || null,
    revision: stored?.revision || null,
    sources: resolved.flatMap((entry) => entry.item ? [entry.item] : []),
    sourceLinks: resolved.map(({ link, status }) => ({ ...link, status })),
    context: { scope: "project" as const, projectId, workspaceId: access.authority.workspaceId,
      accessLevel: access.authority.accessLevel, canWrite: access.authority.canWrite,
      authoritySha256: access.authority.authoritySha256 },
  });
}

export async function saveCsmProfile(caller: AppServiceCaller, projectId: string, body: unknown) {
  const input = csmProfileWriteSchema.parse(body);
  const profile = clientProfileSchema.parse(redactSensitive(input.profile));
  return mutate(caller, projectId, input.expectedRevision, { operation: "profile", profile }, (current) => ({
    ...emptySnapshot(projectId), ...current, profile,
  }));
}

export async function linkCsmSource(caller: AppServiceCaller, projectId: string, body: unknown) {
  const input = csmSourceWriteSchema.parse(body);
  // Resolve current ownership and exact current source/grant state, never trust
  // a browser-supplied title, path, actor, scope or permission assertion.
  const file = (await showWorkspaceLibraryItemService(caller, { libraryItemId: input.libraryItemId })).data.item;
  if (!file) throw new CsmError("The selected source is no longer available.", 404);
  if ((input.versionId && input.versionId !== file.currentVersion.versionId) ||
      (input.contentSha256 && input.contentSha256 !== file.currentVersion.contentSha256)) {
    throw new CsmError("The source changed. Select its current Library version again.", 409);
  }
  const link = { libraryItemId: file.id, versionId: file.currentVersion.versionId, contentSha256: file.currentVersion.contentSha256 };
  return mutate(caller, projectId, input.expectedRevision, { operation: "link", input }, (current) => {
    if (!current) throw new CsmError("Save the client brief before linking sources.", 409);
    const sourceLinks = [...current.sourceLinks.filter((item) => item.libraryItemId !== link.libraryItemId), link];
    if (sourceLinks.length > 50) throw new CsmError("A client can have up to 50 linked sources.", 409);
    return { ...current, sourceLinks };
  });
}

export async function unlinkCsmSource(caller: AppServiceCaller, projectId: string, body: unknown) {
  const input = csmSourceDeleteSchema.parse(body);
  return mutate(caller, projectId, input.expectedRevision, { operation: "unlink", libraryItemId: input.libraryItemId }, (current) => {
    if (!current) throw new CsmError("Client context was not found.", 404);
    return { ...current, sourceLinks: current.sourceLinks.filter((link) => link.libraryItemId !== input.libraryItemId) };
  });
}

export type ResolvedCsmSource = {
  link: CsmSourceLink;
  item: WorkspaceLibraryItem | null;
  status: "current" | "processing" | "changed" | "unavailable";
};

export async function resolveCsmSources(caller: AppServiceCaller, links: readonly CsmSourceLink[]): Promise<ResolvedCsmSource[]> {
  const resolved: ResolvedCsmSource[] = [];
  for (let offset = 0; offset < links.length; offset += 5) {
    resolved.push(...await Promise.all(links.slice(offset, offset + 5).map(async (link): Promise<ResolvedCsmSource> => {
      const item = (await showWorkspaceLibraryItemService(caller, { libraryItemId: link.libraryItemId })).data.item;
      const status = !item ? "unavailable" :
        item.currentVersion.versionId !== link.versionId || item.currentVersion.contentSha256 !== link.contentSha256 ? "changed" :
        item.status === "processing" ? "processing" : item.status === "ready" ? "current" : "unavailable";
      return { link, item, status };
    })));
  }
  return resolved;
}

async function mutate(caller: AppServiceCaller, projectId: string, expectedRevision: string | null,
  intent: unknown, change: (current: CsmSnapshot | null) => CsmSnapshot) {
  const authorized = authorizeAppServiceCall(caller, writeContract);
  const { access } = await requireProject(caller, projectId, true);
  const accepted: CsmStoredContext = await writeCsmContext({ caller, access, projectId, expectedRevision, intent, change });
  // Return the current authorized view, even when the accepted intent is a replay
  // of an older revision, so replaying a request cannot roll the UI backwards.
  const detail = await showCsmProject(caller, projectId);
  return completeAppServiceCall(authorized, { ...detail.data, acceptedRevision: accepted.revision });
}

async function requireProject(caller: AppServiceCaller, projectId: string, write = false) {
  const result = await showProjectService(caller, { projectId, taskLimit: 200, artifactLimit: 200 });
  if (!result.data.project) throw new CsmError("Project not found.", 404);
  if (write && result.data.project.status === "archived") throw new CsmError("Archived client work is read-only.", 409);
  const access = await csmProjectAccess(caller, projectId, write);
  return { project: result.data.project, access };
}

function emptySnapshot(projectId: string): CsmSnapshot {
  return { schemaVersion: 1, kind: "csm_project_context", projectId, profile: clientProfileSchema.parse({}), sourceLinks: [], requestSha256: "0".repeat(64) };
}
