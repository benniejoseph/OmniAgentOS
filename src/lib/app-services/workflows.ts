import { z } from "zod";
import { WORKFLOW_RUN_BUDGET_LIMITS } from "@/lib/config";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { listCorrelatedEvents, listStreamEvents } from "@/lib/events/store";
import { getOperationJobStats } from "@/lib/operations/job-queue";
import { narrowRunBudgetLimits, runBudgetCountersV1Schema } from "@/lib/runs/budgets";
import { redactSensitive } from "@/lib/security/context";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { buildWorkflowTraceHierarchy } from "@/lib/trajectories/hierarchy";
import { getWorkflowPlanNodeExecutionStats, listWorkflowPlanNodeExecutions } from "@/lib/workflows/executor";
import { buildDynamicWorkflowPlan, getWorkflowPlanStats, listWorkflowPlans } from "@/lib/workflows/planner";
import { publicWorkflowRun, publicWorkflowRunDetail, publicWorkflowStats } from "@/lib/workflows/public";
import { cancelWorkflowRunTick, enqueueWorkflowRunTick, processWorkflowQueue, scheduleWorkflowQueueDrain } from "@/lib/workflows/queue";
import { signalWorkflowRun } from "@/lib/workflows/runner";
import { createWorkflowRun, getWorkflowRunDetail, getWorkflowRunExecutionAuthority, getWorkflowStats, listWorkflowRuns } from "@/lib/workflows/store";

const modeSchema = z.enum(["orchestrate", "research", "execute", "learn"]);
const listSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  includeStats: z.boolean().default(true),
  includeQueue: z.boolean().default(true),
}).strict();
const idSchema = z.object({ workflowId: z.string().trim().min(1).max(200) }).strict();
const plansListSchema = z.object({ limit: z.number().int().min(1).max(100).default(20) }).strict();
const executionsListSchema = z.object({ limit: z.number().int().min(1).max(200).default(50) }).strict();
const planSchema = z.object({
  goal: z.string().trim().min(1).max(4_000), mode: modeSchema.default("orchestrate"),
  requireApproval: z.boolean().default(false), reuseExisting: z.boolean().default(true),
}).strict();
const startSchema = z.object({
  goal: z.string().trim().min(1).max(4_000), mode: modeSchema.default("orchestrate"),
  requireApproval: z.boolean().default(false), maxAttempts: z.number().int().min(1).max(5).default(3),
  budgets: runBudgetCountersV1Schema.partial().optional(),
}).strict();
const signalSchema = idSchema.extend({ signal: z.enum(["pause", "resume", "cancel", "approve", "retry"]) }).strict();
const tickSchema = idSchema;

export async function listWorkflowsService(caller: AppServiceCaller, input: z.input<typeof listSchema>) {
  const value = listSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.workflows.list"));
  const owner = { tenantId: caller.context.tenantId };
  const [runs, stats, queue] = await Promise.all([
    listWorkflowRuns(value.limit, owner),
    value.includeStats ? getWorkflowStats(owner) : Promise.resolve(undefined),
    value.includeQueue ? getOperationJobStats(owner) : Promise.resolve(undefined),
  ]);
  const data = {
    runs: runs.map(publicWorkflowRun),
    ...(stats ? { stats: publicWorkflowStats(stats) } : {}),
    ...(queue ? { queue } : {}),
  };
  return completeAppServiceCall(authorized, data, { resourceCount: runs.length });
}

export async function showWorkflowService(caller: AppServiceCaller, input: z.input<typeof idSchema>) {
  const value = idSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.workflows.show"));
  const detail = await getWorkflowRunDetail(value.workflowId, { tenantId: caller.context.tenantId });
  return completeAppServiceCall(authorized, { workflow: detail ? publicWorkflowRunDetail(detail) : null }, { resourceCount: detail ? 1 : 0 });
}

export async function showWorkflowTrajectoryService(caller: AppServiceCaller, input: z.input<typeof idSchema>) {
  const value = idSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.workflows.trajectory"));
  const [detail, authority] = await Promise.all([
    getWorkflowRunDetail(value.workflowId, { tenantId: caller.context.tenantId }),
    getWorkflowRunExecutionAuthority(value.workflowId, { tenantId: caller.context.tenantId }),
  ]);
  if (!detail || !authority) return completeAppServiceCall(authorized, { traceHierarchy: null }, { resourceCount: 0 });
  const ownerActorId = authority.executionScope.initiatingActorId;
  const binding = canonicalRequestActorBindingFromSecurityContext(caller.context);
  if (ownerActorId !== caller.context.actorId && ownerActorId !== binding?.canonicalActorId) {
    throw new Error("Workflow run not found.");
  }
  const correlationId = authority.executionScope.correlationId;
  const [rootEvents, correlatedEvents] = await Promise.all([
    listStreamEvents(`workflow:${value.workflowId}`, { tenantId: caller.context.tenantId, actorId: ownerActorId, limit: 2_000 }),
    listCorrelatedEvents(correlationId, { tenantId: caller.context.tenantId, actorId: ownerActorId, limit: 2_000 }),
  ]);
  const events = [...new Map([...rootEvents, ...correlatedEvents].map((event) => [event.id, event])).values()];
  const traceHierarchy = buildWorkflowTraceHierarchy(detail.run, ownerActorId, events, correlationId);
  return completeAppServiceCall(authorized, { traceHierarchy }, { resourceCount: 1 });
}

export async function listWorkflowPlansService(caller: AppServiceCaller, input: z.input<typeof plansListSchema>) {
  const value = plansListSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.workflows.plans.list"));
  const owner = { tenantId: caller.context.tenantId };
  const [plans, stats] = await Promise.all([listWorkflowPlans(value.limit, owner), getWorkflowPlanStats(owner)]);
  return completeAppServiceCall(authorized, { plans, stats }, { resourceCount: plans.length });
}

export async function planWorkflowService(caller: AppServiceCaller, input: z.input<typeof planSchema>) {
  const value = redactSensitive(planSchema.parse(input)) as z.output<typeof planSchema>;
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.workflows.plan"));
  const plan = await buildDynamicWorkflowPlan({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    goal: value.goal,
    mode: value.mode,
    requireApproval: value.requireApproval,
    reuseExisting: value.reuseExisting,
    source: "api",
    executionScope: caller.executionScope!,
  });
  return completeAppServiceCall(authorized, { plan, stats: await getWorkflowPlanStats({ tenantId: caller.context.tenantId }) });
}

export async function listWorkflowExecutionsService(caller: AppServiceCaller, input: z.input<typeof executionsListSchema>) {
  const value = executionsListSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.workflows.executions.list"));
  const owner = { tenantId: caller.context.tenantId };
  const [executions, stats] = await Promise.all([listWorkflowPlanNodeExecutions(value.limit, owner), getWorkflowPlanNodeExecutionStats(owner)]);
  return completeAppServiceCall(authorized, { executions, stats }, { resourceCount: executions.length });
}

export async function startWorkflowService(caller: AppServiceCaller, input: z.input<typeof startSchema>) {
  const value = redactSensitive(startSchema.parse(input)) as z.output<typeof startSchema>;
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.workflows.start"));
  const budgetLimits = narrowRunBudgetLimits(WORKFLOW_RUN_BUDGET_LIMITS, value.budgets);
  const detail = await createWorkflowRun({
    tenantId: caller.context.tenantId,
    idempotencyKey: caller.idempotencyKey,
    goal: value.goal,
    mode: value.mode,
    requireApproval: value.requireApproval,
    maxAttempts: value.maxAttempts,
    budgetLimits,
    metadata: { actorId: caller.context.actorId },
    executionAuthority: { executionScope: caller.executionScope!, requesterRole: caller.context.role },
  });
  const queueJob = await enqueueWorkflowRunTick(detail.run.id, "app_workflow_created", undefined, caller.context.tenantId);
  scheduleWorkflowQueueDrain(undefined, caller.context.tenantId);
  return completeAppServiceCall(authorized, { ...publicWorkflowRunDetail(detail), queueJob });
}

export async function signalWorkflowService(caller: AppServiceCaller, input: z.input<typeof signalSchema>) {
  const value = signalSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.workflows.signal"));
  const detail = await signalWorkflowRun(value.workflowId, value.signal, {
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    executionScope: caller.executionScope!,
  });
  const canceledJobs = value.signal === "pause" || value.signal === "cancel"
    ? await cancelWorkflowRunTick(value.workflowId, `Workflow ${value.signal} signal received.`, caller.context.tenantId)
    : undefined;
  const queueJob = value.signal === "resume" || value.signal === "approve" || value.signal === "retry"
    ? await enqueueWorkflowRunTick(value.workflowId, `workflow_${value.signal}`, undefined, caller.context.tenantId)
    : undefined;
  if (queueJob) scheduleWorkflowQueueDrain(undefined, caller.context.tenantId);
  return completeAppServiceCall(authorized, { ...publicWorkflowRunDetail(detail), queueJob, canceledJobs });
}

export async function tickWorkflowService(caller: AppServiceCaller, input: z.input<typeof tickSchema>) {
  const value = tickSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.workflows.tick"));
  const queue = await processWorkflowQueue({ workflowRunId: value.workflowId, limit: 1, bootstrapQueuedRuns: false, tenantId: caller.context.tenantId });
  const detail = await getWorkflowRunDetail(value.workflowId, { tenantId: caller.context.tenantId });
  return completeAppServiceCall(authorized, { workflow: detail ? publicWorkflowRunDetail(detail) : null, queue }, { resourceCount: detail ? 1 : 0 });
}
