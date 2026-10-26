import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody, jsonBodyErrorResponse } from "@/lib/http/body";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { executeSelfImprovementControllerAction, listSelfImprovementReleaseRequests } from "@/lib/self-improvement/release-service";
export const runtime = "nodejs";
export const maxDuration = 60;
const headers = { "cache-control": "private, no-store" };
export const GET = withDatabaseRequestScope(async (request: Request) => {
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "self_improvement_release" }); } catch (error) { return forbiddenResponse(error); }
  try { return Response.json(await listSelfImprovementReleaseRequests(context), { headers }); }
  catch { return Response.json({ error: "Release controller owner or candidate is unavailable." }, { status: 403, headers }); }
});
export const POST = withDatabaseRequestScope(requireIdempotencyKey(async (request: Request) => {
  let context;
  try { context = await authorizeRequest({ request, action: "manage.workflow", resourceType: "self_improvement_release" }); } catch (error) { return forbiddenResponse(error); }
  let body;
  try { body = await parseJsonBody(request, 64_000); } catch (error) { return jsonBodyErrorResponse(error); }
  try { return Response.json(await executeSelfImprovementControllerAction(context, body), { headers }); }
  catch (error) { return Response.json({ error: "Release controller action was held.", message: error instanceof Error ? error.message.slice(0, 500) : "Release evidence could not be verified." }, { status: 409, headers }); }
}));
