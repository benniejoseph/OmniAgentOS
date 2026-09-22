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
import type { DelegationExecutionRecordV1 } from "@/lib/delegation/execution-record";
import {
  cancelDelegationExecution,
  getDelegationExecution,
  listDelegationExecutions,
} from "@/lib/delegation/execution-store";
import {
  getLatestDelegationGrantValidation,
  type DelegationGrantValidationProjectionV1,
} from "@/lib/delegation/grant-validation-events";
import {
  delegateAgentTask,
  delegateAgentTaskInputSchema,
} from "@/lib/delegation/runtime";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { assertMoltbookAgentMayBeDeleted } from "@/lib/moltbook/store";
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
const agentTaskListSchema = z.object({
  parentExecutionId: z.string().trim().min(1).max(240).optional(),
  limit: z.number().int().min(1).max(100).default(60),
}).strict();
const agentTaskShowSchema = z.object({
  executionId: z.string().trim().min(1).max(240),
}).strict();
export const agentTaskCancelServiceInputSchema = z.object({
  executionId: z.string().trim().min(1).max(240),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  reason: z.string().trim().min(1).max(500).default("Canceled by the operator."),
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
export const agentDelegateServiceInputSchema = delegateAgentTaskInputSchema;
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

type AgentTaskServiceDependencies = Readonly<{
  delegateTask: typeof delegateAgentTask;
  cancelExecution: typeof cancelDelegationExecution;
  getExecution: typeof getDelegationExecution;
  getGrantValidation: typeof getLatestDelegationGrantValidation;
  listExecutions: typeof listDelegationExecutions;
}>;

const defaultAgentTaskServiceDependencies: AgentTaskServiceDependencies = Object.freeze({
  delegateTask: delegateAgentTask,
  cancelExecution: cancelDelegationExecution,
  getExecution: getDelegationExecution,
  getGrantValidation: getLatestDelegationGrantValidation,
  listExecutions: listDelegationExecutions,
});

export async function delegateAgentTaskService(
  caller: AppServiceCaller,
  input: z.input<typeof agentDelegateServiceInputSchema>,
  dependencies: AgentTaskServiceDependencies = defaultAgentTaskServiceDependencies,
) {
  const value = agentDelegateServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.agents.delegate"),
  );
  const execution = await dependencies.delegateTask({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    parentExecutionScope: caller.executionScope!,
    idempotencyKey: caller.idempotencyKey!,
    input: value,
  });
  return completeAppServiceCall(
    authorized,
    { task: delegationExecutionPublicProjection(execution) },
    { resourceCount: 1 },
  );
}

export async function listAgentTasksService(
  caller: AppServiceCaller,
  input: z.input<typeof agentTaskListSchema>,
  dependencies: AgentTaskServiceDependencies = defaultAgentTaskServiceDependencies,
) {
  const value = agentTaskListSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.agents.tasks.list"),
  );
  const executions = await dependencies.listExecutions({
    tenantId: caller.context.tenantId,
    ownerActorId: caller.context.actorId,
    parentExecutionId: value.parentExecutionId,
    limit: value.limit,
  });
  const tasks = executions.map(delegationExecutionPublicProjection);
  return completeAppServiceCall(authorized, { tasks }, { resourceCount: tasks.length });
}

export async function showAgentTaskService(
  caller: AppServiceCaller,
  input: z.input<typeof agentTaskShowSchema>,
  dependencies: AgentTaskServiceDependencies = defaultAgentTaskServiceDependencies,
) {
  const value = agentTaskShowSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.agents.tasks.show"),
  );
  const execution = await dependencies.getExecution({
    tenantId: caller.context.tenantId,
    ownerActorId: caller.context.actorId,
    executionId: value.executionId,
  });
  const grantValidation = await dependencies.getGrantValidation({
    tenantId: caller.context.tenantId,
    ownerActorId: caller.context.actorId,
    executionId: execution.executionId,
    delegationId: execution.delegationId,
    contractSha256: execution.contractSha256,
  });
  const effectiveGrantValidation =
    grantValidation.status === "not_checked" &&
      execution.failureCode === "grant_assignment_changed"
      ? Object.freeze({
          status: "changed" as const,
          category: "capability_binding" as const,
          validatedAt: execution.updatedAt,
        })
      : grantValidation;
  return completeAppServiceCall(
    authorized,
    {
      task: delegationExecutionDetailProjection(
        execution,
        effectiveGrantValidation,
      ),
    },
    { resourceCount: 1 },
  );
}

export async function cancelAgentTaskService(
  caller: AppServiceCaller,
  input: z.input<typeof agentTaskCancelServiceInputSchema>,
  dependencies: AgentTaskServiceDependencies = defaultAgentTaskServiceDependencies,
) {
  const value = agentTaskCancelServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.agents.tasks.cancel"),
  );
  const canceled = await dependencies.cancelExecution({
    tenantId: caller.context.tenantId,
    ownerActorId: caller.context.actorId,
    executionId: value.executionId,
    expectedRevision: value.expectedRevision,
    requestSha256: canonicalJsonSha256(value),
    idempotencyKeySha256: authorized.idempotencyKeySha256!,
    executionScope: caller.executionScope!,
  });
  return completeAppServiceCall(
    authorized,
    {
      task: delegationExecutionPublicProjection(canceled.execution),
      canceledChildRun: canceled.canceledChildRun,
      canceledDeliveryCount: canceled.canceledDeliveryCount,
      idempotent: canceled.idempotent,
    },
    { resourceCount: 1 },
  );
}

export function delegationExecutionPublicProjection(
  execution: DelegationExecutionRecordV1,
) {
  const assignment = execution.contract.runtimeAssignment;
  return Object.freeze({
    executionId: execution.executionId,
    delegationId: execution.delegationId,
    rootExecutionId: execution.rootExecutionId,
    parentExecutionId: execution.parentExecutionId,
    childRunId: execution.childRunId,
    state: execution.state,
    lifecycleRevision: execution.lifecycleRevision,
    canCancel: ["queued", "running", "waiting"].includes(execution.state),
    mode: execution.mode,
    objective: execution.contract.objective,
    ...(execution.contract.personaBrief
      ? {
          personaBrief: Object.freeze({
            label: execution.contract.personaBrief.label,
            briefSha256: execution.contract.personaBrief.briefSha256,
          }),
        }
      : {}),
    delegateAgentId: execution.delegateAgentId,
    runtime: Object.freeze({
      providerId: assignment.providerId,
      modelId: assignment.modelId,
      modelTier: assignment.modelTier,
      reasoningProfileId: assignment.reasoningProfileId,
      normalizedReasoningEffort: assignment.normalizedReasoningEffort,
    }),
    result: execution.result ? Object.freeze({
      status: execution.result.status,
      summary: execution.result.summary,
      artifacts: execution.result.artifacts.map((artifact) => Object.freeze({
        artifactId: artifact.artifactId,
        kind: artifact.kind,
        mediaType: artifact.mediaType,
        byteCount: artifact.byteCount,
      })),
      acceptanceChecks: execution.result.acceptanceChecks.map((check) => Object.freeze({
        criterionId: check.criterionId,
        passed: check.passed,
        note: check.note,
      })),
    }) : null,
    verification: execution.verification ? Object.freeze({
      verdict: execution.verification.verdict,
      score: execution.verification.score,
      note: execution.verification.note,
      verifiedAt: execution.verification.verifiedAt,
    }) : null,
    failureCode: execution.failureCode,
    createdAt: execution.createdAt,
    acceptBy: execution.acceptBy,
    completeBy: execution.completeBy,
    updatedAt: execution.updatedAt,
    terminalAt: execution.terminalAt,
  });
}

export function delegationExecutionDetailProjection(
  execution: DelegationExecutionRecordV1,
  grantValidation: DelegationGrantValidationProjectionV1,
) {
  const task = delegationExecutionPublicProjection(execution);
  const grants = execution.contract.grants;
  const mcpToolIds = new Set(
    grants.mcpServers.flatMap((server) => server.governedToolIds),
  );
  return Object.freeze({
    ...task,
    authority: Object.freeze({
      immutable: true,
      contractSha256: execution.contractSha256,
      grantRequestSha256: grants.grantRequestSha256,
      validation: grantValidation,
      nativeReadTools: Object.freeze(
        grants.governedToolIds
          .filter((toolId) => !mcpToolIds.has(toolId))
          .map((toolId) => Object.freeze({
            toolId,
            managementHref: "/app/tools",
          })),
      ),
      skills: Object.freeze(grants.skills.map((grant) => Object.freeze({
        capabilityGrantId: grant.capabilityGrantId,
        skillId: grant.skillId,
        skillVersion: grant.skillVersion,
        skillVersionId: grant.skillVersionId,
        skillSha256: grant.skillSha256,
        managementHref: "/app/automation?view=skills",
      }))),
      plugins: Object.freeze(grants.plugins.map((grant) => Object.freeze({
        capabilityGrantId: grant.capabilityGrantId,
        installationId: grant.installationId,
        installationRevision: grant.installationRevision,
        installationSha256: grant.installationSha256,
        pluginId: grant.pluginId,
        pluginVersion: grant.pluginVersion,
        manifestSha256: grant.manifestSha256,
        componentIds: Object.freeze([...grant.componentIds]),
        managementHref: "/app/automation?view=plugins",
      }))),
      mcpServers: Object.freeze(grants.mcpServers.map((grant) => Object.freeze({
        capabilityGrantId: grant.capabilityGrantId,
        serverId: grant.serverId,
        serverVersionId: grant.serverVersionId,
        serverContractSha256: grant.serverContractSha256,
        governedToolIds: Object.freeze([...grant.governedToolIds]),
        connectorTargetIds: Object.freeze([...grant.connectorTargetIds]),
        managementHref: "/app/automation?view=connections",
      }))),
    }),
    controls: Object.freeze({
      grantsImmutable: true,
      allowedActions: Object.freeze(task.canCancel ? ["cancel"] : []),
      cancelHref: task.canCancel
        ? `/api/agents/tasks/${encodeURIComponent(task.executionId)}/cancel`
        : null,
    }),
  });
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
  if (agent) {
    await assertMoltbookAgentMayBeDeleted({
      owner: { tenantId: agent.tenantId, actorId: agent.actorId },
      agentId: agent.id,
    });
  }
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
  await assertMoltbookAgentMayBeDeleted({
    owner: { tenantId: agent!.tenantId, actorId: agent!.actorId },
    agentId: agent!.id,
  });
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
