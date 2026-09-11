import {
  credentialVaultStatus,
  openCredentialBundle,
  sealCredentialBundle,
  type SealedCredentialPayload,
} from "@/lib/settings/credential-vault";
import {
  isSealedPayload,
  openJsonPayload,
  type SealedPayload,
} from "@/lib/security/sealed-payload";

const TOKEN_BUNDLE_FIELD = "oauthTokensJson";

export type SealedOAuthTokens = SealedCredentialPayload | SealedPayload;

export function sealOAuthTokens(
  tokens: Record<string, unknown>,
  binding: string,
): SealedCredentialPayload {
  return sealCredentialBundle(
    { [TOKEN_BUNDLE_FIELD]: JSON.stringify(tokens) },
    binding,
  );
}

export function openOAuthTokens(
  value: unknown,
  binding: string,
): Readonly<{
  tokens: Record<string, unknown>;
  needsRewrap: boolean;
}> {
  if (isKeyedCredentialPayload(value)) {
    const bundle = openCredentialBundle(value, binding);
    const tokens = parseTokenRecord(bundle[TOKEN_BUNDLE_FIELD]);
    const status = credentialVaultStatus();
    if (!status.configured) {
      throw new Error("The OAuth credential keyring is unavailable.");
    }
    return {
      tokens,
      needsRewrap: value.keyId !== status.activeKeyId,
    };
  }
  if (!isSealedPayload(value)) {
    throw new Error("The OAuth credential bundle is invalid.");
  }
  return {
    tokens: parseTokenRecord(openJsonPayload(value, binding)),
    needsRewrap: true,
  };
}

function isKeyedCredentialPayload(
  value: unknown,
): value is SealedCredentialPayload {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as { keyId?: unknown }).keyId === "string",
  );
}

function parseTokenRecord(value: unknown): Record<string, unknown> {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      throw new Error("The OAuth credential bundle is invalid.");
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("The OAuth credential bundle is invalid.");
  }
  return { ...(candidate as Record<string, unknown>) };
}
