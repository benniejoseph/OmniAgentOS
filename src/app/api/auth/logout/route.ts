import { clearSessionCookie, getSessionToken } from "@/lib/auth/session";
import { destroySession } from "@/lib/auth/store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  await destroySession(getSessionToken(request));
  return Response.json(
    { authenticated: false },
    {
      headers: {
        "Set-Cookie": clearSessionCookie(),
      },
    },
  );
}
