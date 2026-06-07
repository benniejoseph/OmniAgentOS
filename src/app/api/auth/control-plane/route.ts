import { z } from "zod";
import { createOpaqueToken } from "@/lib/auth/crypto";
import { createUserWithMembership, getAuthControlPlane } from "@/lib/auth/store";
import { SecurityPolicyError } from "@/lib/security/context";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

const roleSchema = z.enum(["viewer", "operator", "admin"]);

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(160).optional(),
  role: roleSchema.default("viewer"),
  password: z.string().min(12).max(256).optional(),
  tenantId: z.string().min(1).max(120).optional(),
  tenantName: z.string().min(1).max(160).optional(),
});

export async function GET(request: Request) {
  try {
    const context = await authorizeRequest({
      request,
      action: "read.identity",
      resourceType: "identity_control_plane",
    });
    return Response.json(await getAuthControlPlane({ tenantId: context.tenantId }));
  } catch (error) {
    return forbiddenResponse(error);
  }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
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
      metadata: { ...parsed.data, password: parsed.data.password ? "[provided]" : "[generated]" },
    });
    const tenantId = parsed.data.tenantId || context.tenantId;
    if (tenantId !== context.tenantId && context.role !== "system") {
      throw new SecurityPolicyError("Only system actors can administer a different tenant.");
    }

    const generatedPassword = parsed.data.password ? undefined : createOpaqueToken();
    const user = await createUserWithMembership({
      ...parsed.data,
      tenantId,
      password: parsed.data.password || generatedPassword!,
    });
    return Response.json(
      {
        user,
        generatedPassword,
        controlPlane: await getAuthControlPlane({ tenantId: context.tenantId }),
      },
      { status: 201 },
    );
  } catch (error) {
    return forbiddenResponse(error);
  }
}
