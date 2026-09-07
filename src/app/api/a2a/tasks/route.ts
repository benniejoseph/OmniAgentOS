import {
  a2aErrorResponse,
  a2aJsonResponse,
  a2aOptionsResponse,
  authorizeA2AHttpRequest,
  runInA2APrincipalScope,
} from "@/lib/a2a/http";
import { listInboundA2ATasksV1 } from "@/lib/a2a/server";
import { withDatabaseRequestScope } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withDatabaseRequestScope(GETHandler);
export const OPTIONS = withDatabaseRequestScope(a2aOptionsResponse);

async function GETHandler(request: Request) {
  let allowedOrigin: string | undefined;
  try {
    const authorization = await authorizeA2AHttpRequest(request, [
      "a2a:discover",
      "a2a:tasks:read",
    ]);
    allowedOrigin = authorization.allowedOrigin;
    const url = new URL(request.url);
    const pageSizeValue = url.searchParams.get("pageSize");
    const pageSize = pageSizeValue === null ? undefined : Number(pageSizeValue);
    if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)) {
      throw new Error("A2A pageSize must be between 1 and 100.");
    }
    const result = await runInA2APrincipalScope(authorization.principal, () =>
      listInboundA2ATasksV1({
        principal: authorization.principal,
        contextId: url.searchParams.get("contextId") || undefined,
        pageSize,
      })
    );
    return a2aJsonResponse(result, {}, allowedOrigin);
  } catch (error) {
    return a2aErrorResponse(error, allowedOrigin);
  }
}
