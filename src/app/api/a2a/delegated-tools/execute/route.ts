import {
  authenticateDelegatedA2AToolRequest,
  executeDelegatedA2AToolV1,
} from "@/lib/a2a/delegated-tools";
import {
  a2aErrorResponse,
  a2aJsonResponse,
  a2aOptionsResponse,
  assertA2AJsonContentType,
} from "@/lib/a2a/http";
import { assertTrustedA2ANetworkBoundary } from "@/lib/a2a/auth";
import { assertA2AProtocolVersion } from "@/lib/a2a/v1-contracts";
import {
  runWithDatabaseTenantScope,
  withDatabaseRequestScope,
} from "@/lib/db/client";
import { parseJsonBody } from "@/lib/http/body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withDatabaseRequestScope(POSTHandler);
export const OPTIONS = withDatabaseRequestScope(a2aOptionsResponse);

async function POSTHandler(request: Request) {
  let allowedOrigin: string | undefined;
  try {
    allowedOrigin = assertTrustedA2ANetworkBoundary(request);
    assertA2AProtocolVersion(request);
    assertA2AJsonContentType(request);
    const envelope = authenticateDelegatedA2AToolRequest(request);
    const body = await parseJsonBody(request, 256_000);
    const result = await runWithDatabaseTenantScope(
      envelope.principal.tenantId,
      () => executeDelegatedA2AToolV1({
        envelope,
        request: body,
        abortSignal: request.signal,
      }),
    );
    const status = result.execution.status === "approval_required" ||
        result.execution.status === "blocked"
      ? 202
      : result.execution.status === "failed"
        ? 500
        : 200;
    return a2aJsonResponse(result, { status }, allowedOrigin);
  } catch (error) {
    return a2aErrorResponse(error, allowedOrigin);
  }
}
