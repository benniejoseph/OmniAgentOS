import { createHash } from "node:crypto";

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  ap2CredentialGrantSchema,
  ap2CredentialProviderConfigurationSchema,
  ap2CredentialScopeSchema,
  ap2CredentialAuthorizationRequestId,
  buildAp2CredentialAuthorizationRequest,
  buildAp2CredentialClaim,
  buildAp2CredentialGrant,
  obtainAp2CredentialProviderAuthorization,
  providerAuthorizationPublicProof,
  transitionAp2CredentialGrant,
  type Ap2CredentialClaim,
  type Ap2CredentialGrant,
  type Ap2CredentialProvider,
  type Ap2CredentialScope,
} from "@/lib/payments/ap2-credential-authorization";
import {
  openAp2CredentialAuthorization,
  sealAp2CredentialAuthorization,
  type SealedAp2CredentialAuthorization,
} from "@/lib/payments/ap2-credential-vault";
import { ap2HumanPresentReviewSchema } from "@/lib/payments/ap2-mandates";
import {
  ap2MandateAuthorizationSchema,
  ap2PaymentSigningCredentialSchema,
  verifyPersistedAp2Mandates,
  type Ap2WebAuthnTrustPolicy,
} from "@/lib/payments/ap2-webauthn";
import {
  assertExecutionScopeTenant,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

type Owner = Readonly<{ tenantId: string; actorId: string }>;
type MutationOwner = Owner & Readonly<{ executionScope: ExecutionScope }>;

export class Ap2CredentialStoreError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "database_required"
      | "not_found"
      | "conflict"
      | "expired"
      | "already_consumed"
      | "scope_mismatch",
  ) {
    super(message);
    this.name = "Ap2CredentialStoreError";
  }
}

export async function issueAp2CredentialGrant(input: {
  reviewId: string;
  provider: Ap2CredentialProvider;
  trustPolicy: Ap2WebAuthnTrustPolicy;
  now?: Date;
}, owner: MutationOwner) {
  const scope = exactMutationOwner(owner);
  requireDatabase();
  await ensureDatabaseSchema();
  const configuration = ap2CredentialProviderConfigurationSchema.parse(
    input.provider.configuration,
  );
  const reviewId = required(input.reviewId, 240, "review id");
  const now = input.now || new Date();

  return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
    await sql.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `ap2-credential:${scope.tenantId}:${scope.actorId}:${reviewId}`,
    ]);
    const rows = await sql`
      SELECT review.review,
             authorization.authorization_payload,
             credential.credential
      FROM omni_ap2_mandate_reviews review
      JOIN omni_ap2_mandate_authorizations authorization
        ON authorization.tenant_id = review.tenant_id
       AND authorization.owner_actor_id = review.owner_actor_id
       AND authorization.review_id = review.review_id
      JOIN omni_ap2_signing_credentials credential
        ON credential.tenant_id = authorization.tenant_id
       AND credential.owner_actor_id = authorization.owner_actor_id
       AND credential.credential_id = authorization.credential_id
      WHERE review.tenant_id = ${scope.tenantId}
        AND review.owner_actor_id = ${scope.actorId}
        AND review.review_id = ${reviewId}
      LIMIT 1
      FOR UPDATE OF review, credential
    `;
    if (!rows[0]) {
      throw new Ap2CredentialStoreError(
        "Authorized AP2 human-present mandates were not found.",
        "not_found",
      );
    }
    const review = ap2HumanPresentReviewSchema.parse(rows[0].review);
    const authorization = ap2MandateAuthorizationSchema.parse(
      rows[0].authorization_payload,
    );
    const credential = ap2PaymentSigningCredentialSchema.parse(rows[0].credential);
    const expectedRequestId = ap2CredentialAuthorizationRequestId({
      reviewId: review.reviewId,
      authorizationSha256: authorization.authorizationSha256,
      providerConfigurationSha256: configuration.configurationSha256,
    });
    const existing = await readGrantByReview(review.reviewId, scope, sql, true);
    if (existing) {
      if (
        existing.requestId !== expectedRequestId ||
        existing.providerConfigurationSha256 !== configuration.configurationSha256
      ) {
        throw new Ap2CredentialStoreError(
          "The mandate already has a grant from a different provider contract.",
          "conflict",
        );
      }
      return { grant: existing, created: false };
    }

    const mandateVerification = await verifyPersistedAp2Mandates({
      review,
      authorization,
      credential,
      policy: input.trustPolicy,
      now,
    });
    const request = buildAp2CredentialAuthorizationRequest({
      review,
      authorization,
      mandateVerification,
      configuration,
      now,
    });
    const providerAuthorization = await obtainAp2CredentialProviderAuthorization({
      provider: input.provider,
      request,
      checkoutMandateContent: review.checkoutMandateContent,
      paymentMandateContent: review.paymentMandateContent,
      mandateAuthorization: authorization,
      now,
    });
    const grant = buildAp2CredentialGrant({
      tenantId: scope.tenantId,
      ownerActorId: scope.actorId,
      request,
      authorization: providerAuthorization,
      configuration,
      now,
    });
    const sealedAuthorization = sealAp2CredentialAuthorization({
      grant,
      authorization: providerAuthorization,
    });
    await sql`
      INSERT INTO omni_ap2_credential_grants (
        tenant_id, owner_actor_id, grant_id, review_id, authorization_id,
        request_id, request_sha256, provider_id, processor_id,
        provider_configuration_sha256, provider_authorization_sha256,
        scoped_token_sha256, scope_sha256, grant_sha256, state,
        lifecycle_revision, grant_payload, provider_proof,
        sealed_authorization, expires_at, created_at, consumed_at,
        revoked_at, expired_at
      ) VALUES (
        ${grant.tenantId}, ${grant.ownerActorId}, ${grant.grantId},
        ${grant.reviewId}, ${grant.authorizationId}, ${grant.requestId},
        ${grant.requestSha256}, ${grant.providerId},
        ${grant.scope.merchantPaymentProcessorId},
        ${grant.providerConfigurationSha256},
        ${grant.providerAuthorizationSha256}, ${grant.scopedTokenSha256},
        ${grant.scopeSha256}, ${grant.grantSha256}, ${grant.state},
        ${grant.lifecycleRevision}, ${grant}::jsonb,
        ${providerAuthorizationPublicProof(providerAuthorization)}::jsonb,
        ${sealedAuthorization}::jsonb, ${grant.scope.expiresAt},
        ${grant.createdAt}, ${grant.consumedAt}, ${grant.revokedAt},
        ${grant.expiredAt}
      )
    `;
    await appendCredentialEvent({
      id: `ap2-event:credential-grant-issued:${grant.grantSha256}`,
      streamId: `ap2-credential-grant:${grant.grantId}`,
      type: "ap2.credential_grant.issued",
      scope: scope.executionScope,
      sql,
      grant,
    });
    return { grant, created: true };
  }) as Promise<{ grant: Ap2CredentialGrant; created: boolean }>;
}

export async function listAp2CredentialGrants(owner: Owner) {
  const scope = exactOwner(owner);
  requireDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT grant_payload FROM omni_ap2_credential_grants
    WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
    ORDER BY created_at DESC LIMIT 100
  `;
  return rows.map((row) => ap2CredentialGrantSchema.parse(row.grant_payload));
}

export async function consumeAp2CredentialGrant(input: {
  grantId: string;
  expectedScope: Ap2CredentialScope;
  merchantPaymentProcessorId: string;
  idempotencyKey: string;
  now?: Date;
}, owner: MutationOwner, dispatchToProcessor: (input: Readonly<{
  scopedToken: string;
  grant: Ap2CredentialGrant;
  claim: Ap2CredentialClaim;
}>) => Promise<void>) {
  const scope = exactMutationOwner(owner);
  requireDatabase();
  await ensureDatabaseSchema();
  const expectedScope = ap2CredentialScopeSchema.parse(input.expectedScope);
  const now = input.now || new Date();
  const transactionResult = await getSql().transaction(
    async (sql: ReturnType<typeof getSql>) => {
      const row = await readGrantRow(input.grantId, scope, sql, true);
      if (!row) {
        throw new Ap2CredentialStoreError("AP2 credential grant not found.", "not_found");
      }
      const grant = row.grant;
      if (grant.state !== "active") {
        throw new Ap2CredentialStoreError(
          "AP2 credential grant has already been consumed or closed.",
          "already_consumed",
        );
      }
      if (Date.parse(grant.scope.expiresAt) <= now.getTime()) {
        const expired = transitionAp2CredentialGrant(grant, "expired", now.toISOString());
        await updateGrant(expired, grant.lifecycleRevision, sql);
        await appendCredentialEvent({
          id: `ap2-event:credential-grant-expired:${expired.grantSha256}`,
          streamId: `ap2-credential-grant:${expired.grantId}`,
          type: "ap2.credential_grant.expired",
          scope: scope.executionScope,
          sql,
          grant: expired,
        });
        return { expired } as const;
      }
      if (
        canonicalJsonSha256(expectedScope) !== grant.scopeSha256 ||
        input.merchantPaymentProcessorId !== grant.scope.merchantPaymentProcessorId
      ) {
        throw new Ap2CredentialStoreError(
          "AP2 credential claim does not match the exact authorized scope.",
          "scope_mismatch",
        );
      }
      if (!row.sealedAuthorization) {
        throw new Ap2CredentialStoreError(
          "AP2 credential authorization material is unavailable.",
          "already_consumed",
        );
      }
      const providerAuthorization = openAp2CredentialAuthorization({
        grant,
        sealedAuthorization: row.sealedAuthorization,
      });
      const claim = buildAp2CredentialClaim({
        grant,
        merchantPaymentProcessorId: input.merchantPaymentProcessorId,
        idempotencyKey: input.idempotencyKey,
        claimedAt: now.toISOString(),
      });
      const consumed = transitionAp2CredentialGrant(grant, "consumed", now.toISOString());
      await sql`
        INSERT INTO omni_ap2_credential_claims (
          tenant_id, owner_actor_id, claim_id, grant_id, processor_id,
          scope_sha256, idempotency_key_sha256, claim_sha256,
          claim_payload, claimed_at
        ) VALUES (
          ${claim.tenantId}, ${claim.ownerActorId}, ${claim.claimId},
          ${claim.grantId}, ${claim.merchantPaymentProcessorId},
          ${claim.scopeSha256}, ${claim.idempotencyKeySha256},
          ${claim.claimSha256}, ${claim}::jsonb, ${claim.claimedAt}
        )
      `;
      await updateGrant(consumed, grant.lifecycleRevision, sql);
      await appendCredentialEvent({
        id: `ap2-event:credential-grant-consumed:${claim.claimSha256}`,
        streamId: `ap2-credential-grant:${consumed.grantId}`,
        type: "ap2.credential_grant.consumed",
        scope: scope.executionScope,
        sql,
        grant: consumed,
        claim,
      });
      return {
        grant: consumed,
        claim,
        scopedToken: providerAuthorization.scopedToken,
      } as const;
    },
  ) as
    | { expired: Ap2CredentialGrant }
    | { grant: Ap2CredentialGrant; claim: Ap2CredentialClaim; scopedToken: string };

  if ("expired" in transactionResult) {
    throw new Ap2CredentialStoreError(
      "AP2 credential grant expired before use.",
      "expired",
    );
  }
  await dispatchToProcessor({
    scopedToken: transactionResult.scopedToken,
    grant: transactionResult.grant,
    claim: transactionResult.claim,
  });
  return {
    grant: transactionResult.grant,
    claim: transactionResult.claim,
  };
}

export async function revokeAp2CredentialGrant(
  grantId: string,
  owner: MutationOwner,
) {
  const scope = exactMutationOwner(owner);
  requireDatabase();
  await ensureDatabaseSchema();
  return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
    const row = await readGrantRow(grantId, scope, sql, true);
    if (!row) throw new Ap2CredentialStoreError("AP2 credential grant not found.", "not_found");
    if (row.grant.state !== "active") return row.grant;
    const revoked = transitionAp2CredentialGrant(row.grant, "revoked");
    await updateGrant(revoked, row.grant.lifecycleRevision, sql);
    await appendCredentialEvent({
      id: `ap2-event:credential-grant-revoked:${revoked.grantSha256}`,
      streamId: `ap2-credential-grant:${revoked.grantId}`,
      type: "ap2.credential_grant.revoked",
      scope: scope.executionScope,
      sql,
      grant: revoked,
    });
    return revoked;
  }) as Promise<Ap2CredentialGrant>;
}

async function readGrantByReview(
  reviewId: string,
  owner: Owner,
  sql: ReturnType<typeof getSql>,
  forUpdate = false,
) {
  const rows = await sql.unsafe(
    `SELECT grant_payload FROM omni_ap2_credential_grants
     WHERE tenant_id = $1 AND owner_actor_id = $2 AND review_id = $3
     LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [owner.tenantId, owner.actorId, reviewId],
  );
  return rows[0]
    ? ap2CredentialGrantSchema.parse(rows[0].grant_payload)
    : undefined;
}

async function readGrantRow(
  grantId: string,
  owner: Owner,
  sql: ReturnType<typeof getSql>,
  forUpdate = false,
) {
  const rows = await sql.unsafe(
    `SELECT grant_payload, sealed_authorization
     FROM omni_ap2_credential_grants
     WHERE tenant_id = $1 AND owner_actor_id = $2 AND grant_id = $3
     LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [owner.tenantId, owner.actorId, required(grantId, 240, "grant id")],
  );
  return rows[0]
    ? {
        grant: ap2CredentialGrantSchema.parse(rows[0].grant_payload),
        sealedAuthorization: rows[0].sealed_authorization as
          | SealedAp2CredentialAuthorization
          | null,
      }
    : undefined;
}

async function updateGrant(
  grant: Ap2CredentialGrant,
  priorRevision: number,
  sql: ReturnType<typeof getSql>,
) {
  const rows = await sql`
    UPDATE omni_ap2_credential_grants
    SET grant_sha256 = ${grant.grantSha256}, state = ${grant.state},
        lifecycle_revision = ${grant.lifecycleRevision},
        grant_payload = ${grant}::jsonb, sealed_authorization = NULL,
        consumed_at = ${grant.consumedAt}, revoked_at = ${grant.revokedAt},
        expired_at = ${grant.expiredAt}
    WHERE tenant_id = ${grant.tenantId} AND owner_actor_id = ${grant.ownerActorId}
      AND grant_id = ${grant.grantId} AND lifecycle_revision = ${priorRevision}
    RETURNING grant_id
  `;
  if (!rows[0]) {
    throw new Ap2CredentialStoreError("AP2 credential grant changed concurrently.", "conflict");
  }
}

async function appendCredentialEvent(input: {
  id: string;
  streamId: string;
  type: string;
  scope: ExecutionScope;
  sql: ReturnType<typeof getSql>;
  grant: Ap2CredentialGrant;
  claim?: Ap2CredentialClaim;
}) {
  await appendScopedDomainEvent({
    id: input.id,
    streamId: input.streamId,
    type: input.type,
    executionScope: input.scope,
    payload: {
      schemaVersion: 1,
      grantId: input.grant.grantId,
      reviewId: input.grant.reviewId,
      providerIdSha256: sha256(input.grant.providerId),
      processorIdSha256: sha256(input.grant.scope.merchantPaymentProcessorId),
      grantSha256: input.grant.grantSha256,
      scopeSha256: input.grant.scopeSha256,
      state: input.grant.state,
      lifecycleRevision: input.grant.lifecycleRevision,
      claimSha256: input.claim?.claimSha256 || null,
    },
  }, { sql: input.sql });
}

function exactMutationOwner(owner: MutationOwner) {
  const exact = exactOwner(owner);
  assertExecutionScopeTenant(owner.executionScope, exact.tenantId);
  if (owner.executionScope.initiatingActorId !== exact.actorId) {
    throw new Error("AP2 credential execution actor does not match the owner.");
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
    throw new Ap2CredentialStoreError(
      "AP2 credential grants require durable database storage.",
      "database_required",
    );
  }
}

function required(value: string, maxLength: number, label: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`AP2 credential ${label} is invalid.`);
  }
  return normalized;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
