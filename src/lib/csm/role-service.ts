import "server-only";

import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { showWorkspaceLibraryItemService } from "@/lib/app-services/library";
import type { WorkspaceLibraryItem } from "@/lib/library/contracts";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { canPerform, redactSensitive } from "@/lib/security/context";
import { CsmError, csmSourceDeleteSchema, csmSourceWriteSchema, type CsmSourceLink } from "./contracts";
import { CSM_ROLE_CONTEXT_LIMITS, csmRoleWriteSchema, type CsmRoleSnapshot } from "./role-contracts";
import { csmRoleAccess, readCsmRoleContext, writeCsmRoleContext } from "./role-store";
import { resolveCsmSources } from "./service";

const readContract = { operation: "app.csm.role.show", action: "read", resourceType: "memory", accessMode: "read" as const, eventContract: "app_service.read" };
const writeContract = { operation: "app.csm.role.write", action: "write.memory", resourceType: "memory", accessMode: "mutation" as const, eventContract: "csm.role_context.saved" };

export async function showCsmRoleContext(caller: AppServiceCaller) {
  const authorized = authorizeAppServiceCall(caller, readContract);
  const stored = await readCsmRoleContext(csmRoleAccess(caller));
  const resolved = await resolveCsmRoleSources(caller, stored?.snapshot.sourceLinks || []);
  return completeAppServiceCall(authorized, {
    schemaVersion: 1 as const, text: stored?.snapshot.text || "", revision: stored?.revision || null,
    sources: resolved.flatMap((entry) => entry.item ? [entry.item] : []),
    sourceLinks: resolved.map(({ link, status }) => ({ ...link, status })),
    context: { scope: "user" as const, canWrite: canPerform(caller.context.role, "write.memory") },
    limits: CSM_ROLE_CONTEXT_LIMITS,
  });
}

export async function saveCsmRoleText(caller: AppServiceCaller, body: unknown) {
  const input = csmRoleWriteSchema.parse(body);
  const text = String(redactSensitive(input.text));
  return mutate(caller, input.expectedRevision, { operation: "text", text }, (current) => ({
    ...emptySnapshot(), ...current, text,
  }));
}

export async function linkCsmRoleSource(caller: AppServiceCaller, body: unknown) {
  const input = csmSourceWriteSchema.parse(body);
  const item = (await showWorkspaceLibraryItemService(caller, { libraryItemId: input.libraryItemId })).data.item;
  if (!item) throw new CsmError("The selected source is no longer available.", 404);
  if (!roleSourceAllowed(caller, item)) {
    throw new CsmError("Role sources must be your private files without a client, workspace or mission scope. Link client material within its client instead.", 409);
  }
  if ((input.versionId && input.versionId !== item.currentVersion.versionId) ||
      (input.contentSha256 && input.contentSha256 !== item.currentVersion.contentSha256)) {
    throw new CsmError("The source changed. Select its current Library version again.", 409);
  }
  const link = { libraryItemId: item.id, versionId: item.currentVersion.versionId, contentSha256: item.currentVersion.contentSha256 };
  return mutate(caller, input.expectedRevision, { operation: "link", input }, (current) => {
    const snapshot = current || emptySnapshot();
    const sourceLinks = [...snapshot.sourceLinks.filter((source) => source.libraryItemId !== link.libraryItemId), link];
    if (sourceLinks.length > CSM_ROLE_CONTEXT_LIMITS.sourceCount) throw new CsmError("Your role context can have up to 50 linked sources.", 409);
    return { ...snapshot, sourceLinks };
  });
}

export async function unlinkCsmRoleSource(caller: AppServiceCaller, body: unknown) {
  const input = csmSourceDeleteSchema.parse(body);
  return mutate(caller, input.expectedRevision, { operation: "unlink", libraryItemId: input.libraryItemId }, (current) => {
    if (!current) throw new CsmError("Role context was not found.", 404);
    return { ...current, sourceLinks: current.sourceLinks.filter((source) => source.libraryItemId !== input.libraryItemId) };
  });
}

export async function resolveCsmRoleSources(caller: AppServiceCaller, links: readonly CsmSourceLink[]) {
  return (await resolveCsmSources(caller, links)).map((entry) => entry.item && !roleSourceAllowed(caller, entry.item)
    ? { ...entry, item: null, status: "unavailable" as const }
    : entry);
}

function roleSourceAllowed(caller: AppServiceCaller, item: WorkspaceLibraryItem) {
  const binding = canonicalRequestActorBindingFromSecurityContext(caller.context);
  return item.tenantId === caller.context.tenantId &&
    Boolean(binding?.readableOwnerActorIds.includes(item.scope.ownerActorId)) &&
    item.scope.visibility === "user_private" && item.scope.permissionBasis === "owner" &&
    item.scope.workspaceId === null && item.scope.projectId === null && item.scope.missionId === null &&
    item.scope.workItemId === null;
}

async function mutate(caller: AppServiceCaller, expectedRevision: string | null,
  intent: unknown, change: (current: CsmRoleSnapshot | null) => CsmRoleSnapshot) {
  const authorized = authorizeAppServiceCall(caller, writeContract);
  const accepted = await writeCsmRoleContext({ caller, access: csmRoleAccess(caller, true), expectedRevision, intent, change });
  const current = await showCsmRoleContext(caller);
  return completeAppServiceCall(authorized, { ...current.data, acceptedRevision: accepted.revision });
}

function emptySnapshot(): CsmRoleSnapshot {
  return { schemaVersion: 1, kind: "csm_role_context", text: "", sourceLinks: [], requestSha256: "0".repeat(64) };
}
