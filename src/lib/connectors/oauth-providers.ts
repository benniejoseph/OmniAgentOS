import { createHash, randomBytes } from "node:crypto";
import { getAppBaseUrl } from "@/lib/config";
import { openJsonPayload, sealJsonPayload } from "@/lib/security/sealed-payload";

export type OAuthProvider = "google";
export const GOOGLE_PHOTOS_PICKER_SCOPE =
  "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";

const oauthReturnPaths = new Set(["/app/capture", "/app/connectors"]);

export const oauthProviders = {
  google: {
    label: "Google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
    clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
      GOOGLE_PHOTOS_PICKER_SCOPE,
    ],
  },
} as const;

export function isOAuthProvider(value: string): value is OAuthProvider { return value === "google"; }
export function oauthConfigured(provider: OAuthProvider) { const config = oauthProviders[provider]; return Boolean(process.env[config.clientIdEnv]?.trim() && process.env[config.clientSecretEnv]?.trim()); }

export function createOAuthAuthorization(
  provider: OAuthProvider,
  identity: { tenantId: string; actorId: string; returnTo?: string },
) {
  const config = oauthProviders[provider];
  const clientId = process.env[config.clientIdEnv]?.trim();
  if (!clientId || !process.env[config.clientSecretEnv]?.trim()) throw new Error(`${config.label} OAuth is not configured.`);
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = sealJsonPayload(
    {
      tenantId: identity.tenantId,
      actorId: identity.actorId,
      provider,
      verifier,
      returnTo: normalizeOAuthReturnTo(identity.returnTo),
      expiresAt: Date.now() + 10 * 60_000,
    },
    `oauth:${provider}`,
  );
  const redirectUri = `${getAppBaseUrl()}/api/oauth/${provider}/callback`;
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", clientId); url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code"); url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", Buffer.from(JSON.stringify(state)).toString("base64url"));
  url.searchParams.set("code_challenge", challenge); url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline"); url.searchParams.set("include_granted_scopes", "true"); url.searchParams.set("prompt", "consent");
  return url.toString();
}

export function openOAuthState(provider: OAuthProvider, encoded: string) {
  try {
    if (!/^[A-Za-z0-9_-]{40,8000}$/.test(encoded)) throw new Error("Invalid state encoding.");
    const sealed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const state = openJsonPayload(sealed, `oauth:${provider}`) as {
      tenantId: string;
      actorId: string;
      provider: string;
      verifier: string;
      returnTo?: string;
      expiresAt: number;
    };
    if (
      state.provider !== provider ||
      typeof state.tenantId !== "string" ||
      typeof state.actorId !== "string" ||
      typeof state.verifier !== "string" ||
      !state.verifier ||
      !Number.isFinite(state.expiresAt) ||
      state.expiresAt < Date.now()
    ) {
      throw new Error("Invalid state payload.");
    }
    return { ...state, returnTo: normalizeOAuthReturnTo(state.returnTo) };
  } catch {
    throw new Error("OAuth authorization state is invalid or expired.");
  }
}

export function normalizeOAuthReturnTo(value?: string | null) {
  const candidate = String(value || "").trim();
  return oauthReturnPaths.has(candidate) ? candidate : "/app/connectors";
}

export async function exchangeOAuthCode(provider: OAuthProvider, code: string, verifier: string) {
  const config = oauthProviders[provider];
  const body = new URLSearchParams({ client_id: process.env[config.clientIdEnv] || "", client_secret: process.env[config.clientSecretEnv] || "", code, code_verifier: verifier, redirect_uri: `${getAppBaseUrl()}/api/oauth/${provider}/callback`, grant_type: "authorization_code" });
  const response = await fetch(config.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body, signal: AbortSignal.timeout(15_000) });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok || typeof result.access_token !== "string") throw new Error("OAuth token exchange failed.");
  return result;
}

export async function refreshOAuthAccess(provider: OAuthProvider, refreshToken: string): Promise<Record<string, unknown>> {
  const config = oauthProviders[provider];
  const body = new URLSearchParams({
    client_id: process.env[config.clientIdEnv] || "",
    client_secret: process.env[config.clientSecretEnv] || "",
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok || typeof result.access_token !== "string") throw new Error(`${config.label} access expired and could not be refreshed. Reconnect the source.`);
  return { ...result, refresh_token: typeof result.refresh_token === "string" ? result.refresh_token : refreshToken };
}

export async function revokeOAuthAccess(provider: OAuthProvider, token: string) {
  if (provider !== "google" || !token) return false;
  const response = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Google access could not be revoked. Try again.");
  return true;
}
