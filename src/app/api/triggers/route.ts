import { z } from "zod";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  createWorkflowTrigger,
  getWorkflowTriggerStats,
  listWorkflowTriggerEvents,
  listWorkflowTriggers,
} from "@/lib/workflows/triggers";

export const runtime = "nodejs";

const triggerSchema = z.object({
  name: z.string().min(1).max(120),
  source: z.string().min(1).max(120).optional(),
  status: z.enum(["active", "paused"]).optional(),
  authMode: z.enum(["none", "hmac_sha256"]).optional(),
  secretEnvVar: z.string().min(1).max(120).optional(),
  goalTemplate: z.string().min(1).max(1200).optional(),
  workflowMode: z.enum(["orchestrate", "research", "execute", "learn"]).optional(),
  requireApproval: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 200);

  try {
    await authorizeRequest({
      request,
      action: "read",
      resourceType: "workflow_trigger",
      metadata: { limit },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  return Response.json({
    triggers: await listWorkflowTriggers(limit),
    events: await listWorkflowTriggerEvents(limit),
    stats: await getWorkflowTriggerStats(),
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = triggerSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid workflow trigger", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "workflow_trigger",
      metadata: {
        ...parsed.data,
        secretEnvVar: parsed.data.secretEnvVar ? "[env-var]" : undefined,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const trigger = await createWorkflowTrigger(parsed.data);
    return Response.json({ trigger, stats: await getWorkflowTriggerStats() }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: "Workflow trigger create failed", message: error instanceof Error ? error.message : "Unknown error." },
      { status: 400 },
    );
  }
}
