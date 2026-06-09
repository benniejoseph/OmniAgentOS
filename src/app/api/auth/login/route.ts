import { z } from "zod";
import { sessionCookie } from "@/lib/auth/session";
import { authenticatePassword } from "@/lib/auth/store";
import { createRequestTelemetry, recordRuntimeEventSafely } from "@/lib/observability/store";

export const runtime = "nodejs";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(request: Request) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "auth");
  const parsed = loginSchema.safeParse(await request.json().catch(() => ({})));

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid login", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const result = await authenticatePassword(parsed.data);

  if (!result) {
    await recordRuntimeEventSafely({
      level: "warn",
      category: "security",
      action: "security.auth_failed",
      route: "/api/auth/login",
      method: "POST",
      statusCode: 401,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      resourceType: "auth_session",
      message: "Password authentication failed.",
      metadata: {
        failureType: "auth_failure",
        authMethod: "password",
        emailDomain: parsed.data.email.split("@")[1]?.toLowerCase(),
        ...telemetry.syntheticMetadata,
      },
    });
    return Response.json(
      { error: "Unauthorized", message: "Email or password is incorrect, or the user is not active." },
      { status: 401 },
    );
  }

  return Response.json(
    {
      authenticated: true,
      context: result.identity.context,
      user: result.identity.user,
      tenant: result.identity.tenant,
      membership: result.identity.membership,
    },
    {
      headers: {
        "Set-Cookie": sessionCookie(result.token, result.identity.session.expiresAt),
      },
    },
  );
}
