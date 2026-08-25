import { createHash, randomBytes } from "node:crypto";
import { getAppBaseUrl } from "@/lib/config";
import { openJsonPayload, sealJsonPayload } from "@/lib/security/sealed-payload";

const googleAuthorizeUrl = "https://accounts.google.com/o/oauth2/v2/auth";
const googleTokenUrl = "https://oauth2.googleapis.com/token";
const googleTokenInfoUrl = "https://oauth2.googleapis.com/tokeninfo";

type LoginState = {
  verifier: string;
  nonce: string;
  expiresAt: number;
};

export function googleOwnerLoginConfigured() {
  return Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() &&
      process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() &&
      ownerEmail(),
  );
}

export function createGoogleOwnerAuthorization() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  if (!clientId || !process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || !ownerEmail()) {
    throw new Error("Google owner login is not configured.");
  }
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const sealed = sealJsonPayload(
    { verifier, nonce, expiresAt: Date.now() + 10 * 60_000 } satisfies LoginState,
    "auth:google-owner",
  );
  const url = new URL(googleAuthorizeUrl);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", googleOwnerCallbackUrl());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", Buffer.from(JSON.stringify(sealed)).toString("base64url"));
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export async function exchangeGoogleOwnerCode(code: string, encodedState: string) {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("Google owner login is not configured.");
  const state = openLoginState(encodedState);
  const tokenResponse = await fetch(googleTokenUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: state.verifier,
      redirect_uri: googleOwnerCallbackUrl(),
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const tokens = (await tokenResponse.json().catch(() => ({}))) as Record<string, unknown>;
  const idToken = typeof tokens.id_token === "string" ? tokens.id_token : "";
  if (!tokenResponse.ok || !idToken) throw new Error("Google owner token exchange failed.");
  const claimsResponse = await fetch(
    `${googleTokenInfoUrl}?id_token=${encodeURIComponent(idToken)}`,
    { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
  );
  const claims = (await claimsResponse.json().catch(() => ({}))) as Record<string, unknown>;
  const email = String(claims.email || "").trim().toLowerCase();
  const issuer = String(claims.iss || "");
  const expiresAt = Number(claims.exp || 0) * 1_000;
  if (
    !claimsResponse.ok ||
    String(claims.aud || "") !== clientId ||
    !["accounts.google.com", "https://accounts.google.com"].includes(issuer) ||
    claims.email_verified !== "true" ||
    expiresAt <= Date.now() ||
    String(claims.nonce || "") !== state.nonce ||
    email !== ownerEmail()
  ) {
    throw new Error("Google identity is not authorized for this private workspace.");
  }
  return { email, name: String(claims.name || "Asael Owner") };
}

function openLoginState(encoded: string): LoginState {
  const sealed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  const state = openJsonPayload(sealed, "auth:google-owner") as LoginState;
  if (!state.verifier || !state.nonce || state.expiresAt < Date.now()) {
    throw new Error("Google login state is invalid or expired.");
  }
  return state;
}

function googleOwnerCallbackUrl() {
  return `${getAppBaseUrl()}/api/auth/google/callback`;
}

function ownerEmail() {
  return (
    process.env.OMNIAGENT_OWNER_EMAIL || process.env.OMNIAGENT_BOOTSTRAP_EMAIL || ""
  )
    .trim()
    .toLowerCase();
}
