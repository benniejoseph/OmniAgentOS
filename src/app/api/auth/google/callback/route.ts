import { exchangeGooglePrivateCode } from "@/lib/auth/google";
import { sessionCookie } from "@/lib/auth/session";
import { authenticateFederatedIdentity } from "@/lib/auth/store";
import { getAppBaseUrl } from "@/lib/config";
import { enforcePrivateNoStore } from "@/lib/http/response";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return enforcePrivateNoStore(
      Response.redirect(`${getAppBaseUrl()}/login?google=denied`, 302),
    );
  }
  try {
    const profile = await exchangeGooglePrivateCode(code, state);
    const result = await authenticateFederatedIdentity({
      email: profile.email,
      name: profile.name,
    });
    if (!result) {
      throw new Error("The verified Google identity is not an active private account.");
    }
    return enforcePrivateNoStore(
      new Response(null, {
        status: 302,
        headers: {
          location: `${getAppBaseUrl()}/app`,
          "set-cookie": sessionCookie(result.token, result.identity.session.expiresAt),
        },
      }),
    );
  } catch {
    return enforcePrivateNoStore(
      Response.redirect(`${getAppBaseUrl()}/login?google=failed`, 302),
    );
  }
}
