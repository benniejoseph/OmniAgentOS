import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  jsonBodyErrorResponse,
  parseBoundedInteger,
  parseJsonBody,
} from "@/lib/http/body";
import { redactSensitive } from "@/lib/security/context";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { getOperationJobStats } from "@/lib/operations/job-queue";
import { enqueueWorkflowRunTick, scheduleWorkflowQueueDrain } from "@/lib/workflows/queue";
import {
  createWorkflowRun,
  getWorkflowRunDetail,
  getWorkflowStats,
  listWorkflowRuns,
  transitionWorkflowRun,
} from "@/lib/workflows/store";
import {
  claimWorkflowPlanForRun,
  getWorkflowPlanById,
  validateWorkflowPlan,
} from "@/lib/workflows/planner";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const workflowStartSchema = z.object({
  goal: z.string().min(1).max(4000),
  mode: z.enum(["orchestrate", "research", "execute", "learn"]).optional(),
  planId: z.string().min(1).max(120).optional(),
  requireApproval: z.boolean().optional(),
  maxAttempts: z.number().int().min(1).max(5).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "workflow",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const url = new URL(request.url);
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 20, {
    max: 100,
  });
  const includeStats = url.searchParams.get("stats") !== "false";
  const includeQueue = url.searchParams.get("queue") !== "false";
  const [runs, stats, queue] = await Promise.all([
    listWorkflowRuns(limit, { tenantId: context.tenantId }),
    includeStats
      ? getWorkflowStats({ tenantId: context.tenantId })
      : Promise.resolve(undefined),
    includeQueue
      ? getOperationJobStats({ tenantId: context.tenantId })
      : Promise.resolve(undefined),
  ]);
  return Response.json({
    runs,
    ...(stats ? { stats } : {}),
    ...(queue ? { queue } : {}),
  });
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = workflowStartSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid workflow start request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  let idempotencyKey: string | undefined;
  try {
    idempotencyKey = requestIdempotencyKey(request);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid Idempotency-Key." },
      { status: 400 },
    );
  }

  try {
    const context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "workflow",
      metadata: {
        goalLength: parsed.data.goal.length,
        mode: parsed.data.mode || "orchestrate",
        planId: parsed.data.planId,
        requireApproval: Boolean(parsed.data.requireApproval),
        metadataKeys: Object.keys(parsed.data.metadata || {}).slice(0, 50),
      },
    });
    const selectedPlan = parsed.data.planId
      ? await getWorkflowPlanById(parsed.data.planId, {
          tenantId: context.tenantId,
        })
      : undefined;
    if (parsed.data.planId && !selectedPlan) {
      return Response.json(
        { error: "The selected workflow plan was not found for this workspace." },
        { status: 404 },
      );
    }
    if (
      selectedPlan &&
      (
        selectedPlan.status !== "planned" ||
        normalizedWorkflowGoal(selectedPlan.goal) !==
          normalizedWorkflowGoal(parsed.data.goal) ||
        selectedPlan.plan.mode !== (parsed.data.mode || "orchestrate")
      )
    ) {
      return Response.json(
        {
          error: "The selected workflow plan no longer matches this run.",
          message: "Generate a fresh plan after changing the goal or mode.",
        },
        { status: 409 },
      );
    }
    if (selectedPlan) {
      const validation = validateWorkflowPlan(selectedPlan.plan);
      const missingExecutableInput = validation.policyWarnings.some((warning) =>
        warning.startsWith("Missing executable input"),
      );
      if (
        !validation.isDag ||
        validation.missingDependencies.length > 0 ||
        missingExecutableInput
      ) {
        return Response.json(
          {
            error: "The selected workflow plan cannot be executed safely.",
            message: missingExecutableInput
              ? "Generate a fresh plan so connector inputs can be reviewed before execution."
              : "Generate a fresh plan because the stored plan structure is invalid.",
          },
          { status: 409 },
        );
      }
    }
    if (selectedPlan?.workflowRunId) {
      const existing = await getWorkflowRunDetail(selectedPlan.workflowRunId, {
        tenantId: context.tenantId,
      });
      if (!existing) {
        return Response.json(
          {
            error: "The selected workflow plan has an invalid run binding.",
            message: "Generate a fresh plan and contact an administrator if this repeats.",
          },
          { status: 409 },
        );
      }
      const queueJob = existing.run.status === "queued"
        ? await enqueueWorkflowRunTick(
            existing.run.id,
            "workflow_create_replay",
            undefined,
            context.tenantId,
          )
        : undefined;
      if (queueJob) {
        scheduleWorkflowQueueDrain(undefined, context.tenantId);
      }
      return Response.json({ ...existing, queueJob, replayed: true });
    }
    const detail = await createWorkflowRun({
      ...parsed.data,
      idempotencyKey: selectedPlan
        ? `reviewed-plan:${selectedPlan.id}`
        : idempotencyKey,
      requireApproval:
        Boolean(parsed.data.requireApproval) ||
        Boolean(selectedPlan?.approvalRequired),
      tenantId: context.tenantId,
    });
    if (
      idempotencyKey &&
      !selectedPlan &&
      !workflowRequestMatches(detail.run.input, parsed.data)
    ) {
      return Response.json(
        {
          error: "Idempotency-Key was already used for a different workflow request.",
          message: "Use a new idempotency key when the goal or execution options change.",
        },
        { status: 409 },
      );
    }
    if (selectedPlan) {
      const claimedPlan = await claimWorkflowPlanForRun({
        planId: selectedPlan.id,
        workflowRunId: detail.run.id,
        tenantId: context.tenantId,
      });
      if (!claimedPlan) {
        const concurrentlyClaimedPlan = await getWorkflowPlanById(selectedPlan.id, {
          tenantId: context.tenantId,
        });
        if (concurrentlyClaimedPlan?.workflowRunId === detail.run.id) {
          const queueJob = await enqueueWorkflowRunTick(
            detail.run.id,
            "workflow_create_replay",
            undefined,
            context.tenantId,
          );
          scheduleWorkflowQueueDrain(undefined, context.tenantId);
          return Response.json({ ...detail, queueJob, replayed: true });
        }
        await transitionWorkflowRun(
          detail.run.id,
          ["queued"],
          {
            status: "canceled",
            error: "The selected plan was claimed by another workflow.",
            canceledAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          },
          { tenantId: context.tenantId },
        );
        return Response.json(
          {
            error: "The selected workflow plan was already used.",
            message: "Generate a fresh plan and try again.",
          },
          { status: 409 },
        );
      }
    }
    const queueJob = await enqueueWorkflowRunTick(
      detail.run.id,
      "workflow_created",
      undefined,
      context.tenantId,
    );
    scheduleWorkflowQueueDrain(undefined, context.tenantId);
    return Response.json({ ...detail, queueJob }, { status: 201 });
  } catch (error) {
    return forbiddenResponse(error);
  }
}

function requestIdempotencyKey(request: Request) {
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value) {
    return undefined;
  }
  if (value.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error(
      "Idempotency-Key must be 200 characters or fewer and use letters, numbers, dot, underscore, colon, or hyphen.",
    );
  }
  return value;
}

function workflowRequestMatches(
  existing: {
    goal: string;
    mode?: "orchestrate" | "research" | "execute" | "learn";
    requireApproval?: boolean;
    maxAttempts?: number;
    metadata?: Record<string, unknown>;
  },
  requested: z.infer<typeof workflowStartSchema>,
) {
  const safeExisting = redactSensitive(existing) as typeof existing;
  const safeRequested = redactSensitive(requested) as typeof requested;
  return (
    normalizedWorkflowGoal(safeExisting.goal) ===
      normalizedWorkflowGoal(safeRequested.goal) &&
    (safeExisting.mode || "orchestrate") ===
      (safeRequested.mode || "orchestrate") &&
    (safeExisting.requireApproval ?? true) ===
      (safeRequested.requireApproval ?? true) &&
    (safeExisting.maxAttempts ?? 3) === (safeRequested.maxAttempts ?? 3) &&
    stableJson(safeExisting.metadata ?? null) ===
      stableJson(safeRequested.metadata ?? null)
  );
}

function normalizedWorkflowGoal(value: string) {
  return String(redactSensitive(value.trim()));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
