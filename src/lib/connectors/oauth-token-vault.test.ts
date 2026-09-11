import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openOAuthTokens,
  sealOAuthTokens,
} from "@/lib/connectors/oauth-token-vault";
import { sealJsonPayload } from "@/lib/security/sealed-payload";

const originalKeyring = process.env.OMNIAGENT_CREDENTIAL_KEYRING;
const originalLegacySecret = process.env.OMNIAGENT_EXECUTION_PAYLOAD_SECRET;

afterEach(() => {
  vi.unstubAllEnvs();
  restore("OMNIAGENT_CREDENTIAL_KEYRING", originalKeyring);
  restore("OMNIAGENT_EXECUTION_PAYLOAD_SECRET", originalLegacySecret);
});

describe("OAuth token vault", () => {
  it("writes only with the active credential key and does not expose tokens", () => {
    vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", keyring("v1", ["v1"]));
    const sealed = sealOAuthTokens(
      { access_token: "private-access", expires_in: 3_600 },
      "oauth-grant:tenant:actor:google",
    );

    expect(sealed.keyId).toBe("v1");
    expect(JSON.stringify(sealed)).not.toContain("private-access");
    expect(openOAuthTokens(
      sealed,
      "oauth-grant:tenant:actor:google",
    )).toEqual({
      tokens: { access_token: "private-access", expires_in: 3_600 },
      needsRewrap: false,
    });
  });

  it("reads a retained key and marks it for active-key rotation", () => {
    vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", keyring("v1", ["v1"]));
    const sealedV1 = sealOAuthTokens(
      { refresh_token: "private-refresh" },
      "oauth-grant:tenant:actor:google",
    );
    vi.stubEnv(
      "OMNIAGENT_CREDENTIAL_KEYRING",
      keyring("v2", ["v1", "v2"]),
    );

    const opened = openOAuthTokens(
      sealedV1,
      "oauth-grant:tenant:actor:google",
    );
    expect(opened).toEqual({
      tokens: { refresh_token: "private-refresh" },
      needsRewrap: true,
    });
    expect(sealOAuthTokens(opened.tokens, "oauth-grant:tenant:actor:google").keyId)
      .toBe("v2");
  });

  it("keeps legacy execution-payload envelopes readable for migration", () => {
    vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", keyring("v2", ["v2"]));
    vi.stubEnv(
      "OMNIAGENT_EXECUTION_PAYLOAD_SECRET",
      "legacy-oauth-token-secret-at-least-thirty-two-bytes",
    );
    const legacy = sealJsonPayload(
      { access_token: "legacy-private-access" },
      "oauth-grant:tenant:actor:google",
    );

    expect(openOAuthTokens(
      legacy,
      "oauth-grant:tenant:actor:google",
    )).toEqual({
      tokens: { access_token: "legacy-private-access" },
      needsRewrap: true,
    });
  });
});

function keyring(activeKeyId: string, keyIds: string[]) {
  return JSON.stringify({
    activeKeyId,
    keys: Object.fromEntries(keyIds.map((keyId) => [
      keyId,
      createHash("sha256").update(`oauth-test:${keyId}`).digest("base64url"),
    ])),
  });
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
