import { createHash } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { COSEALG } from "@simplewebauthn/server/helpers";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { z } from "zod";

import {
  AP2_DIRECT_SIGNER_PROFILE,
  ap2AuthorizationChallenge,
  ap2HumanPresentReviewSchema,
  type Ap2HumanPresentReview,
} from "@/lib/payments/ap2-mandates";
import {
  openJsonPayload,
  sealJsonPayload,
  type SealedPayload,
} from "@/lib/security/sealed-payload";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const AP2_WEBAUTHN_CREDENTIAL_VERSION =
  "p9.16-ap2-webauthn-credential:1" as const;
export const AP2_WEBAUTHN_AUTHORIZATION_VERSION =
  "p9.16-ap2-webauthn-authorization:1" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/).max(200_000);
const opaqueIdSchema = z.string().trim().min(1).max(240);
const timestampSchema = z.string().datetime({ offset: true });
const aaguidSchema = z.string().regex(
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
);

export const ap2WebAuthnTrustPolicySchema = z.object({
  version: z.literal("p9.16-ap2-webauthn-trust-policy:1"),
  policyId: opaqueIdSchema,
  rpId: z.string().trim().min(1).max(253),
  expectedOrigin: z.string().url().refine((value) => value.startsWith("https://"), {
    message: "Payment WebAuthn origin must use HTTPS.",
  }),
  allowedAaguids: z.array(aaguidSchema).min(1).max(200),
  acceptedAttestationFormats: z.array(z.enum([
    "fido-u2f",
    "packed",
    "android-key",
    "tpm",
    "apple",
  ])).min(1).max(5),
  assurance: z.object({
    hardwareBacked: z.literal(true),
    privateKeyNonExportable: z.literal(true),
    singleDeviceRequired: z.literal(true),
    backupEligible: z.literal(false),
    userVerificationRequired: z.literal(true),
  }).strict(),
  reviewerPrincipalSha256: sha256Schema,
  reviewedAt: timestampSchema,
  validFrom: timestampSchema,
  validUntil: timestampSchema,
  policySha256: sha256Schema,
}).strict().superRefine((policy, context) => {
  const { policySha256, ...body } = policy;
  if (policySha256 !== canonicalJsonSha256(body)) {
    issue(context, ["policySha256"], "WebAuthn trust policy digest does not match.");
  }
  if (new Set(policy.allowedAaguids).size !== policy.allowedAaguids.length) {
    issue(context, ["allowedAaguids"], "WebAuthn AAGUID allowlist must not contain duplicates.");
  }
  if (Date.parse(policy.validFrom) >= Date.parse(policy.validUntil)) {
    issue(context, ["validUntil"], "WebAuthn trust policy validity interval is invalid.");
  }
});

const credentialBodySchema = z.object({
  version: z.literal(AP2_WEBAUTHN_CREDENTIAL_VERSION),
  credentialId: base64UrlSchema,
  tenantId: opaqueIdSchema,
  ownerActorId: opaqueIdSchema,
  publicKey: base64UrlSchema,
  counter: z.number().int().min(0),
  transports: z.array(z.string().trim().min(1).max(80)).max(20),
  aaguid: aaguidSchema,
  attestationFormat: z.enum([
    "fido-u2f",
    "packed",
    "android-key",
    "tpm",
    "apple",
  ]),
  deviceType: z.literal("singleDevice"),
  backedUp: z.literal(false),
  signerProfile: z.literal(AP2_DIRECT_SIGNER_PROFILE),
  trustPolicyId: opaqueIdSchema,
  trustPolicySha256: sha256Schema,
  state: z.enum(["active", "revoked"]),
  lifecycleRevision: z.number().int().min(1),
  createdAt: timestampSchema,
  lastUsedAt: timestampSchema.nullable(),
  revokedAt: timestampSchema.nullable(),
}).strict();

export const ap2PaymentSigningCredentialSchema = credentialBodySchema.extend({
  credentialSha256: sha256Schema,
}).strict().superRefine((credential, context) => {
  const { credentialSha256, ...body } = credential;
  if (credentialSha256 !== canonicalJsonSha256(body)) {
    issue(context, ["credentialSha256"], "Payment signing credential digest does not match.");
  }
});

const webAuthnAuthenticationResponseSchema = z.object({
  id: base64UrlSchema,
  rawId: base64UrlSchema,
  response: z.object({
    clientDataJSON: base64UrlSchema,
    authenticatorData: base64UrlSchema,
    signature: base64UrlSchema,
    userHandle: base64UrlSchema.optional(),
  }).strict(),
  authenticatorAttachment: z.enum(["cross-platform", "platform"]).optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()),
  type: z.literal("public-key"),
}).strict();

const authorizationBodySchema = z.object({
  version: z.literal(AP2_WEBAUTHN_AUTHORIZATION_VERSION),
  authorizationId: z.string().regex(/^ap2_authorization:[0-9a-f-]{36}$/),
  tenantId: opaqueIdSchema,
  ownerActorId: opaqueIdSchema,
  reviewId: z.string().regex(/^ap2_review:[0-9a-f-]{36}$/),
  reviewSha256: sha256Schema,
  authorizationDigest: sha256Schema,
  challenge: base64UrlSchema,
  credentialId: base64UrlSchema,
  credentialSha256: sha256Schema,
  trustPolicyId: opaqueIdSchema,
  trustPolicySha256: sha256Schema,
  previousCounter: z.number().int().min(0),
  newCounter: z.number().int().min(0),
  assertion: webAuthnAuthenticationResponseSchema,
  assertionSha256: sha256Schema,
  userPresent: z.literal(true),
  userVerified: z.literal(true),
  deviceType: z.literal("singleDevice"),
  backedUp: z.literal(false),
  checkoutMandateContentSha256: sha256Schema,
  paymentMandateContentSha256: sha256Schema,
  externalEffectAuthority: z.literal("none"),
  verifiedAt: timestampSchema,
}).strict();

export const ap2MandateAuthorizationSchema = authorizationBodySchema.extend({
  authorizationSha256: sha256Schema,
}).strict().superRefine((authorization, context) => {
  if (authorization.assertionSha256 !== canonicalJsonSha256(authorization.assertion)) {
    issue(context, ["assertionSha256"], "WebAuthn assertion digest does not match.");
  }
  const { authorizationSha256, ...body } = authorization;
  if (authorizationSha256 !== canonicalJsonSha256(body)) {
    issue(context, ["authorizationSha256"], "Mandate authorization digest does not match.");
  }
});

const mandateVerificationReceiptBodySchema = z.object({
  version: z.literal("p9.16-ap2-mandate-verification:1"),
  reviewId: z.string().regex(/^ap2_review:[0-9a-f-]{36}$/),
  authorizationId: z.string().regex(/^ap2_authorization:[0-9a-f-]{36}$/),
  authorizationSha256: sha256Schema,
  authorizationDigest: sha256Schema,
  credentialIdSha256: sha256Schema,
  trustPolicySha256: sha256Schema,
  accepted: z.literal(true),
  checks: z.tuple([
    z.literal("exact_review_digest"),
    z.literal("exact_checkout_mandate_content"),
    z.literal("exact_payment_mandate_content"),
    z.literal("credential_and_trust_anchor"),
    z.literal("webauthn_signature"),
    z.literal("counter_progression"),
    z.literal("user_verification_and_backup_state"),
    z.literal("authorization_time_and_expiry"),
  ]),
  verifiedAt: timestampSchema,
}).strict();

export const ap2MandateVerificationReceiptSchema =
  mandateVerificationReceiptBodySchema.extend({
    receiptSha256: sha256Schema,
  }).strict().superRefine((receipt, context) => {
    const { receiptSha256, ...body } = receipt;
    if (receiptSha256 !== canonicalJsonSha256(body)) {
      issue(context, ["receiptSha256"], "Mandate verification receipt digest does not match.");
    }
  });

export type Ap2WebAuthnTrustPolicy = z.infer<typeof ap2WebAuthnTrustPolicySchema>;
export type Ap2PaymentSigningCredential = z.infer<typeof ap2PaymentSigningCredentialSchema>;
export type Ap2MandateAuthorization = z.infer<typeof ap2MandateAuthorizationSchema>;
export type Ap2MandateVerificationReceipt = z.infer<
  typeof ap2MandateVerificationReceiptSchema
>;

type RegistrationChallenge = {
  version: 1;
  kind: "ap2_webauthn_registration";
  tenantId: string;
  ownerActorId: string;
  challenge: string;
  rpId: string;
  expectedOrigin: string;
  trustPolicySha256: string;
  issuedAt: string;
  expiresAt: string;
};

export async function beginAp2PaymentCredentialRegistration(input: {
  tenantId: string;
  ownerActorId: string;
  policy: Ap2WebAuthnTrustPolicy;
  existingCredentials?: readonly Ap2PaymentSigningCredential[];
  now?: Date;
}) {
  const policy = requireLiveTrustPolicy(input.policy, input.now);
  const options = await generateRegistrationOptions({
    rpName: "Asael Trusted Surface",
    rpID: policy.rpId,
    userID: createHash("sha256")
      .update(`${required(input.tenantId, "tenant")}\0${required(input.ownerActorId, "actor")}`)
      .digest(),
    userName: `asael-payment-${sha256(input.ownerActorId).slice(0, 24)}`,
    userDisplayName: "Asael payment signer",
    timeout: 120_000,
    attestationType: "direct",
    supportedAlgorithmIDs: [COSEALG.ES256],
    preferredAuthenticatorType: "localDevice",
    excludeCredentials: (input.existingCredentials || [])
      .filter((credential) => credential.state === "active")
      .map((credential) => ({
        id: credential.credentialId,
        transports: credential.transports,
      })),
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    },
  });
  const now = input.now || new Date();
  const challenge: RegistrationChallenge = {
    version: 1,
    kind: "ap2_webauthn_registration",
    tenantId: required(input.tenantId, "tenant"),
    ownerActorId: required(input.ownerActorId, "actor"),
    challenge: options.challenge,
    rpId: policy.rpId,
    expectedOrigin: policy.expectedOrigin,
    trustPolicySha256: policy.policySha256,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 2 * 60_000).toISOString(),
  };
  return Object.freeze({
    options,
    challengeToken: sealJsonPayload(
      challenge,
      registrationBinding(input.tenantId, input.ownerActorId),
    ),
    trustPolicy: publicTrustPolicy(policy),
  });
}

export async function completeAp2PaymentCredentialRegistration(input: {
  tenantId: string;
  ownerActorId: string;
  policy: Ap2WebAuthnTrustPolicy;
  challengeToken: SealedPayload;
  response: RegistrationResponseJSON;
  now?: Date;
  credentialId?: string;
}) {
  const now = input.now || new Date();
  const policy = requireLiveTrustPolicy(input.policy, now);
  const challenge = openJsonPayload(
    input.challengeToken,
    registrationBinding(input.tenantId, input.ownerActorId),
  ) as RegistrationChallenge;
  if (
    challenge.version !== 1 ||
    challenge.kind !== "ap2_webauthn_registration" ||
    challenge.tenantId !== input.tenantId ||
    challenge.ownerActorId !== input.ownerActorId ||
    challenge.rpId !== policy.rpId ||
    challenge.expectedOrigin !== policy.expectedOrigin ||
    challenge.trustPolicySha256 !== policy.policySha256 ||
    Date.parse(challenge.expiresAt) < now.getTime()
  ) {
    throw new Error("Payment credential registration challenge is invalid or expired.");
  }
  const verification = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: policy.expectedOrigin,
    expectedRPID: policy.rpId,
    expectedType: "webauthn.create",
    requireUserPresence: true,
    requireUserVerification: true,
    supportedAlgorithmIDs: [COSEALG.ES256],
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("Payment credential registration could not be verified.");
  }
  const info = verification.registrationInfo;
  if (!policy.allowedAaguids.includes(info.aaguid)) {
    throw new Error("Authenticator AAGUID is not accepted by the reviewed payment trust policy.");
  }
  if (!policy.acceptedAttestationFormats.includes(
    info.fmt as Ap2WebAuthnTrustPolicy["acceptedAttestationFormats"][number],
  )) {
    throw new Error("Authenticator attestation format is not accepted for payments.");
  }
  if (info.credentialDeviceType !== "singleDevice" || info.credentialBackedUp) {
    throw new Error("Payment signing requires a non-backup-eligible single-device authenticator.");
  }
  if (!info.userVerified) {
    throw new Error("Payment signing credential registration requires user verification.");
  }
  const createdAt = now.toISOString();
  const body = credentialBodySchema.parse({
    version: AP2_WEBAUTHN_CREDENTIAL_VERSION,
    credentialId: input.credentialId || info.credential.id,
    tenantId: input.tenantId,
    ownerActorId: input.ownerActorId,
    publicKey: Buffer.from(info.credential.publicKey).toString("base64url"),
    counter: info.credential.counter,
    transports: info.credential.transports || input.response.response.transports || [],
    aaguid: info.aaguid,
    attestationFormat: info.fmt,
    deviceType: "singleDevice",
    backedUp: false,
    signerProfile: AP2_DIRECT_SIGNER_PROFILE,
    trustPolicyId: policy.policyId,
    trustPolicySha256: policy.policySha256,
    state: "active",
    lifecycleRevision: 1,
    createdAt,
    lastUsedAt: null,
    revokedAt: null,
  });
  return ap2PaymentSigningCredentialSchema.parse({
    ...body,
    credentialSha256: canonicalJsonSha256(body),
  });
}

export async function beginAp2MandateAuthorization(input: {
  review: Ap2HumanPresentReview;
  credentials: readonly Ap2PaymentSigningCredential[];
  policy: Ap2WebAuthnTrustPolicy;
  now?: Date;
}) {
  const now = input.now || new Date();
  const policy = requireLiveTrustPolicy(input.policy, now);
  const review = requirePendingReview(input.review, now);
  const credentials = input.credentials.map((credential) =>
    requireActiveCredential(credential, policy)
  );
  if (credentials.length === 0) {
    throw new Error("No active hardware-backed payment signing credential is registered.");
  }
  const challenge = ap2AuthorizationChallenge(review);
  const options = await generateAuthenticationOptions({
    rpID: policy.rpId,
    challenge: Buffer.from(challenge, "base64url"),
    timeout: 120_000,
    userVerification: "required",
    allowCredentials: credentials.map((credential) => ({
      id: credential.credentialId,
      transports: credential.transports,
    })),
  });
  return Object.freeze({
    options,
    reviewId: review.reviewId,
    reviewSha256: review.reviewSha256,
    authorizationDigest: review.authorizationDigest,
    expiresAt: review.terms.expiresAt,
  });
}

export async function verifyAp2MandateAuthorization(input: {
  authorizationId: string;
  review: Ap2HumanPresentReview;
  credential: Ap2PaymentSigningCredential;
  policy: Ap2WebAuthnTrustPolicy;
  response: AuthenticationResponseJSON;
  now?: Date;
  verify?: typeof verifyAuthenticationResponse;
}) {
  const now = input.now || new Date();
  const policy = requireLiveTrustPolicy(input.policy, now);
  const review = requirePendingReview(input.review, now);
  const credential = requireActiveCredential(input.credential, policy);
  const response = webAuthnAuthenticationResponseSchema.parse(input.response);
  if (response.id !== credential.credentialId || response.rawId !== credential.credentialId) {
    throw new Error("WebAuthn assertion belongs to a different payment credential.");
  }
  const challenge = ap2AuthorizationChallenge(review);
  const verification = await (input.verify || verifyAuthenticationResponse)({
    response: response as AuthenticationResponseJSON,
    expectedChallenge: challenge,
    expectedOrigin: policy.expectedOrigin,
    expectedRPID: policy.rpId,
    expectedType: "webauthn.get",
    requireUserVerification: true,
    advancedFIDOConfig: { userVerification: "required" },
    credential: {
      id: credential.credentialId,
      publicKey: Buffer.from(credential.publicKey, "base64url"),
      counter: credential.counter,
      transports: credential.transports,
    },
  });
  if (
    !verification.verified ||
    !verification.authenticationInfo.userVerified ||
    verification.authenticationInfo.credentialDeviceType !== "singleDevice" ||
    verification.authenticationInfo.credentialBackedUp
  ) {
    throw new Error("Hardware-bound user authorization could not be verified.");
  }
  const verifiedAt = now.toISOString();
  const body = authorizationBodySchema.parse({
    version: AP2_WEBAUTHN_AUTHORIZATION_VERSION,
    authorizationId: input.authorizationId,
    tenantId: review.tenantId,
    ownerActorId: review.ownerActorId,
    reviewId: review.reviewId,
    reviewSha256: review.reviewSha256,
    authorizationDigest: review.authorizationDigest,
    challenge,
    credentialId: credential.credentialId,
    credentialSha256: credential.credentialSha256,
    trustPolicyId: policy.policyId,
    trustPolicySha256: policy.policySha256,
    previousCounter: credential.counter,
    newCounter: verification.authenticationInfo.newCounter,
    assertion: response,
    assertionSha256: canonicalJsonSha256(response),
    userPresent: true,
    userVerified: true,
    deviceType: "singleDevice",
    backedUp: false,
    checkoutMandateContentSha256: canonicalJsonSha256(review.checkoutMandateContent),
    paymentMandateContentSha256: canonicalJsonSha256(review.paymentMandateContent),
    externalEffectAuthority: "none",
    verifiedAt,
  });
  return ap2MandateAuthorizationSchema.parse({
    ...body,
    authorizationSha256: canonicalJsonSha256(body),
  });
}

export async function verifyPersistedAp2Mandates(input: {
  review: Ap2HumanPresentReview;
  authorization: Ap2MandateAuthorization;
  credential: Ap2PaymentSigningCredential;
  policy: Ap2WebAuthnTrustPolicy;
  now?: Date;
  verify?: typeof verifyAuthenticationResponse;
}): Promise<Ap2MandateVerificationReceipt> {
  const now = input.now || new Date();
  const review = ap2HumanPresentReviewSchema.parse(input.review);
  const authorization = ap2MandateAuthorizationSchema.parse(input.authorization);
  const credential = ap2PaymentSigningCredentialSchema.parse(input.credential);
  const policy = ap2WebAuthnTrustPolicySchema.parse(input.policy);
  if (
    review.state !== "authorized" ||
    authorization.reviewId !== review.reviewId ||
    authorization.tenantId !== review.tenantId ||
    authorization.ownerActorId !== review.ownerActorId ||
    authorization.authorizationDigest !== review.authorizationDigest
  ) {
    throw new Error("Persisted AP2 authorization belongs to a different or unauthorized review.");
  }
  if (
    authorization.checkoutMandateContentSha256 !==
      canonicalJsonSha256(review.checkoutMandateContent) ||
    authorization.paymentMandateContentSha256 !==
      canonicalJsonSha256(review.paymentMandateContent)
  ) {
    throw new Error("Persisted AP2 mandate content changed after authorization.");
  }
  if (
    credential.credentialId !== authorization.credentialId ||
    credential.tenantId !== review.tenantId ||
    credential.ownerActorId !== review.ownerActorId ||
    credential.trustPolicyId !== authorization.trustPolicyId ||
    credential.trustPolicySha256 !== authorization.trustPolicySha256 ||
    policy.policyId !== authorization.trustPolicyId ||
    policy.policySha256 !== authorization.trustPolicySha256 ||
    !policy.allowedAaguids.includes(credential.aaguid) ||
    !policy.acceptedAttestationFormats.includes(credential.attestationFormat)
  ) {
    throw new Error("Persisted AP2 authorization has no matching trusted credential authority.");
  }
  const authorizedTime = Date.parse(authorization.verifiedAt);
  if (
    authorizedTime < Date.parse(policy.validFrom) ||
    authorizedTime >= Date.parse(policy.validUntil) ||
    authorizedTime >= Date.parse(review.terms.expiresAt) ||
    now.getTime() >= Date.parse(review.terms.expiresAt)
  ) {
    throw new Error("Persisted AP2 authorization is outside its trusted validity interval.");
  }
  const verification = await (input.verify || verifyAuthenticationResponse)({
    response: authorization.assertion as AuthenticationResponseJSON,
    expectedChallenge: ap2AuthorizationChallenge(review),
    expectedOrigin: policy.expectedOrigin,
    expectedRPID: policy.rpId,
    expectedType: "webauthn.get",
    requireUserVerification: true,
    advancedFIDOConfig: { userVerification: "required" },
    credential: {
      id: credential.credentialId,
      publicKey: Buffer.from(credential.publicKey, "base64url"),
      counter: authorization.previousCounter,
      transports: credential.transports,
    },
  });
  if (
    !verification.verified ||
    !verification.authenticationInfo.userVerified ||
    verification.authenticationInfo.credentialDeviceType !== "singleDevice" ||
    verification.authenticationInfo.credentialBackedUp ||
    verification.authenticationInfo.newCounter !== authorization.newCounter
  ) {
    throw new Error("Persisted AP2 WebAuthn authorization proof is invalid.");
  }
  const body = mandateVerificationReceiptBodySchema.parse({
    version: "p9.16-ap2-mandate-verification:1",
    reviewId: review.reviewId,
    authorizationId: authorization.authorizationId,
    authorizationSha256: authorization.authorizationSha256,
    authorizationDigest: authorization.authorizationDigest,
    credentialIdSha256: sha256(credential.credentialId),
    trustPolicySha256: policy.policySha256,
    accepted: true,
    checks: [
      "exact_review_digest",
      "exact_checkout_mandate_content",
      "exact_payment_mandate_content",
      "credential_and_trust_anchor",
      "webauthn_signature",
      "counter_progression",
      "user_verification_and_backup_state",
      "authorization_time_and_expiry",
    ],
    verifiedAt: now.toISOString(),
  });
  return ap2MandateVerificationReceiptSchema.parse({
    ...body,
    receiptSha256: canonicalJsonSha256(body),
  });
}

export function loadAp2WebAuthnTrustPolicy() {
  const raw = process.env.OMNIAGENT_AP2_WEBAUTHN_TRUST_POLICY?.trim();
  if (!raw) return undefined;
  try {
    return ap2WebAuthnTrustPolicySchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `OMNIAGENT_AP2_WEBAUTHN_TRUST_POLICY is invalid: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

export function publicTrustPolicy(policy: Ap2WebAuthnTrustPolicy) {
  return Object.freeze({
    version: policy.version,
    policyId: policy.policyId,
    rpId: policy.rpId,
    expectedOrigin: policy.expectedOrigin,
    acceptedAttestationFormats: [...policy.acceptedAttestationFormats],
    allowedAaguidCount: policy.allowedAaguids.length,
    assurance: policy.assurance,
    reviewedAt: policy.reviewedAt,
    validFrom: policy.validFrom,
    validUntil: policy.validUntil,
    policySha256: policy.policySha256,
  });
}

function requireLiveTrustPolicy(policyInput: Ap2WebAuthnTrustPolicy, nowInput?: Date) {
  const policy = ap2WebAuthnTrustPolicySchema.parse(policyInput);
  const now = nowInput || new Date();
  if (
    Date.parse(policy.validFrom) > now.getTime() ||
    Date.parse(policy.validUntil) <= now.getTime()
  ) {
    throw new Error("The reviewed payment WebAuthn trust policy is not currently valid.");
  }
  return policy;
}

function requirePendingReview(reviewInput: Ap2HumanPresentReview, now: Date) {
  const review = ap2HumanPresentReviewSchema.parse(reviewInput);
  if (review.state !== "pending") {
    throw new Error("Only a pending AP2 review can be authorized.");
  }
  if (Date.parse(review.terms.expiresAt) <= now.getTime()) {
    throw new Error("The AP2 mandate review has expired and requires fresh consent.");
  }
  return review;
}

function requireActiveCredential(
  credentialInput: Ap2PaymentSigningCredential,
  policy: Ap2WebAuthnTrustPolicy,
) {
  const credential = ap2PaymentSigningCredentialSchema.parse(credentialInput);
  if (credential.state !== "active" || credential.revokedAt) {
    throw new Error("Payment signing credential is revoked.");
  }
  if (
    credential.trustPolicyId !== policy.policyId ||
    credential.trustPolicySha256 !== policy.policySha256 ||
    !policy.allowedAaguids.includes(credential.aaguid) ||
    !policy.acceptedAttestationFormats.includes(credential.attestationFormat)
  ) {
    throw new Error("Payment signing credential is outside the current reviewed trust policy.");
  }
  return credential;
}

function registrationBinding(tenantId: string, actorId: string) {
  return `ap2-webauthn-registration:${sha256(tenantId)}:${sha256(actorId)}`;
}

function required(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 240) {
    throw new Error(`AP2 WebAuthn requires an exact ${label}.`);
  }
  return normalized;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function issue(context: z.RefinementCtx, path: PropertyKey[], message: string) {
  context.addIssue({ code: "custom", path, message });
}
