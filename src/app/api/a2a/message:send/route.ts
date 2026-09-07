import {
  a2aErrorResponse,
  a2aJsonResponse,
  a2aOptionsResponse,
  assertA2AJsonContentType,
  authorizeA2AHttpRequest,
  runInA2APrincipalScope,
} from "@/lib/a2a/http";
import { sendInboundA2AMessageV1 } from "@/lib/a2a/server";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody } from "@/lib/http/body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withDatabaseRequestScope(POSTHandler);
export const OPTIONS = withDatabaseRequestScope(a2aOptionsResponse);

async function POSTHandler(request: Request) {
  let allowedOrigin: string | undefined;
  try {
    assertA2AJsonContentType(request);
    const authorization = await authorizeA2AHttpRequest(request, [
      "a2a:discover",
      "a2a:tasks:write",
    ]);
    allowedOrigin = authorization.allowedOrigin;
    const body = await parseJsonBody(request);
    const task = await runInA2APrincipalScope(authorization.principal, () =>
      sendInboundA2AMessageV1({
        principal: authorization.principal,
        request: body,
        abortSignal: request.signal,
      })
    );
    return a2aJsonResponse({ task }, {}, allowedOrigin);
  } catch (error) {
    return a2aErrorResponse(error, allowedOrigin);
  }
}
