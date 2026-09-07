import { z } from "zod";

import { discoverAgentCardsService } from "@/lib/app-services/agents";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
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
  const result = await discoverAgentCardsService(createAppServiceCaller({ context }), parsed.data);
  return Response.json(
    { ...result.data, serviceReceipt: result.receipt },
    { headers: privateNoStoreHeaders },
  );
}
