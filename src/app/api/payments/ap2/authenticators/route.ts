import { z } from "zod";

import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { ap2ErrorResponse, ap2PrivateHeaders } from "@/lib/payments/ap2-http";
import {
  listAp2PaymentSigningCredentials,
  revokeAp2PaymentSigningCredential,
} from "@/lib/payments/ap2-store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const DELETE = withDatabaseRequestScope(DELETEHandler);

const revokeSchema = z.object({
  credentialId: z.string().trim().min(1).max(16_384),
}).strict();

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "ap2_signing_credential",
      metadata: { operation: "list_payment_signers" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const credentials = await listAp2PaymentSigningCredentials({
      tenantId: context.tenantId,
      actorId: context.actorId,
    });
    return Response.json({
      credentials: credentials.map((credential) => ({
        credentialId: credential.credentialId,
        aaguid: credential.aaguid,
        attestationFormat: credential.attestationFormat,
        signerProfile: credential.signerProfile,
        trustPolicyId: credential.trustPolicyId,
        trustPolicySha256: credential.trustPolicySha256,
        state: credential.state,
        lifecycleRevision: credential.lifecycleRevision,
        createdAt: credential.createdAt,
        lastUsedAt: credential.lastUsedAt,
        revokedAt: credential.revokedAt,
      })),
    }, { headers: ap2PrivateHeaders });
  } catch (error) {
    return ap2ErrorResponse(error);
  }
}

async function DELETEHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = revokeSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_payment_signer_revocation", details: parsed.error.flatten() },
      { status: 400, headers: ap2PrivateHeaders },
    );
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "ap2_signing_credential",
      resourceId: parsed.data.credentialId,
      metadata: { operation: "revoke_payment_signer" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const executionScope = executionScopeFromSecurityContext(context, {
      correlationId: request.headers.get("x-request-id") || crypto.randomUUID(),
      causationId: parsed.data.credentialId,
      purpose: "ap2.signing_credential.revoke",
    });
    const credential = await revokeAp2PaymentSigningCredential(
      parsed.data.credentialId,
      { tenantId: context.tenantId, actorId: context.actorId, executionScope },
    );
    return Response.json({ credential }, { headers: ap2PrivateHeaders });
  } catch (error) {
    return ap2ErrorResponse(error);
  }
}
