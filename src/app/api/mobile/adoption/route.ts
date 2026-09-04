import { getNativeClientAdoption } from "@/lib/auth/mobile";
import { mobileNoStoreHeaders } from "@/lib/auth/mobile-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  try {
    const context = await authorizeRequest({
      request,
      action: "read.identity",
      resourceType: "native_client_adoption",
    });
    return Response.json(await getNativeClientAdoption(context), {
      headers: mobileNoStoreHeaders,
    });
  } catch (error) {
    const response = forbiddenResponse(error);
    for (const [name, value] of Object.entries(mobileNoStoreHeaders)) {
      response.headers.set(name, value);
    }
    return response;
  }
}
