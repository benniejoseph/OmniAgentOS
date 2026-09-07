import { z } from "zod";

import {
  AP2_BOUNDARY_VERSION,
  AP2_PROTOCOL_COMMIT,
  AP2_PROTOCOL_RELEASE,
  AP2_ROLE_RESPONSIBILITIES,
  ap2ProtocolPinSchema,
  ap2RoleSchema,
  ap2VerificationResponsibilitySchema,
  type Ap2Role,
} from "@/lib/payments/ap2-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const AP2_READINESS_VERSION = "p9.15-ap2-readiness:1" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const roleReadinessSchema = z.object({
  role: ap2RoleSchema,
  ownershipBoundary: z.enum([
    "asael_agent_principal",
    "asael_trusted_surface",
    "external_adapter",
  ]),
  expectedParticipant: z.string().trim().min(1).max(240),
  processingConstraint: z.enum([
    "agentic_orchestrator_deterministic_verification",
    "deterministic_non_agentic",
    "separately_authenticated_deterministic_verification",
  ]),
  verificationResponsibilities: z.array(ap2VerificationResponsibilitySchema)
    .min(1)
    .max(17),
  configuredParticipantCount: z.literal(0),
}).strict();

const readinessBodySchema = z.object({
  readinessVersion: z.literal(AP2_READINESS_VERSION),
  boundaryVersion: z.literal(AP2_BOUNDARY_VERSION),
  architectureDecision: z.object({
    id: z.literal("ADR-009"),
    status: z.literal("accepted"),
  }).strict(),
  protocol: ap2ProtocolPinSchema,
  roleContracts: z.array(roleReadinessSchema).length(5),
  roleCombinationPolicy: z.object({
    default: z.literal("one_participant_one_role"),
    combinationRequiresExplicitReview: z.literal(true),
    combinationCollapsesVerificationChecks: z.literal(false),
  }).strict(),
  configuredParticipants: z.array(z.never()).length(0),
  acceptedAdapterContracts: z.array(z.never()).length(0),
  configuredKeyAuthorities: z.array(z.never()).length(0),
  transactionBoundaryRequirements: z.object({
    exactParticipantForEveryRole: z.literal(true),
    exactProtocolPinPerTransaction: z.literal(true),
    exactMandateVctPerArtifact: z.literal(true),
    keyAuthorityMetadataInspectable: z.literal(true),
    credentialBoundaryInspectable: z.literal(true),
    deterministicVerificationOutsideModel: z.literal(true),
    governedExecutorForEveryExternalEffect: z.literal(true),
  }).strict(),
  credentialBoundary: z.object({
    boundaryVersion: z.literal("p9.15-ap2-credential-boundary:1"),
    agentAndModelAccess: z.literal("opaque_reference_only"),
    trustedSurfaceAccess: z.literal("instrument_summary_only"),
    rawCredentialInModelContext: z.literal(false),
    rawCredentialInMemoryOrEvents: z.literal(false),
    privateSigningKeyInApplicationRuntime: z.literal(false),
    providerIsolationRequired: z.literal(true),
  }).strict(),
  verificationBoundary: z.object({
    deterministicVerifierRequired: z.literal(true),
    modelMayVerify: z.literal(false),
    browserOrRemoteSuccessIsPaymentAuthority: z.literal(false),
    acceptedTerminalAuthority: z.literal("signed_receipt_plus_provider_reconciliation"),
  }).strict(),
  humanPresentMandates: z.object({
    implementationVersion: z.literal("p9.16-ap2-human-present:1"),
    schemaMigrationVersion: z.literal(125),
    trustedSurfacePath: z.literal("/app/payments"),
    processingMode: z.literal("deterministic_non_agentic"),
    exactTermsDisplayRequired: z.literal(true),
    checkoutAndPaymentMandatesBoundTogether: z.literal(true),
    userAuthorization: z.literal("direct_hardware_webauthn_key:1"),
    backupEligibleCredentialsAccepted: z.literal(false),
    agentCanRegisterOrSign: z.literal(false),
    authorizationConfersPaymentEffectAuthority: z.literal(false),
    materialChangesRequireFreshReview: z.literal(true),
  }).strict(),
  capability: z.object({
    state: z.literal("disabled_configuration_only"),
    transactionsPermitted: z.literal(false),
    registeredPaymentEffectToolCount: z.literal(0),
    acceptedAdapterReleaseCount: z.literal(0),
    humanPresentMandateFlowImplemented: z.literal(true),
    humanPresentFlowEnabled: z.literal(false),
    humanNotPresentFlowEnabled: z.literal(false),
    missingGates: z.tuple([
      z.literal("p9.17_credential_isolation_and_authorization"),
      z.literal("p9.18_signed_receipts_and_reconciliation"),
    ]),
    activationBlockers: z.tuple([
      z.literal("reviewed_merchant_adapter"),
      z.literal("reviewed_webauthn_attestation_policy"),
      z.literal("isolated_credential_provider"),
      z.literal("reviewed_merchant_payment_processor"),
      z.literal("signed_receipt_reconciliation"),
    ]),
  }).strict(),
}).strict();

export const ap2ReadinessSchema = readinessBodySchema
  .extend({ readinessSha256: sha256Schema })
  .strict()
  .superRefine((value, context) => {
    const { readinessSha256, ...body } = value;
    if (readinessSha256 !== canonicalJsonSha256(body)) {
      context.addIssue({
        code: "custom",
        path: ["readinessSha256"],
        message: "AP2 readiness digest does not match its body.",
      });
    }
    const roles = value.roleContracts.map((contract) => contract.role);
    if (
      new Set(roles).size !== ap2RoleSchema.options.length ||
      !ap2RoleSchema.options.every((role) => roles.includes(role))
    ) {
      context.addIssue({
        code: "custom",
        path: ["roleContracts"],
        message: "AP2 readiness must describe every protocol role exactly once.",
      });
    }
    for (const contract of value.roleContracts) {
      if (!sameStringSet(
        contract.verificationResponsibilities,
        AP2_ROLE_RESPONSIBILITIES[contract.role],
      )) {
        context.addIssue({
          code: "custom",
          path: ["roleContracts", contract.role, "verificationResponsibilities"],
          message: "AP2 readiness responsibilities do not match the role contract.",
        });
      }
    }
  });

export type Ap2Readiness = z.infer<typeof ap2ReadinessSchema>;

export function loadAp2Readiness(): Ap2Readiness {
  const body = readinessBodySchema.parse({
    readinessVersion: AP2_READINESS_VERSION,
    boundaryVersion: AP2_BOUNDARY_VERSION,
    architectureDecision: { id: "ADR-009", status: "accepted" },
    protocol: {
      protocol: "AP2",
      releaseTag: AP2_PROTOCOL_RELEASE,
      reviewedCommit: AP2_PROTOCOL_COMMIT,
      normativeDocuments: [{
        path: "docs/ap2/specification.md",
        source: `https://github.com/google-agentic-commerce/AP2/blob/${AP2_PROTOCOL_RELEASE}/docs/ap2/specification.md`,
      }],
      acceptedMandateVct: {
        checkoutClosed: "mandate.checkout.1",
        checkoutOpen: "mandate.checkout.open.1",
        paymentClosed: "mandate.payment.1",
        paymentOpen: "mandate.payment.open.1",
      },
    },
    roleContracts: ap2RoleSchema.options.map(roleReadiness),
    roleCombinationPolicy: {
      default: "one_participant_one_role",
      combinationRequiresExplicitReview: true,
      combinationCollapsesVerificationChecks: false,
    },
    configuredParticipants: [],
    acceptedAdapterContracts: [],
    configuredKeyAuthorities: [],
    transactionBoundaryRequirements: {
      exactParticipantForEveryRole: true,
      exactProtocolPinPerTransaction: true,
      exactMandateVctPerArtifact: true,
      keyAuthorityMetadataInspectable: true,
      credentialBoundaryInspectable: true,
      deterministicVerificationOutsideModel: true,
      governedExecutorForEveryExternalEffect: true,
    },
    credentialBoundary: {
      boundaryVersion: "p9.15-ap2-credential-boundary:1",
      agentAndModelAccess: "opaque_reference_only",
      trustedSurfaceAccess: "instrument_summary_only",
      rawCredentialInModelContext: false,
      rawCredentialInMemoryOrEvents: false,
      privateSigningKeyInApplicationRuntime: false,
      providerIsolationRequired: true,
    },
    verificationBoundary: {
      deterministicVerifierRequired: true,
      modelMayVerify: false,
      browserOrRemoteSuccessIsPaymentAuthority: false,
      acceptedTerminalAuthority: "signed_receipt_plus_provider_reconciliation",
    },
    humanPresentMandates: {
      implementationVersion: "p9.16-ap2-human-present:1",
      schemaMigrationVersion: 125,
      trustedSurfacePath: "/app/payments",
      processingMode: "deterministic_non_agentic",
      exactTermsDisplayRequired: true,
      checkoutAndPaymentMandatesBoundTogether: true,
      userAuthorization: "direct_hardware_webauthn_key:1",
      backupEligibleCredentialsAccepted: false,
      agentCanRegisterOrSign: false,
      authorizationConfersPaymentEffectAuthority: false,
      materialChangesRequireFreshReview: true,
    },
    capability: {
      state: "disabled_configuration_only",
      transactionsPermitted: false,
      registeredPaymentEffectToolCount: 0,
      acceptedAdapterReleaseCount: 0,
      humanPresentMandateFlowImplemented: true,
      humanPresentFlowEnabled: false,
      humanNotPresentFlowEnabled: false,
      missingGates: [
        "p9.17_credential_isolation_and_authorization",
        "p9.18_signed_receipts_and_reconciliation",
      ],
      activationBlockers: [
        "reviewed_merchant_adapter",
        "reviewed_webauthn_attestation_policy",
        "isolated_credential_provider",
        "reviewed_merchant_payment_processor",
        "signed_receipt_reconciliation",
      ],
    },
  });
  return ap2ReadinessSchema.parse({
    ...body,
    readinessSha256: canonicalJsonSha256(body),
  });
}

function roleReadiness(role: Ap2Role) {
  const common = {
    role,
    verificationResponsibilities: [...AP2_ROLE_RESPONSIBILITIES[role]],
    configuredParticipantCount: 0 as const,
  };
  if (role === "shopping_agent") {
    return {
      ...common,
      ownershipBoundary: "asael_agent_principal" as const,
      expectedParticipant: "Asael or an explicitly delegated Asael agent principal",
      processingConstraint: "agentic_orchestrator_deterministic_verification" as const,
    };
  }
  if (role === "trusted_surface") {
    return {
      ...common,
      ownershipBoundary: "asael_trusted_surface" as const,
      expectedParticipant: "Asael web UI or attested native client",
      processingConstraint: "deterministic_non_agentic" as const,
    };
  }
  return {
    ...common,
    ownershipBoundary: "external_adapter" as const,
    expectedParticipant: externalParticipantName(role),
    processingConstraint: "separately_authenticated_deterministic_verification" as const,
  };
}

function externalParticipantName(role: Exclude<Ap2Role, "shopping_agent" | "trusted_surface">) {
  if (role === "credential_provider") return "External Credential Provider adapter";
  if (role === "merchant") return "External Merchant adapter";
  return "External Merchant Payment Processor adapter";
}

function sameStringSet(left: readonly string[], right: readonly string[]) {
  return left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value));
}
