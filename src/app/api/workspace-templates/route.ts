import {
  createAppServiceCaller,
  createRequestMutationAppServiceCaller,
} from "@/lib/app-services/contracts";
import {
  listWorkspaceTemplatesService,
  publishWorkspaceTemplateService,
  workspaceTemplateListServiceInputSchema,
  workspaceTemplatePublishServiceInputSchema,
  WorkspaceTemplateWriteDeniedError,
} from "@/lib/app-services/workspace-templates";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { SharedContextAuthorityError } from "@/lib/memory/shared-context";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  WorkspaceTemplateConflictError,
  WorkspaceTemplateUnavailableError,
} from "@/lib/workspace-templates/store";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "workspace_template",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const url = new URL(request.url);
  const parsed = workspaceTemplateListServiceInputSchema.safeParse({
    workspaceId: url.searchParams.get("workspaceId") || undefined,
    includeHistory: url.searchParams.get("includeHistory") === "true",
    limit: numericQuery(url.searchParams.get("limit"), 100),
  });
  if (!parsed.success) return invalidRequest(parsed.error.flatten());
  try {
    const result = await listWorkspaceTemplatesService(
      createAppServiceCaller({ context }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return templateFailure(error, "list");
  }
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request, 100_000);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = workspaceTemplatePublishServiceInputSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error.flatten());
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "workspace_template",
      resourceId: parsed.data.templateId,
      riskLevel: 1,
      metadata: {
        operation: "publish_version",
        taskCount: parsed.data.project.tasks.length,
        playbook: parsed.data.playbook !== null,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await publishWorkspaceTemplateService(
      createRequestMutationAppServiceCaller(request, context, {
        purpose: "api.workspace_template.publish",
        workspaceId: parsed.data.workspaceId,
      }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { status: 201, headers: privateNoStoreHeaders });
  } catch (error) {
    return templateFailure(error, "publish");
  }
}

function invalidRequest(details: unknown) {
  return Response.json(
    { error: "Invalid workspace-template request.", details },
    { status: 400, headers: privateNoStoreHeaders },
  );
}

function templateFailure(error: unknown, operation: string) {
  if (error instanceof SharedContextAuthorityError) {
    return Response.json(
      { error: error.code === "scope_not_found"
        ? "Workspace not found."
        : "Workspace authority is unavailable." },
      { status: error.code === "scope_not_found" ? 404 : 503, headers: privateNoStoreHeaders },
    );
  }
  if (error instanceof WorkspaceTemplateWriteDeniedError) {
    return Response.json({ error: error.message }, { status: 403, headers: privateNoStoreHeaders });
  }
  if (error instanceof WorkspaceTemplateConflictError) {
    return Response.json({ error: error.message }, { status: 409, headers: privateNoStoreHeaders });
  }
  if (error instanceof WorkspaceTemplateUnavailableError) {
    return Response.json({ error: error.message }, { status: 503, headers: privateNoStoreHeaders });
  }
  console.error(`Workspace template ${operation} failed.`, error instanceof Error ? error.name : "UnknownError");
  return Response.json(
    { error: `Workspace template ${operation} is temporarily unavailable.` },
    { status: 503, headers: privateNoStoreHeaders },
  );
}

function numericQuery(value: string | null, fallback: number) {
  if (value === null || !value.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
