import { z } from "zod";
import { createRequestTelemetry, recordRuntimeEventSafely } from "@/lib/observability/store";

export const runtime = "nodejs";

const accessRequestSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  company: z.string().min(2).max(160),
  role: z.enum(["founder", "engineering", "product", "operations", "security", "other"]),
  useCase: z.string().min(12).max(800),
  timeline: z.enum(["now", "30_days", "quarter", "research"]),
});

export async function POST(request: Request) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "onboarding");
  const parsed = accessRequestSchema.safeParse(await request.json().catch(() => ({})));

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid access request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const accessRequestId = crypto.randomUUID();
  const emailDomain = parsed.data.email.split("@")[1]?.toLowerCase();

  await recordRuntimeEventSafely({
    category: "system",
    action: "onboarding.access_requested",
    route: "/api/onboarding/request-access",
    method: "POST",
    statusCode: 202,
    durationMs: Date.now() - startedAt,
    requestId: telemetry.requestId,
    correlationId: telemetry.correlationId,
    resourceType: "access_request",
    resourceId: accessRequestId,
    message: "Public enterprise access request submitted.",
    metadata: {
      accessRequestId,
      company: parsed.data.company,
      role: parsed.data.role,
      timeline: parsed.data.timeline,
      emailDomain,
      useCaseLength: parsed.data.useCase.length,
      ...telemetry.syntheticMetadata,
    },
  });

  return Response.json(
    {
      id: accessRequestId,
      status: "queued",
      next: [
        "Try the sample workspace while access is reviewed.",
        "Use sign in when an administrator has created your account.",
        "Bring one production workflow, one connector, and one memory source to onboarding.",
      ],
    },
    { status: 202 },
  );
}
