import {
  clearLegacySessionCookies,
  clearSessionCookie,
  getSessionToken,
} from "@/lib/auth/session";
import { destroySession } from "@/lib/auth/store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  assertTrustedSessionMutation,
  forbiddenResponse,
} from "@/lib/security/guard";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

async function POSTHandler(request: Request) {
  const token = getSessionToken(request);
  try {
    if (token) {
      assertTrustedSessionMutation(request);
    }
    await destroySession(token);
  } catch (error) {
    return forbiddenResponse(error);
  }
  const headers = new Headers();
  headers.append("Set-Cookie", clearSessionCookie());
  for (const legacyCookie of clearLegacySessionCookies()) {
    headers.append("Set-Cookie", legacyCookie);
  }
  return Response.json({ authenticated: false }, { headers });
}
