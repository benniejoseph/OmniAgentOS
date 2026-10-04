import { z } from "zod";
import { hasDatabaseUrl, withDatabaseRequestScope } from "@/lib/db/client";
import { nativeMarketJobResponseSchema } from "@/lib/mobile/market-contracts";
import { getOperationJob } from "@/lib/operations/job-queue";
import { projectReadableOperationJob } from "@/lib/operations/job-visibility";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
const headers = { "cache-control": "private, no-store" };
async function GETHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  if (!z.string().uuid().safeParse(id).success) return Response.json({ error: "Invalid market job identity." }, { status: 400, headers });
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "operation_job", resourceId: id }); }
  catch (error) { return forbiddenResponse(error); }
  try {
    if (!hasDatabaseUrl()) throw new Error("Market job storage unavailable.");
    const row = await getOperationJob(id, { tenantId: context.tenantId });
    const binding = canonicalRequestActorBindingFromSecurityContext(context);
    const job = row && ["market.events.backfill", "market.replays.backfill", "market.backtest.run"].includes(row.type)
      ? projectReadableOperationJob(row, new Set([context.actorId, ...(binding?.readableOwnerActorIds || [])])) : null;
    if (!job) return Response.json({ error: "Market job not found." }, { status: 404, headers });
    const value = nativeMarketJobResponseSchema.parse({ job: { ...job, ...("lastError" in job && typeof job.lastError === "string" ? { lastError: job.lastError.slice(0, 4000) } : {}) } });
    return Response.json(value, { headers });
  } catch { return Response.json({ error: "Market job status is temporarily unavailable." }, { status: 503, headers }); }
}
