import { describe, expect, it } from "vitest";

import {
  AP2_BOUNDARY_VERSION,
  AP2_PROTOCOL_COMMIT,
  AP2_ROLE_RESPONSIBILITIES,
  ap2AdapterContractSchema,
  ap2KeyAuthoritySchema,
  ap2ParticipantSchema,
  ap2ProtocolPinSchema,
  ap2TransactionBoundarySchema,
  buildAp2TransactionBoundary,
  type Ap2Role,
} from "@/lib/payments/ap2-contracts";
import { loadAp2Readiness } from "@/lib/payments/ap2-readiness";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const digest = (value: string) => canonicalJsonSha256(value);

describe("AP2 role and trust-boundary contracts", () => {
  it("pins the immutable protocol release, commit, document, and exact vct values", () => {
    const protocol = loadAp2Readiness().protocol;
    expect(protocol).toMatchObject({
      releaseTag: "v0.2.0",
      reviewedCommit: AP2_PROTOCOL_COMMIT,
      normativeDocuments: [{ path: "docs/ap2/specification.md" }],
      acceptedMandateVct: {
        checkoutClosed: "mandate.checkout.1",
        checkoutOpen: "mandate.checkout.open.1",
        paymentClosed: "mandate.payment.1",
        paymentOpen: "mandate.payment.open.1",
      },
    });
    expect(ap2ProtocolPinSchema.safeParse({
      ...protocol,
      acceptedMandateVct: {
        ...protocol.acceptedMandateVct,
        paymentClosed: "mandate.payment.2",
      },
    }).success).toBe(false);
  });

  it("keeps the Trusted Surface deterministic and outside every agent principal", () => {
    const surface = participant("trusted_surface");
    expect(ap2ParticipantSchema.parse(surface)).toEqual(surface);
    expect(ap2ParticipantSchema.safeParse({
      ...surface,
      processingMode: "agentic",
      principalRefSha256: digest("agent-main"),
    }).success).toBe(false);
  });

  it("requires a digest-bound review before an external participant combines roles", () => {
    const roles = ["credential_provider", "merchant"] as const;
    const combined = {
      ...participant("credential_provider"),
      roles: [...roles],
      adapterContractIds: ["adapter:credential", "adapter:merchant"],
      verificationResponsibilities: roles.flatMap(
        (role) => [...AP2_ROLE_RESPONSIBILITIES[role]],
      ),
      roleCombinationReview: {
        status: "approved",
        reviewId: "review:combined-provider-merchant",
        reviewerPrincipalSha256: digest("security-reviewer"),
        participantRolesSha256: canonicalJsonSha256([...roles].sort()),
        reviewedAt: "2026-09-07T12:00:00.000Z",
      },
    };
    expect(ap2ParticipantSchema.parse(combined).roles).toEqual(roles);
    expect(ap2ParticipantSchema.safeParse({
      ...combined,
      roleCombinationReview: null,
    }).success).toBe(false);
  });

  it("rejects credential material and unreviewed adapter mutations", () => {
    expect(ap2ParticipantSchema.safeParse({
      ...participant("shopping_agent"),
      rawPaymentCredential: "4111111111111111",
    }).success).toBe(false);

    const adapter = adapterContract("credential_provider");
    expect(ap2AdapterContractSchema.parse(adapter)).toEqual(adapter);
    expect(ap2AdapterContractSchema.safeParse({
      ...adapter,
      release: "mutated-after-review",
    }).success).toBe(false);
  });

  it("fails closed when a user key is exportable, not hardware-backed, or backup eligible", () => {
    const authority = {
      contractVersion: AP2_BOUNDARY_VERSION,
      keyAuthorityId: "key-authority:user-1",
      participantId: "participant:trusted-surface",
      authorityKind: "user_authorization",
      publicKeyId: "public-key:user-1",
      algorithm: "ES256",
      purpose: "authorize_displayed_mandate_digest",
      publicTrustAnchorSha256: digest("public-trust-anchor"),
      assuranceProfile: "user_bound_hardware_nonexportable",
      nonExportable: true,
      hardwareBacked: true,
      backupState: "not_eligible",
      attestationTrustPolicyRef: "attestation-policy:strict-v1",
      validFrom: "2026-09-07T00:00:00.000Z",
      validUntil: "2027-09-07T00:00:00.000Z",
      revocation: { status: "active", effectiveAt: null, reasonCode: null },
    } as const;
    expect(ap2KeyAuthoritySchema.parse(authority)).toEqual(authority);
    expect(ap2KeyAuthoritySchema.safeParse({
      ...authority,
      nonExportable: false,
      hardwareBacked: false,
      backupState: "eligible",
    }).success).toBe(false);
  });

  it("builds a digest-verified, fully enumerated, disabled transaction boundary", () => {
    const boundary = buildAp2TransactionBoundary({
      contractVersion: AP2_BOUNDARY_VERSION,
      transactionId: "ap2-configuration:transaction-example",
      tenantRefSha256: digest("tenant-a"),
      actorRefSha256: digest("actor-a"),
      protocol: loadAp2Readiness().protocol,
      mode: "human_present",
      capabilityState: "disabled_configuration_only",
      participants: [
        participant("shopping_agent"),
        participant("trusted_surface"),
        participant("credential_provider"),
        participant("merchant"),
        participant("merchant_payment_processor"),
      ],
      adapterContracts: [
        adapterContract("credential_provider"),
        adapterContract("merchant"),
        adapterContract("merchant_payment_processor"),
      ],
      keyAuthorities: [],
      credentialBoundary: credentialBoundary(),
      verificationBoundary: {
        deterministicVerifierRequired: true,
        modelMayVerify: false,
        governedExecutorRequiredForExternalEffects: true,
        browserOrRemoteSuccessIsPaymentAuthority: false,
      },
    });
    expect(boundary.capabilityState).toBe("disabled_configuration_only");
    expect(ap2TransactionBoundarySchema.parse(boundary)).toEqual(boundary);
    expect(ap2TransactionBoundarySchema.safeParse({
      ...boundary,
      transactionId: "tampered",
    }).success).toBe(false);
  });
});

function participant(role: Ap2Role) {
  const common = {
    contractVersion: AP2_BOUNDARY_VERSION,
    participantId: `participant:${role}`,
    displayName: role,
    roles: [role],
    modelInVerificationPath: false as const,
    verificationResponsibilities: [...AP2_ROLE_RESPONSIBILITIES[role]],
    keyAuthorityIds: [],
    roleCombinationReview: null,
  };
  if (role === "shopping_agent") {
    return {
      ...common,
      boundary: "asael_agent_principal" as const,
      processingMode: "agentic" as const,
      principalRefSha256: digest("agent-main"),
      adapterContractIds: [],
      endpointAuthentication: "governed_executor_principal" as const,
      credentialVisibility: "opaque_reference_only" as const,
    };
  }
  if (role === "trusted_surface") {
    return {
      ...common,
      boundary: "asael_trusted_surface" as const,
      processingMode: "deterministic" as const,
      principalRefSha256: null,
      adapterContractIds: [],
      endpointAuthentication: "user_bound_trusted_surface_session" as const,
      credentialVisibility: "instrument_summary_only" as const,
    };
  }
  return {
    ...common,
    boundary: "external_adapter" as const,
    processingMode: "external_declared" as const,
    principalRefSha256: null,
    adapterContractIds: [`adapter:${role}`],
    endpointAuthentication: "separately_authenticated_external_adapter" as const,
    credentialVisibility: "isolated_provider_boundary" as const,
  };
}

function adapterContract(
  role: "credential_provider" | "merchant" | "merchant_payment_processor",
) {
  const reviewedContract = {
    contractVersion: AP2_BOUNDARY_VERSION,
    adapterContractId: `adapter:${role}`,
    role,
    operatorName: `Test ${role}`,
    endpointOrigin: `https://${role.replaceAll("_", "-")}.example.com`,
    endpointAuthenticationProfile: `auth-profile:${role}`,
    release: "test-v1",
    artifactSha256: digest(`artifact:${role}:test-v1`),
    deterministicVerifierRelease: "verifier-v1",
    supportedProtocol: loadAp2Readiness().protocol,
    credentialMaterialExportableToAsael: false as const,
    modelInVerificationPath: false as const,
  };
  return {
    ...reviewedContract,
    review: {
      reviewId: `review:${role}:test-v1`,
      reviewerPrincipalSha256: digest("security-reviewer"),
      reviewedAt: "2026-09-07T12:00:00.000Z",
      contractSha256: canonicalJsonSha256(reviewedContract),
    },
    rolloutState: "reviewed_disabled" as const,
  };
}

function credentialBoundary() {
  return {
    boundaryVersion: "p9.15-ap2-credential-boundary:1" as const,
    agentAndModelAccess: "opaque_reference_only" as const,
    trustedSurfaceAccess: "instrument_summary_only" as const,
    rawCredentialInModelContext: false as const,
    rawCredentialInMemoryOrEvents: false as const,
    privateSigningKeyInApplicationRuntime: false as const,
    providerIsolationRequired: true as const,
  };
}
