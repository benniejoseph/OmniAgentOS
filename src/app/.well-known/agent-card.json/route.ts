import { buildAsaelA2AAgentCardV1 } from "@/lib/a2a/v1-contracts";
import {
  A2AAccessError,
  assertTrustedA2ANetworkBoundary,
} from "@/lib/a2a/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    assertTrustedA2ANetworkBoundary(request);
    return Response.json(buildAsaelA2AAgentCardV1({
      baseUrl: applicationBaseUrl(request),
      releaseVersion: "p8.6-a2a-adapter:1",
    }), { headers: publicCardHeaders() });
  } catch (error) {
    const status = error instanceof A2AAccessError ? error.status : 503;
    const message = error instanceof A2AAccessError
      ? error.message
      : "A2A discovery is unavailable.";
    return Response.json({ error: { code: status, message, details: [] } }, {
      status,
      headers: publicCardHeaders(),
    });
  }
}

function applicationBaseUrl(request: Request) {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  return configured || new URL(request.url).origin;
}

function publicCardHeaders() {
  return {
    "Cache-Control": "public, max-age=300, must-revalidate",
    "Content-Type": "application/a2a+json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}
