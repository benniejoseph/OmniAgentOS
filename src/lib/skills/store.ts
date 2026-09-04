import { randomUUID } from "node:crypto";
import { ensureDatabaseSchema, getDatabaseTenantContext, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { redactSensitive } from "@/lib/security/context";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import { skillActorReadOrder } from "@/lib/skills/actor-scope";
import { builtInSkills } from "@/lib/skills/catalog";
import type { AgentBuilderLedger, AgentSkill, CustomAgentDefinition } from "@/lib/skills/types";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";

type Scope = { tenantId?: string; actorId: string };
type RequestReadScope = Scope & {
  requestActorBinding?: CanonicalRequestActorBindingV1;
};

export class AgentSkillReadConflictError extends Error {
  constructor(message = "Custom skill ownership is ambiguous.") {
    super(message);
    this.name = "AgentSkillReadConflictError";
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
  if (!current || current.builtIn) return undefined;
  const normalized = normalizeSkill({ ...current, ...input });
  const next = { ...current, ...normalized, slug: input.name ? slug(input.name) : current.slug, version: current.version + 1, updatedAt: new Date().toISOString() };
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`UPDATE omni_custom_skills SET slug=${next.slug}, name=${next.name}, description=${next.description}, instructions=${next.instructions}, category=${next.category}, status=${next.status}, version=${next.version}, tool_ids=${next.toolIds}, tags=${next.tags}, knowledge_tags=${next.knowledgeTags}, updated_at=${next.updatedAt}
      WHERE id=${id} AND tenant_id=${next.tenantId} AND actor_id=${next.actorId} RETURNING *`;
    return rows[0] ? skillFromRow(rows[0]) : undefined;
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
      await sql`UPDATE omni_custom_agents SET skill_ids=array_remove(skill_ids, ${id}), updated_at=NOW() WHERE tenant_id=${tenantId} AND actor_id=${actorId} AND ${id}=ANY(skill_ids)`;
      return sql`DELETE FROM omni_custom_skills WHERE id=${id} AND tenant_id=${tenantId} AND actor_id=${actorId} RETURNING id`;
    }) as Record<string, unknown>[];
    return Boolean(rows[0]);
  }
  let removed = false;
  await updateLedger((ledger) => ({ skills: ledger.skills.filter((item) => { const match = item.id === id && item.tenantId === tenantId && item.actorId === actorId; if (match) removed = true; return !match; }), agents: ledger.agents.map((agent) => ({ ...agent, skillIds: agent.skillIds.filter((skillId) => skillId !== id) })) }));
  return removed;
}

export async function listCustomAgents(options: Scope) {
  const tenantId = tenant(options.tenantId); const actorId = safe(options.actorId, 200);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`SELECT * FROM omni_custom_agents WHERE tenant_id=${tenantId} AND actor_id=${actorId} ORDER BY updated_at DESC`;
    return rows.map(agentFromRow);
  }
  return (await readLedger()).agents.filter((item) => item.tenantId === tenantId && item.actorId === actorId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getCustomAgent(id: string, options: Scope) { return (await listCustomAgents(options)).find((item) => item.id === id); }

export async function createCustomAgent(input: Omit<CustomAgentDefinition, "id" | "tenantId" | "actorId" | "slug" | "createdAt" | "updatedAt">, options: Scope) {
  const desiredSlug = slug(input.name);
  if ((await listCustomAgents(options)).some((item) => item.slug === desiredSlug)) throw new Error("An agent with this name already exists.");
  const now = new Date().toISOString();
  const agent: CustomAgentDefinition = { ...normalizeAgent(input), id: randomUUID(), tenantId: tenant(options.tenantId), actorId: safe(options.actorId, 200), slug: desiredSlug, createdAt: now, updatedAt: now };
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    try {
      return await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
        await assertAgentSkillAssignmentsWithSql(
          agent.skillIds,
          agent.tenantId,
          agent.actorId,
          sql,
        );
        const rows = await sql`
          INSERT INTO omni_custom_agents (
            id, tenant_id, actor_id, slug, name, role, description,
            instructions, status, accent, model_policy, autonomy,
            approval_policy, memory_scope, skill_ids, tool_ids,
            created_at, updated_at
          ) VALUES (
            ${agent.id}, ${agent.tenantId}, ${agent.actorId}, ${agent.slug},
            ${agent.name}, ${agent.role}, ${agent.description},
            ${agent.instructions}, ${agent.status}, ${agent.accent},
            ${agent.modelPolicy}, ${agent.autonomy}, ${agent.approvalPolicy},
            ${agent.memoryScope}, ${agent.skillIds}, ${agent.toolIds},
            ${now}, ${now}
          )
          RETURNING *
        `;
        return agentFromRow(rows[0]);
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
        await assertAgentSkillAssignmentsWithSql(
          next.skillIds,
          tenantId,
          actorId,
          sql,
        );
        const rows = await sql`
          UPDATE omni_custom_agents
          SET slug = ${next.slug}, name = ${next.name}, role = ${next.role},
            description = ${next.description}, instructions = ${next.instructions},
            status = ${next.status}, accent = ${next.accent},
            model_policy = ${next.modelPolicy}, autonomy = ${next.autonomy},
            approval_policy = ${next.approvalPolicy}, memory_scope = ${next.memoryScope},
            skill_ids = ${next.skillIds}, tool_ids = ${next.toolIds},
            updated_at = ${next.updatedAt}
          WHERE id = ${id} AND tenant_id = ${tenantId} AND actor_id = ${actorId}
          RETURNING *
        `;
        return rows[0] ? agentFromRow(rows[0]) : undefined;
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
  if (hasDatabaseUrl()) { await ensureDatabaseSchema(); const rows = await getSql()`DELETE FROM omni_custom_agents WHERE id=${id} AND tenant_id=${tenantId} AND actor_id=${actorId} RETURNING id`; return Boolean(rows[0]); }
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
    selectable: exactOwner,
    manageable: exactOwner,
  };
}

function skillForBuiltInRequest(skill: AgentSkill): AgentSkill {
  return { ...skill, selectable: true, manageable: false };
}

function skillForExactFileRequest(skill: AgentSkill): AgentSkill {
  return skill.builtIn
    ? skillForBuiltInRequest(skill)
    : { ...skill, selectable: true, manageable: true };
}

const builtInSkillIds = new Set(builtInSkills.map((skill) => skill.id));

async function assertAgentSkillAssignmentsWithSql(
  skillIds: string[],
  tenantId: string,
  actorId: string,
  sql: ReturnType<typeof getSql>,
) {
  const customSkillIds = skillIds.filter((id) => !builtInSkillIds.has(id));
  if (!customSkillIds.length) return;
  const rows = await sql`
    SELECT id, tenant_id, actor_id
    FROM omni_custom_skills
    WHERE tenant_id COLLATE "C" = ${tenantId}::text COLLATE "C"
      AND actor_id COLLATE "C" = ${actorId}::text COLLATE "C"
      AND id COLLATE "C" = ANY(${customSkillIds}::text[])
    ORDER BY id COLLATE "C"
    FOR KEY SHARE
  `;
  const requested = new Set(customSkillIds);
  if (rows.some((row) =>
    String(row.tenant_id) !== tenantId ||
    String(row.actor_id) !== actorId ||
    !requested.has(String(row.id))
  )) {
    throw new AgentSkillAssignmentError();
  }
  const found = new Set(rows.map((row) => String(row.id)));
  if (customSkillIds.some((id) => !found.has(id))) {
    throw new AgentSkillAssignmentError();
  }
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
    updatedAt: new Date().toISOString(),
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
function normalizeAgent(input: Pick<CustomAgentDefinition, "name" | "role" | "description" | "instructions" | "status" | "accent" | "modelPolicy" | "autonomy" | "approvalPolicy" | "memoryScope" | "skillIds" | "toolIds">) { return { name: safe(input.name, 120), role: safe(input.role, 120), description: safe(input.description, 700), instructions: safe(input.instructions, 12_000), status: input.status, accent: input.accent, modelPolicy: input.modelPolicy, autonomy: input.autonomy, approvalPolicy: input.approvalPolicy, memoryScope: input.memoryScope, skillIds: ids(input.skillIds, 30), toolIds: ids(input.toolIds, 50) }; }
function skillFromRow(row: Record<string, unknown>): AgentSkill { return { id: String(row.id), tenantId: String(row.tenant_id), actorId: String(row.actor_id), slug: String(row.slug), name: String(row.name), description: String(row.description), instructions: String(row.instructions), category: String(row.category) as AgentSkill["category"], status: String(row.status) as AgentSkill["status"], version: Number(row.version), toolIds: strings(row.tool_ids), tags: strings(row.tags), knowledgeTags: strings(row.knowledge_tags), createdAt: date(row.created_at), updatedAt: date(row.updated_at) }; }
function agentFromRow(row: Record<string, unknown>): CustomAgentDefinition { return { id: String(row.id), tenantId: String(row.tenant_id), actorId: String(row.actor_id), slug: String(row.slug), name: String(row.name), role: String(row.role), description: String(row.description), instructions: String(row.instructions), status: String(row.status) as CustomAgentDefinition["status"], accent: String(row.accent) as CustomAgentDefinition["accent"], modelPolicy: String(row.model_policy) as CustomAgentDefinition["modelPolicy"], autonomy: String(row.autonomy) as CustomAgentDefinition["autonomy"], approvalPolicy: String(row.approval_policy) as CustomAgentDefinition["approvalPolicy"], memoryScope: String(row.memory_scope) as CustomAgentDefinition["memoryScope"], skillIds: strings(row.skill_ids), toolIds: strings(row.tool_ids), createdAt: date(row.created_at), updatedAt: date(row.updated_at) }; }
function tenant(value?: string) { return (value || getDatabaseTenantContext() || process.env.OMNIAGENT_DEFAULT_TENANT || "default").trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "default"; }
function safe(value: unknown, max: number) { return String(redactSensitive(value || "")).trim().slice(0, max); }
function slug(value: string) { return safe(value, 120).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || `item-${randomUUID().slice(0, 8)}`; }
function ids(values: unknown, max: number) { return [...new Set((Array.isArray(values) ? values : []).map((item) => safe(item, 120)).filter(Boolean))].slice(0, max); }
function strings(value: unknown) { return Array.isArray(value) ? value.map(String) : []; }
function date(value: unknown) { return value instanceof Date ? value.toISOString() : String(value); }
