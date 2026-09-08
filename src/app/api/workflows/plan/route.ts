import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AgentIdentityResolutionError,
  resolveAgentIdentityForExecution,
} from "@/lib/agents/identity-store";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { listWorkflowPlansService } from "@/lib/app-services/workflows";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  jsonBodyErrorResponse,
  parseBoundedInteger,
  parseJsonBody,
} from "@/lib/http/body";
import { buildDynamicWorkflowPlan, getWorkflowPlanStats } from "@/lib/workflows/planner";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import {
  requestSharedMemoryAccessFromSecurityContext,
  SharedContextAuthorityError,
} from "@/lib/memory/shared-context";
import {
  contextSelectionRequestSchema,
  verifyContextSelectionLock,
} from "@/lib/rag/context-selection-lock";
import {
  assertContextScopeRequest,
  CONTEXT_SCOPE_IDS,
  getContextScopePolicy,
} from "@/lib/rag/context-scope";
import {
  isWorkflowSharedContextScope,
  workflowPlanContextBoundary,
} from "@/lib/workflows/shared-context";
import {
  workflowAgentPrivateDatabaseAccessScope,
  workflowAgentPrivatePlanContextBoundary,
} from "@/lib/workflows/agent-private-context";

export const runtime = "nodejs";
export const maxDuration = 60;
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const workflowPlanSchema = z.object({
  goal: z.string().min(1).max(4000),
  contextScope: z.enum(CONTEXT_SCOPE_IDS).optional(),
  contextSelection: contextSelectionRequestSchema.optional(),
  agentId: z.string().trim().min(1).max(120)
    .regex(/^[a-zA-Z0-9_.:-]+$/).optional(),
  projectId: z.string().trim().min(1).max(200)
    .regex(/^[a-zA-Z0-9_.:-]+$/).optional(),
  missionId: z.string().uuid().optional(),
  workspaceId: z.string().trim().min(1).max(240)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/).optional(),
  mode: z.enum(["orchestrate", "research", "execute", "learn"]).optional(),
  workflowRunId: z.string().min(1).optional(),
  requireApproval: z.boolean().optional(),
  reuseExisting: z.boolean().optional(),
}).strict()
  .refine((value) => value.contextScope !== "project" || Boolean(value.projectId), {
    message: "A project is required for project context.",
    path: ["projectId"],
  })
  .refine((value) => value.contextScope !== "mission" || Boolean(value.missionId), {
    message: "A mission is required for Mission context.",
    path: ["missionId"],
  })
  .refine((value) => value.contextScope !== "mission" || !value.projectId, {
    message: "Mission context resolves its canonical Project on the server.",
    path: ["projectId"],
  })
  .refine(
    (value) => value.contextScope !== "mission" || !value.workspaceId,
    {
      message: "Mission context cannot be combined with a Workspace coordinate.",
      path: ["workspaceId"],
    },
  )
  .refine(
    (value) => value.contextScope !== "project" ||
      (!value.missionId && !value.workspaceId),
    {
      message: "Project context accepts only its Project coordinate.",
      path: ["projectId"],
    },
  )
  .refine((value) => value.contextScope !== "workspace" || !value.missionId, {
    message: "Workspace context cannot be combined with a Mission coordinate.",
    path: ["missionId"],
  })
  .refine(
    (value) => isWorkflowSharedContextScope(value.contextScope) ||
      (!value.projectId && !value.missionId && !value.workspaceId),
    {
      message: "Shared-context coordinates require a shared context scope.",
      path: ["contextScope"],
    },
  )
  .refine(
    (value) => value.contextScope !== "agent_private" || Boolean(value.agentId),
    {
      message: "Agent-private context requires an assigned Agent.",
      path: ["agentId"],
    },
  )
  .refine(
    (value) => value.contextScope === "agent_private" || !value.agentId,
    {
      message: "An Agent coordinate is only valid for Agent-private context.",
      path: ["agentId"],
    },
  );

async function GETHandler(request: Request) {
  const url = new URL(request.url);
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 20, {
    max: 100,
  });

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "workflow_plan",
      metadata: { limit },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const result = await listWorkflowPlansService(createAppServiceCaller({ context }), { limit });
  return Response.json({ ...result.data, serviceReceipt: result.receipt });
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = workflowPlanSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid workflow plan request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (
    parsed.data.contextSelection
    && normalizeTaskQuery(parsed.data.contextSelection.query) !== normalizeTaskQuery(parsed.data.goal)
  ) {
    return Response.json(
      {
        error: "Context selection is out of date.",
        message: "The reviewed context does not match this workflow goal. Rebuild context before planning.",
      },
      { status: 409 },
    );
  }
  if (parsed.data.contextScope) {
    try {
      assertContextScopeRequest(
        parsed.data.contextScope,
        Boolean(parsed.data.contextSelection),
      );
    } catch (error) {
      const policy = getContextScopePolicy(parsed.data.contextScope);
      return Response.json({
        error: policy.state === "authority_held"
          ? "Context scope unavailable"
          : "Invalid context scope",
        message: error instanceof Error ? error.message : "Invalid context scope.",
      }, { status: policy.state === "authority_held" ? 409 : 400 });
    }
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "workflow_plan",
      metadata: {
        goalLength: parsed.data.goal.length,
        mode: parsed.data.mode || "orchestrate",
        workflowRunId: parsed.data.workflowRunId,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  let contextSelection;
  if (parsed.data.contextSelection) {
    try {
      contextSelection = verifyContextSelectionLock({
        tenantId: context.tenantId,
        actorId: context.actorId,
        selection: parsed.data.contextSelection,
      });
    } catch (error) {
      return Response.json({
        error: "Context selection lock is invalid.",
        message: error instanceof Error
          ? error.message
          : "Refresh and review context again.",
      }, {
        status: 409,
        headers: { "cache-control": "private, no-store" },
      });
    }
  }

  const planCorrelationId =
    request.headers.get("x-idempotency-key")?.trim().slice(0, 240) ||
    request.headers.get("x-request-id")?.trim().slice(0, 240) ||
    `workflow-plan:${randomUUID()}`;
  let sharedContextAccess;
  if (isWorkflowSharedContextScope(parsed.data.contextScope)) {
    try {
      sharedContextAccess = await requestSharedMemoryAccessFromSecurityContext(
        context,
        {
          scope: parsed.data.contextScope === "workspace"
            ? "workspace"
            : "project",
          projectId: parsed.data.contextScope === "mission"
            ? parsed.data.missionId
            : parsed.data.projectId,
          workspaceId: parsed.data.workspaceId,
          correlationId: planCorrelationId,
        },
      );
    } catch (error) {
      if (!(error instanceof SharedContextAuthorityError)) throw error;
      return Response.json({
        error: error.code === "scope_not_found"
          ? "Shared context not found"
          : "Shared context unavailable",
        message: error.code === "scope_not_found"
          ? "The selected shared context is unavailable to this account."
          : "Shared context authority could not be verified.",
      }, {
        status: error.code === "scope_not_found" ? 404 : 503,
        headers: { "cache-control": "private, no-store" },
      });
    }
  }
  let agentPrivateIdentity;
  if (parsed.data.contextScope === "agent_private" && parsed.data.agentId) {
    try {
      agentPrivateIdentity = await resolveAgentIdentityForExecution({
        tenantId: context.tenantId,
        actorId: context.actorId,
        agentId: parsed.data.agentId,
      });
    } catch (error) {
      if (!(error instanceof AgentIdentityResolutionError)) throw error;
      return Response.json({
        error: "Agent-private context unavailable",
        message: "The assigned Agent's current identity and grants could not be verified.",
      }, {
        status: 409,
        headers: { "cache-control": "private, no-store" },
      });
    }
  }
  const executionScope = executionScopeFromSecurityContext(context, {
    workspaceId: sharedContextAccess?.authority.workspaceId,
    projectId: sharedContextAccess?.authority.projectId,
    missionId: parsed.data.contextScope === "mission"
      ? parsed.data.missionId
      : undefined,
    correlationId: planCorrelationId,
    purpose: "workflow.plan.create",
  });

  const plan = await buildDynamicWorkflowPlan({
    tenantId: context.tenantId,
    actorId: context.actorId,
    goal: parsed.data.goal,
    contextSelection: contextSelection || (parsed.data.contextScope &&
        !isWorkflowSharedContextScope(parsed.data.contextScope) &&
        parsed.data.contextScope !== "agent_private"
      ? { query: parsed.data.goal, evidenceIds: [] }
      : undefined),
    databaseMemoryAccessScope: sharedContextAccess?.databaseAccessScope ||
      (agentPrivateIdentity
        ? workflowAgentPrivateDatabaseAccessScope({
            identity: agentPrivateIdentity,
            requestingActorId: context.actorId,
            correlationId: planCorrelationId,
          })
        : undefined),
    contextBoundary: sharedContextAccess &&
        isWorkflowSharedContextScope(parsed.data.contextScope)
      ? workflowPlanContextBoundary(
          sharedContextAccess,
          parsed.data.contextScope,
        )
      : agentPrivateIdentity
        ? workflowAgentPrivatePlanContextBoundary(agentPrivateIdentity)
        : undefined,
    mode: parsed.data.mode,
    workflowRunId: parsed.data.workflowRunId,
    requireApproval: parsed.data.requireApproval,
    source: "api",
    reuseExisting: parsed.data.reuseExisting,
    executionScope,
  });

  return Response.json({ plan, stats: await getWorkflowPlanStats({ tenantId: context.tenantId }) }, { status: 201 });
}

function normalizeTaskQuery(value: string) {
  return value.replace(/\s+/g, " ").trim();
}
