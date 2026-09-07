import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  revokeBrowserProfile,
  updateBrowserProfile,
} from "@/lib/browser/profiles";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const PATCH = withDatabaseRequestScope(PATCHHandler);
export const DELETE = withDatabaseRequestScope(DELETEHandler);

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  allowedDomains: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
  expectedRevision: z.number().int().min(1),
}).strict();
const revokeSchema = z.object({
  expectedRevision: z.number().int().min(1),
}).strict();
const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function PATCHHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  return mutateProfile(request, route, "update");
}

async function DELETEHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  return mutateProfile(request, route, "revoke");
}

async function mutateProfile(
  request: Request,
  route: { params: Promise<{ id: string }> },
  operation: "update" | "revoke",
) {
  const { id } = await route.params;
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "execute.tool",
      resourceType: "browser_profile",
      resourceId: id,
      metadata: { operation },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = (operation === "update" ? updateSchema : revokeSchema).safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid browser profile mutation.", details: parsed.error.flatten() }, {
      status: 400,
      headers: privateNoStoreHeaders,
    });
  }
  try {
    const correlationId = request.headers.get("x-request-id")?.trim() || randomUUID();
    const executionScope = executionScopeFromSecurityContext(context, {
      correlationId,
      causationId: id,
      purpose: `browser.profile.${operation}`,
    });
    const profile = operation === "update"
      ? await updateBrowserProfile({
          tenantId: context.tenantId,
          ownerActorId: context.actorId,
          profileId: id,
          name: (parsed.data as z.infer<typeof updateSchema>).name,
          allowedDomains: (parsed.data as z.infer<typeof updateSchema>).allowedDomains,
          expectedRevision: parsed.data.expectedRevision,
          executionScope,
        })
      : await revokeBrowserProfile({
          tenantId: context.tenantId,
          ownerActorId: context.actorId,
          profileId: id,
          expectedRevision: parsed.data.expectedRevision,
          executionScope,
        });
    return Response.json({ profile: {
      id: profile.id,
      name: profile.name,
      allowedDomains: profile.allowedDomains,
      state: profile.state,
      lifecycleRevision: profile.lifecycleRevision,
      consentedAt: profile.consentedAt,
      lastUsedAt: profile.lastUsedAt,
      revokedAt: profile.revokedAt,
      updatedAt: profile.updatedAt,
    } }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Browser profile could not be changed.",
    }, { status: 409, headers: privateNoStoreHeaders });
  }
}
