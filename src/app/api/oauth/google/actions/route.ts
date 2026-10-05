import { createAppServiceCaller,createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { reviewGooglePersonalNativeService,submitGooglePersonalNativeService } from "@/lib/app-services/google-personal-native";
import { googlePersonalNativeRequestSchema } from "@/lib/connectors/google-personal-native-contracts";
import { googlePersonalNativeFailure,googlePersonalNativeHeaders as headers,googlePersonalPrivateResponse } from "@/lib/connectors/google-personal-native-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody,jsonBodyErrorResponse } from "@/lib/http/body";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { authorizeRequest,forbiddenResponse } from "@/lib/security/guard";
export const runtime = "nodejs";
export const maxDuration = 300;
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(requireIdempotencyKey(POSTHandler));
async function GETHandler(request: Request) {
  if ([...new URL(request.url).searchParams].length) return Response.json({ error: "Google action queries are not supported." },{ status: 400,headers });
  let context; try { context = await authorizeRequest({ request,action: "read",resourceType: "oauth_grant" }); }
  catch (error) { return googlePersonalPrivateResponse(forbiddenResponse(error)); }
  try { const result = await reviewGooglePersonalNativeService(createAppServiceCaller({ context })); return Response.json({ ...result.data,serviceReceipt: result.receipt },{ headers }); }
  catch (error) { return googlePersonalNativeFailure(error); }
}
async function POSTHandler(request: Request) {
  if ([...new URL(request.url).searchParams].length) return Response.json({ error: "Google action queries are not supported." },{ status: 400,headers });
  let body; try { body = await parseJsonBody(request,16_384); } catch (error) { return googlePersonalPrivateResponse(jsonBodyErrorResponse(error)); }
  const parsed = googlePersonalNativeRequestSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "An exact reviewed Google action is required." },{ status: 400,headers });
  let context; try { context = await authorizeRequest({ request,action: "write.memory",resourceType: "oauth_grant",resourceId: parsed.data.review.connectionId,
    nativeMutationCapability: "google.personal.manage",metadata: { operation: parsed.data.action,authorizationGeneration: parsed.data.review.authorizationGeneration } }); }
  catch (error) { return googlePersonalPrivateResponse(forbiddenResponse(error)); }
  try { const result = await submitGooglePersonalNativeService(createRequestMutationAppServiceCaller(request,context,{ purpose: "api.google.personal.action",causationId: parsed.data.review.connectionId }),parsed.data,request.signal);
    return Response.json({ ...result.data,serviceReceipt: result.receipt },{ status: result.data.replayed ? 200 : 201,headers }); }
  catch (error) { return googlePersonalNativeFailure(error); }
}
