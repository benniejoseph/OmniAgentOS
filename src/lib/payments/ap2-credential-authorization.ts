import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
} from "node:crypto";
import { z } from "zod";

import {
  ap2AdapterContractSchema,
  type Ap2AdapterContract,
} from "@/lib/payments/ap2-contracts";
import {
  ap2HumanPresentReviewSchema,
  type Ap2HumanPresentReview,
} from "@/lib/payments/ap2-mandates";
import {
  ap2MandateAuthorizationSchema,
  ap2MandateVerificationReceiptSchema,
  type Ap2MandateAuthorization,
  type Ap2MandateVerificationReceipt,
} from "@/lib/payments/ap2-webauthn";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const AP2_CREDENTIAL_AUTHORIZATION_VERSION =
  "p9.17-ap2-credential-authorization:1" as const;
export const AP2_CREDENTIAL_GRANT_VERSION =
  "p9.17-ap2-credential-grant:1" as const;
export const AP2_CREDENTIAL_PROVIDER_INTERFACE_VERSION =
  "p9.17-ap2-credential-provider:1" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const opaqueIdSchema = z.string().trim().min(1).max(240);
const timestampSchema = z.string().datetime({ offset: true });
const currencySchema = z.string().regex(/^[A-Z]{3}$/);
const minorAmountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/).max(200_000);
const uuidId = (prefix: string) => z.string().regex(
  new RegExp(`^${prefix}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`),
);

const publicKeySchema = z.object({
  keyId: opaqueIdSchema,
  algorithm: z.literal("ES256"),
  spkiDerBase64url: base64UrlSchema.refine(
    (value) => decodedLength(value) >= 64 && decodedLength(value) <= 2_048,
    { message: "Credential-provider public key must be a bounded SPKI DER value." },
  ),
  publicKeySha256: sha256Schema,
  validFrom: timestampSchema,
  validUntil: timestampSchema,
  revocation: z.object({
    status: z.enum(["active", "revoked"]),
    effectiveAt: timestampSchema.nullable(),
  }).strict(),
}).strict().superRefine((key, context) => {
  if (key.publicKeySha256 !== sha256Bytes(Buffer.from(key.spkiDerBase64url, "base64url"))) {
    issue(context, ["publicKeySha256"], "Credential-provider public key digest does not match.");
  }
  if (Date.parse(key.validFrom) >= Date.parse(key.validUntil)) {
    issue(context, ["validUntil"], "Credential-provider key validity interval is invalid.");
  }
  if (key.revocation.status === "active" && key.revocation.effectiveAt !== null) {
    issue(context, ["revocation", "effectiveAt"], "An active provider key cannot have a revocation time.");
  }
  if (key.revocation.status === "revoked" && !key.revocation.effectiveAt) {
    issue(context, ["revocation", "effectiveAt"], "A revoked provider key requires an effective time.");
  }
});

const credentialProviderConfigurationBodySchema = z.object({
  version: z.literal(AP2_CREDENTIAL_PROVIDER_INTERFACE_VERSION),
  providerId: opaqueIdSchema,
  participantId: opaqueIdSchema,
  adapterContract: ap2AdapterContractSchema,
  signingKey: publicKeySchema,
  acceptedMerchantPaymentProcessorIds: z.array(opaqueIdSchema).min(1).max(50),
  maximumScopeTtlSeconds: z.number().int().min(30).max(300),
  credentialBoundary: z.object({
    rawCredentialExportableToAsael: z.literal(false),
    privateSigningKeyExportableToAsael: z.literal(false),
    providerTokenVisibleToModelOrBrowser: z.literal(false),
    providerTokenStorage: z.literal("encrypted_payment_boundary_only"),
    oneTimeScopeRequired: z.literal(true),
    redirectAllowed: z.literal(false),
  }).strict(),
}).strict().superRefine((configuration, context) => {
  if (configuration.adapterContract.role !== "credential_provider") {
    issue(context, ["adapterContract", "role"], "The adapter must implement only the credential-provider role.");
  }
  if (configuration.adapterContract.rolloutState !== "enabled") {
    issue(context, ["adapterContract", "rolloutState"], "Credential authorization requires an enabled reviewed adapter.");
  }
  if (new Set(configuration.acceptedMerchantPaymentProcessorIds).size !==
      configuration.acceptedMerchantPaymentProcessorIds.length) {
    issue(context, ["acceptedMerchantPaymentProcessorIds"], "Processor allowlist entries must be unique.");
  }
});

export const ap2CredentialProviderConfigurationSchema =
  credentialProviderConfigurationBodySchema.extend({
    configurationSha256: sha256Schema,
  }).strict().superRefine((configuration, context) => {
    const { configurationSha256, ...body } = configuration;
    if (configurationSha256 !== canonicalJsonSha256(body)) {
      issue(context, ["configurationSha256"], "Credential-provider configuration digest does not match.");
    }
  });

export const ap2CredentialScopeSchema = z.object({
  purpose: z.literal("single_ap2_transaction"),
  credentialProviderId: opaqueIdSchema,
  merchantPaymentProcessorId: opaqueIdSchema,
  merchantSha256: sha256Schema,
  checkoutHash: base64UrlSchema,
  checkoutMandateContentSha256: sha256Schema,
  paymentMandateContentSha256: sha256Schema,
  paymentInstrumentReference: opaqueIdSchema,
  paymentInstrumentSha256: sha256Schema,
  amountMinor: minorAmountSchema,
  currency: currencySchema,
  intentSha256: sha256Schema,
  shoppingAgentPrincipalSha256: sha256Schema,
  authorizationSha256: sha256Schema,
  mandateVerificationReceiptSha256: sha256Schema,
  audience: opaqueIdSchema,
  nonce: base64UrlSchema.refine((value) => decodedLength(value) === 32, {
    message: "AP2 credential scope nonce must contain exactly 32 bytes.",
  }),
  issuedAt: timestampSchema,
  notBefore: timestampSchema,
  expiresAt: timestampSchema,
  singleUse: z.literal(true),
  redirectAllowed: z.literal(false),
}).strict().superRefine((scope, context) => {
  if (scope.audience !== scope.merchantPaymentProcessorId) {
    issue(context, ["audience"], "Credential scope audience must be the exact reviewed processor.");
  }
  if (
    Date.parse(scope.issuedAt) > Date.parse(scope.notBefore) ||
    Date.parse(scope.notBefore) >= Date.parse(scope.expiresAt)
  ) {
    issue(context, ["expiresAt"], "Credential scope validity interval is invalid.");
  }
});

const credentialAuthorizationRequestBodySchema = z.object({
  version: z.literal(AP2_CREDENTIAL_AUTHORIZATION_VERSION),
  requestId: uuidId("ap2_credential_request"),
  tenantRefSha256: sha256Schema,
  ownerActorRefSha256: sha256Schema,
  reviewId: uuidId("ap2_review"),
  reviewSha256: sha256Schema,
  authorizationId: uuidId("ap2_authorization"),
  exactTermsSha256: sha256Schema,
  scope: ap2CredentialScopeSchema,
}).strict();

export const ap2CredentialAuthorizationRequestSchema =
  credentialAuthorizationRequestBodySchema.extend({
    requestSha256: sha256Schema,
  }).strict().superRefine((request, context) => {
    const { requestSha256, ...body } = request;
    if (requestSha256 !== canonicalJsonSha256(body)) {
      issue(context, ["requestSha256"], "Credential authorization request digest does not match.");
    }
  });

const providerAuthorizationBodySchema = z.object({
  version: z.literal("p9.17-ap2-provider-authorization:1"),
  providerId: opaqueIdSchema,
  providerAuthorizationId: opaqueIdSchema,
  requestId: uuidId("ap2_credential_request"),
  requestSha256: sha256Schema,
  scopeSha256: sha256Schema,
  scopedTokenSha256: sha256Schema,
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
  nonce: base64UrlSchema,
  singleUse: z.literal(true),
  redirectAllowed: z.literal(false),
  signingKeyId: opaqueIdSchema,
  signatureAlgorithm: z.literal("ES256"),
}).strict();

export const ap2CredentialProviderAuthorizationSchema =
  providerAuthorizationBodySchema.extend({
    scopedToken: z.string().min(32).max(32_768),
    signature: base64UrlSchema,
  }).strict().superRefine((authorization, context) => {
    if (authorization.scopedTokenSha256 !== sha256Text(authorization.scopedToken)) {
      issue(context, ["scopedTokenSha256"], "Scoped provider token digest does not match.");
    }
  });

const credentialGrantBodySchema = z.object({
  version: z.literal(AP2_CREDENTIAL_GRANT_VERSION),
  grantId: uuidId("ap2_credential_grant"),
  tenantId: opaqueIdSchema,
  ownerActorId: opaqueIdSchema,
  reviewId: uuidId("ap2_review"),
  authorizationId: uuidId("ap2_authorization"),
  requestId: uuidId("ap2_credential_request"),
  requestSha256: sha256Schema,
  providerId: opaqueIdSchema,
  providerConfigurationSha256: sha256Schema,
  providerAuthorizationIdSha256: sha256Schema,
  providerAuthorizationSha256: sha256Schema,
  scopedTokenSha256: sha256Schema,
  scope: ap2CredentialScopeSchema,
  scopeSha256: sha256Schema,
  state: z.enum(["active", "consumed", "revoked", "expired"]),
  lifecycleRevision: z.number().int().min(1),
  createdAt: timestampSchema,
  consumedAt: timestampSchema.nullable(),
  revokedAt: timestampSchema.nullable(),
}).strict();

export const ap2CredentialGrantSchema = credentialGrantBodySchema.extend({
  grantSha256: sha256Schema,
}).strict().superRefine((grant, context) => {
  if (grant.scopeSha256 !== canonicalJsonSha256(grant.scope)) {
    issue(context, ["scopeSha256"], "Credential grant scope digest does not match.");
  }
  const { grantSha256, ...body } = grant;
  if (grantSha256 !== canonicalJsonSha256(body)) {
    issue(context, ["grantSha256"], "Credential grant digest does not match.");
  }
});

export type Ap2CredentialProviderConfiguration = z.infer<
  typeof ap2CredentialProviderConfigurationSchema
>;
export type Ap2CredentialAuthorizationRequest = z.infer<
  typeof ap2CredentialAuthorizationRequestSchema
>;
export type Ap2CredentialProviderAuthorization = z.infer<
  typeof ap2CredentialProviderAuthorizationSchema
>;
export type Ap2CredentialGrant = z.infer<typeof ap2CredentialGrantSchema>;

export type Ap2CredentialProvider = Readonly<{
  interfaceVersion: typeof AP2_CREDENTIAL_PROVIDER_INTERFACE_VERSION;
  configuration: Ap2CredentialProviderConfiguration;
  authorize: (input: Readonly<{
    request: Ap2CredentialAuthorizationRequest;
    checkoutMandateContent: Ap2HumanPresentReview["checkoutMandateContent"];
    paymentMandateContent: Ap2HumanPresentReview["paymentMandateContent"];
    mandateAuthorization: Ap2MandateAuthorization;
  }>) => Promise<Ap2CredentialProviderAuthorization>;
  reconcile: (input: Readonly<{
    requestId: string;
    requestSha256: string;
  }>) => Promise<Ap2CredentialProviderAuthorization | undefined>;
}>;

export function buildAp2CredentialProviderConfiguration(
  input: z.input<typeof credentialProviderConfigurationBodySchema>,
) {
  const body = credentialProviderConfigurationBodySchema.parse(input);
  return ap2CredentialProviderConfigurationSchema.parse({
    ...body,
    configurationSha256: canonicalJsonSha256(body),
  });
}

export function buildAp2CredentialAuthorizationRequest(input: {
  review: Ap2HumanPresentReview;
  authorization: Ap2MandateAuthorization;
  mandateVerification: Ap2MandateVerificationReceipt;
  configuration: Ap2CredentialProviderConfiguration;
  now?: Date;
  nonce?: string;
}) {
  const review = ap2HumanPresentReviewSchema.parse(input.review);
  const authorization = ap2MandateAuthorizationSchema.parse(input.authorization);
  const verification = ap2MandateVerificationReceiptSchema.parse(input.mandateVerification);
  const configuration = ap2CredentialProviderConfigurationSchema.parse(input.configuration);
  const now = input.now || new Date();

  assertMandateArtifactsMatch(review, authorization, verification);
  if (review.terms.paymentConstraints.credentialProviderId !== configuration.providerId) {
    throw new Error("Reviewed mandate names a different credential provider.");
  }
  const processorId = review.terms.paymentConstraints.merchantPaymentProcessorId;
  if (!configuration.acceptedMerchantPaymentProcessorIds.includes(processorId)) {
    throw new Error("Reviewed payment processor is not accepted by the credential provider.");
  }
  if (!isProviderKeyLive(configuration, now)) {
    throw new Error("Credential-provider verification key is not currently trusted.");
  }
  const mandateExpiry = Date.parse(review.terms.expiresAt);
  if (mandateExpiry <= now.getTime()) {
    throw new Error("Reviewed AP2 mandate expired before credential authorization.");
  }
  const expiry = new Date(Math.min(
    mandateExpiry,
    now.getTime() + configuration.maximumScopeTtlSeconds * 1_000,
  )).toISOString();
  const requestId = `ap2_credential_request:${deterministicUuid(
    `${review.reviewId}\0${authorization.authorizationSha256}\0${configuration.configurationSha256}`,
  )}`;
  const scope = ap2CredentialScopeSchema.parse({
    purpose: "single_ap2_transaction",
    credentialProviderId: configuration.providerId,
    merchantPaymentProcessorId: processorId,
    merchantSha256: canonicalJsonSha256(review.terms.merchant),
    checkoutHash: review.checkoutMandateContent.checkout_hash,
    checkoutMandateContentSha256: canonicalJsonSha256(review.checkoutMandateContent),
    paymentMandateContentSha256: canonicalJsonSha256(review.paymentMandateContent),
    paymentInstrumentReference: review.terms.paymentInstrument.id,
    paymentInstrumentSha256: canonicalJsonSha256(review.terms.paymentInstrument),
    amountMinor: review.terms.totals.totalAmountMinor,
    currency: review.terms.totals.currency,
    intentSha256: review.intentSha256,
    shoppingAgentPrincipalSha256: sha256Text(review.shoppingAgentPrincipalId),
    authorizationSha256: authorization.authorizationSha256,
    mandateVerificationReceiptSha256: verification.receiptSha256,
    audience: processorId,
    nonce: input.nonce || randomBytes(32).toString("base64url"),
    issuedAt: now.toISOString(),
    notBefore: now.toISOString(),
    expiresAt: expiry,
    singleUse: true,
    redirectAllowed: false,
  });
  const body = credentialAuthorizationRequestBodySchema.parse({
    version: AP2_CREDENTIAL_AUTHORIZATION_VERSION,
    requestId,
    tenantRefSha256: sha256Text(review.tenantId),
    ownerActorRefSha256: sha256Text(review.ownerActorId),
    reviewId: review.reviewId,
    reviewSha256: review.reviewSha256,
    authorizationId: authorization.authorizationId,
    exactTermsSha256: review.exactTermsSha256,
    scope,
  });
  return ap2CredentialAuthorizationRequestSchema.parse({
    ...body,
    requestSha256: canonicalJsonSha256(body),
  });
}

export function credentialProviderSigningPayload(
  input: Ap2CredentialProviderAuthorization,
) {
  const authorization = ap2CredentialProviderAuthorizationSchema.parse(input);
  const { scopedToken: _scopedToken, signature: _signature, ...body } = authorization;
  return Buffer.from(JSON.stringify(body), "utf8");
}

export function verifyAp2CredentialProviderAuthorization(input: {
  request: Ap2CredentialAuthorizationRequest;
  authorization: Ap2CredentialProviderAuthorization;
  configuration: Ap2CredentialProviderConfiguration;
  now?: Date;
}) {
  const request = ap2CredentialAuthorizationRequestSchema.parse(input.request);
  const authorization = ap2CredentialProviderAuthorizationSchema.parse(input.authorization);
  const configuration = ap2CredentialProviderConfigurationSchema.parse(input.configuration);
  const now = input.now || new Date();
  const key = configuration.signingKey;

  const mismatched =
    authorization.providerId !== configuration.providerId ||
    authorization.requestId !== request.requestId ||
    authorization.requestSha256 !== request.requestSha256 ||
    authorization.scopeSha256 !== canonicalJsonSha256(request.scope) ||
    authorization.issuedAt !== request.scope.issuedAt ||
    authorization.expiresAt !== request.scope.expiresAt ||
    authorization.nonce !== request.scope.nonce ||
    authorization.signingKeyId !== key.keyId;
  if (mismatched) {
    throw new Error("Credential-provider authorization does not match the exact AP2 scope.");
  }
  if (!isProviderKeyLive(configuration, now)) {
    throw new Error("Credential-provider authorization key is not currently trusted.");
  }
  if (
    now.getTime() < Date.parse(request.scope.notBefore) ||
    now.getTime() >= Date.parse(request.scope.expiresAt)
  ) {
    throw new Error("Credential-provider authorization is outside its exact validity interval.");
  }
  const publicKey = createPublicKey({
    key: Buffer.from(key.spkiDerBase64url, "base64url"),
    format: "der",
    type: "spki",
  });
  if (!verifySignature(
    "sha256",
    credentialProviderSigningPayload(authorization),
    publicKey,
    Buffer.from(authorization.signature, "base64url"),
  )) {
    throw new Error("Credential-provider authorization signature is invalid.");
  }
  return authorization;
}

export function buildAp2CredentialGrant(input: {
  tenantId: string;
  ownerActorId: string;
  request: Ap2CredentialAuthorizationRequest;
  authorization: Ap2CredentialProviderAuthorization;
  configuration: Ap2CredentialProviderConfiguration;
}) {
  const authorization = verifyAp2CredentialProviderAuthorization(input);
  const request = ap2CredentialAuthorizationRequestSchema.parse(input.request);
  const configuration = ap2CredentialProviderConfigurationSchema.parse(input.configuration);
  const body = credentialGrantBodySchema.parse({
    version: AP2_CREDENTIAL_GRANT_VERSION,
    grantId: `ap2_credential_grant:${deterministicUuid(`${request.requestId}\0grant`)}`,
    tenantId: required(input.tenantId, "tenant"),
    ownerActorId: required(input.ownerActorId, "actor"),
    reviewId: request.reviewId,
    authorizationId: request.authorizationId,
    requestId: request.requestId,
    requestSha256: request.requestSha256,
    providerId: configuration.providerId,
    providerConfigurationSha256: configuration.configurationSha256,
    providerAuthorizationIdSha256: sha256Text(authorization.providerAuthorizationId),
    providerAuthorizationSha256: canonicalJsonSha256(
      providerAuthorizationPublicProof(authorization),
    ),
    scopedTokenSha256: authorization.scopedTokenSha256,
    scope: request.scope,
    scopeSha256: canonicalJsonSha256(request.scope),
    state: "active",
    lifecycleRevision: 1,
    createdAt: authorization.issuedAt,
    consumedAt: null,
    revokedAt: null,
  });
  return ap2CredentialGrantSchema.parse({
    ...body,
    grantSha256: canonicalJsonSha256(body),
  });
}

export function providerAuthorizationPublicProof(
  input: Ap2CredentialProviderAuthorization,
) {
  const authorization = ap2CredentialProviderAuthorizationSchema.parse(input);
  const { scopedToken: _scopedToken, ...proof } = authorization;
  return Object.freeze(proof);
}

function assertMandateArtifactsMatch(
  review: Ap2HumanPresentReview,
  authorization: Ap2MandateAuthorization,
  verification: Ap2MandateVerificationReceipt,
) {
  if (
    review.state !== "authorized" ||
    authorization.reviewId !== review.reviewId ||
    authorization.authorizationDigest !== review.authorizationDigest ||
    authorization.authorizationSha256 !== verification.authorizationSha256 ||
    authorization.authorizationId !== verification.authorizationId ||
    verification.reviewId !== review.reviewId ||
    verification.authorizationDigest !== review.authorizationDigest ||
    !verification.accepted
  ) {
    throw new Error("Credential authorization requires the exact verified human-present mandates.");
  }
}

function isProviderKeyLive(
  configuration: Ap2CredentialProviderConfiguration,
  now: Date,
) {
  const key = configuration.signingKey;
  return key.revocation.status === "active" &&
    Date.parse(key.validFrom) <= now.getTime() &&
    Date.parse(key.validUntil) > now.getTime();
}

function deterministicUuid(value: string) {
  const hex = sha256Text(value).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function required(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 240) {
    throw new Error(`AP2 credential authorization requires an exact ${label}.`);
  }
  return normalized;
}

function decodedLength(value: string) {
  return Buffer.from(value, "base64url").length;
}

function sha256Text(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function issue(context: z.RefinementCtx, path: PropertyKey[], message: string) {
  context.addIssue({ code: "custom", path, message });
}

export type { Ap2AdapterContract };
