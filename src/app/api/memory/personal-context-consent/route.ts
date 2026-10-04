import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { decidePersonalContextConsentService, inspectPersonalContextConsentService } from "@/lib/app-services/personal-context-consent";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody, jsonBodyErrorResponse } from "@/lib/http/body";
import { IdempotencyKeyError, idempotencyKeyErrorResponse, requireIdempotencyKey, requiredRequestIdempotencyKey } from "@/lib/http/idempotency-key";
import { PersonalContextConsentNativeError, personalContextConsentNativeRequestSchema } from "@/lib/memory/personal-context-consent-native-contracts";
import { nativePersonalContextConsentQuerySchema } from "@/lib/mobile/personal-context-consent-contracts";
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
export const PATCH = withDatabaseRequestScope(requireIdempotencyKey(PATCHHandler));

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
    const params = [...new URL(request.url).searchParams];
    if (context.source === "mobile" || params.some(([key]) => key === "contract")) {
      const parsed = nativePersonalContextConsentQuerySchema.safeParse(Object.fromEntries(params));
      if (!parsed.success || new Set(params.map(([key]) => key)).size !== params.length) {
        return Response.json({ error: "The current personal recall read contract is required." }, { status: 400, headers: privateNoStoreHeaders });
      }
      try {
        const result = await inspectPersonalContextConsentService(createAppServiceCaller({ context }));
        return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: privateNoStoreHeaders });
      } catch (error) { return nativeFailure(error); }
    }
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
    return privateResponse(jsonBodyErrorResponse(error));
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
    if (context.source === "mobile") return nativeContractRequired();
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
    if (context.source === "mobile") return nativeContractRequired();
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

async function PATCHHandler(request: Request) {
  if ([...new URL(request.url).searchParams].length) {
    return Response.json({ error: "Personal recall decisions do not accept query parameters." }, { status: 400, headers: privateNoStoreHeaders });
  }
  try { requiredRequestIdempotencyKey(request); }
  catch (error) {
    if (error instanceof IdempotencyKeyError) return idempotencyKeyErrorResponse(error);
    throw error;
  }
  let body: unknown;
  try { body = await parseJsonBody(request, 4_096); }
  catch (error) { return privateResponse(jsonBodyErrorResponse(error)); }
  const parsed = personalContextConsentNativeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "The exact reviewed personal recall state and current notice are required." }, { status: 400, headers: privateNoStoreHeaders });
  }
  let context;
  try {
    context = await authorizeRequest({
      request, action: "write.memory", resourceType: "personal_context_consent",
      nativeMutationCapability: "memory.personal-context-consent.manage",
      metadata: { operation: parsed.data.action },
    });
  } catch (error) { return privateResponse(forbiddenResponse(error)); }
  const binding = canonicalRequestActorBindingFromSecurityContext(context);
  if (!binding) return canonicalIdentityRequired();
  try {
    const result = await decidePersonalContextConsentService(
      createRequestMutationAppServiceCaller(request, context, {
        purpose: "api.memory.personal-context-consent.native.decide",
        causationId: binding.canonicalActorId,
      }), parsed.data,
    );
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: privateNoStoreHeaders });
  } catch (error) { return nativeFailure(error); }
}

function nativeContractRequired() {
  return Response.json({ error: "Personal recall changes require an exact reviewed decision." }, { status: 400, headers: privateNoStoreHeaders });
}

function privateResponse(response: Response) {
  response.headers.set("cache-control", privateNoStoreHeaders["cache-control"]);
  return response;
}

function nativeFailure(error: unknown) {
  return error instanceof PersonalContextConsentNativeError
    ? Response.json({ error: error.message, code: error.code }, { status: error.status, headers: privateNoStoreHeaders })
    : Response.json({ error: "Personal recall consent is temporarily unavailable.", code: "personal_context_consent_unavailable" }, { status: 503, headers: privateNoStoreHeaders });
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
  return privateResponse(forbiddenResponse(error));
}
