import { z } from "zod";
import {
  createOpaqueToken,
  hashSessionToken,
  MAX_PASSWORD_LENGTH,
} from "@/lib/auth/crypto";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  createUserWithMembership,
  getAuthControlPlane,
  IdentityConflictError,
  rotateUserPassword,
} from "@/lib/auth/store";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { getAccessRequestStore } from "@/lib/onboarding/access-request-store";
import { SecurityPolicyError } from "@/lib/security/context";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const roleSchema = z.enum(["viewer", "operator", "admin"]);

const createUserSchema = z.object({
  operation: z.enum(["create", "rotate"]).default("create"),
  accessRequestId: z.string().uuid().optional(),
  email: z.string().email(),
  name: z.string().min(1).max(160).optional(),
  role: roleSchema.default("viewer"),
  password: z.string().min(12).max(MAX_PASSWORD_LENGTH).optional(),
  tenantId: z.string().min(1).max(120).optional(),
  tenantName: z.string().min(1).max(160).optional(),
}).strict();

async function GETHandler(request: Request) {
  try {
    const context = await authorizeRequest({
      request,
      action: "read.identity",
      resourceType: "identity_control_plane",
    });
    return Response.json(
      await getAuthControlPlane({ tenantId: context.tenantId }),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return forbiddenResponse(error);
  }
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request, 32_768);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = createUserSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid identity request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const context = await authorizeRequest({
      request,
      action: "manage.identity",
      resourceType: "auth_user",
      metadata: {
        emailHash: hashSessionToken(parsed.data.email.trim().toLowerCase()).slice(0, 24),
        hasName: Boolean(parsed.data.name),
        role: parsed.data.role,
        passwordMode: parsed.data.password ? "provided" : "generated",
        hasTenantOverride: Boolean(parsed.data.tenantId),
        createsTenant: Boolean(parsed.data.tenantName),
        accessRequestId: parsed.data.accessRequestId,
        operation: parsed.data.operation,
      },
    });
    const tenantId = parsed.data.tenantId || context.tenantId;
    if (tenantId !== context.tenantId && context.role !== "system") {
      throw new SecurityPolicyError("Only system actors can administer a different tenant.");
    }

    if (parsed.data.operation === "rotate") {
      if (parsed.data.accessRequestId) {
        return Response.json(
          {
            error: "Invalid credential rotation",
            message:
              "Credential rotation does not accept an access request id.",
          },
          { status: 400 },
        );
      }
      const generatedPassword = parsed.data.password
        ? undefined
        : createOpaqueToken();
      const user = await rotateUserPassword({
        email: parsed.data.email,
        password: parsed.data.password || generatedPassword!,
        tenantId,
      });
      if (!user) {
        return Response.json(
          {
            error: "Workspace user not found.",
            message:
              "No active workspace membership matches this email.",
          },
          { status: 404 },
        );
      }
      return Response.json(
        {
          user,
          generatedPassword,
          credentialRotated: true,
          sessionsRevoked: true,
          controlPlane: await getAuthControlPlane({
            tenantId: context.tenantId,
          }),
        },
        {
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    const accessRequest = parsed.data.accessRequestId
      ? await getAccessRequestStore().get({
          id: parsed.data.accessRequestId,
          tenantId,
        })
      : undefined;
    if (
      parsed.data.accessRequestId &&
      (
        !accessRequest ||
        !["approved", "provisioning_pending", "provisioned"].includes(
          accessRequest.status,
        ) ||
        accessRequest.email.trim().toLowerCase() !==
          parsed.data.email.trim().toLowerCase()
      )
    ) {
      return Response.json(
        {
          error: "Access request cannot be provisioned.",
          message:
            "The approved access request is unavailable, already closed, or does not match this email.",
        },
        { status: 409 },
      );
    }

    const generatedPassword = parsed.data.password ? undefined : createOpaqueToken();
    let user;
    let existingIdentity = false;
    let credentialRotated = false;
    try {
      user = await createUserWithMembership({
        ...parsed.data,
        tenantId,
        password: parsed.data.password || generatedPassword!,
      });
    } catch (error) {
      if (
        !(error instanceof IdentityConflictError) ||
        !parsed.data.accessRequestId
      ) {
        throw error;
      }
      const controlPlane = await getAuthControlPlane({ tenantId });
      user = controlPlane.users.find(
        (item) =>
          item.email.trim().toLowerCase() ===
          parsed.data.email.trim().toLowerCase(),
      );
      if (!user) {
        throw error;
      }
      existingIdentity = true;
      const rotated = await rotateUserPassword({
        email: parsed.data.email,
        password: parsed.data.password || generatedPassword!,
        tenantId,
      });
      if (!rotated) {
        throw error;
      }
      user = rotated;
      credentialRotated = true;
    }
    if (parsed.data.accessRequestId) {
      const provisioned = await getAccessRequestStore().markProvisioned({
        id: parsed.data.accessRequestId,
        tenantId,
        userId: user.id,
      });
      if (!provisioned) {
        return Response.json(
          {
            error: "Provisioning state conflict.",
            message:
              "The user exists, but the access request changed before it could be linked. Refresh Inbox to reconcile it.",
          },
          { status: 409 },
        );
      }
    }
    return Response.json(
      {
        user,
        generatedPassword,
        existingIdentity,
        credentialRotated,
        controlPlane: await getAuthControlPlane({ tenantId: context.tenantId }),
      },
      {
        status: existingIdentity ? 200 : 201,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    if (error instanceof IdentityConflictError) {
      return Response.json(
        { error: "Identity conflict", code: error.code, message: error.message },
        { status: error.status },
      );
    }
    return forbiddenResponse(error);
  }
}
