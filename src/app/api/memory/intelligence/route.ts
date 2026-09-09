import { createAppServiceCaller } from "@/lib/app-services/contracts";
import {
  memoryIntelligenceServiceInputSchema,
  showMemoryIntelligenceService,
} from "@/lib/app-services/memory-intelligence";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseBoundedInteger } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "memory_intelligence",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const url = new URL(request.url);
  const parsed = memoryIntelligenceServiceInputSchema.safeParse({
    view: url.searchParams.get("view") || "overview",
    query: url.searchParams.get("q") || undefined,
    category: url.searchParams.get("category") || "all",
    tier: url.searchParams.get("tier") || "all",
    state: url.searchParams.get("state") || "all",
    cursor: url.searchParams.get("cursor") || undefined,
    limit: parseBoundedInteger(url.searchParams.get("limit"), 40, { max: 100 }),
  });
  if (!parsed.success) {
    return Response.json({
      error: "Invalid memory intelligence query",
      details: parsed.error.flatten(),
    }, { status: 400, headers: privateNoStoreHeaders });
  }

  try {
    const result = await showMemoryIntelligenceService(
      createAppServiceCaller({ context }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return Response.json({
      error: error instanceof Error
        ? error.message
        : "Memory intelligence could not be loaded.",
    }, { status: 400, headers: privateNoStoreHeaders });
  }
}
