import {
  agentCouncilMapServiceInputSchema,
  showAgentCouncilMapService,
} from "@/lib/app-services/agents";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withDatabaseRequestScope(GETHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  const url = new URL(request.url);
  const parsed = agentCouncilMapServiceInputSchema.safeParse({
    limit: numberQuery(url, "limit", 60),
  });
  if (!parsed.success) return Response.json(
    { error: "Invalid Agent Council request.", details: parsed.error.flatten() },
    { status: 400, headers: privateNoStoreHeaders },
  );
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "agent_council",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await showAgentCouncilMapService(
      createAppServiceCaller({ context }),
      parsed.data,
    );
    return Response.json(
      { ...result.data, serviceReceipt: result.receipt },
      { headers: privateNoStoreHeaders },
    );
  } catch (error) {
    console.error(
      "Agent Council read failed.",
      error instanceof Error ? error.name : "UnknownError",
    );
    return Response.json(
      { error: "The Agent Council is temporarily unavailable." },
      { status: 503, headers: privateNoStoreHeaders },
    );
  }
}

function numberQuery(url: URL, name: string, fallback: number) {
  const value = url.searchParams.get(name);
  return value === null || !value.trim() ? fallback : Number(value);
}
