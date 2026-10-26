import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { configureSelfImprovementService, listSelfImprovementRepositoriesService, pauseSelfImprovementService,
  advanceSelfImprovementService, reviewSelfImprovementService, retrySelfImprovementService, runSelfImprovementService, showSelfImprovementService } from "@/lib/app-services/self-improvement";
import { parseJsonBody, jsonBodyErrorResponse } from "@/lib/http/body";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";

export const runtime = "nodejs";
export const maxDuration = 300;
const headers = { "cache-control": "private, no-store" };
export const GET = withDatabaseRequestScope(async (request: Request) => {
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "self_improvement" }); }
  catch (error) { return forbiddenResponse(error); }
  try {
    const caller = createAppServiceCaller({ context });
    const result = new URL(request.url).searchParams.get("view") === "repositories"
      ? await listSelfImprovementRepositoriesService(caller) : await showSelfImprovementService(caller);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Improvement state is unavailable." }, { status: 409, headers }); }
});

const bodySchema = z.object({ action: z.enum(["configure", "pause", "run", "review", "advance", "retry"]), input: z.record(z.string(), z.unknown()) }).strict();
export const POST = withDatabaseRequestScope(requireIdempotencyKey(async (request: Request) => {
  let body: z.infer<typeof bodySchema>;
  try { body = bodySchema.parse(await parseJsonBody(request, 64_000)); }
  catch (error) { if (error instanceof z.ZodError) return Response.json({ error: "Invalid improvement operation." }, { status: 400, headers }); return jsonBodyErrorResponse(error); }
  let context;
  try { context = await authorizeRequest({ request, action: "manage.workflow", resourceType: "self_improvement",
    riskLevel: body.action === "configure" || body.action === "review" ? 2 : 1, nativeMutationCapability: "workspaces.update" }); }
  catch (error) { return forbiddenResponse(error); }
  try {
    const caller = createRequestMutationAppServiceCaller(request, context, { purpose: `self_improvement.${body.action}` });
    const result = body.action === "configure" ? await configureSelfImprovementService(caller, body.input)
      : body.action === "pause" ? await pauseSelfImprovementService(caller, body.input)
        : body.action === "review" ? await reviewSelfImprovementService(caller, body.input)
          : body.action === "advance" ? await advanceSelfImprovementService(caller, body.input, { abortSignal: request.signal })
            : body.action === "retry" ? await retrySelfImprovementService(caller, body.input)
            : await runSelfImprovementService(caller, body.input);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Improvement operation could not complete." }, { status: 409, headers }); }
}));
