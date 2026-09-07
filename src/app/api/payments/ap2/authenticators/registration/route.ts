import type { RegistrationResponseJSON } from "@simplewebauthn/browser";
import { z } from "zod";

import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { ap2ErrorResponse, ap2PrivateHeaders } from "@/lib/payments/ap2-http";
import {
  listAp2PaymentSigningCredentials,
  Ap2HumanPresentStoreError,
  registerAp2PaymentSigningCredential,
} from "@/lib/payments/ap2-store";
import {
  beginAp2PaymentCredentialRegistration,
  completeAp2PaymentCredentialRegistration,
  loadAp2WebAuthnTrustPolicy,
} from "@/lib/payments/ap2-webauthn";
import { isSealedPayload } from "@/lib/security/sealed-payload";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);
export const PUT = withDatabaseRequestScope(PUTHandler);

const completionSchema = z.object({
  challengeToken: z.unknown(),
  response: z.unknown(),
}).strict();

async function POSTHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "ap2_signing_credential",
      metadata: { operation: "begin_payment_signer_registration" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const policy = requirePolicy();
    const existingCredentials = await listAp2PaymentSigningCredentials({
      tenantId: context.tenantId,
      actorId: context.actorId,
    });
    const registration = await beginAp2PaymentCredentialRegistration({
      tenantId: context.tenantId,
      ownerActorId: context.actorId,
      policy,
      existingCredentials,
    });
    return Response.json(registration, { headers: ap2PrivateHeaders });
  } catch (error) {
    return ap2ErrorResponse(error);
  }
}

async function PUTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = completionSchema.safeParse(body);
  if (!parsed.success || !isSealedPayload(parsed.data.challengeToken)) {
    return Response.json(
      { error: "invalid_payment_signer_registration" },
      { status: 400, headers: ap2PrivateHeaders },
    );
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "ap2_signing_credential",
      metadata: { operation: "complete_payment_signer_registration" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const credential = await completeAp2PaymentCredentialRegistration({
      tenantId: context.tenantId,
      ownerActorId: context.actorId,
      policy: requirePolicy(),
      challengeToken: parsed.data.challengeToken,
      response: parsed.data.response as RegistrationResponseJSON,
    });
    const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
    const result = await registerAp2PaymentSigningCredential(credential, {
      tenantId: context.tenantId,
      actorId: context.actorId,
      executionScope: executionScopeFromSecurityContext(context, {
        correlationId: requestId,
        causationId: requestId,
        purpose: "ap2.signing_credential.register",
      }),
    });
    return Response.json(result, {
      status: result.created ? 201 : 200,
      headers: ap2PrivateHeaders,
    });
  } catch (error) {
    return ap2ErrorResponse(error);
  }
}

function requirePolicy() {
  const policy = loadAp2WebAuthnTrustPolicy();
  if (!policy) {
    throw new Ap2HumanPresentStoreError(
      "A reviewed AP2 WebAuthn trust policy is not configured.",
      "trust_policy_required",
    );
  }
  return policy;
}
