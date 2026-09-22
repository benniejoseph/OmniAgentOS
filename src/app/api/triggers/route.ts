import { randomUUID } from "node:crypto";
import { z } from "zod";
import { arsenalAgents } from "@/lib/agents/arsenal";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  jsonBodyErrorResponse,
  parseBoundedInteger,
  parseJsonBody,
} from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { listCustomAgentsForRequest } from "@/lib/skills/store";
import {
  createReviewedWorkflowSchedule,
  createWorkflowTrigger,
  DEFAULT_READ_ONLY_SCHEDULE_BUDGET,
  getWorkflowTriggerStats,
  listSchedulableWorkflowProcedures,
  listWorkflowScheduleOccurrenceReceipts,
  listWorkflowScheduleOccurrences,
  listWorkflowTriggerEvents,
  listWorkflowTriggers,
} from "@/lib/workflows/triggers";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const webhookTriggerSchema = z.object({
  triggerKind: z.literal("webhook").optional(),
  name: z.string().min(1).max(120),
  source: z.string().min(1).max(120).optional(),
  status: z.enum(["active", "paused"]).optional(),
  authMode: z.enum(["none", "hmac_sha256"]).optional(),
  secretEnvVar: z.string().min(1).max(120).optional(),
  goalTemplate: z.string().min(1).max(1200).optional(),
  workflowMode: z.enum(["orchestrate", "research", "execute", "learn"]).optional(),
  requireApproval: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const scheduleTriggerSchema = z.object({
  triggerKind: z.literal("schedule"),
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
  occurrenceBudget: z.object({
    modelTurns: z.number().int().min(0),
    tokens: z.number().int().min(0),
    costMicrousd: z.number().int().min(0),
    wallTimeMs: z.number().int().min(0),
    toolCalls: z.number().int().min(0),
    browserActions: z.number().int().min(0),
    agents: z.number().int().min(0),
    fanOut: z.number().int().min(0),
    retries: z.number().int().min(0),
    replans: z.number().int().min(0),
  }).strict().optional(),
  failureLimit: z.number().int().min(1).max(20).default(3),
  replacesTriggerId: z.string().trim().min(1).max(240).optional(),
}).strict();

const triggerSchema = z.union([scheduleTriggerSchema, webhookTriggerSchema]);

async function GETHandler(request: Request) {
  const url = new URL(request.url);
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 50, {
    max: 200,
  });

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "workflow_trigger",
      metadata: { limit },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const [triggers, events, stats, procedures, occurrences, receipts, customAgents] =
    await Promise.all([
      listWorkflowTriggers(limit, {
        tenantId: context.tenantId,
        actorId: context.actorId,
      }),
      listWorkflowTriggerEvents(limit, {
        tenantId: context.tenantId,
        actorId: context.actorId,
      }),
      getWorkflowTriggerStats({
        tenantId: context.tenantId,
        actorId: context.actorId,
      }),
      listSchedulableWorkflowProcedures({
        tenantId: context.tenantId,
        actorId: context.actorId,
      }),
      listWorkflowScheduleOccurrences({
        tenantId: context.tenantId,
        actorId: context.actorId,
        limit,
      }),
      listWorkflowScheduleOccurrenceReceipts({
        tenantId: context.tenantId,
        actorId: context.actorId,
        limit,
      }),
      listCustomAgentsForRequest({
        tenantId: context.tenantId,
        actorId: context.actorId,
        requestActorBinding:
          canonicalRequestActorBindingFromSecurityContext(context),
      }),
    ]);
  return Response.json({
    triggers,
    events,
    stats,
    procedures,
    agents: [
      ...arsenalAgents.map(({ id, name, role, status }) => ({
        id,
        name,
        role,
        status,
        builtIn: true,
      })),
      ...customAgents
        .filter((agent) => agent.selectable)
        .map(({ id, name, role, status }) => ({
          id,
          name,
          role,
          status,
          builtIn: false,
        })),
    ],
    occurrences,
    receipts,
    scheduleDefaults: {
      occurrenceBudget: DEFAULT_READ_ONLY_SCHEDULE_BUDGET,
      failureLimit: 3,
      maxOccurrences: 365,
      missedPolicy: "skip",
    },
  });
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = triggerSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid workflow trigger", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "workflow_trigger",
      metadata: {
        nameLength: parsed.data.name.length,
        source: parsed.data.source,
        triggerKind: parsed.data.triggerKind || "webhook",
        ...(parsed.data.triggerKind === "schedule"
          ? {
              procedureId: parsed.data.procedureId,
              agentId: parsed.data.agentId,
              timezone: parsed.data.timezone,
              missedPolicy: parsed.data.missedPolicy,
              replacesTriggerId: parsed.data.replacesTriggerId,
            }
          : {
              status: parsed.data.status,
              authMode: parsed.data.authMode,
              hasSecretBinding: Boolean(parsed.data.secretEnvVar),
              goalTemplateLength: parsed.data.goalTemplate?.length || 0,
              workflowMode: parsed.data.workflowMode,
              requireApproval: Boolean(parsed.data.requireApproval),
              metadataKeys: Object.keys(parsed.data.metadata || {}).slice(0, 50),
            }),
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const explicitIdempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (parsed.data.triggerKind === "schedule" && !explicitIdempotencyKey) {
      return Response.json({
        error: "Idempotency-Key is required for schedule creation.",
        code: "idempotency_key_required",
      }, { status: 428 });
    }
    if (explicitIdempotencyKey && explicitIdempotencyKey.length > 240) {
      return Response.json({
        error: "Idempotency-Key exceeds 240 characters.",
        code: "idempotency_key_invalid",
      }, { status: 400 });
    }
    const requestIdentity = explicitIdempotencyKey ||
      request.headers.get("x-idempotency-key")?.trim().slice(0, 240) ||
      request.headers.get("x-request-id")?.trim().slice(0, 240) ||
      `workflow-trigger:${randomUUID()}`;
    const executionScope = executionScopeFromSecurityContext(context, {
      correlationId: requestIdentity,
      purpose: parsed.data.triggerKind === "schedule"
        ? "workflow.schedule.review"
        : "workflow.trigger.create",
    });
    const trigger = parsed.data.triggerKind === "schedule"
      ? await createReviewedWorkflowSchedule({
          ...parsed.data,
          tenantId: context.tenantId,
          actorId: context.actorId,
          occurrenceBudget:
            parsed.data.occurrenceBudget || DEFAULT_READ_ONLY_SCHEDULE_BUDGET,
          idempotencyKey: requestIdentity,
          executionScope,
        })
      : await createWorkflowTrigger({
          ...parsed.data,
          tenantId: context.tenantId,
          idempotencyKey: requestIdentity,
          executionScope,
        });
    return Response.json({
      trigger,
      stats: await getWorkflowTriggerStats({
        tenantId: context.tenantId,
        actorId: context.actorId,
      }),
    }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: "Workflow trigger create failed", message: error instanceof Error ? error.message : "Unknown error." },
      { status: 400 },
    );
  }
}
