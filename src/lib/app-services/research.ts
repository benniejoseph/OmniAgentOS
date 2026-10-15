import "server-only";
import { z } from "zod";
import { resolveAgentIdentityForExecution } from "@/lib/agents/identity-store";
import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { WORKFLOW_RUN_BUDGET_LIMITS } from "@/lib/config";
import { listStreamEvents } from "@/lib/events/store";
import { createMission, ensureMissionTask, getMission, getMissionTask, transitionMission } from "@/lib/missions/store";
import { isResearchWebExplicitlyDisabled } from "@/lib/orchestration/research";
import { RESEARCH_WORKFLOW_METADATA_KEY, researchOptionsSchema } from "@/lib/research/contracts";
import { getAgentRun, getAgentRunIdentityPin } from "@/lib/runs/store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { redactSensitive } from "@/lib/security/context";
import { deriveExecutionScope } from "@/lib/security/execution-scope";
import { getOwnedThread } from "@/lib/threads/store";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { enqueueWorkflowRunTick, scheduleWorkflowQueueDrain } from "@/lib/workflows/queue";
import { createWorkflowRun, deterministicWorkflowRunId, getWorkflowRunDetail } from "@/lib/workflows/store";

const inputSchema = z.object({ goal: z.string().trim().min(1).max(4_000), ...researchOptionsSchema.shape }).strict();
const webTools = ["web.search", "web.read"] as const;

function availableResearchRecovery(allowed: readonly string[], readOnly = false) {
  const tools = new Set(allowed);
  const routes = [
    ...(tools.has("web.search") ? ["search public sources with web.search"] : []),
    ...(tools.has("web.read") ? ["read known public URLs with web.read"] : []),
    ...(!readOnly && tools.has("local.macos.open_url") && tools.has("local.macos.observe")
      ? ["inspect public sources in the selected Mac browser with local.macos.open_url and local.macos.observe"] : []),
  ];
  return routes.length
    ? ` No background work was started. Continue the same task using the tools already admitted: ${routes.join("; ")}. Each action still follows its current approval policy.`
    : " No background work was started and no alternative live-source tool is available in this request. Keep the task open and explain this specific blocker. The Research mode button does not grant web access.";
}

/** Start the existing bounded research pipeline from one exact live conversation.
 * This entry point deliberately carries no saved/private context into web research. */
export async function startResearchService(caller: AppServiceCaller, input: unknown) {
  const { goal: rawGoal, ...brief } = inputSchema.parse(input);
  const goal = String(redactSensitive(rawGoal));
  const options = researchOptionsSchema.parse(redactSensitive(brief));
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.research.start"));
  const scope = caller.executionScope!;
  const binding = canonicalRequestActorBindingFromSecurityContext(caller.context);
  if (!binding || scope.purpose !== "agent.tool.execute" || scope.delegationId !== null ||
    scope.executingPrincipalType !== "agent" || !scope.executingPrincipalId) {
    throw new Error("Start research from your signed-in Asael conversation.");
  }
  const owner = { tenantId: caller.context.tenantId, actorId: caller.context.actorId };
  const parent = await getAgentRun(scope.correlationId, owner);
  // The legacy approval route dispatches the granted tool before claiming the
  // continuation. Only that exact pending execution can start work while paused.
  const approvedPendingStart = parent?.status === "waiting_approval" &&
    parent.continuation?.pendingToolCall.toolId === "app.research.start" &&
    parent.continuation.pendingToolCall.executionId === caller.idempotencyKey;
  if (!parent || parent.ownerActorId !== caller.context.actorId ||
    (!["running", "resuming"].includes(parent.status) && !approvedPendingStart) || !parent.threadId) {
    throw new Error("The conversation is no longer active. Ask Asael to start research again in this conversation.");
  }
  const thread = await getOwnedThread(parent.threadId, { ...owner, requestActorBinding: binding });
  if (!thread) throw new Error("The research conversation is no longer available.");
  const identityPin = await getAgentRunIdentityPin(parent.id, owner);
  const harnesses = (await listStreamEvents(`run:${parent.id}`, { ...owner, limit: 2_000 }))
    .filter(event => event.type === "run.harness");
  if (!identityPin || harnesses.length !== 1 || identityPin.principalId !== scope.executingPrincipalId) {
    throw new Error("Research could not confirm this conversation's tool authority.");
  }
  const harness = harnesses[0].payload;
  const allowed = Array.isArray(harness.toolIds)
    ? harness.toolIds.filter((tool): tool is string => typeof tool === "string") : [];
  if (isResearchWebExplicitlyDisabled(parent.prompt) || isResearchWebExplicitlyDisabled(goal)) {
    throw new Error("This request restricts research to supplied sources or explicitly excludes the web. No background work was started. Continue from the permitted sources; do not use a browser to bypass that instruction.");
  }
  if (harness.contextScope === "personal") {
    throw new Error("This request uses personal context, which cannot be sent to public web research. No background work was started. Continue with the permitted private context, or ask for a separate public research brief without private details.");
  }
  const identity = await resolveAgentIdentityForExecution({ ...owner, agentId: identityPin.logicalAgentId });
  if (identity.definition.definitionSha256 !== identityPin.definitionSha256 ||
    identity.principal.principalSha256 !== identityPin.principalSha256 || identity.principal.state !== "active" ||
    (identity.principal.expiresAt !== null && Date.parse(identity.principal.expiresAt) <= Date.now()) ||
    identity.principal.principalId !== scope.executingPrincipalId) {
    throw new Error("The Agent's research permissions changed. Start a fresh conversation request.");
  }
  const currentlyAllowed = allowed.filter(tool => identity.principal.authorityMode !== "explicit_grants" ||
    identity.principal.toolGrantIds.includes(tool));
  if (harness.approvalPolicy === "read_only" || identity.principal.approvalPolicy === "read_only") {
    throw new Error("This Agent has a read-only policy, so it cannot create a background research job." +
      availableResearchRecovery(currentlyAllowed, true));
  }
  if (harness.autonomy === "assist" || identity.principal.autonomy === "assist") {
    throw new Error("This Agent is in assist mode, so it cannot start background work." +
      availableResearchRecovery(currentlyAllowed, true));
  }
  if (!currentlyAllowed.includes("app.research.start")) {
    throw new Error("Starting background research was not admitted for this request." +
      availableResearchRecovery(currentlyAllowed));
  }
  const missingTools = webTools.filter(tool => !currentlyAllowed.includes(tool));
  if (missingTools.length) {
    throw new Error(`Background research requires both web.search and web.read; this request is missing ${missingTools.join(" and ")}.` +
      availableResearchRecovery(currentlyAllowed));
  }
  const requestSha256 = canonicalJsonSha256({ goal, options, parentRunId: parent.id, threadId: parent.threadId,
    identityPinSha256: identityPin.pinSha256, context: "public_web" });
  const workflowId = deterministicWorkflowRunId(owner.tenantId, caller.idempotencyKey!);
  const sourceKey = `conversation-research:${workflowId}`;
  const existing = await getWorkflowRunDetail(workflowId, owner);
  if (existing && (existing.run.goal !== goal ||
    existing.run.input.metadata?.researchStartRequestSha256 !== requestSha256 ||
    existing.run.input.metadata?.source !== "conversation_research")) {
    throw new Error("This research request was already used for a different brief. Start a new request.");
  }
  const existingMissionId = existing?.run.input.metadata?.missionId;
  const existingTaskId = existing?.run.input.metadata?.missionTaskId;
  if (existing && (typeof existingMissionId !== "string" || typeof existingTaskId !== "string")) {
    // Root workflow authority is immutable. Reusing a pre-fix job must neither
    // rebind it nor create orphan missions while returning its old broken run.
    throw new Error("This saved research request has an incomplete work binding. Cancel it and start a new research request.");
  }
  const missionOwner = {
    ...owner, idempotencyKey: sourceKey,
    executionScope: deriveExecutionScope(scope, {
      purpose: "mission.orchestrate", contextGrantIds: [], workspaceId: null, projectId: null, missionId: null,
    }),
  };
  // Source keys are stable per governed execution, so a retry after any partial
  // initialization reuses the same owner-scoped mission, task and workflow.
  const mission = typeof existingMissionId === "string"
    ? await getMission(existingMissionId, missionOwner)
    : await createMission({
        ...missionOwner, title: goal.slice(0, 180), objective: goal, priority: "high", source: "talk", sourceKey,
        metadata: { threadId: parent.threadId, parentRunId: parent.id, route: "durable_workflow",
          source: "conversation_research", researchStartRequestSha256: requestSha256 },
      });
  if (!mission || mission.sourceKey !== sourceKey || mission.objective !== goal ||
    mission.metadata.researchStartRequestSha256 !== requestSha256) {
    throw new Error("The research mission no longer matches this request. Start a new research request.");
  }
  const taskOwner = { ...missionOwner,
    executionScope: deriveExecutionScope(missionOwner.executionScope, { purpose: "mission.orchestrate", missionId: mission.id }),
  };
  const missionTask = typeof existingTaskId === "string"
    ? await getMissionTask(existingTaskId, taskOwner)
    : await ensureMissionTask(mission.id, {
        sourceKey, title: goal.slice(0, 180), instructions: goal, priority: mission.priority, position: 1,
        definitionOfDone: "Deliver the requested research report in the conversation, cite public sources, and state evidence gaps honestly.",
        input: { threadId: parent.threadId, parentRunId: parent.id, route: "durable_workflow",
          workflowRunId: workflowId, researchStartRequestSha256: requestSha256 },
      }, taskOwner);
  if (!missionTask || missionTask.missionId !== mission.id || missionTask.sourceKey !== sourceKey ||
    missionTask.instructions !== goal || missionTask.input.researchStartRequestSha256 !== requestSha256) {
    throw new Error("The research task no longer matches this request. Start a new research request.");
  }
  const workflowScope = deriveExecutionScope(scope, {
    purpose: "workflow.run", contextGrantIds: [], workspaceId: null, projectId: null,
    missionId: mission.id, causationId: missionTask.id,
  });
  const detail = await createWorkflowRun({
    tenantId: owner.tenantId, idempotencyKey: caller.idempotencyKey, goal, mode: "research",
    requireApproval: identity.principal.approvalPolicy === "always", maxAttempts: 3,
    budgetLimits: WORKFLOW_RUN_BUDGET_LIMITS,
    executionAuthority: { executionScope: workflowScope, requesterRole: caller.context.role },
    metadata: {
      source: "conversation_research", actorId: owner.actorId, threadId: parent.threadId,
      parentRunId: parent.id, primaryAgentId: identity.definition.logicalAgentId,
      missionId: mission.id, missionTaskId: missionTask.id,
      contextScope: "none", researchStartRequestSha256: requestSha256,
      [RESEARCH_WORKFLOW_METADATA_KEY]: options,
      agentProfile: {
        name: identity.definition.name, role: identity.definition.role, description: identity.definition.description,
        instructions: identity.definition.instructions, persona: identity.definition.persona,
        modelPolicy: identity.definition.modelPolicy, autonomy: identity.principal.autonomy,
        approvalPolicy: identity.principal.approvalPolicy, memoryScope: "session", toolIds: [...webTools], skills: [],
      },
    },
  });
  if (detail.run.input.metadata?.researchStartRequestSha256 !== requestSha256 || detail.run.goal !== goal ||
    detail.run.input.metadata.missionId !== mission.id || detail.run.input.metadata.missionTaskId !== missionTask.id) {
    throw new Error("This research request was already used for a different brief. Start a new request.");
  }
  // An idempotent retry returns terminal or paused work without restarting it.
  if (detail.run.status === "queued" || detail.run.status === "running") {
    if (mission.status === "draft") await transitionMission(mission.id, "queued", taskOwner);
    await enqueueWorkflowRunTick(detail.run.id, "conversation_research_created", undefined, owner.tenantId);
    scheduleWorkflowQueueDrain(undefined, owner.tenantId);
  }
  return completeAppServiceCall(authorized, {
    workflowId: detail.run.id, status: detail.run.status,
    title: goal.slice(0, 180), depth: options.depth, threadId: parent.threadId,
    context: "public_web" as const,
    href: `/app/command?thread=${encodeURIComponent(parent.threadId)}`,
    message: detail.run.status === "queued" || detail.run.status === "running"
      ? "Research is running in this conversation using live public sources. Its final report will appear here."
      : `This research request is ${detail.run.status.replaceAll("_", " ")}. Its saved work remains in this conversation.`,
  });
}
