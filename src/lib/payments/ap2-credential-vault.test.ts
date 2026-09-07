import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AP2_BOUNDARY_VERSION } from "@/lib/payments/ap2-contracts";
import {
  ap2CredentialProviderAuthorizationSchema,
  buildAp2CredentialGrant,
  buildAp2CredentialProviderConfiguration,
  credentialProviderSigningPayload,
  type Ap2CredentialAuthorizationRequest,
} from "@/lib/payments/ap2-credential-authorization";
import {
  openAp2CredentialAuthorization,
  sealAp2CredentialAuthorization,
} from "@/lib/payments/ap2-credential-vault";
import { loadAp2Readiness } from "@/lib/payments/ap2-readiness";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

afterEach(() => vi.unstubAllEnvs());

describe("P9.17 AP2 credential vault boundary", () => {
  it("encrypts the provider token and authenticates every grant binding", () => {
    vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", JSON.stringify({
      activeKeyId: "payment-test-key",
      keys: { paymentKeyUnused: "unused", "payment-test-key": Buffer.alloc(32, 7).toString("base64url") },
    }));
    const fixture = grantFixture();
    const sealedAuthorization = sealAp2CredentialAuthorization(fixture);

    expect(JSON.stringify(sealedAuthorization)).not.toContain("one-time-provider-token");
    expect(openAp2CredentialAuthorization({
      grant: fixture.grant,
      sealedAuthorization,
    })).toEqual(fixture.authorization);

    const changedBody = {
      ...fixture.grant,
      scopedTokenSha256: "f".repeat(64),
    };
    expect(() => openAp2CredentialAuthorization({
      grant: changedBody,
      sealedAuthorization,
    })).toThrow();
  });
});

function grantFixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ format: "der", type: "spki" });
  const reviewedAdapter = {
    contractVersion: AP2_BOUNDARY_VERSION,
    adapterContractId: "adapter:credential-provider:vault-test",
    role: "credential_provider" as const,
    operatorName: "Vault test provider",
    endpointOrigin: "https://credential-provider.example",
    endpointAuthenticationProfile: "mtls:vault-test",
    release: "vault-test-v1",
    artifactSha256: sha256("vault-test-artifact"),
    deterministicVerifierRelease: "vault-test-verifier-v1",
    supportedProtocol: loadAp2Readiness().protocol,
    credentialMaterialExportableToAsael: false as const,
    modelInVerificationPath: false as const,
  };
  const configuration = buildAp2CredentialProviderConfiguration({
    version: "p9.17-ap2-credential-provider:1",
    providerId: "credential_provider_1",
    participantId: "participant:credential-provider:vault-test",
    adapterContract: {
      ...reviewedAdapter,
      review: {
        reviewId: "review:credential-provider:vault-test",
        reviewerPrincipalSha256: sha256("reviewer"),
        reviewedAt: "2026-09-01T00:00:00.000Z",
        contractSha256: canonicalJsonSha256(reviewedAdapter),
      },
      rolloutState: "enabled",
    },
    signingKey: {
      keyId: "provider-key:vault-test",
      algorithm: "ES256",
      spkiDerBase64url: spki.toString("base64url"),
      publicKeySha256: createHash("sha256").update(spki).digest("hex"),
      validFrom: "2026-09-01T00:00:00.000Z",
      validUntil: "2027-09-01T00:00:00.000Z",
      revocation: { status: "active", effectiveAt: null },
    },
    acceptedMerchantPaymentProcessorIds: ["processor_1"],
    maximumScopeTtlSeconds: 180,
    credentialBoundary: {
      rawCredentialExportableToAsael: false,
      privateSigningKeyExportableToAsael: false,
      providerTokenVisibleToModelOrBrowser: false,
      providerTokenStorage: "encrypted_payment_boundary_only",
      oneTimeScopeRequired: true,
      redirectAllowed: false,
    },
  });
  const scope = {
    purpose: "single_ap2_transaction" as const,
    credentialProviderId: "credential_provider_1",
    merchantPaymentProcessorId: "processor_1",
    merchantSha256: sha256("merchant"),
    checkoutHash: Buffer.from("checkout").toString("base64url"),
    checkoutMandateContentSha256: sha256("checkout-mandate"),
    paymentMandateContentSha256: sha256("payment-mandate"),
    paymentInstrumentReference: "instrument_ref_1",
    paymentInstrumentSha256: sha256("instrument"),
    amountMinor: 11_300,
    currency: "USD",
    intentSha256: sha256("intent"),
    shoppingAgentPrincipalSha256: sha256("agent"),
    authorizationSha256: sha256("authorization"),
    mandateVerificationReceiptSha256: sha256("verification"),
    audience: "processor_1",
    nonce: createHash("sha256").update("nonce").digest().toString("base64url"),
    issuedAt: "2026-09-07T10:05:00.000Z",
    notBefore: "2026-09-07T10:05:00.000Z",
    expiresAt: "2026-09-07T10:08:00.000Z",
    singleUse: true as const,
    redirectAllowed: false as const,
  };
  const requestBody = {
    version: "p9.17-ap2-credential-authorization:1" as const,
    requestId: "ap2_credential_request:11111111-1111-4111-8111-111111111111",
    tenantRefSha256: sha256("tenant_1"),
    ownerActorRefSha256: sha256("actor_1"),
    reviewId: "ap2_review:22222222-2222-4222-8222-222222222222",
    reviewSha256: sha256("review"),
    authorizationId: "ap2_authorization:33333333-3333-4333-8333-333333333333",
    exactTermsSha256: sha256("terms"),
    scope,
  };
  const request: Ap2CredentialAuthorizationRequest = {
    ...requestBody,
    requestSha256: canonicalJsonSha256(requestBody),
  };
  const scopedToken = "one-time-provider-token-material-000001";
  const unsigned = ap2CredentialProviderAuthorizationSchema.parse({
    version: "p9.17-ap2-provider-authorization:1",
    providerId: "credential_provider_1",
    providerAuthorizationId: "provider-auth:vault-test",
    requestId: request.requestId,
    requestSha256: request.requestSha256,
    scopeSha256: canonicalJsonSha256(scope),
    scopedToken,
    scopedTokenSha256: sha256(scopedToken),
    issuedAt: scope.issuedAt,
    expiresAt: scope.expiresAt,
    nonce: scope.nonce,
    singleUse: true,
    redirectAllowed: false,
    signingKeyId: "provider-key:vault-test",
    signatureAlgorithm: "ES256",
    signature: "AA",
  });
  const authorization = {
    ...unsigned,
    signature: sign("sha256", credentialProviderSigningPayload(unsigned), privateKey)
      .toString("base64url"),
  };
  const grant = buildAp2CredentialGrant({
    tenantId: "tenant_1",
    ownerActorId: "actor_1",
    request,
    authorization,
    configuration,
    now: new Date("2026-09-07T10:06:00.000Z"),
  });
  return { grant, authorization };
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
