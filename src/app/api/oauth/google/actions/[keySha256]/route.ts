import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { readGooglePersonalNativeService } from "@/lib/app-services/google-personal-native";
import { googlePersonalNativeFailure,googlePersonalNativeHeaders as headers,googlePersonalPrivateResponse } from "@/lib/connectors/google-personal-native-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest,forbiddenResponse } from "@/lib/security/guard";
export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
async function GETHandler(request: Request,route: { params: Promise<{ keySha256: string }> }) {
  const { keySha256 } = await route.params;
  if ([...new URL(request.url).searchParams].length || !/^[a-f0-9]{64}$/.test(keySha256)) return Response.json({ error: "An exact Google receipt key is required." },{ status: 400,headers });
  let context; try { context = await authorizeRequest({ request,action: "read",resourceType: "oauth_grant" }); }
  catch (error) { return googlePersonalPrivateResponse(forbiddenResponse(error)); }
  try { const result = await readGooglePersonalNativeService(createAppServiceCaller({ context }),keySha256); return Response.json({ ...result.data,serviceReceipt: result.receipt },{ headers }); }
  catch (error) { return googlePersonalNativeFailure(error); }
}
