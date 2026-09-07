import { createHash } from "node:crypto";
import type { AuthenticationResponseJSON } from "@simplewebauthn/browser";

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  ap2HumanPresentReviewSchema,
  buildAp2HumanPresentReview,
  type Ap2HumanPresentReview,
  type Ap2HumanPresentTerms,
  type MerchantCheckoutVerification,
} from "@/lib/payments/ap2-mandates";
import {
  ap2MandateAuthorizationSchema,
  ap2PaymentSigningCredentialSchema,
  verifyAp2MandateAuthorization,
  type Ap2MandateAuthorization,
  type Ap2PaymentSigningCredential,
  type Ap2WebAuthnTrustPolicy,
} from "@/lib/payments/ap2-webauthn";
import {
  assertExecutionScopeTenant,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

type Owner = Readonly<{
  tenantId: string;
  actorId: string;
}>;

type MutationOwner = Owner & Readonly<{
  executionScope: ExecutionScope;
}>;

export type MerchantCheckoutVerifier = (input: {
  tenantId: string;
  ownerActorId: string;
  merchantCheckoutJwt: string;
  terms: Ap2HumanPresentTerms;
}) => Promise<MerchantCheckoutVerification>;

export class Ap2HumanPresentStoreError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "database_required"
      | "not_found"
      | "conflict"
      | "adapter_required"
      | "trust_policy_required",
  ) {
    super(message);
    this.name = "Ap2HumanPresentStoreError";
  }
}

export async function registerAp2PaymentSigningCredential(
  input: Ap2PaymentSigningCredential,
  owner: MutationOwner,
) {
  const scope = exactMutationOwner(owner);
  requireDatabase();
  await ensureDatabaseSchema();
  const credential = ap2PaymentSigningCredentialSchema.parse(input);
  assertOwnedCredential(credential, scope);
  return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
    const rows = await sql`
      INSERT INTO omni_ap2_signing_credentials (
        tenant_id, owner_actor_id, credential_id, credential_sha256,
        trust_policy_sha256, aaguid, state, counter, lifecycle_revision,
        credential, created_at, last_used_at, revoked_at
      ) VALUES (
        ${credential.tenantId}, ${credential.ownerActorId}, ${credential.credentialId},
        ${credential.credentialSha256}, ${credential.trustPolicySha256},
        ${credential.aaguid}, ${credential.state}, ${credential.counter},
        ${credential.lifecycleRevision}, ${credential}::jsonb,
        ${credential.createdAt}, ${credential.lastUsedAt}, ${credential.revokedAt}
      )
      ON CONFLICT (tenant_id, owner_actor_id, credential_id) DO NOTHING
      RETURNING credential
    `;
    if (!rows[0]) {
      const existing = await readCredentialDb(credential.credentialId, scope, sql);
      if (!existing || existing.credentialSha256 !== credential.credentialSha256) {
        throw new Ap2HumanPresentStoreError(
          "Payment signing credential conflicts with an existing credential.",
          "conflict",
        );
      }
      return { credential: existing, created: false };
    }
    await appendAp2Event({
      id: `ap2-event:credential-registered:${credential.credentialSha256}`,
      streamId: `ap2-credential:${credential.credentialId}`,
      type: "ap2.signing_credential.registered",
      scope: scope.executionScope,
      payload: {
        schemaVersion: 1,
        credentialIdSha256: sha256(credential.credentialId),
        credentialSha256: credential.credentialSha256,
        trustPolicySha256: credential.trustPolicySha256,
        aaguid: credential.aaguid,
        state: credential.state,
        lifecycleRevision: credential.lifecycleRevision,
      },
      sql,
    });
    return { credential, created: true };
  }) as Promise<{ credential: Ap2PaymentSigningCredential; created: boolean }>;
}

export async function listAp2PaymentSigningCredentials(owner: Owner) {
  const scope = exactOwner(owner);
  requireDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT credential FROM omni_ap2_signing_credentials
    WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
    ORDER BY created_at DESC LIMIT 50
  `;
  return rows.map((row) => ap2PaymentSigningCredentialSchema.parse(row.credential));
}

export async function getAp2PaymentSigningCredential(
  credentialId: string,
  owner: Owner,
) {
  const scope = exactOwner(owner);
  requireDatabase();
  await ensureDatabaseSchema();
  return readCredentialDb(credentialId, scope, getSql());
}

export async function revokeAp2PaymentSigningCredential(
  credentialId: string,
  owner: MutationOwner,
) {
  const scope = exactMutationOwner(owner);
  requireDatabase();
  await ensureDatabaseSchema();
  return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
    const credential = await readCredentialDb(credentialId, scope, sql, true);
    if (!credential) {
      throw new Ap2HumanPresentStoreError("Payment signing credential not found.", "not_found");
    }
    if (credential.state === "revoked") return credential;
    const revokedAt = new Date().toISOString();
    const body = {
      ...credential,
      state: "revoked" as const,
      lifecycleRevision: credential.lifecycleRevision + 1,
      revokedAt,
    };
    const { credentialSha256: _oldDigest, ...withoutDigest } = body;
    const updated = ap2PaymentSigningCredentialSchema.parse({
      ...withoutDigest,
      credentialSha256: canonicalJsonSha256(withoutDigest),
    });
    await updateCredentialDb(updated, credential.lifecycleRevision, sql);
    await appendAp2Event({
      id: `ap2-event:credential-revoked:${updated.credentialSha256}`,
      streamId: `ap2-credential:${updated.credentialId}`,
      type: "ap2.signing_credential.revoked",
      scope: scope.executionScope,
      payload: {
        schemaVersion: 1,
        credentialIdSha256: sha256(updated.credentialId),
        credentialSha256: updated.credentialSha256,
        trustPolicySha256: updated.trustPolicySha256,
        state: updated.state,
        lifecycleRevision: updated.lifecycleRevision,
      },
      sql,
    });
    return updated;
  }) as Promise<Ap2PaymentSigningCredential>;
}

export async function createAp2HumanPresentReview(input: {
  shoppingAgentPrincipalId: string;
  intentSha256: string;
  merchantCheckoutJwt: string;
  terms: Ap2HumanPresentTerms;
  idempotencyKey: string;
}, owner: MutationOwner, verifier: MerchantCheckoutVerifier) {
  const scope = exactMutationOwner(owner);
  requireDatabase();
  const idempotencyKey = required(input.idempotencyKey, 512, "idempotency key");
  const reviewId = `ap2_review:${deterministicUuid(
    `${scope.tenantId}\0${scope.actorId}\0${idempotencyKey}\0ap2-review`,
  )}`;
  const merchantCheckoutVerification = await verifier({
    tenantId: scope.tenantId,
    ownerActorId: scope.actorId,
    merchantCheckoutJwt: input.merchantCheckoutJwt,
    terms: input.terms,
  });
  const review = buildAp2HumanPresentReview({
    reviewId,
    tenantId: scope.tenantId,
    ownerActorId: scope.actorId,
    shoppingAgentPrincipalId: input.shoppingAgentPrincipalId,
    intentSha256: input.intentSha256,
    merchantCheckoutJwt: input.merchantCheckoutJwt,
    merchantCheckoutVerification,
    terms: input.terms,
  });
  await ensureDatabaseSchema();
  return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
    const prior = await readReviewDb(reviewId, scope, sql, true);
    if (prior) {
      if (prior.authorizationDigest !== review.authorizationDigest) {
        throw new Ap2HumanPresentStoreError(
          "AP2 review idempotency key was reused for different terms.",
          "conflict",
        );
      }
      return { review: prior, created: false };
    }
    const pendingRows = await sql`
      SELECT review FROM omni_ap2_mandate_reviews
      WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
        AND intent_sha256 = ${review.intentSha256} AND state = 'pending'
      FOR UPDATE
    `;
    for (const row of pendingRows) {
      const pending = ap2HumanPresentReviewSchema.parse(row.review);
      const superseded = transitionReview(pending, "superseded");
      await updateReviewDb(superseded, pending.lifecycleRevision, sql);
      await appendReviewLifecycleEvent(superseded, scope.executionScope, sql);
    }
    await sql`
      INSERT INTO omni_ap2_mandate_reviews (
        tenant_id, owner_actor_id, review_id, intent_sha256,
        authorization_digest, exact_terms_sha256, review_sha256, state,
        lifecycle_revision, review, expires_at, created_at, updated_at,
        authorized_at, superseded_at
      ) VALUES (
        ${review.tenantId}, ${review.ownerActorId}, ${review.reviewId},
        ${review.intentSha256}, ${review.authorizationDigest},
        ${review.exactTermsSha256}, ${review.reviewSha256}, ${review.state},
        ${review.lifecycleRevision}, ${review}::jsonb, ${review.terms.expiresAt},
        ${review.createdAt}, ${review.updatedAt}, ${review.authorizedAt},
        ${review.supersededAt}
      )
    `;
    await appendAp2Event({
      id: `ap2-event:review-created:${review.reviewSha256}`,
      streamId: `ap2-review:${review.reviewId}`,
      type: "ap2.mandate_review.created",
      scope: scope.executionScope,
      payload: {
        schemaVersion: 1,
        reviewId: review.reviewId,
        intentSha256: review.intentSha256,
        authorizationDigest: review.authorizationDigest,
        exactTermsSha256: review.exactTermsSha256,
        checkoutMandateContentSha256: canonicalJsonSha256(review.checkoutMandateContent),
        paymentMandateContentSha256: canonicalJsonSha256(review.paymentMandateContent),
        state: review.state,
        lifecycleRevision: review.lifecycleRevision,
      },
      sql,
    });
    return { review, created: true };
  }) as Promise<{ review: Ap2HumanPresentReview; created: boolean }>;
}

export async function listAp2HumanPresentReviews(owner: Owner) {
  const scope = exactOwner(owner);
  requireDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT review FROM omni_ap2_mandate_reviews
    WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
    ORDER BY created_at DESC LIMIT 100
  `;
  return rows.map((row) => ap2HumanPresentReviewSchema.parse(row.review));
}

export async function getAp2HumanPresentReview(reviewId: string, owner: Owner) {
  const scope = exactOwner(owner);
  requireDatabase();
  await ensureDatabaseSchema();
  return readReviewDb(reviewId, scope, getSql());
}

export async function getAp2MandateAuthorization(reviewId: string, owner: Owner) {
  const scope = exactOwner(owner);
  requireDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT authorization_payload FROM omni_ap2_mandate_authorizations
    WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
      AND review_id = ${required(reviewId, 240, "review id")}
    LIMIT 1
  `;
  return rows[0]
    ? ap2MandateAuthorizationSchema.parse(rows[0].authorization_payload)
    : undefined;
}

export async function authorizeAp2HumanPresentReview(input: {
  reviewId: string;
  response: AuthenticationResponseJSON;
  policy: Ap2WebAuthnTrustPolicy;
}, owner: MutationOwner) {
  const scope = exactMutationOwner(owner);
  requireDatabase();
  await ensureDatabaseSchema();
  return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
    const review = await readReviewDb(input.reviewId, scope, sql, true);
    if (!review) {
      throw new Ap2HumanPresentStoreError("AP2 mandate review not found.", "not_found");
    }
    const existingRows = await sql`
      SELECT authorization_payload FROM omni_ap2_mandate_authorizations
      WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
        AND review_id = ${review.reviewId} LIMIT 1
    `;
    if (existingRows[0]) {
      return {
        review,
        authorization: ap2MandateAuthorizationSchema.parse(existingRows[0].authorization_payload),
        created: false,
      };
    }
    const credential = await readCredentialDb(input.response.id, scope, sql, true);
    if (!credential) {
      throw new Ap2HumanPresentStoreError("Payment signing credential not found.", "not_found");
    }
    const authorization = await verifyAp2MandateAuthorization({
      authorizationId: `ap2_authorization:${deterministicUuid(`${review.reviewId}\0authorization`)}`,
      review,
      credential,
      policy: input.policy,
      response: input.response,
    });
    const usedCredential = advanceCredentialCounter(credential, authorization);
    const authorizedReview = transitionReview(review, "authorized", authorization.verifiedAt);
    await updateCredentialDb(usedCredential, credential.lifecycleRevision, sql);
    await updateReviewDb(authorizedReview, review.lifecycleRevision, sql);
    await sql`
      INSERT INTO omni_ap2_mandate_authorizations (
        tenant_id, owner_actor_id, authorization_id, review_id, credential_id,
        authorization_sha256, authorization_payload, verified_at
      ) VALUES (
        ${authorization.tenantId}, ${authorization.ownerActorId},
        ${authorization.authorizationId}, ${authorization.reviewId},
        ${authorization.credentialId}, ${authorization.authorizationSha256},
        ${authorization}::jsonb, ${authorization.verifiedAt}
      )
    `;
    await appendAp2Event({
      id: `ap2-event:mandates-authorized:${authorization.authorizationSha256}`,
      streamId: `ap2-review:${review.reviewId}`,
      type: "ap2.mandates.authorized",
      scope: scope.executionScope,
      payload: {
        schemaVersion: 1,
        reviewId: review.reviewId,
        authorizationId: authorization.authorizationId,
        authorizationDigest: authorization.authorizationDigest,
        authorizationSha256: authorization.authorizationSha256,
        credentialIdSha256: sha256(authorization.credentialId),
        checkoutMandateContentSha256: authorization.checkoutMandateContentSha256,
        paymentMandateContentSha256: authorization.paymentMandateContentSha256,
        state: authorizedReview.state,
        lifecycleRevision: authorizedReview.lifecycleRevision,
      },
      sql,
    });
    return { review: authorizedReview, authorization, created: true };
  }) as Promise<{
    review: Ap2HumanPresentReview;
    authorization: Ap2MandateAuthorization;
    created: boolean;
  }>;
}

export async function requireConfiguredMerchantCheckoutVerifier(): Promise<never> {
  throw new Ap2HumanPresentStoreError(
    "No reviewed AP2 merchant adapter is configured. Checkout verification fails closed.",
    "adapter_required",
  );
}

async function readCredentialDb(
  credentialId: string,
  owner: Owner,
  sql: ReturnType<typeof getSql>,
  forUpdate = false,
) {
  const rows = await sql.unsafe(
    `SELECT credential FROM omni_ap2_signing_credentials
     WHERE tenant_id = $1 AND owner_actor_id = $2 AND credential_id = $3
     LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [owner.tenantId, owner.actorId, required(credentialId, 16_384, "credential id")],
  );
  return rows[0]
    ? ap2PaymentSigningCredentialSchema.parse(rows[0].credential)
    : undefined;
}

async function readReviewDb(
  reviewId: string,
  owner: Owner,
  sql: ReturnType<typeof getSql>,
  forUpdate = false,
) {
  const rows = await sql.unsafe(
    `SELECT review FROM omni_ap2_mandate_reviews
     WHERE tenant_id = $1 AND owner_actor_id = $2 AND review_id = $3
     LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [owner.tenantId, owner.actorId, required(reviewId, 240, "review id")],
  );
  return rows[0] ? ap2HumanPresentReviewSchema.parse(rows[0].review) : undefined;
}

async function updateCredentialDb(
  credential: Ap2PaymentSigningCredential,
  priorRevision: number,
  sql: ReturnType<typeof getSql>,
) {
  const rows = await sql`
    UPDATE omni_ap2_signing_credentials
    SET credential_sha256 = ${credential.credentialSha256},
        state = ${credential.state}, counter = ${credential.counter},
        lifecycle_revision = ${credential.lifecycleRevision},
        credential = ${credential}::jsonb, last_used_at = ${credential.lastUsedAt},
        revoked_at = ${credential.revokedAt}
    WHERE tenant_id = ${credential.tenantId}
      AND owner_actor_id = ${credential.ownerActorId}
      AND credential_id = ${credential.credentialId}
      AND lifecycle_revision = ${priorRevision}
    RETURNING credential_id
  `;
  if (!rows[0]) throw new Ap2HumanPresentStoreError("Payment credential changed concurrently.", "conflict");
}

async function updateReviewDb(
  review: Ap2HumanPresentReview,
  priorRevision: number,
  sql: ReturnType<typeof getSql>,
) {
  const rows = await sql`
    UPDATE omni_ap2_mandate_reviews
    SET review_sha256 = ${review.reviewSha256}, state = ${review.state},
        lifecycle_revision = ${review.lifecycleRevision}, review = ${review}::jsonb,
        updated_at = ${review.updatedAt}, authorized_at = ${review.authorizedAt},
        superseded_at = ${review.supersededAt}
    WHERE tenant_id = ${review.tenantId} AND owner_actor_id = ${review.ownerActorId}
      AND review_id = ${review.reviewId} AND lifecycle_revision = ${priorRevision}
    RETURNING review_id
  `;
  if (!rows[0]) throw new Ap2HumanPresentStoreError("AP2 review changed concurrently.", "conflict");
}

function transitionReview(
  review: Ap2HumanPresentReview,
  state: "authorized" | "expired" | "superseded",
  occurredAt = new Date().toISOString(),
) {
  if (review.state !== "pending") {
    throw new Ap2HumanPresentStoreError("Only pending AP2 reviews can transition.", "conflict");
  }
  const { reviewSha256: _oldDigest, ...current } = review;
  const body = {
    ...current,
    state,
    lifecycleRevision: review.lifecycleRevision + 1,
    authorizedAt: state === "authorized" ? occurredAt : null,
    supersededAt: state === "superseded" ? occurredAt : null,
    updatedAt: occurredAt,
  };
  return ap2HumanPresentReviewSchema.parse({
    ...body,
    reviewSha256: canonicalJsonSha256(body),
  });
}

function advanceCredentialCounter(
  credential: Ap2PaymentSigningCredential,
  authorization: Ap2MandateAuthorization,
) {
  const { credentialSha256: _oldDigest, ...current } = credential;
  const body = {
    ...current,
    counter: authorization.newCounter,
    lifecycleRevision: credential.lifecycleRevision + 1,
    lastUsedAt: authorization.verifiedAt,
  };
  return ap2PaymentSigningCredentialSchema.parse({
    ...body,
    credentialSha256: canonicalJsonSha256(body),
  });
}

async function appendReviewLifecycleEvent(
  review: Ap2HumanPresentReview,
  scope: ExecutionScope,
  sql: ReturnType<typeof getSql>,
) {
  await appendAp2Event({
    id: `ap2-event:review-${review.state}:${review.reviewSha256}`,
    streamId: `ap2-review:${review.reviewId}`,
    type: `ap2.mandate_review.${review.state}`,
    scope,
    payload: {
      schemaVersion: 1,
      reviewId: review.reviewId,
      intentSha256: review.intentSha256,
      authorizationDigest: review.authorizationDigest,
      exactTermsSha256: review.exactTermsSha256,
      state: review.state,
      lifecycleRevision: review.lifecycleRevision,
    },
    sql,
  });
}

async function appendAp2Event(input: {
  id: string;
  streamId: string;
  type: string;
  scope: ExecutionScope;
  payload: Record<string, unknown>;
  sql: ReturnType<typeof getSql>;
}) {
  await appendScopedDomainEvent({
    id: input.id,
    streamId: input.streamId,
    type: input.type,
    executionScope: input.scope,
    payload: input.payload,
  }, { sql: input.sql });
}

function assertOwnedCredential(credential: Ap2PaymentSigningCredential, owner: Owner) {
  if (credential.tenantId !== owner.tenantId || credential.ownerActorId !== owner.actorId) {
    throw new Error("Payment signing credential belongs to a different tenant or actor.");
  }
}

function exactMutationOwner(owner: MutationOwner) {
  const exact = exactOwner(owner);
  assertExecutionScopeTenant(owner.executionScope, exact.tenantId);
  if (owner.executionScope.initiatingActorId !== exact.actorId) {
    throw new Error("AP2 execution actor does not match the owner.");
  }
  return { ...exact, executionScope: owner.executionScope };
}

function exactOwner(owner: Owner) {
  return {
    tenantId: required(owner.tenantId, 240, "tenant"),
    actorId: required(owner.actorId, 240, "actor"),
  };
}

function requireDatabase() {
  if (!hasDatabaseUrl()) {
    throw new Ap2HumanPresentStoreError(
      "AP2 human-present mandates require durable database storage.",
      "database_required",
    );
  }
}

function deterministicUuid(value: string) {
  const hex = sha256(value).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function required(value: string, maxLength: number, label: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`AP2 ${label} is invalid.`);
  }
  return normalized;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
