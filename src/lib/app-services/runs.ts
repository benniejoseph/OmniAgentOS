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
  getRunContextUseReceipt,
  getRunStats,
  listAgentRuns,
  recordAgentRunFeedback,
} from "@/lib/runs/store";
import { listRunBrowserActivity } from "@/lib/runs/activity";
import { listRunForkLineage } from "@/lib/runs/fork-store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { getOwnedThread } from "@/lib/threads/store";
import { getGovernedTool } from "@/lib/tools/registry";
import { buildRunTrajectory } from "@/lib/trajectories/builder";
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
  const value = runShowServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.runs.show"));
  const [run, contextReceipt, agentIdentity] = await Promise.all([
    getAgentRun(value.runId, { tenantId: caller.context.tenantId }),
    getRunContextUseReceipt(value.runId, { tenantId: caller.context.tenantId }),
    getAgentIdentityCardForRun(value.runId, { tenantId: caller.context.tenantId }),
  ]);
  await assertRunReadable(run, caller);
  return completeAppServiceCall(authorized, {
    run: run ? publicAgentRun(run) : null,
    contextReceipt: run ? contextReceipt : null,
    agentIdentity: run ? agentIdentity : null,
  }, { resourceCount: run ? 1 : 0 });
}

export async function inspectRunActivityService(
  caller: AppServiceCaller,
  input: z.input<typeof runInspectionServiceInputSchema>,
) {
  const value = runInspectionServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.runs.activity"));
  const run = await getAgentRun(value.runId, { tenantId: caller.context.tenantId });
  await assertRunReadable(run, caller);
  const browserActivity = run
    ? await listRunBrowserActivity(run.id, { tenantId: caller.context.tenantId, actorId: caller.context.actorId })
    : [];
  return completeAppServiceCall(authorized, {
    runId: run?.id || value.runId,
    status: run?.status || null,
    browserActivity,
  }, { resourceCount: browserActivity.length });
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
  const traceEvents = [...new Map([...runEvents, ...correlatedEvents].map((event) => [event.id, event])).values()];
  const trajectory = buildRunTrajectory(run, runEvents);
  const verification = verifyRunTrajectory(trajectory, run);
  return completeAppServiceCall(authorized, {
    trajectory,
    verification,
    traceHierarchy: buildRunTraceHierarchy(run, traceEvents, correlationId),
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
  return completeAppServiceCall(authorized, { run: publicAgentRun(current), canceledJobs: canceledJobs.length });
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
      requestActorBinding: canonicalRequestActorBindingFromSecurityContext(caller.context),
    });
    if (!thread) throw new Error("Run not found.");
    return;
  }
  const binding = canonicalRequestActorBindingFromSecurityContext(caller.context);
  if (run.ownerActorId !== caller.context.actorId && run.ownerActorId !== binding?.canonicalActorId) {
    throw new Error("Run not found.");
  }
}
