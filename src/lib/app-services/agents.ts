import { z } from "zod";
import { arsenalAgents } from "@/lib/agents/arsenal";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { redactSensitive } from "@/lib/security/context";
import { customAgentInputSchema, customAgentPatchSchema, skillInputSchema, skillPatchSchema } from "@/lib/skills/schema";
import {
  createAgentSkill,
  createCustomAgent,
  deleteAgentSkill,
  deleteCustomAgent,
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

const emptySchema = z.object({}).strict();
const agentListSchema = z.object({ ownerScope: z.enum(["exact", "readable"]).default("readable") }).strict();
const idSchema = z.object({ id: z.string().trim().min(1).max(200) }).strict();
const agentShowSchema = idSchema.extend({ includeBuiltIns: z.boolean().default(true) }).strict();
const deleteSchema = idSchema.extend({ expectedTargetSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

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
  const target = agent ? { id: agent.id, name: agent.name, slug: agent.slug, skillIds: [...agent.skillIds].sort(), toolIds: [...agent.toolIds].sort() } : null;
  return completeAppServiceCall(authorized, { target, targetSha256: canonicalJsonSha256(target), irreversible: true as const }, { resourceCount: target ? 1 : 0 });
}

export async function deleteAgentService(caller: AppServiceCaller, input: z.input<typeof deleteSchema>) {
  const value = deleteSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.agents.delete"));
  const preview = await previewAgentDeleteService(caller, { id: value.id });
  if (!preview.data.target || preview.data.targetSha256 !== value.expectedTargetSha256) {
    throw new Error("Agent deletion target changed after preview; review the exact target again.");
  }
  const deleted = await deleteCustomAgent(value.id, exactOwner(caller));
  return completeAppServiceCall(authorized, { deleted, target: preview.data.target, targetSha256: preview.data.targetSha256 }, { resourceCount: deleted ? 1 : 0 });
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
  const target = skill && !skill.builtIn ? {
    id: skill.id, name: skill.name, slug: skill.slug,
    affectedAgents: agents.filter((agent) => agent.skillIds.includes(skill.id)).map((agent) => ({ id: agent.id, name: agent.name })).sort((a, b) => a.id.localeCompare(b.id)),
  } : null;
  return completeAppServiceCall(authorized, { target, targetSha256: canonicalJsonSha256(target), irreversible: true as const }, { resourceCount: target ? 1 : 0 });
}

export async function deleteSkillService(caller: AppServiceCaller, input: z.input<typeof deleteSchema>) {
  const value = deleteSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.skills.delete"));
  const preview = await previewSkillDeleteService(caller, { id: value.id });
  if (!preview.data.target || preview.data.targetSha256 !== value.expectedTargetSha256) {
    throw new Error("Skill deletion target changed after preview; review the exact target again.");
  }
  const deleted = await deleteAgentSkill(value.id, exactOwner(caller));
  return completeAppServiceCall(authorized, { deleted, target: preview.data.target, targetSha256: preview.data.targetSha256 }, { resourceCount: deleted ? 1 : 0 });
}

function exactOwner(caller: AppServiceCaller) { return { tenantId: caller.context.tenantId, actorId: caller.context.actorId }; }
function readOwner(caller: AppServiceCaller) { return { ...exactOwner(caller), requestActorBinding: canonicalRequestActorBindingFromSecurityContext(caller.context) }; }
