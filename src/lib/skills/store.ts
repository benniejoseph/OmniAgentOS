import { createHash, randomUUID } from "node:crypto";
import { arsenalAgents } from "@/lib/agents/arsenal";
import { parseAgentPersonaV1 } from "@/lib/agents/persona";
import {
  createAgentIdentityMutationScope,
  createCustomAgentIdentityWithSql,
  revokeCustomAgentIdentityWithSql,
  updateCustomAgentIdentityWithSql,
  versionCustomAgentsForSkillChangeWithSql,
} from "@/lib/agents/identity-store";
import {
  initializeAgentReleaseChannelWithSql,
  retireAgentReleaseChannelWithSql,
} from "@/lib/agents/release-store";
import { ensureDatabaseSchema, getDatabaseTenantContext, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { redactSensitive } from "@/lib/security/context";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import { skillActorReadOrder } from "@/lib/skills/actor-scope";
import { builtInSkills } from "@/lib/skills/catalog";
import type { AgentBuilderLedger, AgentSkill, CustomAgentDefinition, RequestCustomAgentDefinition } from "@/lib/skills/types";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import {
  PLUGIN_SKILL_ID_PREFIX,
  type PluginInstallationState,
  type PluginManifest,
} from "@/lib/plugins/contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

type Scope = { tenantId?: string; actorId: string };
type CustomAgentCreateInput = Omit<
  CustomAgentDefinition,
  "id" | "tenantId" | "actorId" | "slug" | "persona" | "createdAt" | "updatedAt"
> & { persona?: CustomAgentDefinition["persona"] };
type RequestReadScope = Scope & {
  requestActorBinding?: CanonicalRequestActorBindingV1;
};

export class AgentSkillReadConflictError extends Error {
  constructor(message = "Custom skill ownership is ambiguous.") {
    super(message);
    this.name = "AgentSkillReadConflictError";
  }
}

export class CustomAgentReadConflictError extends Error {
  constructor(message = "Custom Agent ownership is ambiguous.") {
    super(message);
    this.name = "CustomAgentReadConflictError";
  }
}

export class AgentSkillAssignmentError extends Error {
  readonly code = "agent_skill_assignment_invalid";

  constructor() {
    super("One or more selected skills are unavailable for this agent.");
    this.name = "AgentSkillAssignmentError";
  }
}

export async function listAgentSkills(options: Scope, includeBuiltIns = true) {
  const custom = await listCustomSkills(options);
  return includeBuiltIns ? [...builtInSkills, ...custom] : custom;
}

export async function getAgentSkill(id: string, options: Scope) {
  const builtIn = builtInSkills.find((item) => item.id === id);
  if (builtIn) return builtIn;
  return (await listCustomSkills(options)).find((item) => item.id === id);
}

export async function listAgentSkillsForRequest(
  options: RequestReadScope,
  includeBuiltIns = true,
) {
  if (!hasDatabaseUrl()) {
    return (await listAgentSkills(options, includeBuiltIns)).map((skill) =>
      skillForExactFileRequest(skill),
    );
  }
  const custom = await listCustomSkillsForRequest(options);
  return includeBuiltIns
    ? [...builtInSkills.map(skillForBuiltInRequest), ...custom]
    : custom;
}

export async function getAgentSkillForRequest(
  id: string,
  options: RequestReadScope,
) {
  const builtIn = builtInSkills.find((item) => item.id === id);
  if (builtIn) return skillForBuiltInRequest(builtIn);
  if (!hasDatabaseUrl()) {
    const skill = await getAgentSkill(id, options);
    return skill ? skillForExactFileRequest(skill) : undefined;
  }
  return (await listCustomSkillsForRequest(options)).find((item) => item.id === id);
}

export async function createAgentSkill(input: Omit<AgentSkill, "id" | "tenantId" | "actorId" | "slug" | "version" | "builtIn" | "selectable" | "manageable" | "createdAt" | "updatedAt">, options: Scope) {
  const desiredSlug = slug(input.name);
  if ((await listAgentSkills(options)).some((item) => item.slug === desiredSlug)) throw new Error("A skill with this name already exists.");
  const now = new Date().toISOString();
  const skill: AgentSkill = {
    ...normalizeSkill(input), id: randomUUID(), tenantId: tenant(options.tenantId), actorId: safe(options.actorId, 200),
    slug: desiredSlug, version: 1, createdAt: now, updatedAt: now,
  };
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`INSERT INTO omni_custom_skills (id, tenant_id, actor_id, slug, name, description, instructions, category, status, version, tool_ids, tags, knowledge_tags, created_at, updated_at)
      VALUES (${skill.id}, ${skill.tenantId}, ${skill.actorId}, ${skill.slug}, ${skill.name}, ${skill.description}, ${skill.instructions}, ${skill.category}, ${skill.status}, ${skill.version}, ${skill.toolIds}, ${skill.tags}, ${skill.knowledgeTags}, ${now}, ${now}) RETURNING *`;
    return skillFromRow(rows[0]);
  }
  await updateLedger((ledger) => ({ ...ledger, skills: [skill, ...ledger.skills] }));
  return skill;
}

export async function updateAgentSkill(id: string, input: Partial<Pick<AgentSkill, "name" | "description" | "instructions" | "category" | "status" | "toolIds" | "tags" | "knowledgeTags">>, options: Scope) {
  const current = await getAgentSkill(id, options);
  if (!current || current.builtIn || current.sourcePluginInstallationId) return undefined;
  const normalized = normalizeSkill({ ...current, ...input });
  const next = { ...current, ...normalized, slug: input.name ? slug(input.name) : current.slug, version: current.version + 1, updatedAt: new Date().toISOString() };
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const rows = await sql`UPDATE omni_custom_skills SET slug=${next.slug}, name=${next.name}, description=${next.description}, instructions=${next.instructions}, category=${next.category}, status=${next.status}, version=${next.version}, tool_ids=${next.toolIds}, tags=${next.tags}, knowledge_tags=${next.knowledgeTags}, updated_at=${next.updatedAt}
        WHERE id=${id} AND tenant_id=${next.tenantId} AND actor_id=${next.actorId} RETURNING *`;
      if (!rows[0]) return undefined;
      await versionCustomAgentsForSkillChangeWithSql({
        tenantId: next.tenantId,
        actorId: next.actorId,
        skillId: id,
        removeSkill: false,
        sql,
      });
      return skillFromRow(rows[0]);
    }) as AgentSkill | undefined;
  }
  await updateLedger((ledger) => ({ ...ledger, skills: ledger.skills.map((item) => item.id === id && item.tenantId === next.tenantId && item.actorId === next.actorId ? next : item) }));
  return next;
}

export async function deleteAgentSkill(id: string, options: Scope) {
  const tenantId = tenant(options.tenantId); const actorId = safe(options.actorId, 200);
  if (builtInSkills.some((item) => item.id === id)) return false;
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const sourceRows = await sql`
        SELECT source_plugin_installation_id
        FROM omni_custom_skills
        WHERE id = ${id} AND tenant_id = ${tenantId} AND actor_id = ${actorId}
        FOR KEY SHARE
      `;
      if (sourceRows[0]?.source_plugin_installation_id) return [];
      await versionCustomAgentsForSkillChangeWithSql({
        tenantId,
        actorId,
        skillId: id,
        removeSkill: true,
        sql,
      });
      return sql`DELETE FROM omni_custom_skills WHERE id=${id} AND tenant_id=${tenantId} AND actor_id=${actorId} RETURNING id`;
    }) as Record<string, unknown>[];
    return Boolean(rows[0]);
  }
  let removed = false;
  await updateLedger((ledger) => ({ skills: ledger.skills.filter((item) => { const match = item.id === id && item.tenantId === tenantId && item.actorId === actorId; if (match) removed = true; return !match; }), agents: ledger.agents.map((agent) => ({ ...agent, skillIds: agent.skillIds.filter((skillId) => skillId !== id) })) }));
  return removed;
}

export async function restoreAgentSkill(
  skill: AgentSkill,
  affectedAgentIds: readonly string[],
  options: Scope,
) {
  const tenantId = tenant(options.tenantId);
  const actorId = safe(options.actorId, 200);
  if (
    skill.builtIn ||
    skill.sourcePluginInstallationId ||
    skill.tenantId !== tenantId ||
    skill.actorId !== actorId ||
    builtInSkills.some((item) => item.id === skill.id)
  ) {
    throw new Error("Trash Skill snapshot does not belong to this actor.");
  }
  const agentIds = [...new Set(affectedAgentIds.map((id) => safe(id, 120)).filter(Boolean))]
    .slice(0, 100);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const existingRows = await sql`
        SELECT * FROM omni_custom_skills
        WHERE id = ${skill.id} AND tenant_id = ${tenantId}
        FOR UPDATE
      `;
      if (existingRows[0]) {
        const existing = skillFromRow(existingRows[0]);
        if (existing.actorId !== actorId || JSON.stringify(existing) !== JSON.stringify(skill)) {
          throw new Error("The original Skill ID is already in use.");
        }
        return existing;
      }
      const slugRows = await sql`
        SELECT id FROM omni_custom_skills
        WHERE tenant_id = ${tenantId} AND actor_id = ${actorId}
          AND slug = ${skill.slug}
        LIMIT 1 FOR UPDATE
      `;
      if (slugRows[0]) throw new Error("The original Skill name is already in use.");
      const rows = await sql`
        INSERT INTO omni_custom_skills (
          id, tenant_id, actor_id, slug, name, description, instructions,
          category, status, version, tool_ids, tags, knowledge_tags,
          created_at, updated_at
        ) VALUES (
          ${skill.id}, ${tenantId}, ${actorId}, ${skill.slug}, ${skill.name},
          ${skill.description}, ${skill.instructions}, ${skill.category},
          ${skill.status}, ${skill.version}, ${skill.toolIds}, ${skill.tags},
          ${skill.knowledgeTags}, ${skill.createdAt}, ${skill.updatedAt}
        ) RETURNING *
      `;
      if (agentIds.length) {
        await sql`
          UPDATE omni_custom_agents
          SET skill_ids = array_append(skill_ids, ${skill.id}),
              updated_at = GREATEST(clock_timestamp(), updated_at + INTERVAL '1 millisecond')
          WHERE tenant_id = ${tenantId} AND actor_id = ${actorId}
            AND id = ANY(${agentIds}::text[])
            AND NOT (${skill.id} = ANY(skill_ids))
        `;
        await versionCustomAgentsForSkillChangeWithSql({
          tenantId,
          actorId,
          skillId: skill.id,
          removeSkill: false,
          sql,
        });
      }
      return skillFromRow(rows[0]);
    }) as Promise<AgentSkill>;
  }
  let restored = skill;
  await updateLedger((ledger) => {
    const existing = ledger.skills.find((item) => item.id === skill.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(skill)) {
        throw new Error("The original Skill ID is already in use.");
      }
      restored = existing;
      return ledger;
    }
    if (ledger.skills.some((item) =>
      item.tenantId === tenantId && item.actorId === actorId && item.slug === skill.slug
    )) {
      throw new Error("The original Skill name is already in use.");
    }
    const affected = new Set(agentIds);
    return {
      skills: [skill, ...ledger.skills],
      agents: ledger.agents.map((agent) =>
        agent.tenantId === tenantId &&
        agent.actorId === actorId &&
        affected.has(agent.id) &&
        !agent.skillIds.includes(skill.id)
          ? { ...agent, skillIds: [...agent.skillIds, skill.id] }
          : agent
      ),
    };
  });
  return restored;
}

/**
 * Projects enabled declarative Plugin Skills into the existing actor-owned
 * Skill store. MCP and workflow declarations deliberately never enter this
 * path. The caller must hold the surrounding plugin-installation transaction.
 */
export async function syncPluginSkillTemplatesWithSql(input: {
  tenantId: string;
  actorId: string;
  installationId: string;
  manifest: PluginManifest;
  installationState: PluginInstallationState;
  occurredAt: string;
  sql: ReturnType<typeof getSql>;
}) {
  const tenantId = exactPluginProjectionIdentity(input.tenantId, "tenant", 120);
  const actorId = exactPluginProjectionIdentity(input.actorId, "actor", 200);
  const installationId = exactPluginProjectionIdentity(
    input.installationId,
    "installation",
    200,
  );
  if (input.manifest.pluginId.length > 120) {
    throw new Error("Plugin Skill projection identity is invalid.");
  }
  const desiredStatus = pluginSkillStatusForInstallation(input.installationState);
  const existingRows = await input.sql`
    SELECT *
    FROM omni_custom_skills
    WHERE tenant_id = ${tenantId}
      AND actor_id = ${actorId}
      AND source_plugin_installation_id = ${installationId}
    ORDER BY source_plugin_skill_key
    FOR UPDATE
  `;
  const existingByKey = new Map(existingRows.map((row) => [
    String(row.source_plugin_skill_key),
    skillFromRow(row),
  ]));
  const desiredKeys = new Set(input.manifest.skills.map((template) => template.key));
  const projected: AgentSkill[] = [];

  for (const template of input.manifest.skills) {
    const skillId = pluginSkillIdForInstallation(installationId, template.key);
    const skillSha256 = canonicalJsonSha256({
      schemaVersion: 1,
      pluginId: input.manifest.pluginId,
      pluginVersion: input.manifest.version,
      manifestSha256: canonicalJsonSha256(input.manifest),
      template,
    });
    const existing = existingByKey.get(template.key);
    if (existing && (
      existing.id !== skillId ||
      existing.sourcePluginInstallationId !== installationId ||
      existing.sourcePluginId !== input.manifest.pluginId
    )) {
      throw new Error("Plugin Skill projection identity changed unexpectedly.");
    }
    const nextValues = {
      slug: pluginSkillSlug(input.manifest.pluginId, template.key),
      name: template.name,
      description: template.description,
      instructions: template.instructions,
      category: template.category,
      status: desiredStatus,
      toolIds: [...template.toolIds],
      tags: [...template.tags],
      knowledgeTags: [...template.knowledgeTags],
    };
    const changed = !existing || pluginSkillChanged(existing, nextValues) ||
      existing.sourcePluginSkillSha256 !== skillSha256;
    const version = existing ? existing.version + (changed ? 1 : 0) : 1;
    const createdAt = existing?.createdAt || input.occurredAt;
    const updatedAt = changed ? input.occurredAt : existing?.updatedAt || input.occurredAt;
    const rows = existing
      ? await input.sql`
          UPDATE omni_custom_skills
          SET slug = ${nextValues.slug}, name = ${nextValues.name},
              description = ${nextValues.description},
              instructions = ${nextValues.instructions},
              category = ${nextValues.category}, status = ${nextValues.status},
              version = ${version}, tool_ids = ${nextValues.toolIds},
              tags = ${nextValues.tags}, knowledge_tags = ${nextValues.knowledgeTags},
              source_plugin_version = ${input.manifest.version},
              source_plugin_manifest_sha256 = ${canonicalJsonSha256(input.manifest)},
              source_plugin_skill_sha256 = ${skillSha256}, updated_at = ${updatedAt}
          WHERE tenant_id = ${tenantId} AND actor_id = ${actorId}
            AND id = ${skillId}
          RETURNING *
        `
      : await input.sql`
          INSERT INTO omni_custom_skills (
            id, tenant_id, actor_id, slug, name, description, instructions,
            category, status, version, tool_ids, tags, knowledge_tags,
            source_plugin_installation_id, source_plugin_id,
            source_plugin_version, source_plugin_skill_key,
            source_plugin_manifest_sha256, source_plugin_skill_sha256,
            created_at, updated_at
          ) VALUES (
            ${skillId}, ${tenantId}, ${actorId}, ${nextValues.slug},
            ${nextValues.name}, ${nextValues.description}, ${nextValues.instructions},
            ${nextValues.category}, ${nextValues.status}, ${version},
            ${nextValues.toolIds}, ${nextValues.tags}, ${nextValues.knowledgeTags},
            ${installationId}, ${input.manifest.pluginId}, ${input.manifest.version},
            ${template.key}, ${canonicalJsonSha256(input.manifest)}, ${skillSha256},
            ${createdAt}, ${updatedAt}
          ) RETURNING *
        `;
    const skill = skillFromRow(rows[0]);
    projected.push(skill);
    if (existing && changed) {
      await versionCustomAgentsForSkillChangeWithSql({
        tenantId,
        actorId,
        skillId,
        removeSkill: false,
        sql: input.sql,
      });
    }
  }

  for (const row of existingRows) {
    const existing = skillFromRow(row);
    const key = existing.sourcePluginSkillKey || "";
    if (desiredKeys.has(key) || existing.status === "disabled") continue;
    const rows = await input.sql`
      UPDATE omni_custom_skills
      SET status = 'disabled', version = version + 1,
          source_plugin_version = ${input.manifest.version},
          source_plugin_manifest_sha256 = ${canonicalJsonSha256(input.manifest)},
          updated_at = ${input.occurredAt}
      WHERE tenant_id = ${tenantId} AND actor_id = ${actorId}
        AND id = ${existing.id}
      RETURNING *
    `;
    if (rows[0]) {
      await versionCustomAgentsForSkillChangeWithSql({
        tenantId,
        actorId,
        skillId: existing.id,
        removeSkill: false,
        sql: input.sql,
      });
    }
  }
  return projected;
}

export async function listCustomAgents(options: Scope) {
  const tenantId = tenant(options.tenantId); const actorId = safe(options.actorId, 200);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`SELECT * FROM omni_custom_agents WHERE tenant_id=${tenantId} AND actor_id=${actorId} ORDER BY updated_at DESC`;
    return rows.map(agentFromRow);
  }
  return (await readLedger()).agents
    .filter((item) => item.tenantId === tenantId && item.actorId === actorId)
    .map(agentWithParsedPersona)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function listCustomAgentsForRequest(options: RequestReadScope) {
  if (!hasDatabaseUrl()) {
    const tenantId = tenant(options.tenantId);
    const exactActorId = safe(options.actorId, 200);
    const agents = await listCustomAgents(options);
    assertRequestCustomAgentOwners(
      agents,
      tenantId,
      exactActorId,
      exactActorId,
    );
    assertNoAgentSlugCollisions(agents);
    return agents.map(customAgentForExactFileRequest);
  }
  const tenantId = tenant(options.tenantId);
  const requestActorId = safe(options.actorId, 200);
  const [canonicalActorId, exactActorId] = skillActorReadOrder(
    options.actorId,
    options.requestActorBinding,
    requestActorId,
  );
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT agent.*, release.state AS release_state,
      release.active_definition_version,
      latest.latest_definition_version
    FROM omni_custom_agents agent
    JOIN omni_agent_release_channels release
      ON release.tenant_id = agent.tenant_id
      AND release.agent_definition_id = agent.id
    JOIN LATERAL (
      SELECT MAX(definition.definition_version) AS latest_definition_version
      FROM omni_agent_definition_versions definition
      WHERE definition.tenant_id = agent.tenant_id
        AND definition.agent_definition_id = agent.id
    ) latest ON TRUE
    WHERE agent.tenant_id = ${tenantId}
      AND (agent.actor_id = ${canonicalActorId} OR agent.actor_id = ${exactActorId})
    ORDER BY agent.updated_at DESC, agent.id ASC
  `;
  const agents = rows.map(agentFromRow);
  assertRequestCustomAgentOwners(
    agents,
    tenantId,
    canonicalActorId,
    exactActorId,
  );
  assertNoAgentSlugCollisions(agents);
  return agents.map((agent, index) =>
    customAgentForRequest(agent, exactActorId, rows[index])
  );
}

export async function getCustomAgent(id: string, options: Scope) { return (await listCustomAgents(options)).find((item) => item.id === id); }

export async function getCustomAgentForRequest(
  id: string,
  options: RequestReadScope,
) {
  if (!isValidCustomAgentRequestId(id) || builtInAgentIds.has(id)) {
    throw new CustomAgentReadConflictError(
      "Invalid or reserved IDs cannot resolve custom Agent details.",
    );
  }
  if (!hasDatabaseUrl()) {
    const agent = await getCustomAgent(id, options);
    return agent ? customAgentForExactFileRequest(agent) : undefined;
  }
  const tenantId = tenant(options.tenantId);
  const requestActorId = safe(options.actorId, 200);
  const [canonicalActorId, exactActorId] = skillActorReadOrder(
    options.actorId,
    options.requestActorBinding,
    requestActorId,
  );
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT agent.*, release.state AS release_state,
      release.active_definition_version,
      latest.latest_definition_version
    FROM omni_custom_agents agent
    JOIN omni_agent_release_channels release
      ON release.tenant_id = agent.tenant_id
      AND release.agent_definition_id = agent.id
    JOIN LATERAL (
      SELECT MAX(definition.definition_version) AS latest_definition_version
      FROM omni_agent_definition_versions definition
      WHERE definition.tenant_id = agent.tenant_id
        AND definition.agent_definition_id = agent.id
    ) latest ON TRUE
    WHERE agent.id = ${id} AND agent.tenant_id = ${tenantId}
      AND (agent.actor_id = ${canonicalActorId} OR agent.actor_id = ${exactActorId})
    LIMIT 1
  `;
  if (!rows[0]) return undefined;
  const agent = agentFromRow(rows[0]);
  assertRequestCustomAgentOwner(
    agent,
    id,
    tenantId,
    canonicalActorId,
    exactActorId,
  );
  return customAgentForRequest(agent, exactActorId, rows[0]);
}

export async function createCustomAgent(input: CustomAgentCreateInput, options: Scope) {
  const desiredSlug = slug(input.name);
  if ((await listCustomAgents(options)).some((item) => item.slug === desiredSlug)) throw new Error("An agent with this name already exists.");
  const now = new Date().toISOString();
  const agent: CustomAgentDefinition = { ...normalizeAgent(input), id: randomUUID(), tenantId: tenant(options.tenantId), actorId: safe(options.actorId, 200), slug: desiredSlug, createdAt: now, updatedAt: now };
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    try {
      return await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
        const skills = await resolveAgentSkillAssignmentsWithSql(
          agent.skillIds,
          agent.tenantId,
          agent.actorId,
          sql,
        );
        const rows = await sql`
          INSERT INTO omni_custom_agents (
            id, tenant_id, actor_id, slug, name, role, description,
            instructions, persona_profile, status, accent, model_policy, autonomy,
            approval_policy, memory_scope, skill_ids, tool_ids,
            created_at, updated_at
          ) VALUES (
            ${agent.id}, ${agent.tenantId}, ${agent.actorId}, ${agent.slug},
            ${agent.name}, ${agent.role}, ${agent.description},
            ${agent.instructions}, ${agent.persona}::jsonb,
            ${agent.status}, ${agent.accent},
            ${agent.modelPolicy}, ${agent.autonomy}, ${agent.approvalPolicy},
            ${agent.memoryScope}, ${agent.skillIds}, ${agent.toolIds},
            ${now}, ${now}
          )
          RETURNING *
        `;
        const saved = agentFromRow(rows[0]);
        const executionScope = createAgentIdentityMutationScope(saved, "create");
        const identity = await createCustomAgentIdentityWithSql({
          agent: saved,
          skills,
          executionScope,
          sql,
        });
        await initializeAgentReleaseChannelWithSql({
          agent: saved,
          definitionVersion: identity.definition.definitionVersion,
          canonicalActorId: identity.definition.ownerActorId,
          executionScope,
          sql,
        });
        return saved;
      }) as CustomAgentDefinition;
    } catch (error) {
      throw translatedAgentSkillConstraintError(error);
    }
  }
  await updateLedger((ledger) => {
    if (ledger.agents.some((item) =>
      item.tenantId === agent.tenantId &&
      item.actorId === agent.actorId &&
      item.slug === agent.slug
    )) {
      throw new Error("An agent with this name already exists.");
    }
    assertAgentSkillAssignmentsInLedger(
      agent.skillIds,
      agent.tenantId,
      agent.actorId,
      ledger,
    );
    return { ...ledger, agents: [agent, ...ledger.agents] };
  });
  return agent;
}

export async function updateCustomAgent(id: string, input: Partial<Omit<CustomAgentDefinition, "id" | "tenantId" | "actorId" | "slug" | "createdAt" | "updatedAt">>, options: Scope) {
  const tenantId = tenant(options.tenantId);
  const actorId = safe(options.actorId, 200);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    try {
      return await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
        const currentRows = await sql`
          SELECT * FROM omni_custom_agents
          WHERE id = ${id} AND tenant_id = ${tenantId} AND actor_id = ${actorId}
          FOR UPDATE
        `;
        if (!currentRows[0]) return undefined;
        const current = agentFromRow(currentRows[0]);
        const next = updatedCustomAgent(current, input);
        const skills = await resolveAgentSkillAssignmentsWithSql(
          next.skillIds,
          tenantId,
          actorId,
          sql,
        );
        const rows = await sql`
          UPDATE omni_custom_agents
          SET slug = ${next.slug}, name = ${next.name}, role = ${next.role},
            description = ${next.description}, instructions = ${next.instructions},
            persona_profile = ${next.persona}::jsonb,
            status = ${next.status}, accent = ${next.accent},
            model_policy = ${next.modelPolicy}, autonomy = ${next.autonomy},
            approval_policy = ${next.approvalPolicy}, memory_scope = ${next.memoryScope},
            skill_ids = ${next.skillIds}, tool_ids = ${next.toolIds},
            updated_at = ${next.updatedAt}
          WHERE id = ${id} AND tenant_id = ${tenantId} AND actor_id = ${actorId}
          RETURNING *
        `;
        if (!rows[0]) return undefined;
        const saved = agentFromRow(rows[0]);
        await updateCustomAgentIdentityWithSql({
          current,
          next: saved,
          skills,
          executionScope: createAgentIdentityMutationScope(saved, "update"),
          sql,
        });
        return saved;
      }) as CustomAgentDefinition | undefined;
    } catch (error) {
      throw translatedAgentSkillConstraintError(error);
    }
  }
  let saved: CustomAgentDefinition | undefined;
  const missingAgent = new Error("Custom agent not found.");
  try {
    await updateLedger((ledger) => {
      const current = ledger.agents.find((item) =>
        item.id === id && item.tenantId === tenantId && item.actorId === actorId
      );
      if (!current) throw missingAgent;
      const next = updatedCustomAgent(current, input);
      if (ledger.agents.some((item) =>
        item.id !== id &&
        item.tenantId === tenantId &&
        item.actorId === actorId &&
        item.slug === next.slug
      )) {
        throw new Error("An agent with this name already exists.");
      }
      assertAgentSkillAssignmentsInLedger(
        next.skillIds,
        tenantId,
        actorId,
        ledger,
      );
      saved = next;
      return {
        ...ledger,
        agents: ledger.agents.map((item) => item === current ? next : item),
      };
    });
  } catch (error) {
    if (error === missingAgent) return undefined;
    throw error;
  }
  return saved;
}

export async function deleteCustomAgent(id: string, options: Scope) {
  const tenantId = tenant(options.tenantId); const actorId = safe(options.actorId, 200);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const currentRows = await sql`
        SELECT * FROM omni_custom_agents
        WHERE id = ${id} AND tenant_id = ${tenantId} AND actor_id = ${actorId}
        FOR UPDATE
      `;
      if (!currentRows[0]) return false;
      const current = agentFromRow(currentRows[0]);
      const releaseRows = await sql`
        SELECT owner_actor_id
        FROM omni_agent_release_channels
        WHERE tenant_id = ${tenantId}
          AND agent_definition_id = ${id}
        LIMIT 1
        FOR UPDATE
      `;
      if (!releaseRows[0]) {
        throw new Error("The Agent release channel is unavailable.");
      }
      const executionScope = createAgentIdentityMutationScope(current, "delete");
      await revokeCustomAgentIdentityWithSql({
        agent: current,
        executionScope,
        sql,
      });
      await retireAgentReleaseChannelWithSql({
        agent: current,
        canonicalActorId: String(releaseRows[0].owner_actor_id),
        executionScope,
        sql,
      });
      const rows = await sql`
        DELETE FROM omni_custom_agents
        WHERE id = ${id} AND tenant_id = ${tenantId} AND actor_id = ${actorId}
        RETURNING id
      `;
      return Boolean(rows[0]);
    }) as boolean;
  }
  let removed = false; await updateLedger((ledger) => ({ ...ledger, agents: ledger.agents.filter((item) => { const match = item.id === id && item.tenantId === tenantId && item.actorId === actorId; if (match) removed = true; return !match; }) })); return removed;
}

function listCustomSkills(options: Scope) {
  const tenantId = tenant(options.tenantId); const actorId = safe(options.actorId, 200);
  if (hasDatabaseUrl()) return ensureDatabaseSchema().then(() => getSql()`SELECT * FROM omni_custom_skills WHERE tenant_id=${tenantId} AND actor_id=${actorId} ORDER BY updated_at DESC`).then((rows) => rows.map(skillFromRow));
  return readLedger().then((ledger) => ledger.skills.filter((item) => item.tenantId === tenantId && item.actorId === actorId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
}

async function listCustomSkillsForRequest(options: RequestReadScope) {
  const tenantId = tenant(options.tenantId);
  const requestActorId = safe(options.actorId, 200);
  const [canonicalActorId, exactActorId] = skillActorReadOrder(
    options.actorId,
    options.requestActorBinding,
    requestActorId,
  );
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT *
    FROM omni_custom_skills
    WHERE tenant_id = ${tenantId}
      AND (actor_id = ${canonicalActorId} OR actor_id = ${exactActorId})
    ORDER BY updated_at DESC, id ASC
  `;
  const skills = rows.map(skillFromRow);
  assertRequestSkillOwners(skills, tenantId, canonicalActorId, exactActorId);
  assertNoCrossActorSkillSlugCollisions(skills);
  return skills.map((skill) => skillForRequest(skill, exactActorId));
}

function assertRequestSkillOwners(
  skills: AgentSkill[],
  tenantId: string,
  canonicalActorId: string,
  exactActorId: string,
) {
  for (const skill of skills) {
    if (
      skill.tenantId !== tenantId ||
      (skill.actorId !== canonicalActorId && skill.actorId !== exactActorId)
    ) {
      throw new AgentSkillReadConflictError("Custom skill owner validation failed.");
    }
  }
}

function assertNoCrossActorSkillSlugCollisions(skills: AgentSkill[]) {
  const ownersBySlug = new Map<string, string>();
  for (const skill of skills) {
    const existingOwner = ownersBySlug.get(skill.slug);
    if (existingOwner !== undefined && existingOwner !== skill.actorId) {
      throw new AgentSkillReadConflictError(
        "Custom skill slug is ambiguous across readable owners.",
      );
    }
    ownersBySlug.set(skill.slug, skill.actorId);
  }
}

function skillForRequest(skill: AgentSkill, requestActorId: string): AgentSkill {
  const exactOwner = skill.actorId === requestActorId;
  return {
    ...skill,
    actorId: requestActorId,
    selectable: exactOwner && isAgentSkillRuntimeActive(skill),
    manageable: exactOwner && !skill.sourcePluginInstallationId,
  };
}

function skillForBuiltInRequest(skill: AgentSkill): AgentSkill {
  return { ...skill, selectable: true, manageable: false };
}

function skillForExactFileRequest(skill: AgentSkill): AgentSkill {
  return skill.builtIn
    ? skillForBuiltInRequest(skill)
    : {
        ...skill,
        selectable: isAgentSkillRuntimeActive(skill),
        manageable: !skill.sourcePluginInstallationId,
      };
}

const builtInSkillIds = new Set(builtInSkills.map((skill) => skill.id));
const builtInAgentIds = new Set(arsenalAgents.map((agent) => agent.id));

function isValidCustomAgentRequestId(id: string) {
  return /^[a-zA-Z0-9_.:-]{1,120}$/.test(id);
}

function assertRequestCustomAgentOwner(
  agent: CustomAgentDefinition,
  requestedId: string,
  tenantId: string,
  canonicalActorId: string,
  exactActorId: string,
) {
  if (
    agent.id !== requestedId ||
    agent.tenantId !== tenantId ||
    (agent.actorId !== canonicalActorId && agent.actorId !== exactActorId)
  ) {
    throw new CustomAgentReadConflictError(
      "Custom Agent request row validation failed.",
    );
  }
}

function assertRequestCustomAgentOwners(
  agents: CustomAgentDefinition[],
  tenantId: string,
  canonicalActorId: string,
  exactActorId: string,
) {
  const seenIds = new Set<string>();
  for (const agent of agents) {
    if (
      agent.tenantId !== tenantId ||
      (agent.actorId !== canonicalActorId && agent.actorId !== exactActorId) ||
      !isValidCustomAgentRequestId(agent.id) ||
      builtInAgentIds.has(agent.id) ||
      seenIds.has(agent.id)
    ) {
      throw new CustomAgentReadConflictError(
        "Custom Agent request list validation failed.",
      );
    }
    seenIds.add(agent.id);
  }
}

function assertNoAgentSlugCollisions(agents: CustomAgentDefinition[]) {
  const seenSlugs = new Set<string>();
  for (const agent of agents) {
    if (seenSlugs.has(agent.slug)) {
      throw new CustomAgentReadConflictError(
        "Custom Agent slug is ambiguous in the readable namespace.",
      );
    }
    seenSlugs.add(agent.slug);
  }
}

function customAgentForRequest(
  agent: CustomAgentDefinition,
  requestActorId: string,
  row?: Record<string, unknown>,
): RequestCustomAgentDefinition {
  const exactOwner = agent.actorId === requestActorId;
  if (row && row.release_state !== "active" && row.release_state !== "retired") {
    throw new CustomAgentReadConflictError(
      "Custom Agent release metadata is invalid.",
    );
  }
  const releaseState = row?.release_state === "retired" ? "retired" : "active";
  const activeDefinitionVersion = optionalPositiveVersion(
    row?.active_definition_version,
  );
  const latestDefinitionVersion = optionalPositiveVersion(
    row?.latest_definition_version,
  );
  return {
    ...agent,
    actorId: requestActorId,
    selectable: exactOwner && releaseState === "active",
    manageable: exactOwner && releaseState === "active",
    releaseState,
    activeDefinitionVersion,
    latestDefinitionVersion,
  };
}

function customAgentForExactFileRequest(
  agent: CustomAgentDefinition,
): RequestCustomAgentDefinition {
  return { ...agent, selectable: true, manageable: true };
}

function optionalPositiveVersion(value: unknown) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new CustomAgentReadConflictError(
      "Custom Agent release metadata is invalid.",
    );
  }
  return parsed;
}

async function resolveAgentSkillAssignmentsWithSql(
  skillIds: string[],
  tenantId: string,
  actorId: string,
  sql: ReturnType<typeof getSql>,
) {
  const customSkillIds = skillIds.filter((id) => !builtInSkillIds.has(id));
  const rows = customSkillIds.length
    ? await sql`
        SELECT *
        FROM omni_custom_skills
        WHERE tenant_id COLLATE "C" = ${tenantId}::text COLLATE "C"
          AND actor_id COLLATE "C" = ${actorId}::text COLLATE "C"
          AND id COLLATE "C" = ANY(${customSkillIds}::text[])
        ORDER BY id COLLATE "C"
        FOR KEY SHARE
      `
    : [];
  const requested = new Set(customSkillIds);
  if (rows.some((row) => {
    const skill = skillFromRow(row);
    return String(row.tenant_id) !== tenantId ||
      String(row.actor_id) !== actorId ||
      !requested.has(String(row.id)) ||
      (skill.sourcePluginInstallationId && !isAgentSkillRuntimeActive(skill));
  }
  )) {
    throw new AgentSkillAssignmentError();
  }
  const found = new Set(rows.map((row) => String(row.id)));
  if (customSkillIds.some((id) => !found.has(id))) {
    throw new AgentSkillAssignmentError();
  }
  return [
    ...builtInSkills.filter((skill) => skillIds.includes(skill.id)),
    ...rows.map(skillFromRow),
  ];
}

function assertAgentSkillAssignmentsInLedger(
  skillIds: string[],
  tenantId: string,
  actorId: string,
  ledger: AgentBuilderLedger,
) {
  const exactCustomSkillIds = new Set(
    ledger.skills
      .filter((skill) =>
        skill.tenantId === tenantId && skill.actorId === actorId
      )
      .map((skill) => skill.id),
  );
  if (skillIds.some((id) =>
    !builtInSkillIds.has(id) && !exactCustomSkillIds.has(id)
  )) {
    throw new AgentSkillAssignmentError();
  }
}

function updatedCustomAgent(
  current: CustomAgentDefinition,
  input: Partial<Omit<CustomAgentDefinition, "id" | "tenantId" | "actorId" | "slug" | "createdAt" | "updatedAt">>,
) {
  return {
    ...current,
    ...normalizeAgent({ ...current, ...input }),
    slug: input.name ? slug(input.name) : current.slug,
    updatedAt: monotonicTimestamp(current.updatedAt),
  };
}

function translatedAgentSkillConstraintError(error: unknown) {
  if (isAgentSkillConstraintError(error)) {
    return new AgentSkillAssignmentError();
  }
  return error;
}

function isAgentSkillConstraintError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const failure = error as Record<string, unknown>;
  const constraint = failure.constraint_name ?? failure.constraint;
  return failure.code === "23514" &&
    constraint === "omni_custom_agents_skill_references_valid";
}

function readLedger() { return readJsonFile<AgentBuilderLedger>(getDataPath("agent-builder.json"), { skills: [], agents: [] }); }
function updateLedger(mutate: (ledger: AgentBuilderLedger) => AgentBuilderLedger) { return updateJsonFile<AgentBuilderLedger>(getDataPath("agent-builder.json"), { skills: [], agents: [] }, mutate); }
function normalizeSkill(input: Pick<AgentSkill, "name" | "description" | "instructions" | "category" | "status" | "toolIds" | "tags" | "knowledgeTags">) { return { name: safe(input.name, 120), description: safe(input.description, 500), instructions: safe(input.instructions, 12_000), category: input.category, status: input.status, toolIds: ids(input.toolIds, 40), tags: ids(input.tags, 30), knowledgeTags: ids(input.knowledgeTags, 30) }; }
function normalizeAgent(input: Pick<CustomAgentDefinition, "name" | "role" | "description" | "instructions" | "status" | "accent" | "modelPolicy" | "autonomy" | "approvalPolicy" | "memoryScope" | "skillIds" | "toolIds"> & { persona?: CustomAgentDefinition["persona"] }) { return { name: safe(input.name, 120), role: safe(input.role, 120), description: safe(input.description, 700), instructions: safe(input.instructions, 12_000), persona: normalizePersona(input.persona), status: input.status, accent: input.accent, modelPolicy: input.modelPolicy, autonomy: input.autonomy, approvalPolicy: input.approvalPolicy, memoryScope: input.memoryScope, skillIds: ids(input.skillIds, 30), toolIds: ids(input.toolIds, 50) }; }
function skillFromRow(row: Record<string, unknown>): AgentSkill { return { id: String(row.id), tenantId: String(row.tenant_id), actorId: String(row.actor_id), slug: String(row.slug), name: String(row.name), description: String(row.description), instructions: String(row.instructions), category: String(row.category) as AgentSkill["category"], status: String(row.status) as AgentSkill["status"], version: Number(row.version), toolIds: strings(row.tool_ids), tags: strings(row.tags), knowledgeTags: strings(row.knowledge_tags), ...(row.source_plugin_installation_id ? { sourcePluginInstallationId: String(row.source_plugin_installation_id), sourcePluginId: String(row.source_plugin_id), sourcePluginVersion: String(row.source_plugin_version), sourcePluginSkillKey: String(row.source_plugin_skill_key), sourcePluginManifestSha256: String(row.source_plugin_manifest_sha256), sourcePluginSkillSha256: String(row.source_plugin_skill_sha256) } : {}), createdAt: date(row.created_at), updatedAt: date(row.updated_at) }; }
function agentFromRow(row: Record<string, unknown>): CustomAgentDefinition { return { id: String(row.id), tenantId: String(row.tenant_id), actorId: String(row.actor_id), slug: String(row.slug), name: String(row.name), role: String(row.role), description: String(row.description), instructions: String(row.instructions), persona: parseAgentPersonaV1(row.persona_profile), status: String(row.status) as CustomAgentDefinition["status"], accent: String(row.accent) as CustomAgentDefinition["accent"], modelPolicy: String(row.model_policy) as CustomAgentDefinition["modelPolicy"], autonomy: String(row.autonomy) as CustomAgentDefinition["autonomy"], approvalPolicy: String(row.approval_policy) as CustomAgentDefinition["approvalPolicy"], memoryScope: String(row.memory_scope) as CustomAgentDefinition["memoryScope"], skillIds: strings(row.skill_ids), toolIds: strings(row.tool_ids), createdAt: date(row.created_at), updatedAt: date(row.updated_at) }; }
function tenant(value?: string) { return (value || getDatabaseTenantContext() || process.env.OMNIAGENT_DEFAULT_TENANT || "default").trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "default"; }
function safe(value: unknown, max: number) { return String(redactSensitive(value || "")).trim().slice(0, max); }
function slug(value: string) { return safe(value, 120).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || `item-${randomUUID().slice(0, 8)}`; }
function ids(values: unknown, max: number) { return [...new Set((Array.isArray(values) ? values : []).map((item) => safe(item, 120)).filter(Boolean))].slice(0, max); }
function normalizePersona(value?: CustomAgentDefinition["persona"]) { const persona = parseAgentPersonaV1(value); return parseAgentPersonaV1({ ...persona, charter: safe(persona.charter, 2_000), operatingStyle: safe(persona.operatingStyle, 2_000), voice: safe(persona.voice, 500), visualIdentity: safe(persona.visualIdentity, 500), allowedDomains: uniqueText(persona.allowedDomains, 20, 120), escalationBehavior: safe(persona.escalationBehavior, 1_000), successMeasures: uniqueText(persona.successMeasures, 20, 200) }); }
function agentWithParsedPersona(agent: CustomAgentDefinition): CustomAgentDefinition { return { ...agent, persona: parseAgentPersonaV1(agent.persona) }; }
function uniqueText(values: readonly string[], max: number, maxLength: number) { return [...new Set(values.map((value) => safe(value, maxLength)).filter(Boolean))].slice(0, max); }
function strings(value: unknown) { return Array.isArray(value) ? value.map(String) : []; }
function date(value: unknown) { return value instanceof Date ? value.toISOString() : String(value); }
function monotonicTimestamp(previous: string) { const now = Date.now(); const before = new Date(previous).getTime(); return new Date(Number.isFinite(before) ? Math.max(now, before + 1) : now).toISOString(); }
export function pluginSkillIdForInstallation(installationId: string, key: string) { return `${PLUGIN_SKILL_ID_PREFIX}${createHash("sha256").update(`${installationId}:${key}`, "utf8").digest("hex").slice(0, 40)}`; }
export function pluginSkillStatusForInstallation(state: PluginInstallationState): AgentSkill["status"] { return state === "enabled" ? "active" : "disabled"; }
export function isAgentSkillRuntimeActive(skill: Pick<AgentSkill, "status">) { return skill.status === "active"; }
function pluginSkillSlug(pluginId: string, key: string) { return `plugin-${createHash("sha256").update(pluginId, "utf8").digest("hex").slice(0, 12)}-${slug(key).slice(0, 50)}`; }
function pluginSkillChanged(current: AgentSkill, next: Pick<AgentSkill, "slug" | "name" | "description" | "instructions" | "category" | "status" | "toolIds" | "tags" | "knowledgeTags">) { return current.slug !== next.slug || current.name !== next.name || current.description !== next.description || current.instructions !== next.instructions || current.category !== next.category || current.status !== next.status || JSON.stringify(current.toolIds) !== JSON.stringify(next.toolIds) || JSON.stringify(current.tags) !== JSON.stringify(next.tags) || JSON.stringify(current.knowledgeTags) !== JSON.stringify(next.knowledgeTags); }
function exactPluginProjectionIdentity(value: string, label: string, max: number) { if (!value || value !== value.trim() || value.length > max) throw new Error(`Plugin Skill projection ${label} is invalid.`); return value; }
