import { buildAgentRunIdentityPinV1, buildBuiltInAgentIdentityV1, isBuiltInAgentIdentityId } from "@/lib/agents/identity-contracts";
import { resolveCustomAgentIdentityWithSql } from "@/lib/agents/identity-store";
import { getCaptureAssetForRequest } from "@/lib/capture/assets";
import { getSql, hasDatabaseUrl, runWithDatabaseActorScope } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/sql-types";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { requestSharedMemoryAccessFromSecurityContext } from "@/lib/memory/shared-context";
import { getMeeting } from "@/lib/meetings/store";
import { canonicalAuthUserActorFromSecurityContext, canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import type { SecurityContext } from "@/lib/security/types";
import { getOwnedThread } from "@/lib/threads/store";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { getGovernedTool } from "@/lib/tools/registry";
import { buildWorkflowProcedureSnapshot, listSavedProcedures, type SavedProcedure } from "@/lib/workflows/saved-procedures";
import { parseCanonicalWorkItemV1 } from "@/lib/workspaces/contracts";
import { responsibilityPinsSchema, type ResponsibilityPins, type ResponsibilityRecord, type ResponsibilitySource } from "./contracts";
import { ResponsibilityError, type ResponsibilityOwner } from "./state";
import { readOwnedResponsibilityProcedures } from "./procedure-reference";

/** Metadata-only authorization/pinning. This neither retrieves source bodies nor invokes a tool. */
export async function resolveResponsibilityPins(context: SecurityContext, owner: ResponsibilityOwner, record: ResponsibilityRecord): Promise<ResponsibilityPins> {
  const draft = record.draft;
  if (!draft.work || !draft.agentId || !draft.procedureId) throw unavailable();
  const canonical = canonicalAuthUserActorFromSecurityContext(context);
  if (owner.tenantId !== context.tenantId || owner.actorId !== (canonical?.actorId ?? context.actorId) ||
    record.tenantId !== owner.tenantId || record.actorId !== owner.actorId ||
    ((context.source === "session" || context.source === "mobile") && !canonical)) throw unavailable();
  const binding = canonicalRequestActorBindingFromSecurityContext(context);
  const readable = binding?.readableOwnerActorIds ?? [context.actorId];
  return runWithDatabaseActorScope(owner.tenantId, readable, async () => {
    const sources: ResponsibilityPins["sources"] = [];
    for (const source of draft.sources) sources.push({ source, revisionSha256: await sourceDigest(context, source) });
    const work = draft.work!;
    const rows = await getSql()`SELECT projection, projection_sha256 FROM omni_work_items
      WHERE tenant_id = ${owner.tenantId} AND workspace_id = ${work.workspaceId}
        AND project_id = ${work.projectId} AND work_item_id = ${work.workItemId}
        AND owner_actor_ids @> ${[owner.actorId]}::jsonb LIMIT 2`;
    if (rows.length !== 1) throw unavailable();
    const projected = parseCanonicalWorkItemV1(rows[0].projection);
    const projectionSha256 = canonicalJsonSha256(projected);
    if (projected.tenantId !== owner.tenantId || projected.workspaceId !== work.workspaceId || projected.projectId !== work.projectId ||
      projected.workItemId !== work.workItemId || !projected.ownerActorIds.includes(owner.actorId) || rows[0].projection_sha256 !== projectionSha256) throw unavailable();
    const privateProcedures = hasDatabaseUrl() ? await getSql().transaction((sql: SqlClient) =>
      readOwnedResponsibilityProcedures(sql, owner, { lock: false, now: new Date().toISOString() })) as readonly SavedProcedure[] : [];
    // Legacy previews remain compatible; only exact owner-private procedures
    // can later satisfy the separate runtime activation contract. Ambiguity
    // across the two read lanes still fails closed below.
    const procedures = [...await listSavedProcedures({ tenantId: owner.tenantId, actorId: context.actorId }), ...privateProcedures];
    const matches = procedures.filter((procedure) => procedure.id === draft.procedureId);
    if (matches.length !== 1) throw unavailable();
    const snapshot = buildWorkflowProcedureSnapshot(matches[0], matches[0].aliases[0]);
    const { governedToolOperationClass } = await import("@/lib/tools/executor");
    const tools = snapshot.toolBindings.map((binding) => {
      const tool = getGovernedTool(binding.toolId);
      if (!tool || tool.status !== "active" || tool.riskLevel !== 0 || tool.approvalRequired || containsDynamicInput(binding.input) || governedToolOperationClass(tool, { ...binding.input }) !== "read_only") {
        throw new ResponsibilityError("The selected procedure is not a bounded read-only procedure.", 409, "responsibility_procedure_not_read_only");
      }
      return { id: tool.id, inputSha256: canonicalJsonSha256(binding.input), contractSha256: canonicalJsonSha256(tool) };
    });
    // A preview must not ensure a personal workspace or provision an identity.
    // Built-ins are immutable code definitions; custom identities must already
    // have an active exact-owner release and principal in the read-only store.
    const agentId = draft.agentId!;
    const identity = isBuiltInAgentIdentityId(agentId)
      ? buildBuiltInAgentIdentityV1({ tenantId: owner.tenantId, controllerActorId: owner.actorId, agentId })
      : await resolveCustomAgentIdentityWithSql({ tenantId: owner.tenantId, ownerActorId: owner.actorId, agentId, sql: getSql() });
    if (identity.principal.authorityMode === "explicit_grants" && snapshot.toolBindings.some((binding) => !identity.principal.toolGrantIds.includes(binding.toolId))) {
      throw new ResponsibilityError("The selected Agent does not hold every pinned procedure Tool.", 409, "responsibility_agent_policy_changed");
    }
    const pin = buildAgentRunIdentityPinV1({ runId: record.id, identity });
    if (pin.tenantId !== owner.tenantId || pin.actorId !== owner.actorId || pin.logicalAgentId !== draft.agentId) throw unavailable();
    return responsibilityPinsSchema.parse({ sources, work: { ...work, projectionSha256 },
      procedure: { id: snapshot.id, snapshotSha256: snapshot.snapshotSha256, toolBindingsSha256: canonicalJsonSha256(tools) },
      agent: { id: pin.logicalAgentId, definitionVersionId: pin.definitionVersionId, principalVersionId: pin.principalVersionId, identityPinSha256: pin.pinSha256, policySha256: canonicalJsonSha256(pin.policyPins) } });
  });
}
async function sourceDigest(context: SecurityContext, source: ResponsibilitySource) {
  // These request readers authorize stored canonical/current-email rows, then
  // deliberately project actorId back to this exact request actor. It is not
  // the source's authored owner and must not be accepted as a new owner grant.
  const owner = { tenantId: context.tenantId, actorId: context.actorId, requestActorBinding: canonicalRequestActorBindingFromSecurityContext(context) };
  if (source.kind === "thread") {
    const thread = await getOwnedThread(source.id, owner);
    if (!thread || thread.id !== source.id || thread.tenantId !== context.tenantId || thread.actorId !== context.actorId) throw unavailable();
    return canonicalJsonSha256({ kind: source.kind, id: thread.id, updatedAt: thread.updatedAt });
  }
  if (source.kind === "capture_asset") {
    const asset = await getCaptureAssetForRequest(source.id, owner);
    if (!asset || asset.id !== source.id || asset.tenantId !== context.tenantId || asset.actorId !== context.actorId) throw unavailable();
    return canonicalJsonSha256({ kind: source.kind, id: asset.id, contentSha256: asset.contentSha256, updatedAt: asset.updatedAt, extractionStatus: asset.extractionStatus, status: asset.status });
  }
  const access = await requestSharedMemoryAccessFromSecurityContext(context, { scope: "workspace", workspaceId: source.workspaceId,
    correlationId: `responsibility-review:${source.id}`, purposeId: MEMORY_PURPOSE_IDS.read, auditPurpose: "Review selected responsibility source metadata." });
  if (access.authority.workspaceId !== source.workspaceId || access.authority.tenantId !== context.tenantId) throw unavailable();
  const meeting = await getMeeting({ tenantId: context.tenantId, workspaceId: source.workspaceId,
    canonicalActorId: access.actorBinding.canonicalActorId, readableActorIds: access.actorBinding.readableOwnerActorIds }, source.id);
  if (!meeting || meeting.meetingId !== source.id || meeting.tenantId !== context.tenantId || meeting.workspaceId !== source.workspaceId) throw unavailable();
  return meeting.meetingSha256;
}
function containsDynamicInput(value: unknown): boolean {
  if (typeof value === "string") return value.includes("{{") || value.includes("${");
  if (Array.isArray(value)) return value.some(containsDynamicInput);
  if (value && typeof value === "object") return Object.values(value).some(containsDynamicInput);
  return false;
}
function unavailable() { return new ResponsibilityError("A selected source or reference is unavailable, ambiguous, or changed.", 409, "responsibility_reference_unavailable"); }
