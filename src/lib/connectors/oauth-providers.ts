import { createHash, randomBytes } from "node:crypto";
import { getAppBaseUrl } from "@/lib/config";
import { openJsonPayload, sealJsonPayload } from "@/lib/security/sealed-payload";
import { GOOGLE_WORKSPACE_OAUTH_SCOPES } from "@/lib/connectors/google-workspace-capabilities";

export {
  GOOGLE_GMAIL_SEND_SCOPE,
  GOOGLE_PHOTOS_PICKER_SCOPE,
} from "@/lib/connectors/google-workspace-capabilities";
export { GOOGLE_CALENDAR_EVENTS_SCOPE as GOOGLE_CALENDAR_WRITE_SCOPE } from "@/lib/connectors/google-workspace-capabilities";

export type OAuthProvider = "google" | "salesforce";
export type GoogleConnectionPurpose = "personal" | "work";
export type GoogleConnectorAccountPolicy = Readonly<{
  purpose: GoogleConnectionPurpose;
  email: string;
  label: string;
}>;
export type OAuthProviderFailureCode =
  | "token_exchange_failed"
  | "refresh_rejected"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "owner_verification_failed";

export class OAuthProviderError extends Error {
  readonly status = 502;

  constructor(
    message: string,
    readonly code: OAuthProviderFailureCode,
    readonly reconnectRequired: boolean,
  ) {
    super(message);
    this.name = "OAuthProviderError";
  }
}

const oauthReturnPaths = new Set([
  "/app/accounts",
  "/app/capture",
  "/app/connectors",
]);

export const oauthProviders = {
  google: {
    label: "Google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
    clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
    scopes: GOOGLE_WORKSPACE_OAUTH_SCOPES,
  },
  salesforce: {
    label: "Salesforce",
    authorizeUrl: "https://login.salesforce.com/services/oauth2/authorize",
    tokenUrl: "https://login.salesforce.com/services/oauth2/token",
    revokeUrl: "https://login.salesforce.com/services/oauth2/revoke",
    clientIdEnv: "SALESFORCE_OAUTH_CLIENT_ID",
    clientSecretEnv: "SALESFORCE_OAUTH_CLIENT_SECRET",
    scopes: ["api", "refresh_token"],
  },
} as const;

export function isOAuthProvider(value: string): value is OAuthProvider {
  return value === "google" || value === "salesforce";
}
export function oauthConfigured(provider: OAuthProvider) {
  const config = oauthProviders[provider];
  return Boolean(
    process.env[config.clientIdEnv]?.trim() &&
      process.env[config.clientSecretEnv]?.trim() &&
      (provider !== "google" || googleOwnerEmail()),
  );
}

export function googleConnectorAccountPolicy(
  purpose: GoogleConnectionPurpose,
): GoogleConnectorAccountPolicy {
  const email = purpose === "personal"
    ? googleOwnerEmail()
    : (
        process.env.OMNIAGENT_GOOGLE_WORK_EMAIL ||
        "benniejoseph.richard@gmail.com"
      ).trim().toLowerCase();
  if (!isNormalizedEmail(email)) {
    throw new Error(
      purpose === "personal"
        ? "The private Google account policy is not configured."
        : "The work Google account policy is not configured.",
    );
  }
  return {
    purpose,
    email,
    label: purpose === "personal" ? "Personal" : "Work",
  };
}

export function createOAuthAuthorization(
  provider: OAuthProvider,
  identity: {
    tenantId: string;
    actorId: string;
    workspaceId?: string;
    returnTo?: string;
    authorizationIntent?: "connect" | "repair";
    googleConnectionPurpose?: GoogleConnectionPurpose;
    connectionId?: string;
  },
) {
  const config = oauthProviders[provider];
  const clientId = process.env[config.clientIdEnv]?.trim();
  if (
    !clientId ||
    !process.env[config.clientSecretEnv]?.trim() ||
    (provider === "google" && !googleOwnerEmail())
  ) {
    throw new Error(`${config.label} OAuth is not configured.`);
  }
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const googleAccount = provider === "google"
    ? googleConnectorAccountPolicy(identity.googleConnectionPurpose || "personal")
    : undefined;
  const state = sealJsonPayload(
    {
      tenantId: identity.tenantId,
      actorId: identity.actorId,
      workspaceId: identity.workspaceId || null,
      provider,
      verifier,
      returnTo: normalizeOAuthReturnTo(identity.returnTo),
      googleConnectionPurpose: googleAccount?.purpose || null,
      connectionId: identity.connectionId || null,
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
  if (provider === "google") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("login_hint", googleAccount!.email);
    if (identity.authorizationIntent === "repair") {
      url.searchParams.set("prompt", "consent");
    } else {
      url.searchParams.set("prompt", "select_account");
    }
  }
  return url.toString();
}

export function openOAuthState(provider: OAuthProvider, encoded: string) {
  try {
    if (!/^[A-Za-z0-9_-]{40,8000}$/.test(encoded)) throw new Error("Invalid state encoding.");
    const sealed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const state = openJsonPayload(sealed, `oauth:${provider}`) as {
      tenantId: string;
      actorId: string;
      workspaceId?: string | null;
      provider: string;
      verifier: string;
      returnTo?: string;
      googleConnectionPurpose?: string | null;
      connectionId?: string | null;
      expiresAt: number;
    };
    if (
      state.provider !== provider ||
      typeof state.tenantId !== "string" ||
      typeof state.actorId !== "string" ||
      !(state.workspaceId === null || state.workspaceId === undefined ||
        (typeof state.workspaceId === "string" &&
          /^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(state.workspaceId))) ||
      typeof state.verifier !== "string" ||
      !state.verifier ||
      !(
        state.googleConnectionPurpose === null ||
        state.googleConnectionPurpose === undefined ||
        state.googleConnectionPurpose === "personal" ||
        state.googleConnectionPurpose === "work"
      ) ||
      !(
        state.connectionId === null ||
        state.connectionId === undefined ||
        isOpaqueOAuthConnectionId(state.connectionId)
      ) ||
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

export async function exchangeOAuthCode(
  provider: OAuthProvider,
  code: string,
  verifier: string,
  options?: { googleConnectionPurpose?: GoogleConnectionPurpose },
) {
  const config = oauthProviders[provider];
  const body = new URLSearchParams({ client_id: process.env[config.clientIdEnv] || "", client_secret: process.env[config.clientSecretEnv] || "", code, code_verifier: verifier, redirect_uri: `${getAppBaseUrl()}/api/oauth/${provider}/callback`, grant_type: "authorization_code" });
  let response: Response;
  try {
    response = await fetch(config.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw oauthProviderFailure(0, "exchange", config.label);
  }
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof result.access_token !== "string") {
    throw oauthProviderFailure(response.status, "exchange");
  }
  if (
    provider === "salesforce" &&
    !isSalesforceInstanceUrl(result.instance_url)
  ) {
    throw new Error("Salesforce returned an invalid instance authority.");
  }
  if (provider === "google") {
    const identity = await validateGoogleConnectorIdentity(
      result,
      options?.googleConnectionPurpose || "personal",
    ).catch(async (error) => {
      await revokeOAuthAccess(
        "google",
        String(result.refresh_token || result.access_token || ""),
      ).catch(() => false);
      throw error;
    });
    const { id_token: _idToken, ...persistable } = result;
    void _idToken;
    return {
      ...persistable,
      scope: typeof result.scope === "string"
        ? result.scope
        : config.scopes.join(" "),
      google_account_sub: identity.subject,
      google_account_email: identity.email,
    };
  }
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
  let response: Response;
  try {
    response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw oauthProviderFailure(0, "refresh", config.label);
  }
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof result.access_token !== "string") {
    throw oauthProviderFailure(response.status, "refresh", config.label);
  }
  if (
    provider === "salesforce" &&
    result.instance_url !== undefined &&
    !isSalesforceInstanceUrl(result.instance_url)
  ) {
    throw new Error("Salesforce returned an invalid instance authority.");
  }
  return { ...result, refresh_token: typeof result.refresh_token === "string" ? result.refresh_token : refreshToken };
}

export async function revokeOAuthAccess(provider: OAuthProvider, token: string) {
  if (!token) return false;
  const response = await fetch(
    provider === "google"
      ? "https://oauth2.googleapis.com/revoke"
      : oauthProviders.salesforce.revokeUrl,
    {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) throw new Error(`${oauthProviders[provider].label} access could not be revoked. Try again.`);
  return true;
}

export function isSalesforceInstanceUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 500) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      (
        host.endsWith(".salesforce.com") ||
        host.endsWith(".salesforce.mil") ||
        host.endsWith(".cloudforce.com")
      );
  } catch {
    return false;
  }
}

async function validateGoogleConnectorIdentity(
  tokens: Record<string, unknown>,
  purpose: GoogleConnectionPurpose,
) {
  const idToken = typeof tokens.id_token === "string" ? tokens.id_token : "";
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || "";
  const expectedEmail = googleConnectorAccountPolicy(purpose).email;
  if (!idToken || !clientId || !expectedEmail) {
    throw new OAuthProviderError(
      "Google could not verify the allowed private Workspace account.",
      "owner_verification_failed",
      true,
    );
  }
  let response: Response;
  try {
    response = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    throw oauthProviderFailure(0, "exchange", "Google");
  }
  const claims = await response.json().catch(() => ({})) as Record<string, unknown>;
  const issuer = String(claims.iss || "");
  const verified = claims.email_verified === true || claims.email_verified === "true";
  const email = String(claims.email || "").trim().toLowerCase();
  const subject = String(claims.sub || "").trim();
  if (
    !response.ok ||
    String(claims.aud || "") !== clientId ||
    !["accounts.google.com", "https://accounts.google.com"].includes(issuer) ||
    !verified ||
    Number(claims.exp || 0) * 1_000 <= Date.now() ||
    email !== expectedEmail ||
    !/^[A-Za-z0-9_-]{6,255}$/.test(subject)
  ) {
    throw new OAuthProviderError(
      "Google identity is not authorized for this private workspace.",
      "owner_verification_failed",
      true,
    );
  }
  return { email, subject };
}

function isOpaqueOAuthConnectionId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function isNormalizedEmail(value: string) {
  return value.length >= 3 && value.length <= 320 &&
    value === value.trim().toLowerCase() &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function googleOwnerEmail() {
  return (
    process.env.OMNIAGENT_OWNER_EMAIL ||
    process.env.OWNER_EMAIL ||
    process.env.OMNIAGENT_BOOTSTRAP_EMAIL ||
    ""
  ).trim().toLowerCase();
}

function oauthProviderFailure(
  status: number,
  operation: "exchange" | "refresh",
  label = "OAuth",
) {
  if (status === 429) {
    return new OAuthProviderError(
      `${label} is temporarily rate limited. Try again shortly.`,
      "provider_rate_limited",
      false,
    );
  }
  if (status >= 500 || status === 0) {
    return new OAuthProviderError(
      `${label} is temporarily unavailable. Try again shortly.`,
      "provider_unavailable",
      false,
    );
  }
  if (operation === "refresh") {
    return new OAuthProviderError(
      `${label} refresh authorization was rejected. Reconnect the source.`,
      "refresh_rejected",
      true,
    );
  }
  return new OAuthProviderError(
    "OAuth token exchange failed.",
    "token_exchange_failed",
    false,
  );
}
