import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody, jsonBodyErrorResponse } from "@/lib/http/body";
import {
  PERSONAL_CONTEXT_NOTICE_SHA256,
} from "@/lib/memory/personal-context-consent";
import {
  PERSONAL_CONTEXT_CONSENT_MANAGE_PURPOSE,
  PersonalContextConsentError,
  activatePersonalContextConsent,
  getPersonalContextConsentStatus,
  revokePersonalContextConsent,
} from "@/lib/memory/personal-context-consent-store";
import {
  canonicalRequestActorBindingFromSecurityContext,
} from "@/lib/security/canonical-actor";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);
export const DELETE = withDatabaseRequestScope(DELETEHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };
const activateSchema = z.object({
  noticeSha256: z.literal(PERSONAL_CONTEXT_NOTICE_SHA256),
}).strict();

async function GETHandler(request: Request) {
  try {
    const context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "personal_context_consent",
    });
    const actorBinding = canonicalRequestActorBindingFromSecurityContext(context);
    if (!actorBinding) return canonicalIdentityRequired();
    return Response.json(
      await getPersonalContextConsentStatus({
        tenantId: context.tenantId,
        actorBinding,
      }),
      { headers: privateNoStoreHeaders },
    );
  } catch (error) {
    return routeError(error);
  }
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = activateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "The personal-context notice is stale." },
      { status: 409, headers: privateNoStoreHeaders },
    );
  }
  try {
    const context = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "personal_context_consent",
      metadata: { operation: "activate" },
    });
    const actorBinding = canonicalRequestActorBindingFromSecurityContext(context);
    if (!actorBinding) return canonicalIdentityRequired();
    return Response.json(
      await activatePersonalContextConsent({
        tenantId: context.tenantId,
        actorBinding,
        executionScope: createConsentExecutionScope(
          context.tenantId,
          actorBinding.canonicalActorId,
          request,
        ),
        noticeSha256: parsed.data.noticeSha256,
      }),
      { headers: privateNoStoreHeaders },
    );
  } catch (error) {
    return routeError(error);
  }
}

async function DELETEHandler(request: Request) {
  try {
    const context = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "personal_context_consent",
      metadata: { operation: "revoke" },
    });
    const actorBinding = canonicalRequestActorBindingFromSecurityContext(context);
    if (!actorBinding) return canonicalIdentityRequired();
    return Response.json(
      await revokePersonalContextConsent({
        tenantId: context.tenantId,
        actorBinding,
        executionScope: createConsentExecutionScope(
          context.tenantId,
          actorBinding.canonicalActorId,
          request,
        ),
      }),
      { headers: privateNoStoreHeaders },
    );
  } catch (error) {
    return routeError(error);
  }
}

function createConsentExecutionScope(
  tenantId: string,
  actorId: string,
  request: Request,
) {
  const requestedCorrelationId = request.headers.get("x-request-id")?.trim();
  return createExecutionScope({
    tenantId,
    initiatingActorId: actorId,
    executingPrincipalType: "user",
    executingPrincipalId: actorId,
    correlationId: requestedCorrelationId?.slice(0, 240) || randomUUID(),
    purpose: PERSONAL_CONTEXT_CONSENT_MANAGE_PURPOSE,
  });
}

function canonicalIdentityRequired() {
  return Response.json(
    { error: "Canonical user identity is required." },
    { status: 409, headers: privateNoStoreHeaders },
  );
}

function routeError(error: unknown) {
  if (error instanceof PersonalContextConsentError) {
    return Response.json(
      { error: error.message },
      {
        status: error.code === "inactive" ? 409 :
          error.code === "invalid_authority" ? 400 : 503,
        headers: privateNoStoreHeaders,
      },
    );
  }
  return forbiddenResponse(error);
}
