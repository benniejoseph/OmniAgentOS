import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseActorScope, runWithManagedDatabaseTransaction } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { assertMoltbookAgentMayBeDeleted } from "@/lib/moltbook/store";
import { redactSensitive } from "@/lib/security/context";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { createAgentSkill, deleteAgentSkill, deleteCustomAgent, getAgentSkill, getCustomAgent, updateAgentSkill } from "@/lib/skills/store";
import { AgentSkillNativeError, agentSkillNativeAcceptanceId, agentSkillNativeAcceptanceSchema, agentSkillNativeIdSchema,
  agentSkillNativeIntentSchema, agentSkillNativeReviewSchema, agentSkillNativeScopeSchema, buildAgentSkillNativeAcceptance,
  buildAgentSkillNativeIntent, nativeAgentRecordSchema, nativeSkillInputSchema, nativeSkillRecordSchema,
  type AgentSkillNativeAcceptance, type AgentSkillNativeIntent, type AgentSkillNativeRequest, type AgentSkillNativeReview,
  type AgentSkillNativeScope } from "@/lib/skills/native-mutation-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { compensationForSnapshot } from "@/lib/trash/resources";
import { createTrashEntry, createTrashPreview, getTrashLifecycleResultByPreview } from "@/lib/trash/store";

type Sql = ReturnType<typeof getSql>;
export type AgentSkillNativeAuthority = { scope: AgentSkillNativeScope; executionScope?: ExecutionScope };
function fail(message: string, code = "agent_skill_mutation_conflict", status = 409): never { throw new AgentSkillNativeError(code, status, message); }
const same = (a: unknown, b: unknown) => canonicalJsonSha256(a) === canonicalJsonSha256(b);
const owner = (scope: AgentSkillNativeScope) => ({ tenantId: scope.tenantId, actorId: scope.ownerActorId });
const purposes = { "agent.delete": "agent.move_to_trash", "skill.create": "skill.create", "skill.update": "skill.update", "skill.delete": "skill.move_to_trash" } as const;
async function ready(authority: AgentSkillNativeAuthority) {
  agentSkillNativeScopeSchema.parse(authority.scope);
  if (!hasDatabaseUrl()) fail("Native catalog mutations require the canonical database.", "agent_skill_database_required", 503);
  await ensureDatabaseSchema();
}
async function currentIdentity(sql: Sql, scope: AgentSkillNativeScope, management = false) {
  const [row] = await sql`SELECT public.omni_native_private_memory_owner_v1(
    ${scope.tenantId},${scope.ownerActorId},${scope.canonicalActorId},${management}) AS allowed`;
  if (row?.allowed !== true) fail("Current exact catalog owner could not be verified.", "agent_skill_owner_unavailable", 403);
}
function assertMutation(authority: AgentSkillNativeAuthority, intent: AgentSkillNativeIntent): ExecutionScope {
  const value = authority.executionScope, scope = authority.scope;
  if (!value || value.tenantId !== scope.tenantId || value.initiatingActorId !== scope.ownerActorId ||
    value.executingPrincipalType !== "user" || value.executingPrincipalId !== scope.ownerActorId || value.workspaceId !== null ||
    value.projectId !== null || value.missionId !== null || value.delegationId !== null || value.contextGrantIds.length || value.capabilityGrantIds.length ||
    value.purpose !== purposes[intent.operation] || value.causationId !== (intent.resourceId ?? "skills:create")) {
    fail("Exact current catalog mutation authority is required.", "agent_skill_authority_invalid", 403);
  }
  return value;
}
function inScope<T>(scope: AgentSkillNativeScope, operation: () => Promise<T>) {
  return runWithDatabaseActorScope(scope.tenantId, [...new Set([scope.ownerActorId, scope.canonicalActorId])], operation);
}
async function receipt(sql: Sql, scope: AgentSkillNativeScope, keySha256: string) {
  const rows = await sql`SELECT intent, acceptance FROM omni_agent_skill_native_mutations
    WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.ownerActorId}
      AND canonical_actor_id = ${scope.canonicalActorId} AND idempotency_key_sha256 = ${keySha256} LIMIT 2`;
  if (!rows.length) return null;
  if (rows.length !== 1) fail("Native acceptance ownership is ambiguous.");
  const intent = agentSkillNativeIntentSchema.parse(rows[0].intent), acceptance = agentSkillNativeAcceptanceSchema.parse(rows[0].acceptance);
  if (!same(intent.scope, scope) || !same(acceptance.scope, scope) || intent.keySha256 !== keySha256 || acceptance.keySha256 !== keySha256 ||
    acceptance.operation !== intent.operation || acceptance.requestSha256 !== canonicalJsonSha256(intent) ||
    (intent.resourceId !== null && intent.resourceId !== acceptance.resourceId)) fail("Stored acceptance does not bind its exact immutable intent.");
  const request = intent.request;
  if (request.contract !== "asael-skill-create:1" && (acceptance.reviewSha256 !== canonicalJsonSha256(request.review) ||
    acceptance.beforeResourceSha256 !== request.review.resourceSha256 || acceptance.beforeVersion !== request.review.resourceVersion ||
    (request.contract === "asael-agent-skill-delete:1" && acceptance.trash?.previewSha256 !== request.preview.previewSha256))) fail("Stored reviewed acceptance is inconsistent.");
  return { intent, acceptance };
}
export async function readAgentSkillNativeAcceptance(authority: AgentSkillNativeAuthority,
  input: { keySha256: string; resourceType: "custom_agent" | "agent_skill" }): Promise<AgentSkillNativeAcceptance | null> {
  await ready(authority);
  if (authority.executionScope || !/^[a-f0-9]{64}$/.test(input.keySha256)) fail("Exact read authority and key are required.", "agent_skill_read_invalid", 400);
  return inScope(authority.scope, async () => {
    const sql = getSql(); await currentIdentity(sql, authority.scope);
    const found = await receipt(sql, authority.scope, input.keySha256);
    return found?.acceptance.resourceType === input.resourceType ? found.acceptance : null;
  });
}

async function lockReviewParents(sql: Sql, scope: AgentSkillNativeScope, resourceId: string, agent: boolean) {
  if (agent) {
    const rows = await sql`SELECT id FROM omni_custom_agents WHERE tenant_id = ${scope.tenantId}
      AND actor_id = ${scope.ownerActorId} AND id = ${resourceId} FOR UPDATE`;
    if (rows.length !== 1) fail("Exact custom Agent was not found.", "agent_skill_not_found", 404);
    return [] as string[];
  }
  // Existing Agent edits lock the Agent before its referenced Skills. Preserve
  // that order, then recheck the impact set after acquiring the Skill parent.
  const agents = await sql`SELECT id FROM omni_custom_agents WHERE tenant_id = ${scope.tenantId}
    AND actor_id = ${scope.ownerActorId} AND ${resourceId} = ANY(skill_ids) ORDER BY id COLLATE "C" LIMIT 101 FOR UPDATE`;
  if (agents.length > 100) fail("The affected Agent set exceeds this bounded review.");
  const rows = await sql`SELECT id, source_plugin_installation_id FROM omni_custom_skills WHERE tenant_id = ${scope.tenantId}
    AND actor_id = ${scope.ownerActorId} AND id = ${resourceId} FOR UPDATE`;
  if (rows.length !== 1 || rows[0].source_plugin_installation_id) fail("Exact custom Skill was not found.", "agent_skill_not_found", 404);
  const current = await sql`SELECT id FROM omni_custom_agents WHERE tenant_id = ${scope.tenantId}
    AND actor_id = ${scope.ownerActorId} AND ${resourceId} = ANY(skill_ids) ORDER BY id COLLATE "C" LIMIT 101`;
  if (!same(agents.map((row) => String(row.id)), current.map((row) => String(row.id)))) fail("Skill assignments changed while the review was prepared.");
  return agents.map((row) => String(row.id));
}
async function lifecycle(sql: Sql, scope: AgentSkillNativeScope, agentId: string, lock: boolean) {
  const channels = lock ? await sql`SELECT state, release_revision, active_definition_version FROM omni_agent_release_channels
    WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.canonicalActorId} AND agent_definition_id = ${agentId} FOR UPDATE`
    : await sql`SELECT state, release_revision, active_definition_version FROM omni_agent_release_channels
      WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.canonicalActorId} AND agent_definition_id = ${agentId}`;
  const versions = await sql`SELECT MAX(definition_version) AS version FROM omni_agent_definition_versions
    WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.canonicalActorId} AND agent_definition_id = ${agentId}`;
  const principals = lock ? await sql`SELECT principal_generation, state, lifecycle_revision FROM omni_tenant_execution_principals
    WHERE tenant_id = ${scope.tenantId} AND controller_actor_id = ${scope.canonicalActorId} AND agent_definition_id = ${agentId}
      AND principal_kind = 'agent' ORDER BY principal_generation DESC LIMIT 1 FOR UPDATE`
    : await sql`SELECT principal_generation, state, lifecycle_revision FROM omni_tenant_execution_principals
      WHERE tenant_id = ${scope.tenantId} AND controller_actor_id = ${scope.canonicalActorId} AND agent_definition_id = ${agentId}
        AND principal_kind = 'agent' ORDER BY principal_generation DESC LIMIT 1`;
  if (channels.length !== 1 || principals.length !== 1 || !versions[0]?.version) fail("Exact Agent identity lifecycle is unavailable.");
  return { releaseState: String(channels[0].state), releaseRevision: Number(channels[0].release_revision),
    activeDefinitionVersion: Number(channels[0].active_definition_version), latestDefinitionVersion: Number(versions[0].version),
    principalGeneration: Number(principals[0].principal_generation), principalState: String(principals[0].state),
    principalLifecycleRevision: Number(principals[0].lifecycle_revision) };
}
async function reviewLocked(sql: Sql, scope: AgentSkillNativeScope,
  input: { resourceId: string; operation: "agent.delete" | "skill.update" | "skill.delete" }): Promise<AgentSkillNativeReview> {
  const agent = input.operation === "agent.delete", affectedIds = await lockReviewParents(sql, scope, input.resourceId, agent);
  const current = agent ? await getCustomAgent(input.resourceId, owner(scope)) : await getAgentSkill(input.resourceId, owner(scope));
  if (!current || current.tenantId !== scope.tenantId || current.actorId !== scope.ownerActorId) fail("Exact owned catalog resource was not found.", "agent_skill_not_found", 404);
  const resource = agent ? nativeAgentRecordSchema.parse(current) : nativeSkillRecordSchema.parse(current);
  const affected: { id: string; name: string; resourceSha256: string; lifecycle: Awaited<ReturnType<typeof lifecycle>> }[] = [];
  for (const id of affectedIds) {
    const item = await getCustomAgent(id, owner(scope));
    if (!item) fail("A reviewed affected Agent disappeared.");
    affected.push({ id, name: item.name, resourceSha256: canonicalJsonSha256(nativeAgentRecordSchema.parse(item)), lifecycle: await lifecycle(sql, scope, id, false) });
  }
  const identity = agent ? await lifecycle(sql, scope, input.resourceId, true) : null;
  if (agent) await assertMoltbookAgentMayBeDeleted({ owner: owner(scope), agentId: input.resourceId });
  const pin = { operation: input.operation, resourceType: agent ? "custom_agent" as const : "agent_skill" as const,
    resourceId: input.resourceId, resourceVersion: agent ? null : nativeSkillRecordSchema.parse(resource).version,
    resourceSha256: canonicalJsonSha256(resource), impactSha256: canonicalJsonSha256({ affected, identity }) };
  const { principalLifecycleRevision: _lifecycle, ...publicIdentity } = identity ?? {}; void _lifecycle;
  const preview = input.operation === "skill.update" ? null : createTrashPreview({ resourceType: pin.resourceType, resourceId: pin.resourceId, target: pin,
    effectSummary: agent ? `Move custom Agent ${resource.name} to Trash. Undo creates an equivalent new identity; the retired original cannot be reactivated.`
      : `Move custom Skill ${resource.name} to Trash and detach it from ${affected.length} Agent(s). Undo restores the Skill and surviving assignments.` });
  return agentSkillNativeReviewSchema.parse({ pin, agent: agent ? resource : null, skill: agent ? null : resource,
    affectedAgents: affected.map(({ id, name }) => ({ id, name })), agentLifecycle: identity ? publicIdentity : null, preview });
}
export async function reviewAgentSkillNativeMutation(authority: AgentSkillNativeAuthority,
  input: { resourceId: string; operation: "agent.delete" | "skill.update" | "skill.delete" }) {
  await ready(authority); agentSkillNativeIdSchema.parse(input.resourceId);
  if (authority.executionScope) fail("Review requires read-only authority.", "agent_skill_authority_invalid", 403);
  return inScope(authority.scope, () => getSql().transaction(async (transaction: Sql) => runWithManagedDatabaseTransaction(transaction, async () => {
    const sql = getSql();
    await currentIdentity(sql, authority.scope, true); return reviewLocked(sql, authority.scope, input);
  })) as Promise<AgentSkillNativeReview>);
}
function skillFields(skill: ReturnType<typeof nativeSkillRecordSchema.parse>) {
  return { name: skill.name, description: skill.description, instructions: skill.instructions, category: skill.category,
    status: skill.status, toolIds: skill.toolIds, tags: skill.tags, knowledgeTags: skill.knowledgeTags };
}
export async function submitAgentSkillNativeMutation(input: { authority: AgentSkillNativeAuthority; idempotencyKey: string; request: AgentSkillNativeRequest }) {
  await ready(input.authority);
  const scope = input.authority.scope, intent = buildAgentSkillNativeIntent({ scope, idempotencyKey: input.idempotencyKey, request: input.request });
  const executionScope = assertMutation(input.authority, intent);
  if (!same(redactSensitive(intent.request), intent.request)) fail("Skill input contains sensitive material that cannot be saved as reviewed.");
  return inScope(scope, () => getSql().transaction(async (transaction: Sql) => runWithManagedDatabaseTransaction(transaction, async () => {
    const sql = getSql();
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-skill-native:${scope.tenantId}:${scope.ownerActorId}:${intent.keySha256}`}, 0))`;
    await currentIdentity(sql, scope, true);
    const prior = await receipt(sql, scope, intent.keySha256);
    if (prior) {
      if (!same(prior.intent, intent)) fail("Idempotency-Key is already bound to a different catalog mutation.");
      return { acceptance: prior.acceptance, replayed: true };
    }
    const request = intent.request;
    let current: AgentSkillNativeReview | null = null, after: ReturnType<typeof nativeSkillRecordSchema.parse> | null = null;
    let trash: AgentSkillNativeAcceptance["trash"] = null, acceptedAt: string;
    if (request.contract === "asael-skill-create:1") {
      after = nativeSkillRecordSchema.parse(await createAgentSkill(request.skill, owner(scope)));
      if (after.version !== 1 || !same(skillFields(after), request.skill)) fail("Created Skill differs from its exact normalized request.");
      acceptedAt = after.updatedAt;
    } else {
      current = await reviewLocked(sql, scope, { resourceId: request.review.resourceId, operation: request.review.operation });
      if (!same(current.pin, request.review)) fail("The reviewed resource or affected Agent state changed. Refresh the review.");
      if (request.contract === "asael-skill-update:1") {
        if (!current.skill || current.skill.version >= 2_147_483_647) fail("The Skill version cannot advance.");
        const expected = nativeSkillInputSchema.parse({ ...skillFields(current.skill), ...request.change });
        after = nativeSkillRecordSchema.parse(await updateAgentSkill(current.pin.resourceId, request.change, owner(scope)));
        if (after.version !== current.skill.version + 1 || !same(skillFields(after), expected)) fail("Updated Skill differs from its exact normalized request.");
        acceptedAt = after.updatedAt;
      } else {
        if (await getTrashLifecycleResultByPreview(request.preview.previewSha256, { executionScope })) fail("This preview has a prior non-native Trash receipt and cannot be adopted.");
        const resource = current.agent ?? current.skill!;
        const snapshot = { resourceType: current.pin.resourceType, resource: { ...resource }, children: [], affectedResourceIds: current.affectedAgents.map((item) => item.id) };
        const moved = await createTrashEntry({ preview: request.preview, displayLabel: resource.name, target: current.pin,
          snapshot, compensation: compensationForSnapshot(snapshot) }, { executionScope });
        const deleted = current.agent ? await deleteCustomAgent(resource.id, owner(scope)) : await deleteAgentSkill(resource.id, owner(scope));
        if (!deleted) fail("The reviewed resource could not be moved atomically to Trash.");
        trash = { trashId: moved.item.trashId, previewSha256: moved.receipt.previewSha256, targetSha256: moved.item.targetSha256,
          snapshotSha256: moved.item.snapshotSha256, receiptSha256: moved.receipt.receiptSha256,
          compensation: current.agent ? "equivalent_action" : "exact_restore" };
        acceptedAt = moved.receipt.occurredAt;
      }
    }
    const acceptance = buildAgentSkillNativeAcceptance({ contract: "asael-agent-skill-acceptance:1", id: agentSkillNativeAcceptanceId(scope, intent.keySha256), scope,
      operation: intent.operation, resourceType: intent.operation === "agent.delete" ? "custom_agent" : "agent_skill", resourceId: after?.id ?? current!.pin.resourceId,
      keySha256: intent.keySha256, requestSha256: canonicalJsonSha256(intent), reviewSha256: current ? canonicalJsonSha256(current.pin) : null,
      beforeVersion: current?.pin.resourceVersion ?? null, afterVersion: after?.version ?? null,
      beforeResourceSha256: current?.pin.resourceSha256 ?? null, afterResourceSha256: after ? canonicalJsonSha256(after) : null,
      affectedAgentIds: current?.affectedAgents.map((item) => item.id) ?? [], trash, acceptedAt });
    await currentIdentity(sql, scope, true);
    await sql`INSERT INTO omni_agent_skill_native_mutations (tenant_id, owner_actor_id, canonical_actor_id, idempotency_key_sha256,
      operation, resource_type, resource_id, request_sha256, intent, acceptance, accepted_at)
      VALUES (${scope.tenantId}, ${scope.ownerActorId}, ${scope.canonicalActorId}, ${intent.keySha256}, ${intent.operation}, ${acceptance.resourceType},
        ${acceptance.resourceId}, ${acceptance.requestSha256}, ${intent}::JSONB, ${acceptance}::JSONB, ${acceptance.acceptedAt})`;
    await appendScopedDomainEvent({ id: acceptance.id, streamId: acceptance.resourceId, type: "agent_skill.native_mutation.accepted", executionScope,
      payload: { schemaVersion: 1, operation: intent.operation, resourceType: acceptance.resourceType, resourceId: acceptance.resourceId, acceptanceId: acceptance.id,
        acceptanceSha256: acceptance.acceptanceSha256 } }, { sql });
    return { acceptance, replayed: false };
  })) as Promise<{ acceptance: AgentSkillNativeAcceptance; replayed: boolean }>);
}
