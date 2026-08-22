import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  jsonBodyErrorResponse,
  parseBoundedInteger,
  parseJsonBody,
} from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  createWorkflowTrigger,
  getWorkflowTriggerStats,
  listWorkflowTriggerEvents,
  listWorkflowTriggers,
} from "@/lib/workflows/triggers";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const triggerSchema = z.object({
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

  return Response.json({
    triggers: await listWorkflowTriggers(limit, { tenantId: context.tenantId }),
    events: await listWorkflowTriggerEvents(limit, { tenantId: context.tenantId }),
    stats: await getWorkflowTriggerStats({ tenantId: context.tenantId }),
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
        status: parsed.data.status,
        authMode: parsed.data.authMode,
        hasSecretBinding: Boolean(parsed.data.secretEnvVar),
        goalTemplateLength: parsed.data.goalTemplate?.length || 0,
        workflowMode: parsed.data.workflowMode,
        requireApproval: Boolean(parsed.data.requireApproval),
        metadataKeys: Object.keys(parsed.data.metadata || {}).slice(0, 50),
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const trigger = await createWorkflowTrigger({
      ...parsed.data,
      tenantId: context.tenantId,
    });
    return Response.json({
      trigger,
      stats: await getWorkflowTriggerStats({ tenantId: context.tenantId }),
    }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: "Workflow trigger create failed", message: error instanceof Error ? error.message : "Unknown error." },
      { status: 400 },
    );
  }
}
