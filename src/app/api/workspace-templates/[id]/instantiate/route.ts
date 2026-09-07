import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import {
  instantiateWorkspaceTemplateService,
  workspaceTemplateInstantiateServiceInputSchema,
  WorkspaceTemplateNotFoundError,
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
export const POST = withDatabaseRequestScope(POSTHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function POSTHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  const { id } = await route.params;
  let body: unknown;
  try {
    body = await parseJsonBody(request, 20_000);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = workspaceTemplateInstantiateServiceInputSchema.safeParse({
    ...(body && typeof body === "object" && !Array.isArray(body) ? body : {}),
    templateId: id,
  });
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid template instantiation.", details: parsed.error.flatten() },
      { status: 400, headers: privateNoStoreHeaders },
    );
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "workspace_template",
      resourceId: id,
      riskLevel: 1,
      metadata: {
        operation: "instantiate_project",
        templateVersionId: parsed.data.templateVersionId,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await instantiateWorkspaceTemplateService(
      createRequestMutationAppServiceCaller(request, context, {
        purpose: "api.workspace_template.instantiate",
        workspaceId: parsed.data.workspaceId,
      }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { status: 201, headers: privateNoStoreHeaders });
  } catch (error) {
    if (error instanceof WorkspaceTemplateNotFoundError) {
      return Response.json({ error: error.message }, { status: 404, headers: privateNoStoreHeaders });
    }
    if (error instanceof WorkspaceTemplateWriteDeniedError) {
      return Response.json({ error: error.message }, { status: 403, headers: privateNoStoreHeaders });
    }
    if (error instanceof WorkspaceTemplateConflictError) {
      return Response.json({ error: error.message }, { status: 409, headers: privateNoStoreHeaders });
    }
    if (error instanceof WorkspaceTemplateUnavailableError || error instanceof SharedContextAuthorityError) {
      return Response.json(
        { error: "Workspace template instantiation is unavailable." },
        { status: 503, headers: privateNoStoreHeaders },
      );
    }
    console.error("Workspace template instantiation failed.", error instanceof Error ? error.name : "UnknownError");
    return Response.json(
      { error: "Workspace template instantiation is temporarily unavailable." },
      { status: 503, headers: privateNoStoreHeaders },
    );
  }
}
