import { exchangeGooglePrivateCode } from "@/lib/auth/google";
import { sessionCookie } from "@/lib/auth/session";
import { authenticateFederatedIdentity } from "@/lib/auth/store";
import { getAppBaseUrl } from "@/lib/config";
import { enforcePrivateNoStore } from "@/lib/http/response";
import { safeCompanionReturn } from "@/lib/companion/return-path";

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
    // The established session cookie authorizes the login entry's read-only
    // preference lookup. Only the sealed, validated explicit target bypasses it.
    const destination = safeCompanionReturn(profile.returnTo);
    const entry = destination ? `/login?next=${encodeURIComponent(destination)}` : "/login";
    return enforcePrivateNoStore(
      new Response(null, {
        status: 302,
        headers: {
          location: `${getAppBaseUrl()}${entry}`,
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
