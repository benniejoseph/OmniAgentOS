import { z } from "zod";

import { listInternalAgentCardsV1 } from "@/lib/agents/discovery-card";
import { discoverInternalAgentsV1 } from "@/lib/agents/discovery";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

const querySchema = z.object({
  query: z.string().trim().min(1).max(4_000).optional(),
  taskKind: z.enum([
    "general",
    "coordinate",
    "research",
    "build",
    "verify",
    "memory",
  ]).optional(),
}).strict();

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "custom_agent",
      metadata: { operation: "discover_internal_cards" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    query: url.searchParams.get("query") || undefined,
    taskKind: url.searchParams.get("taskKind") || undefined,
  });
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid Agent Card discovery query." },
      { status: 400, headers: privateNoStoreHeaders },
    );
  }
  const cards = listInternalAgentCardsV1({
    tenantId: context.tenantId,
    controllerActorId: context.actorId,
  });
  const discovery = parsed.data.query
    ? discoverInternalAgentsV1({
        cards,
        request: {
          query: parsed.data.query,
          taskKinds: [parsed.data.taskKind || "general"],
          inputModalities: ["text", "artifact_reference"],
          outputModalities: ["application/json", "artifact_reference"],
          limits: {
            maxInputArtifacts: 32,
            maxOutputArtifacts: 8,
            maxOutputBytes: 64_000,
            maxWallClockMs: 900_000,
            maxFanOut: 0,
          },
          authenticationScheme: "delegated_principal",
        },
      })
    : undefined;
  return Response.json(
    {
      version: "p8.5-agent-card-collection:1",
      cards,
      ...(discovery ? { discovery } : {}),
    },
    { headers: privateNoStoreHeaders },
  );
}
