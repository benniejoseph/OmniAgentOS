import { z } from "zod";

import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const AP2_BOUNDARY_VERSION = "p9.15-ap2-boundary:1" as const;
export const AP2_PROTOCOL_RELEASE = "v0.2.0" as const;
export const AP2_PROTOCOL_COMMIT =
  "b4587ac1d055888a73b4b21750973cffba961793" as const;
export const AP2_NORMATIVE_SPECIFICATION_PATH =
  "docs/ap2/specification.md" as const;

export const AP2_MANDATE_VCT = Object.freeze({
  checkoutClosed: "mandate.checkout.1",
  checkoutOpen: "mandate.checkout.open.1",
  paymentClosed: "mandate.payment.1",
  paymentOpen: "mandate.payment.open.1",
} as const);

export const ap2RoleSchema = z.enum([
  "shopping_agent",
  "trusted_surface",
  "credential_provider",
  "merchant",
  "merchant_payment_processor",
]);
export type Ap2Role = z.infer<typeof ap2RoleSchema>;

export const ap2VerificationResponsibilitySchema = z.enum([
  "execute_external_effects_through_governed_executor",
  "assemble_transaction_bound_mandate_content",
  "route_user_authorization_through_trusted_surface",
  "preserve_mandate_and_receipt_bindings",
  "display_exact_mandate_terms",
  "collect_user_bound_authorization",
  "bind_authorization_to_displayed_digest",
  "verify_agent_credential_access_authority",
  "verify_payment_mandate_and_constraints",
  "scope_credential_to_checkout",
  "preserve_inventory_price_and_discount_integrity",
  "issue_signed_checkout",
  "verify_checkout_mandate_hash_and_constraints",
  "return_checkout_receipt",
  "verify_credential_scope_against_checkout",
  "process_transaction_bound_payment",
  "return_payment_receipt",
]);
export type Ap2VerificationResponsibility = z.infer<
  typeof ap2VerificationResponsibilitySchema
>;

export const AP2_ROLE_RESPONSIBILITIES: Readonly<
  Record<Ap2Role, readonly Ap2VerificationResponsibility[]>
> = Object.freeze({
  shopping_agent: Object.freeze([
    "execute_external_effects_through_governed_executor",
    "assemble_transaction_bound_mandate_content",
    "route_user_authorization_through_trusted_surface",
    "preserve_mandate_and_receipt_bindings",
  ] as const),
  trusted_surface: Object.freeze([
    "display_exact_mandate_terms",
    "collect_user_bound_authorization",
    "bind_authorization_to_displayed_digest",
  ] as const),
  credential_provider: Object.freeze([
    "verify_agent_credential_access_authority",
    "verify_payment_mandate_and_constraints",
    "scope_credential_to_checkout",
  ] as const),
  merchant: Object.freeze([
    "preserve_inventory_price_and_discount_integrity",
    "issue_signed_checkout",
    "verify_checkout_mandate_hash_and_constraints",
    "return_checkout_receipt",
  ] as const),
  merchant_payment_processor: Object.freeze([
    "verify_credential_scope_against_checkout",
    "process_transaction_bound_payment",
    "return_payment_receipt",
  ] as const),
});

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const opaqueIdSchema = z.string().trim().min(1).max(240);
const timestampSchema = z.string().datetime({ offset: true });

export const ap2ProtocolPinSchema = z.object({
  protocol: z.literal("AP2"),
  releaseTag: z.literal(AP2_PROTOCOL_RELEASE),
  reviewedCommit: z.literal(AP2_PROTOCOL_COMMIT),
  normativeDocuments: z.tuple([
    z.object({
      path: z.literal(AP2_NORMATIVE_SPECIFICATION_PATH),
      source: z.literal(
        `https://github.com/google-agentic-commerce/AP2/blob/${AP2_PROTOCOL_RELEASE}/${AP2_NORMATIVE_SPECIFICATION_PATH}`,
      ),
    }).strict(),
  ]),
  acceptedMandateVct: z.object({
    checkoutClosed: z.literal(AP2_MANDATE_VCT.checkoutClosed),
    checkoutOpen: z.literal(AP2_MANDATE_VCT.checkoutOpen),
    paymentClosed: z.literal(AP2_MANDATE_VCT.paymentClosed),
    paymentOpen: z.literal(AP2_MANDATE_VCT.paymentOpen),
  }).strict(),
}).strict();
export type Ap2ProtocolPin = z.infer<typeof ap2ProtocolPinSchema>;

const roleCombinationReviewSchema = z.object({
  status: z.literal("approved"),
  reviewId: opaqueIdSchema,
  reviewerPrincipalSha256: sha256Schema,
  participantRolesSha256: sha256Schema,
  reviewedAt: timestampSchema,
}).strict();

const ap2ParticipantBodySchema = z.object({
  contractVersion: z.literal(AP2_BOUNDARY_VERSION),
  participantId: opaqueIdSchema,
  displayName: z.string().trim().min(1).max(160),
  roles: z.array(ap2RoleSchema).min(1).max(5),
  boundary: z.enum([
    "asael_agent_principal",
    "asael_trusted_surface",
    "external_adapter",
  ]),
  processingMode: z.enum(["agentic", "deterministic", "external_declared"]),
  principalRefSha256: sha256Schema.nullable(),
  adapterContractIds: z.array(opaqueIdSchema).max(3),
  endpointAuthentication: z.enum([
    "governed_executor_principal",
    "user_bound_trusted_surface_session",
    "separately_authenticated_external_adapter",
  ]),
  credentialVisibility: z.enum([
    "opaque_reference_only",
    "instrument_summary_only",
    "isolated_provider_boundary",
  ]),
  modelInVerificationPath: z.literal(false),
  verificationResponsibilities: z.array(ap2VerificationResponsibilitySchema)
    .min(1)
    .max(17),
  keyAuthorityIds: z.array(opaqueIdSchema).max(20),
  roleCombinationReview: roleCombinationReviewSchema.nullable(),
}).strict();

export const ap2ParticipantSchema = ap2ParticipantBodySchema.superRefine(
  (value, context) => {
    const uniqueRoles = [...new Set(value.roles)];
    if (uniqueRoles.length !== value.roles.length) {
      issue(context, ["roles"], "AP2 participant roles must be unique.");
      return;
    }

    const allowedRoles = allowedRolesForBoundary(value.boundary);
    const invalidRole = uniqueRoles.find((role) => !allowedRoles.has(role));
    if (invalidRole) {
      issue(
        context,
        ["roles"],
        `${value.boundary} cannot claim the ${invalidRole} role.`,
      );
    }

    if (value.boundary === "asael_agent_principal") {
      expectField(value.processingMode === "agentic", context, ["processingMode"],
        "The Asael Shopping Agent boundary must be agentic.");
      expectField(Boolean(value.principalRefSha256), context, ["principalRefSha256"],
        "The Shopping Agent must bind an exact governed principal reference.");
      expectField(value.adapterContractIds.length === 0, context, ["adapterContractIds"],
        "The first-party Shopping Agent is not an external adapter.");
      expectField(value.endpointAuthentication === "governed_executor_principal", context,
        ["endpointAuthentication"], "The Shopping Agent must use governed executor authority.");
      expectField(value.credentialVisibility === "opaque_reference_only", context,
        ["credentialVisibility"], "Shopping Agents may receive only opaque credential references.");
    } else if (value.boundary === "asael_trusted_surface") {
      expectField(value.processingMode === "deterministic", context, ["processingMode"],
        "The Trusted Surface must be deterministic and non-agentic.");
      expectField(value.principalRefSha256 === null, context, ["principalRefSha256"],
        "The Trusted Surface cannot reuse an agent principal.");
      expectField(value.adapterContractIds.length === 0, context, ["adapterContractIds"],
        "The first-party Trusted Surface is not an external adapter.");
      expectField(value.endpointAuthentication === "user_bound_trusted_surface_session", context,
        ["endpointAuthentication"], "The Trusted Surface must use a user-bound session.");
      expectField(value.credentialVisibility === "instrument_summary_only", context,
        ["credentialVisibility"], "The Trusted Surface may display only instrument summaries.");
    } else {
      expectField(value.processingMode === "external_declared", context, ["processingMode"],
        "External processing mode must remain separately declared by its adapter.");
      expectField(value.principalRefSha256 === null, context, ["principalRefSha256"],
        "External adapters cannot reuse an Asael principal.");
      expectField(value.adapterContractIds.length === uniqueRoles.length, context,
        ["adapterContractIds"],
        "Every external role must bind one exact adapter contract.");
      expectField(value.endpointAuthentication === "separately_authenticated_external_adapter", context,
        ["endpointAuthentication"], "External participants require separate authentication.");
      expectField(value.credentialVisibility === "isolated_provider_boundary", context,
        ["credentialVisibility"], "External credentials must remain in an isolated provider boundary.");
    }

    const expectedResponsibilities = uniqueRoles.flatMap(
      (role) => AP2_ROLE_RESPONSIBILITIES[role],
    );
    if (!sameStringSet(value.verificationResponsibilities, expectedResponsibilities)) {
      issue(
        context,
        ["verificationResponsibilities"],
        "Participant verification responsibilities must exactly cover every claimed AP2 role.",
      );
    }

    if (uniqueRoles.length > 1) {
      if (!value.roleCombinationReview) {
        issue(context, ["roleCombinationReview"],
          "Combining AP2 roles requires an explicit approved review.");
      } else if (
        value.roleCombinationReview.participantRolesSha256 !==
        canonicalJsonSha256([...uniqueRoles].sort())
      ) {
        issue(context, ["roleCombinationReview", "participantRolesSha256"],
          "The role-combination review does not match the claimed roles.");
      }
    } else if (value.roleCombinationReview !== null) {
      issue(context, ["roleCombinationReview"],
        "A single-role participant must not carry a misleading combination review.");
    }
  },
);
export type Ap2Participant = z.infer<typeof ap2ParticipantSchema>;

const ap2AdapterContractBaseSchema = z.object({
  contractVersion: z.literal(AP2_BOUNDARY_VERSION),
  adapterContractId: opaqueIdSchema,
  role: z.enum(["credential_provider", "merchant", "merchant_payment_processor"]),
  operatorName: z.string().trim().min(1).max(160),
  endpointOrigin: z.string().url().refine((value) => value.startsWith("https://"), {
    message: "AP2 adapters require an HTTPS endpoint origin.",
  }),
  endpointAuthenticationProfile: opaqueIdSchema,
  release: z.string().trim().min(1).max(120),
  artifactSha256: sha256Schema,
  deterministicVerifierRelease: z.string().trim().min(1).max(120),
  supportedProtocol: ap2ProtocolPinSchema,
  review: z.object({
    reviewId: opaqueIdSchema,
    reviewerPrincipalSha256: sha256Schema,
    reviewedAt: timestampSchema,
    contractSha256: sha256Schema,
  }).strict(),
  rolloutState: z.enum(["reviewed_disabled", "enabled"]),
  credentialMaterialExportableToAsael: z.literal(false),
  modelInVerificationPath: z.literal(false),
}).strict();

export const ap2AdapterContractSchema = ap2AdapterContractBaseSchema
  .superRefine((value, context) => {
    const { review, rolloutState: _rolloutState, ...reviewedContract } = value;
    if (review.contractSha256 !== canonicalJsonSha256(reviewedContract)) {
      issue(context, ["review", "contractSha256"],
        "The adapter review digest does not match the reviewed contract.");
    }
  });
export type Ap2AdapterContract = z.infer<typeof ap2AdapterContractSchema>;

export const ap2KeyAuthoritySchema = z.object({
  contractVersion: z.literal(AP2_BOUNDARY_VERSION),
  keyAuthorityId: opaqueIdSchema,
  participantId: opaqueIdSchema,
  authorityKind: z.enum(["user_authorization", "ap2_issuer", "external_verifier"]),
  publicKeyId: opaqueIdSchema,
  algorithm: z.enum(["ES256", "ES384", "PS256"]),
  purpose: z.enum([
    "authorize_displayed_mandate_digest",
    "issue_ap2_protocol_artifact",
    "verify_external_ap2_artifact",
  ]),
  publicTrustAnchorSha256: sha256Schema,
  assuranceProfile: z.enum([
    "user_bound_hardware_nonexportable",
    "isolated_hsm",
    "reviewed_external",
  ]),
  nonExportable: z.boolean(),
  hardwareBacked: z.boolean(),
  backupState: z.enum(["not_eligible", "eligible", "unknown"]),
  attestationTrustPolicyRef: opaqueIdSchema.nullable(),
  validFrom: timestampSchema,
  validUntil: timestampSchema,
  revocation: z.object({
    status: z.enum(["active", "revoked"]),
    effectiveAt: timestampSchema.nullable(),
    reasonCode: z.string().trim().min(1).max(120).nullable(),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.validUntil) <= Date.parse(value.validFrom)) {
    issue(context, ["validUntil"], "Key validity must end after it begins.");
  }
  if (value.revocation.status === "revoked" && !value.revocation.effectiveAt) {
    issue(context, ["revocation", "effectiveAt"],
      "A revoked key authority requires an effective time.");
  }
  if (value.revocation.status === "active" && value.revocation.effectiveAt !== null) {
    issue(context, ["revocation", "effectiveAt"],
      "An active key authority cannot carry a revocation time.");
  }
  if (value.authorityKind === "user_authorization") {
    expectField(value.purpose === "authorize_displayed_mandate_digest", context, ["purpose"],
      "User keys may authorize only the displayed mandate digest.");
    expectField(value.assuranceProfile === "user_bound_hardware_nonexportable", context,
      ["assuranceProfile"], "User authorization requires the strict signer assurance profile.");
    expectField(value.nonExportable && value.hardwareBacked, context, ["nonExportable"],
      "User authorization keys must be hardware-backed and non-exportable.");
    expectField(value.backupState === "not_eligible", context, ["backupState"],
      "Backup-eligible credentials do not satisfy the strict signer profile.");
    expectField(Boolean(value.attestationTrustPolicyRef), context, ["attestationTrustPolicyRef"],
      "User authorization requires a reviewed attestation trust policy.");
  }
  if (value.authorityKind === "ap2_issuer") {
    expectField(value.purpose === "issue_ap2_protocol_artifact", context, ["purpose"],
      "Issuer keys may only package AP2 protocol artifacts.");
    expectField(value.assuranceProfile === "isolated_hsm", context, ["assuranceProfile"],
      "AP2 issuer keys must use the isolated HSM profile.");
    expectField(value.nonExportable && value.hardwareBacked, context, ["nonExportable"],
      "AP2 issuer keys must be hardware-backed and non-exportable.");
  }
  if (value.authorityKind === "external_verifier") {
    expectField(value.purpose === "verify_external_ap2_artifact", context, ["purpose"],
      "External verifier keys may only verify external AP2 artifacts.");
    expectField(value.assuranceProfile === "reviewed_external", context, ["assuranceProfile"],
      "External verifier keys require a reviewed external profile.");
  }
});
export type Ap2KeyAuthority = z.infer<typeof ap2KeyAuthoritySchema>;

const ap2TransactionBoundaryBodySchema = z.object({
  contractVersion: z.literal(AP2_BOUNDARY_VERSION),
  transactionId: opaqueIdSchema,
  tenantRefSha256: sha256Schema,
  actorRefSha256: sha256Schema,
  protocol: ap2ProtocolPinSchema,
  mode: z.literal("human_present"),
  capabilityState: z.literal("disabled_configuration_only"),
  participants: z.array(ap2ParticipantSchema).min(3).max(20),
  adapterContracts: z.array(ap2AdapterContractSchema).max(20),
  keyAuthorities: z.array(ap2KeyAuthoritySchema).max(50),
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
    governedExecutorRequiredForExternalEffects: z.literal(true),
    browserOrRemoteSuccessIsPaymentAuthority: z.literal(false),
  }).strict(),
}).strict();

export const ap2TransactionBoundarySchema = ap2TransactionBoundaryBodySchema
  .extend({ boundarySha256: sha256Schema })
  .strict()
  .superRefine((value, context) => {
    const { boundarySha256, ...body } = value;
    if (boundarySha256 !== canonicalJsonSha256(body)) {
      issue(context, ["boundarySha256"],
        "AP2 transaction-boundary digest does not match its body.");
    }
    validateTransactionRelationships(body, context);
  });
export type Ap2TransactionBoundary = z.infer<typeof ap2TransactionBoundarySchema>;

export function buildAp2TransactionBoundary(
  input: z.input<typeof ap2TransactionBoundaryBodySchema>,
): Ap2TransactionBoundary {
  const body = ap2TransactionBoundaryBodySchema.parse(input);
  const candidate = { ...body, boundarySha256: canonicalJsonSha256(body) };
  return ap2TransactionBoundarySchema.parse(candidate);
}

function validateTransactionRelationships(
  value: z.infer<typeof ap2TransactionBoundaryBodySchema>,
  context: z.RefinementCtx,
) {
  const roleCounts = new Map<Ap2Role, number>();
  const participantIds = new Set<string>();
  for (const participant of value.participants) {
    if (participantIds.has(participant.participantId)) {
      issue(context, ["participants"], "AP2 participant IDs must be unique.");
    }
    participantIds.add(participant.participantId);
    for (const role of participant.roles) {
      roleCounts.set(role, (roleCounts.get(role) || 0) + 1);
    }
  }
  for (const role of ap2RoleSchema.options) {
    if (roleCounts.get(role) !== 1) {
      issue(context, ["participants"],
        `A transaction must bind exactly one participant for the ${role} role.`);
    }
  }

  const adapterById = new Map(
    value.adapterContracts.map((adapter) => [adapter.adapterContractId, adapter]),
  );
  if (adapterById.size !== value.adapterContracts.length) {
    issue(context, ["adapterContracts"], "AP2 adapter-contract IDs must be unique.");
  }
  for (const participant of value.participants) {
    const boundAdapterRoles: Ap2Role[] = [];
    for (const adapterContractId of participant.adapterContractIds) {
      const adapter = adapterById.get(adapterContractId);
      if (!adapter) {
        issue(context, ["participants"],
          `Participant ${participant.participantId} references an unknown adapter contract.`);
        continue;
      }
      boundAdapterRoles.push(adapter.role);
    }
    const externalRoles = participant.roles.filter((role) =>
      role !== "shopping_agent" && role !== "trusted_surface"
    );
    if (!sameStringSet(boundAdapterRoles, externalRoles)) {
      issue(context, ["participants"],
        `Participant ${participant.participantId} adapter contracts do not match its roles.`);
    }
  }

  const authorityById = new Map(
    value.keyAuthorities.map((authority) => [authority.keyAuthorityId, authority]),
  );
  if (authorityById.size !== value.keyAuthorities.length) {
    issue(context, ["keyAuthorities"], "AP2 key-authority IDs must be unique.");
  }
  for (const participant of value.participants) {
    for (const authorityId of participant.keyAuthorityIds) {
      const authority = authorityById.get(authorityId);
      if (!authority || authority.participantId !== participant.participantId) {
        issue(context, ["participants"],
          `Participant ${participant.participantId} has an invalid key-authority binding.`);
      }
    }
  }
}

function allowedRolesForBoundary(boundary: z.infer<typeof ap2ParticipantBodySchema>["boundary"]) {
  if (boundary === "asael_agent_principal") {
    return new Set<Ap2Role>(["shopping_agent"]);
  }
  if (boundary === "asael_trusted_surface") {
    return new Set<Ap2Role>(["trusted_surface"]);
  }
  return new Set<Ap2Role>([
    "credential_provider",
    "merchant",
    "merchant_payment_processor",
  ]);
}

function sameStringSet(left: readonly string[], right: readonly string[]) {
  return left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value));
}

function expectField(
  condition: boolean,
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
) {
  if (!condition) issue(context, path, message);
}

function issue(context: z.RefinementCtx, path: PropertyKey[], message: string) {
  context.addIssue({ code: "custom", path, message });
}
