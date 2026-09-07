import { listInternalAgentCardsV1 } from "@/lib/agents/discovery-card";
import {
  A2AAccessError,
  a2aBearerChallenge,
  assertTrustedA2ANetworkBoundary,
  authenticateA2ARequest,
} from "@/lib/a2a/auth";
import {
  A2A_MEDIA_TYPE,
  A2A_PROTOCOL_VERSION,
  assertA2AProtocolVersion,
  buildAsaelA2AAgentCardV1,
} from "@/lib/a2a/v1-contracts";
import { A2A_ADAPTER_RELEASE } from "@/lib/a2a/rollout";
import { withDatabaseRequestScope } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  let allowedOrigin: string | undefined;
  try {
    allowedOrigin = assertTrustedA2ANetworkBoundary(request);
    assertA2AProtocolVersion(request);
    const principal = await authenticateA2ARequest(request, ["a2a:discover"]);
    const cards = listInternalAgentCardsV1({
      tenantId: principal.tenantId,
      controllerActorId: principal.actorId,
    });
    return secureA2AResponse(Response.json(
      buildAsaelA2AAgentCardV1({
        baseUrl: process.env.NEXT_PUBLIC_APP_URL?.trim() || new URL(request.url).origin,
        releaseVersion: A2A_ADAPTER_RELEASE,
        internalCards: cards,
      }),
    ), allowedOrigin);
  } catch (error) {
    return a2aErrorResponse(error, allowedOrigin);
  }
}

function a2aErrorResponse(error: unknown, allowedOrigin?: string) {
  const access = error instanceof A2AAccessError ? error : undefined;
  const protocol = error && typeof error === "object" && "status" in error && "code" in error
    ? error as { status: number; code: string; message?: string }
    : undefined;
  const status = access?.status || protocol?.status || 500;
  const headers = new Headers();
  if (status === 401) {
    headers.set("WWW-Authenticate", a2aBearerChallenge(access?.requiredScope));
  }
  return secureA2AResponse(Response.json({
    error: {
      code: protocol?.code || (status === 401 ? "unauthenticated" : "forbidden"),
      message: access?.message || protocol?.message || "The A2A request could not be completed.",
      details: [],
    },
  }, { status, headers }), allowedOrigin);
}

function secureA2AResponse(response: Response, allowedOrigin?: string) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Pragma", "no-cache");
  headers.set("Content-Type", `${A2A_MEDIA_TYPE}; charset=utf-8`);
  headers.set("A2A-Version", A2A_PROTOCOL_VERSION);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Vary", "Authorization, Origin, A2A-Version");
  if (allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    headers.set("Access-Control-Expose-Headers", "A2A-Version");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
