import { createHash } from "node:crypto";

import {
  ap2CredentialGrantSchema,
  ap2CredentialProviderAuthorizationSchema,
  type Ap2CredentialGrant,
  type Ap2CredentialProviderAuthorization,
} from "@/lib/payments/ap2-credential-authorization";
import {
  credentialVaultStatus,
  openCredentialBundle,
  sealCredentialBundle,
  type SealedCredentialPayload,
} from "@/lib/settings/credential-vault";

const BUNDLE_FIELD = "ap2ScopedProviderAuthorization";

export type SealedAp2CredentialAuthorization = SealedCredentialPayload;

export function ap2CredentialVaultStatus() {
  const status = credentialVaultStatus();
  return status.configured
    ? {
        configured: true,
        activeKeyId: status.activeKeyId,
        boundary: "encrypted_payment_boundary_only" as const,
        rawPaymentCredentialStored: false as const,
        message: "AP2 one-time provider authorizations are sealed with the independent tenant credential keyring.",
      }
    : {
        configured: false,
        boundary: "encrypted_payment_boundary_only" as const,
        rawPaymentCredentialStored: false as const,
        message: "The independent tenant credential keyring is required before AP2 provider authorizations can be retained.",
      };
}

export function sealAp2CredentialAuthorization(input: {
  grant: Ap2CredentialGrant;
  authorization: Ap2CredentialProviderAuthorization;
}) {
  const grant = ap2CredentialGrantSchema.parse(input.grant);
  const authorization = ap2CredentialProviderAuthorizationSchema.parse(input.authorization);
  assertExactAuthorization(grant, authorization);
  return sealCredentialBundle(
    { [BUNDLE_FIELD]: JSON.stringify(authorization) },
    ap2CredentialVaultBinding(grant),
  );
}

export function openAp2CredentialAuthorization(input: {
  grant: Ap2CredentialGrant;
  sealedAuthorization: SealedAp2CredentialAuthorization;
}) {
  const grant = ap2CredentialGrantSchema.parse(input.grant);
  const bundle = openCredentialBundle(
    input.sealedAuthorization,
    ap2CredentialVaultBinding(grant),
  );
  const raw = bundle[BUNDLE_FIELD];
  if (!raw || Object.keys(bundle).length !== 1) {
    throw new Error("The AP2 payment authorization vault bundle is invalid.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error("The AP2 payment authorization vault bundle is invalid.");
  }
  const authorization = ap2CredentialProviderAuthorizationSchema.parse(decoded);
  assertExactAuthorization(grant, authorization);
  return authorization;
}

export function ap2CredentialVaultBinding(grantInput: Ap2CredentialGrant) {
  const grant = ap2CredentialGrantSchema.parse(grantInput);
  return [
    "ap2-payment-credential-v1",
    sha256(grant.tenantId),
    sha256(grant.ownerActorId),
    grant.grantId,
    grant.providerId,
    grant.providerConfigurationSha256,
    grant.scopeSha256,
    grant.scopedTokenSha256,
  ].join(":");
}

function assertExactAuthorization(
  grant: Ap2CredentialGrant,
  authorization: Ap2CredentialProviderAuthorization,
) {
  if (
    authorization.providerId !== grant.providerId ||
    authorization.requestId !== grant.requestId ||
    authorization.requestSha256 !== grant.requestSha256 ||
    authorization.scopeSha256 !== grant.scopeSha256 ||
    authorization.scopedTokenSha256 !== grant.scopedTokenSha256 ||
    authorization.issuedAt !== grant.createdAt ||
    authorization.expiresAt !== grant.scope.expiresAt ||
    authorization.nonce !== grant.scope.nonce ||
    sha256(authorization.providerAuthorizationId) !== grant.providerAuthorizationIdSha256
  ) {
    throw new Error("The sealed provider authorization does not match its exact AP2 grant.");
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
