import { z } from "zod";
import { recordSecurityAudit } from "@/lib/security/audit-store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import type { SecurityContext } from "@/lib/security/types";
import { tickQueuedWorkflows } from "@/lib/workflows/runner";

export const runtime = "nodejs";

const tickSchema = z.object({
  limit: z.number().int().min(1).max(10).optional(),
});

const cronTickLimit = 5;

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  const context = getCronSecurityContext();

  if (!cronSecret) {
    await recordSecurityAudit({
      context,
      action: "manage.workflow",
      resourceType: "workflow_queue",
      decision: "deny",
      reason: "CRON_SECRET is not configured.",
      metadata: { trigger: "vercel_cron" },
    });

    return Response.json(
      { error: "Cron is not configured.", message: "CRON_SECRET is required for scheduled workflow ticks." },
      { status: 503 },
    );
  }

  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    await recordSecurityAudit({
      context,
      action: "manage.workflow",
      resourceType: "workflow_queue",
      decision: "deny",
      reason: "Invalid cron authorization.",
      metadata: { trigger: "vercel_cron" },
    });

    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const runs = await tickQueuedWorkflows(cronTickLimit);
  await recordSecurityAudit({
    context,
    action: "manage.workflow",
    resourceType: "workflow_queue",
    decision: "allow",
    reason: "Vercel Cron workflow tick.",
    metadata: { trigger: "vercel_cron", limit: cronTickLimit, count: runs.length },
  });

  return Response.json({ runs, count: runs.length, trigger: "vercel_cron" });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = tickSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid workflow tick request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "workflow_queue",
      metadata: parsed.data,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const runs = await tickQueuedWorkflows(parsed.data.limit || 5);
  return Response.json({ runs, count: runs.length });
}

function getCronSecurityContext(): SecurityContext {
  return {
    tenantId: process.env.OMNIAGENT_DEFAULT_TENANT || "default",
    actorId: "vercel-cron",
    role: "system",
    source: "default",
  };
}
