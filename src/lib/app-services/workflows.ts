import { z } from "zod";
import { WORKFLOW_RUN_BUDGET_LIMITS } from "@/lib/config";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { getOperationJobStats } from "@/lib/operations/job-queue";
import { narrowRunBudgetLimits, runBudgetCountersV1Schema } from "@/lib/runs/budgets";
import { redactSensitive } from "@/lib/security/context";
import { getWorkflowPlanNodeExecutionStats, listWorkflowPlanNodeExecutions } from "@/lib/workflows/executor";
import { buildDynamicWorkflowPlan, getWorkflowPlanStats, listWorkflowPlans } from "@/lib/workflows/planner";
import { publicWorkflowRun, publicWorkflowRunDetail, publicWorkflowStats } from "@/lib/workflows/public";
import { cancelWorkflowRunTick, enqueueWorkflowRunTick, processWorkflowQueue, scheduleWorkflowQueueDrain } from "@/lib/workflows/queue";
import { signalWorkflowRun } from "@/lib/workflows/runner";
import { createWorkflowRun, getWorkflowRunDetail, getWorkflowStats, listWorkflowRuns } from "@/lib/workflows/store";
import { DEFAULT_READ_ONLY_SCHEDULE_BUDGET } from "@/lib/workflows/schedule-defaults";
import {
  createReviewedWorkflowSchedule,
  listSchedulableWorkflowProcedures,
  listWorkflowScheduleOccurrenceReceipts,
  listWorkflowScheduleOccurrences,
  listWorkflowTriggers,
  previewWorkflowSchedule,
  runWorkflowScheduleOnce,
  setWorkflowSchedulePaused,
} from "@/lib/workflows/triggers";

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
const scheduleListSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
}).strict();
const scheduleCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  source: z.string().trim().min(1).max(120).optional(),
  procedureId: z.string().trim().min(1).max(240),
  agentId: z.string().trim().min(1).max(240),
  timezone: z.string().trim().min(1).max(120),
  rrule: z.string().trim().min(1).max(512),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).optional(),
  maxOccurrences: z.number().int().min(1).max(10_000).default(365),
  missedPolicy: z.enum(["skip", "run_once"]).default("skip"),
  occurrenceBudget: runBudgetCountersV1Schema.default(
    DEFAULT_READ_ONLY_SCHEDULE_BUDGET,
  ),
  failureLimit: z.number().int().min(1).max(20).default(3),
  replacesTriggerId: z.string().trim().min(1).max(240).optional(),
}).strict();
const scheduleControlSchema = z.discriminatedUnion("action", [
  z.object({
    triggerId: z.string().trim().min(1).max(240),
    action: z.literal("pause"),
    reason: z.string().trim().min(1).max(500).optional(),
  }).strict(),
  z.object({
    triggerId: z.string().trim().min(1).max(240),
    action: z.literal("resume"),
  }).strict(),
  z.object({
    triggerId: z.string().trim().min(1).max(240),
    action: z.literal("run_once"),
    scheduledFor: z.string().datetime({ offset: true }).optional(),
  }).strict(),
]);
const schedulePreviewSchema = z.object({
  triggerId: z.string().trim().min(1).max(240),
  count: z.number().int().min(1).max(12).default(3),
}).strict();

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

export async function listWorkflowSchedulesService(
  caller: AppServiceCaller,
  input: z.input<typeof scheduleListSchema>,
) {
  const value = scheduleListSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.workflows.schedules.list"),
  );
  const owner = {
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
  };
  const [triggers, procedures, occurrences, receipts] = await Promise.all([
    listWorkflowTriggers(value.limit, owner),
    listSchedulableWorkflowProcedures(owner),
    listWorkflowScheduleOccurrences({ ...owner, limit: value.limit }),
    listWorkflowScheduleOccurrenceReceipts({ ...owner, limit: value.limit }),
  ]);
  const schedules = triggers.filter((trigger) => trigger.triggerKind === "schedule");
  return completeAppServiceCall(authorized, {
    schedules,
    procedures,
    occurrences,
    receipts,
  }, { resourceCount: schedules.length });
}

export async function createWorkflowScheduleService(
  caller: AppServiceCaller,
  input: z.input<typeof scheduleCreateSchema>,
) {
  const value = scheduleCreateSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.workflows.schedules.create"),
  );
  const trigger = await createReviewedWorkflowSchedule({
    ...value,
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    executionScope: caller.executionScope!,
    idempotencyKey: caller.idempotencyKey!,
  });
  return completeAppServiceCall(authorized, { trigger }, { resourceCount: 1 });
}

export async function controlWorkflowScheduleService(
  caller: AppServiceCaller,
  input: z.input<typeof scheduleControlSchema>,
) {
  const value = scheduleControlSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.workflows.schedules.control"),
  );
  if (value.action === "run_once") {
    const occurrence = await runWorkflowScheduleOnce({
      tenantId: caller.context.tenantId,
      actorId: caller.context.actorId,
      triggerId: value.triggerId,
      scheduledFor: value.scheduledFor || new Date().toISOString(),
      executionScope: caller.executionScope!,
    });
    return completeAppServiceCall(authorized, { occurrence }, { resourceCount: 1 });
  }
  const trigger = await setWorkflowSchedulePaused({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    triggerId: value.triggerId,
    paused: value.action === "pause",
    reason: value.action === "pause" ? value.reason : undefined,
    executionScope: caller.executionScope!,
  });
  return completeAppServiceCall(authorized, { trigger }, { resourceCount: 1 });
}

export async function previewWorkflowScheduleService(
  caller: AppServiceCaller,
  input: z.input<typeof schedulePreviewSchema>,
) {
  const value = schedulePreviewSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.workflows.schedules.preview"),
  );
  const preview = await previewWorkflowSchedule({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    triggerId: value.triggerId,
    count: value.count,
  });
  return completeAppServiceCall(authorized, { preview }, { resourceCount: 1 });
}
