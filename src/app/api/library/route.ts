import { createAppServiceCaller } from "@/lib/app-services/contracts";
import {
  listWorkspaceLibraryService,
  workspaceLibraryListServiceInputSchema,
} from "@/lib/app-services/library";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(GETHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "workspace_library",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const url = new URL(request.url);
  const kinds = url.searchParams.getAll("kind")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const parsed = workspaceLibraryListServiceInputSchema.safeParse({
    query: url.searchParams.get("q") || "",
    kinds,
    projectId: url.searchParams.get("project") || undefined,
    limit: numberOrDefault(url.searchParams.get("limit"), 60),
    offset: numberOrDefault(url.searchParams.get("offset"), 0),
  });
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid workspace library query." },
      { status: 400, headers: privateNoStoreHeaders },
    );
  }
  try {
    const result = await listWorkspaceLibraryService(
      createAppServiceCaller({ context }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
      generatedAt: new Date().toISOString(),
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    console.error(
      "Workspace library read failed.",
      error instanceof Error ? error.name : "UnknownError",
    );
    return Response.json(
      { error: "The workspace library is temporarily unavailable." },
      { status: 503, headers: privateNoStoreHeaders },
    );
  }
}

function numberOrDefault(value: string | null, fallback: number) {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
