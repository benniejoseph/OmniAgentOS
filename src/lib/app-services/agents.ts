import { z } from "zod";
import { arsenalAgents } from "@/lib/agents/arsenal";
import { buildAgentCouncilMap } from "@/lib/agents/council-map";
import { loadAgentCouncilMapSource } from "@/lib/agents/council-map-store";
import { listInternalAgentCardsV1 } from "@/lib/agents/discovery-card";
import { discoverInternalAgentsV1 } from "@/lib/agents/discovery";
import { getAgentPerformance } from "@/lib/agents/performance";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { runWithDatabaseActorScope } from "@/lib/db/client";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { redactSensitive } from "@/lib/security/context";
import { customAgentInputSchema, customAgentPatchSchema, skillInputSchema, skillPatchSchema } from "@/lib/skills/schema";
import {
  createAgentSkill,
  createCustomAgent,
  getAgentSkill,
  getAgentSkillForRequest,
  getCustomAgent,
  getCustomAgentForRequest,
  listAgentSkillsForRequest,
  listCustomAgents,
  listCustomAgentsForRequest,
  updateAgentSkill,
  updateCustomAgent,
} from "@/lib/skills/store";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { trashActionPreviewV1Schema } from "@/lib/trash/contracts";
import {
  captureRestorableResource,
  moveRestorableResourceToTrash,
} from "@/lib/trash/resources";
import {
  createTrashPreview,
  getTrashLifecycleResultByPreview,
} from "@/lib/trash/store";

const emptySchema = z.object({}).strict();
const agentListSchema = z.object({ ownerScope: z.enum(["exact", "readable"]).default("readable") }).strict();
const idSchema = z.object({ id: z.string().trim().min(1).max(200) }).strict();
const agentShowSchema = idSchema.extend({ includeBuiltIns: z.boolean().default(true) }).strict();
const deleteSchema = idSchema.extend({ preview: trashActionPreviewV1Schema }).strict();
const cardDiscoverySchema = z.object({
  query: z.string().trim().min(1).max(4_000).optional(),
  taskKind: z.enum(["general", "coordinate", "research", "build", "verify", "memory"]).optional(),
}).strict();
export const agentCouncilMapServiceInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(60),
}).strict();

type AgentCouncilMapDependencies = Readonly<{
  loadSource: typeof loadAgentCouncilMapSource;
}>;

const defaultAgentCouncilMapDependencies: AgentCouncilMapDependencies = Object.freeze({
  loadSource: loadAgentCouncilMapSource,
});

export const agentCreateServiceInputSchema = customAgentInputSchema;
export const agentUpdateServiceInputSchema = z.object({ id: z.string().trim().min(1).max(200), change: customAgentPatchSchema }).strict();
export const skillCreateServiceInputSchema = skillInputSchema;
export const skillUpdateServiceInputSchema = z.object({ id: z.string().trim().min(1).max(200), change: skillPatchSchema }).strict();

export async function listAgentsService(caller: AppServiceCaller, input: z.input<typeof agentListSchema>) {
  const value = agentListSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.agents.list"));
  const agents = await listCustomAgentsForRequest(value.ownerScope === "readable" ? readOwner(caller) : exactOwner(caller));
  const builtIns = arsenalAgents.map((agent) => ({ ...agent, builtIn: true, selectable: true, manageable: false }));
  return completeAppServiceCall(authorized, { builtIns, agents }, { resourceCount: builtIns.length + agents.length });
}

export async function showAgentService(caller: AppServiceCaller, input: z.input<typeof agentShowSchema>) {
  const value = agentShowSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.agents.show"));
  const builtIn = value.includeBuiltIns ? arsenalAgents.find((agent) => agent.id === value.id) : undefined;
  const agent = builtIn ? { ...builtIn, builtIn: true, selectable: true, manageable: false } : await getCustomAgentForRequest(value.id, readOwner(caller));
  return completeAppServiceCall(authorized, { agent: agent || null }, { resourceCount: agent ? 1 : 0 });
}

export async function discoverAgentCardsService(caller: AppServiceCaller, input: z.input<typeof cardDiscoverySchema>) {
  const value = cardDiscoverySchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.agents.cards"));
  const cards = listInternalAgentCardsV1({ tenantId: caller.context.tenantId, controllerActorId: caller.context.actorId });
  const discovery = value.query ? discoverInternalAgentsV1({
    cards,
    request: {
      query: value.query,
      taskKinds: [value.taskKind || "general"],
      inputModalities: ["text", "artifact_reference"],
      outputModalities: ["application/json", "artifact_reference"],
      limits: { maxInputArtifacts: 32, maxOutputArtifacts: 8, maxOutputBytes: 64_000, maxWallClockMs: 900_000, maxFanOut: 0 },
      authenticationScheme: "delegated_principal",
    },
  }) : undefined;
  return completeAppServiceCall(authorized, { version: "p8.5-agent-card-collection:1", cards, ...(discovery ? { discovery } : {}) }, { resourceCount: cards.length });
}

export async function showAgentPerformanceService(caller: AppServiceCaller, input: z.input<typeof emptySchema>) {
  emptySchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.agents.performance"));
  const agents = await getAgentPerformance(caller.context.tenantId);
  return completeAppServiceCall(authorized, { agents }, { resourceCount: agents.length });
}

export async function showAgentCouncilMapService(
  caller: AppServiceCaller,
  input: z.input<typeof agentCouncilMapServiceInputSchema>,
  dependencies: AgentCouncilMapDependencies = defaultAgentCouncilMapDependencies,
) {
  const value = agentCouncilMapServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.agents.council.show"),
  );
  const requestActorBinding = canonicalRequestActorBindingFromSecurityContext(caller.context);
  const ownerActorIds = requestActorBinding?.readableOwnerActorIds || [caller.context.actorId];
  return runWithDatabaseActorScope(
    caller.context.tenantId,
    ownerActorIds,
    async () => {
      const source = await dependencies.loadSource({
        tenantId: caller.context.tenantId,
        ownerActorIds,
        limit: value.limit,
      });
      const map = buildAgentCouncilMap({ source });
      return completeAppServiceCall(authorized, { map }, {
        resourceCount: map.summary.memberCount,
      });
    },
  );
}

export async function createAgentService(caller: AppServiceCaller, input: z.input<typeof agentCreateServiceInputSchema>) {
  const value = redactSensitive(agentCreateServiceInputSchema.parse(input)) as z.output<typeof agentCreateServiceInputSchema>;
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.agents.create"));
  const agent = await createCustomAgent(value, exactOwner(caller));
  return completeAppServiceCall(authorized, { agent });
}

export async function updateAgentService(caller: AppServiceCaller, input: z.input<typeof agentUpdateServiceInputSchema>) {
  const value = redactSensitive(agentUpdateServiceInputSchema.parse(input)) as z.output<typeof agentUpdateServiceInputSchema>;
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.agents.update"));
  const agent = await updateCustomAgent(value.id, value.change, exactOwner(caller));
  return completeAppServiceCall(authorized, { agent: agent || null }, { resourceCount: agent ? 1 : 0 });
}

export async function previewAgentDeleteService(caller: AppServiceCaller, input: z.input<typeof idSchema>) {
  const value = idSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.agents.delete.preview"));
  const agent = await getCustomAgent(value.id, exactOwner(caller));
  const target = agent ? agentDeleteTarget(agent) : null;
  const preview = target ? createTrashPreview({
    resourceType: "custom_agent",
    resourceId: value.id,
    target,
    effectSummary: `Move custom Agent ${agent!.name} to trash. Its retired identity cannot be reactivated; undo creates an equivalent new Agent identity.`,
  }) : null;
  return completeAppServiceCall(authorized, {
    target,
    targetSha256: canonicalJsonSha256(target),
    preview,
    reversible: Boolean(preview),
    compensation: preview ? "equivalent_agent_identity" as const : null,
  }, { resourceCount: target ? 1 : 0 });
}

export async function deleteAgentService(caller: AppServiceCaller, input: z.input<typeof deleteSchema>) {
  const value = deleteSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.agents.delete"));
  const prior = await getTrashLifecycleResultByPreview(
    value.preview.previewSha256,
    { executionScope: caller.executionScope! },
  );
  if (prior) {
    return completeAppServiceCall(authorized, {
      movedToTrash: true,
      trash: prior.item,
      effectReceipt: prior.receipt,
      target: null,
      targetSha256: prior.item.targetSha256,
    });
  }
  const agent = await getCustomAgent(value.id, exactOwner(caller));
  const target = agent ? agentDeleteTarget(agent) : null;
  if (!target) throw new Error("Custom Agent not found.");
  const snapshot = await captureRestorableResource(
    "custom_agent",
    value.id,
    caller.executionScope!,
  );
  if (!snapshot) throw new Error("Custom Agent changed after preview.");
  const moved = await moveRestorableResourceToTrash({
    preview: value.preview,
    displayLabel: agent!.name,
    target,
    snapshot,
    executionScope: caller.executionScope!,
  });
  return completeAppServiceCall(authorized, {
    movedToTrash: true,
    trash: moved.item,
    effectReceipt: moved.receipt,
    target,
    targetSha256: canonicalJsonSha256(target),
  });
}

export async function listSkillsService(caller: AppServiceCaller, input: z.input<typeof emptySchema>) {
  emptySchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.skills.list"));
  const skills = await listAgentSkillsForRequest(readOwner(caller));
  return completeAppServiceCall(authorized, { skills }, { resourceCount: skills.length });
}

export async function showSkillService(caller: AppServiceCaller, input: z.input<typeof idSchema>) {
  const value = idSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.skills.show"));
  const skill = await getAgentSkillForRequest(value.id, readOwner(caller));
  return completeAppServiceCall(authorized, { skill: skill || null }, { resourceCount: skill ? 1 : 0 });
}

export async function createSkillService(caller: AppServiceCaller, input: z.input<typeof skillCreateServiceInputSchema>) {
  const value = redactSensitive(skillCreateServiceInputSchema.parse(input)) as z.output<typeof skillCreateServiceInputSchema>;
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.skills.create"));
  const skill = await createAgentSkill(value, exactOwner(caller));
  return completeAppServiceCall(authorized, { skill });
}

export async function updateSkillService(caller: AppServiceCaller, input: z.input<typeof skillUpdateServiceInputSchema>) {
  const value = redactSensitive(skillUpdateServiceInputSchema.parse(input)) as z.output<typeof skillUpdateServiceInputSchema>;
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.skills.update"));
  const skill = await updateAgentSkill(value.id, value.change, exactOwner(caller));
  return completeAppServiceCall(authorized, { skill: skill || null }, { resourceCount: skill ? 1 : 0 });
}

export async function previewSkillDeleteService(caller: AppServiceCaller, input: z.input<typeof idSchema>) {
  const value = idSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.skills.delete.preview"));
  const [skill, agents] = await Promise.all([getAgentSkill(value.id, exactOwner(caller)), listCustomAgents(exactOwner(caller))]);
  const target = skill && !skill.builtIn && !skill.sourcePluginInstallationId ? {
    id: skill.id, name: skill.name, slug: skill.slug,
    affectedAgents: agents.filter((agent) => agent.skillIds.includes(skill.id)).map((agent) => ({ id: agent.id, name: agent.name })).sort((a, b) => a.id.localeCompare(b.id)),
  } : null;
  const preview = target ? createTrashPreview({
    resourceType: "agent_skill",
    resourceId: value.id,
    target,
    effectSummary: `Move custom Skill ${skill!.name} to trash and detach it from ${target.affectedAgents.length} Agent(s). Undo restores the Skill and surviving assignments.`,
  }) : null;
  return completeAppServiceCall(authorized, {
    target,
    targetSha256: canonicalJsonSha256(target),
    preview,
    reversible: Boolean(preview),
    compensation: preview ? "exact_restore" as const : null,
  }, { resourceCount: target ? 1 : 0 });
}

export async function deleteSkillService(caller: AppServiceCaller, input: z.input<typeof deleteSchema>) {
  const value = deleteSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.skills.delete"));
  const prior = await getTrashLifecycleResultByPreview(
    value.preview.previewSha256,
    { executionScope: caller.executionScope! },
  );
  if (prior) {
    return completeAppServiceCall(authorized, {
      movedToTrash: true,
      trash: prior.item,
      effectReceipt: prior.receipt,
      target: null,
      targetSha256: prior.item.targetSha256,
    });
  }
  const [skill, agents] = await Promise.all([
    getAgentSkill(value.id, exactOwner(caller)),
    listCustomAgents(exactOwner(caller)),
  ]);
  const target = skill && !skill.builtIn && !skill.sourcePluginInstallationId ? {
    id: skill.id,
    name: skill.name,
    slug: skill.slug,
    affectedAgents: agents
      .filter((agent) => agent.skillIds.includes(skill.id))
      .map((agent) => ({ id: agent.id, name: agent.name }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  } : null;
  if (!target) throw new Error("Custom Skill not found.");
  const snapshot = await captureRestorableResource(
    "agent_skill",
    value.id,
    caller.executionScope!,
  );
  if (!snapshot) throw new Error("Custom Skill changed after preview.");
  const moved = await moveRestorableResourceToTrash({
    preview: value.preview,
    displayLabel: skill!.name,
    target,
    snapshot,
    executionScope: caller.executionScope!,
  });
  return completeAppServiceCall(authorized, {
    movedToTrash: true,
    trash: moved.item,
    effectReceipt: moved.receipt,
    target,
    targetSha256: canonicalJsonSha256(target),
  });
}

function agentDeleteTarget(agent: Awaited<ReturnType<typeof getCustomAgent>> & {}) {
  return {
    id: agent.id,
    name: agent.name,
    slug: agent.slug,
    skillIds: [...agent.skillIds].sort(),
    toolIds: [...agent.toolIds].sort(),
  };
}

function exactOwner(caller: AppServiceCaller) { return { tenantId: caller.context.tenantId, actorId: caller.context.actorId }; }
function readOwner(caller: AppServiceCaller) { return { ...exactOwner(caller), requestActorBinding: canonicalRequestActorBindingFromSecurityContext(caller.context) }; }
