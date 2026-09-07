import { createAppServiceCaller } from "@/lib/app-services/contracts";
import {
  cohesiveTodayServiceInputSchema,
  showCohesiveTodayService,
} from "@/lib/app-services/cohesive-today";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";
export const GET = withDatabaseRequestScope(GETHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  const url = new URL(request.url);
  const parsed = cohesiveTodayServiceInputSchema.safeParse({
    workspaceId: url.searchParams.get("workspaceId") || undefined,
    workLimit: numberQuery(url, "workLimit", 16),
    approvalLimit: numberQuery(url, "approvalLimit", 12),
    meetingLimit: numberQuery(url, "meetingLimit", 50),
    accountLimit: numberQuery(url, "accountLimit", 50),
  });
  if (!parsed.success) return Response.json(
    { error: "Invalid cohesive Today request.", details: parsed.error.flatten() },
    { status: 400, headers: privateNoStoreHeaders },
  );
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "today_agenda" });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const result = await showCohesiveTodayService(createAppServiceCaller({ context }), parsed.data);
  return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: privateNoStoreHeaders });
}

function numberQuery(url: URL, name: string, fallback: number) {
  const value = url.searchParams.get(name);
  return value === null || !value.trim() ? fallback : Number(value);
}
