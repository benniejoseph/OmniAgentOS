import { cancelParentDependentWork } from "@/lib/delegation/parent-continuation-cancel";
import { readParentContinuationProgress } from "@/lib/delegation/parent-continuation-progress";
import { buildExecutionFailureFixture, compareExecutionBehavior, executionImprovementComparisonInputSchema } from "@/lib/agents/execution-improvement";
import { getToolExecutionsByIds } from "@/lib/tools/audit-store";
import { getToolExecutionScopeBinding } from "@/lib/tools/execution-scope";
import { appServiceActorBinding } from "@/lib/app-services/contracts";
import { z } from "zod";
import { getAgentIdentityCardForRun } from "@/lib/agents/card-store";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { publicAgentRun } from "@/lib/runs/public";
import { getMcpGovernedTool, getOpenApiGovernedTool } from "@/lib/connectors/governed-tools";
import { listCorrelatedEvents, listStreamEvents } from "@/lib/events/store";
import { applyRunMemoryFeedback } from "@/lib/memory/store";
import { syncMissionExecutorSafely } from "@/lib/missions/runtime";
import { cancelOperationJobByDedupeKey, getAgentExecuteJobDedupeKey, getAgentResumeJobDedupeKey } from "@/lib/operations/job-queue";
import {
  appendRunEvent,
  cancelAgentRun,
  getAgentRun,
  getAgentRunResearchProgress,
  getAgentRunWorkflowHandoff,
  getRunContextUseReceipt,
  getRunStats,
  listAgentRuns,
  recordAgentRunFeedback,
} from "@/lib/runs/store";
import { listRunForkLineage } from "@/lib/runs/fork-store";
import { getOwnedThread } from "@/lib/threads/store";
import { getGovernedTool } from "@/lib/tools/registry";
import { buildRunTrajectory } from "@/lib/trajectories/builder";
import { buildConversationProgressV1 } from "@/lib/trajectories/conversation-progress";
import { evaluateTrajectoryOutcome } from "@/lib/trajectories/evaluate";
import { buildRunTraceHierarchy, resolveRunCorrelationId } from "@/lib/trajectories/hierarchy";
import { verifyRunTrajectory } from "@/lib/trajectories/verify";
import { actionClassFor, recordActionOutcome } from "@/lib/trust/ledger";

export const runListServiceInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  includeStats: z.boolean().default(false),
}).strict();

export const runShowServiceInputSchema = z.object({ runId: z.string().trim().min(1).max(200) }).strict();
export const runInspectionServiceInputSchema = runShowServiceInputSchema;
export const runFeedbackServiceInputSchema = z.object({
  runId: z.string().trim().min(1).max(200), verdict: z.enum(["useful", "needs_work"]),
  correction: z.string().trim().max(2_000).optional(),
}).strict();
export const runCancelServiceInputSchema = z.object({
  runId: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(500).default("Canceled by the operator."),
}).strict();

export async function listRunsService(
  caller: AppServiceCaller,
  input: z.input<typeof runListServiceInputSchema>,
) {
  const value = runListServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("runs.list"),
  );
  const owner = { tenantId: caller.context.tenantId };
  const [runs, stats] = await Promise.all([
    listAgentRuns(value.limit, owner),
    value.includeStats ? getRunStats(owner) : Promise.resolve(undefined),
  ]);
  const publicRuns = runs.map(publicAgentRun);
  return completeAppServiceCall(authorized, {
    runs: publicRuns,
    ...(stats
      ? {
          stats: {
            ...stats,
            latest: stats.latest.map(publicAgentRun),
          },
        }
      : {}),
  }, { resourceCount: publicRuns.length });
}

export async function showRunService(
  caller: AppServiceCaller,
  input: z.input<typeof runShowServiceInputSchema>,
) {
  return (await showRunServiceWithRecord(caller, input)).result;
}

/**
 * Route-only variant that keeps the authorized store record in server memory
 * so artifact/status projections do not issue the same full run query again.
 * The public app-service payload and receipt remain unchanged.
 */
export async function showRunServiceWithRecord(
  caller: AppServiceCaller,
  input: z.input<typeof runShowServiceInputSchema>,
) {
  const value = runShowServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.runs.show"));
  const [run, contextReceipt, agentIdentity] = await Promise.all([
    getAgentRun(value.runId, { tenantId: caller.context.tenantId }),
    getRunContextUseReceipt(value.runId, { tenantId: caller.context.tenantId }),
    getAgentIdentityCardForRun(value.runId, { tenantId: caller.context.tenantId }),
  ]);
  await assertRunReadable(run, caller);
  const supportsResearchProgress = caller.context.source !== "mobile" ||
    (caller.context.native?.clientContractVersion ?? 0) >= 49;
  const researchProgress = run?.mode === "research" && supportsResearchProgress
    ? await getAgentRunResearchProgress(run.id, {
        tenantId: caller.context.tenantId,
        actorId: run.ownerActorId,
      })
    : undefined;
  const supportsWorkflowHandoff = caller.context.source !== "mobile" ||
    (caller.context.native?.clientContractVersion ?? 0) >= 52;
  const workflowHandoff = run?.status === "completed" && supportsWorkflowHandoff
    ? await getAgentRunWorkflowHandoff(run.id, { tenantId: caller.context.tenantId, actorId: run.ownerActorId })
    : undefined;
  const canonicalActorId = appServiceActorBinding(caller)?.canonicalActorId;
  const parentHandoff = run?.status === "completed" && run.threadId && canonicalActorId && supportsWorkflowHandoff && !workflowHandoff
    ? await readParentContinuationProgress({ tenantId: caller.context.tenantId, ownerActorId: run.ownerActorId,
        canonicalActorId, runId: run.id, threadId: run.threadId }) : undefined;
  const result = completeAppServiceCall(authorized, {
    run: run ? {
      ...publicAgentRun(run), ...(researchProgress ? { researchProgress } : {}),
      ...(workflowHandoff ? { delegatedWork: {
        workflowId: workflowHandoff.workflowId, threadId: workflowHandoff.threadId, status: "accepted" as const,
      } } : {}),
      ...(parentHandoff ? { delegatedWork: parentHandoff } : {}),
    } : null,
    contextReceipt: run ? contextReceipt : null,
    agentIdentity: run ? agentIdentity : null,
  }, { resourceCount: run ? 1 : 0 });
  return { result, run };
}

export async function inspectRunTrajectoryService(
  caller: AppServiceCaller,
  input: z.input<typeof runInspectionServiceInputSchema>,
) {
  const value = runInspectionServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.runs.trajectory"));
  const run = await getAgentRun(value.runId, { tenantId: caller.context.tenantId });
  await assertRunReadable(run, caller);
  if (!run) return completeAppServiceCall(authorized, { trajectory: null }, { resourceCount: 0 });
  const runEvents = await listStreamEvents(`run:${run.id}`, { tenantId: caller.context.tenantId, actorId: run.ownerActorId, limit: 2_000 });
  const correlationId = resolveRunCorrelationId(run, runEvents);
  const correlatedEvents = await listCorrelatedEvents(correlationId, { tenantId: caller.context.tenantId, actorId: run.ownerActorId, limit: 2_000 });
  const threadEvents = run.threadId
    ? await listStreamEvents(`thread:${run.threadId}`, { tenantId: caller.context.tenantId, actorId: run.ownerActorId, limit: 2_000 })
    : [];
  const agentIdentity = await getAgentIdentityCardForRun(run.id, { tenantId: caller.context.tenantId });
  const traceEvents = [...new Map([...runEvents, ...correlatedEvents].map((event) => [event.id, event])).values()];
  const conversationEvents = [...new Map(
    [...traceEvents, ...threadEvents].map((event) => [event.id, event]),
  ).values()];
  const trajectory = buildRunTrajectory(run, runEvents);
  const verification = verifyRunTrajectory(trajectory, run);
  const conversationProgress = buildConversationProgressV1({
    run,
    events: conversationEvents,
    correlationId,
    agentIdentity,
  });
  return completeAppServiceCall(authorized, {
    trajectory,
    verification,
    traceHierarchy: buildRunTraceHierarchy(run, traceEvents, correlationId),
    conversationProgress,
    lineage: await listRunForkLineage(run.id, { tenantId: caller.context.tenantId }),
    outcomeEvaluation: evaluateTrajectoryOutcome(trajectory, verification),
  }, { resourceCount: 1 });
}

export async function recordRunFeedbackService(
  caller: AppServiceCaller,
  input: z.input<typeof runFeedbackServiceInputSchema>,
) {
  const value = runFeedbackServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.runs.feedback"));
  const run = await getAgentRun(value.runId, { tenantId: caller.context.tenantId });
  await assertRunReadable(run, caller);
  if (!run) return completeAppServiceCall(authorized, { run: null }, { resourceCount: 0 });
  if (run.status !== "completed") throw new Error("Feedback is available only after a run completes.");
  const feedback = { verdict: value.verdict, correction: value.correction };
  const updated = await recordAgentRunFeedback(value.runId, feedback, {
    tenantId: caller.context.tenantId,
    executionScope: caller.executionScope,
  });
  const affectedMemoryIds = await applyRunMemoryFeedback(value.runId, value.verdict, {
    tenantId: caller.context.tenantId,
    executionScope: caller.executionScope,
  });
  const enteredNeedsWork = value.verdict === "needs_work" && run.feedback?.verdict !== "needs_work";
  const demotedCapabilities = enteredNeedsWork
    ? await demoteRunCapabilities(value.runId, caller.context.tenantId)
    : [];
  return completeAppServiceCall(authorized, {
    run: publicAgentRun(updated || run),
    feedbackEffects: {
      disposition: value.verdict === "useful" ? "reinforced" : "quarantined",
      affectedMemories: affectedMemoryIds.length,
      demotedCapabilities,
    },
  });
}

export async function cancelRunService(
  caller: AppServiceCaller,
  input: z.input<typeof runCancelServiceInputSchema>,
) {
  const value = runCancelServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.runs.cancel"));
  const owner = { tenantId: caller.context.tenantId };
  const run = await getAgentRun(value.runId, owner);
  await assertRunReadable(run, caller);
  if (!run) return completeAppServiceCall(authorized, { run: null, canceledJobs: 0 }, { resourceCount: 0 });
  const terminal = ["completed", "failed", "canceled"].includes(run.status);
  if (!terminal) {
    await cancelAgentRun(run.id, value.reason, {
      ...owner,
      executionScope: caller.executionScope,
      runContractEnvelope: run.continuation?.runContractEnvelope,
    });
  }
  const executionId = run.continuation?.pendingToolCall.executionId;
  const canceledJobs = executionId
    ? await cancelOperationJobByDedupeKey(getAgentResumeJobDedupeKey(executionId), value.reason, owner)
    : [];
  canceledJobs.push(...await cancelOperationJobByDedupeKey(getAgentExecuteJobDedupeKey(run.id), value.reason, owner));
  const actorBinding = appServiceActorBinding(caller);
  const dependentWork = run.agentId === "atlas" && actorBinding && caller.executionScope && caller.idempotencyKey
    ? await cancelParentDependentWork({ tenantId: caller.context.tenantId, actorId: actorBinding.canonicalActorId,
        parentRunId: run.id, reason: value.reason, executionScope: caller.executionScope, idempotencyKey: caller.idempotencyKey })
    : { canceledJobs: 0, unresolved: [] };
  const current = await getAgentRun(run.id, owner) || run;
  if (current.status === "canceled") {
    await ensureRunCancellationEvent(current.id, current.error || value.reason, caller.context.tenantId, run.continuation);
    await syncMissionExecutorSafely({ executorType: "agent_run", executorId: current.id, status: "canceled" }, {
      tenantId: caller.context.tenantId,
      actorId: caller.context.actorId,
      executionScope: caller.executionScope!,
      idempotencyKey: caller.idempotencyKey!,
    });
  }
  return completeAppServiceCall(authorized, { run: publicAgentRun(current), canceledJobs: canceledJobs.length + dependentWork.canceledJobs, dependentWork });
}

async function ensureRunCancellationEvent(
  runId: string,
  message: string,
  tenantId: string,
  continuation?: NonNullable<Awaited<ReturnType<typeof getAgentRun>>>["continuation"],
) {
  const events = await listStreamEvents(`run:${runId}`, { tenantId });
  if (events.some((event) => event.type === "run.canceled")) return;
  await appendRunEvent(runId, { type: "canceled", message }, {
    tenantId,
    executionScope: continuation?.executionScope,
    runContractEnvelope: continuation?.runContractEnvelope,
  });
}

async function demoteRunCapabilities(runId: string, tenantId: string) {
  const events = await listStreamEvents(`run:${runId}`, { tenantId, limit: 2_000 });
  const toolIds = [...new Set(events.flatMap((event) =>
    event.type === "run.tool" && event.payload.status === "executed" && typeof event.payload.toolId === "string"
      ? [event.payload.toolId]
      : [],
  ))].slice(0, 20);
  const demoted: string[] = [];
  for (const toolId of toolIds) {
    const tool = getGovernedTool(toolId) || await getMcpGovernedTool(toolId, { tenantId }) || await getOpenApiGovernedTool(toolId, { tenantId });
    if (!tool || (!tool.approvalRequired && tool.riskLevel < 2)) continue;
    await recordActionOutcome({
      actionClass: actionClassFor(tool.id), toolId: tool.id, tenantId,
      kind: "rejected", reversible: tool.reversible === true, riskLevel: tool.riskLevel, humanApproved: false,
    });
    demoted.push(tool.id);
  }
  return demoted;
}

async function assertRunReadable(
  run: Awaited<ReturnType<typeof getAgentRun>>,
  caller: AppServiceCaller,
) {
  if (!run) return;
  if (run.threadId) {
    const thread = await getOwnedThread(run.threadId, {
      tenantId: caller.context.tenantId,
      actorId: caller.context.actorId,
      requestActorBinding: appServiceActorBinding(caller),
    });
    if (!thread) throw new Error("Run not found.");
    return;
  }
  const binding = appServiceActorBinding(caller);
  if (run.ownerActorId !== caller.context.actorId && run.ownerActorId !== binding?.canonicalActorId) {
    throw new Error("Run not found.");
  }
}

/** Reads only exact owner-bound receipts; creating a fixture never replays work. */
async function improvementRun(caller: AppServiceCaller, runId: string) {
  const run = await getAgentRun(runId, { tenantId: caller.context.tenantId });
  await assertRunReadable(run, caller);
  if (!run) throw new Error("Run not found.");
  const events = await listStreamEvents(`run:${run.id}`, { tenantId: caller.context.tenantId, actorId: run.ownerActorId, limit: 2_000 });
  const ids = [...new Set(events.flatMap(event => event.type === "run.tool" && typeof event.payload.executionId === "string" ? [event.payload.executionId] : []))];
  const records = await getToolExecutionsByIds(ids, { tenantId: caller.context.tenantId });
  const receipts: typeof records = [];
  for (const record of records) {
    const binding = await getToolExecutionScopeBinding(record.id, { tenantId: caller.context.tenantId });
    if (record.tenantId === caller.context.tenantId && record.actorId === run.ownerActorId && binding?.toolId === record.toolId &&
        binding.executionScope.correlationId === run.id && binding.executionScope.initiatingActorId === run.ownerActorId) receipts.push(record);
  }
  return { run, receipts };
}

export async function prepareExecutionImprovementService(caller: AppServiceCaller, input: unknown) {
  const value = runShowServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.agents.improvements.prepare"));
  const { run, receipts } = await improvementRun(caller, value.runId);
  return completeAppServiceCall(authorized, { fixture: buildExecutionFailureFixture(run, receipts) });
}

export async function compareExecutionImprovementService(caller: AppServiceCaller, input: unknown) {
  const value = executionImprovementComparisonInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.agents.improvements.compare"));
  const baseline = await improvementRun(caller, value.baselineRunId);
  const candidate = await improvementRun(caller, value.candidateRunId);
  return completeAppServiceCall(authorized, { comparison: compareExecutionBehavior({ baseline: baseline.run, candidate: candidate.run,
    baselineReceipts: baseline.receipts, candidateReceipts: candidate.receipts, assertions: value.assertions }) });
}
