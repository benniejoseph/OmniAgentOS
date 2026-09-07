import { createHash } from "node:crypto";
import { z } from "zod";

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  ap2CredentialGrantSchema,
} from "@/lib/payments/ap2-credential-authorization";
import {
  ap2HumanPresentReviewSchema,
} from "@/lib/payments/ap2-mandates";
import {
  ap2PaymentProjectionSchema,
  ap2ReceiptAuthoritySchema,
  ap2SignedReconciliationObservationSchema,
  ap2VerifiedReceiptSchema,
  createInitialAp2PaymentProjection,
  reconcileAp2PaymentProjection,
  verifyAp2ReceiptJwt,
  verifyAp2ReconciliationObservation,
  type Ap2PaymentProjection,
  type Ap2ReceiptAuthority,
  type Ap2SignedReconciliationObservation,
  type Ap2VerifiedReceipt,
} from "@/lib/payments/ap2-receipts";
import {
  ap2MandateAuthorizationSchema,
} from "@/lib/payments/ap2-webauthn";
import {
  assertExecutionScopeTenant,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

type Owner = Readonly<{ tenantId: string; actorId: string }>;
type MutationOwner = Owner & Readonly<{ executionScope: ExecutionScope }>;
type Sql = ReturnType<typeof getSql>;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });
const opaqueIdSchema = z.string().trim().min(1).max(240);
const paymentIdSchema = z.string().regex(/^ap2_payment:[0-9a-f-]{36}$/);
const jobIdSchema = z.string().regex(/^ap2_reconciliation_job:[0-9a-f-]{36}$/);
const reconciliationReasonSchema = z.enum([
  "receipt_recorded",
  "provider_event",
  "scheduled",
  "discrepancy",
  "operator_requested",
]);

const reconciliationRequestBodySchema = z.object({
  version: z.literal("p9.18-ap2-reconciliation-job:1"),
  jobId: jobIdSchema,
  transactionId: paymentIdSchema,
  reason: reconciliationReasonSchema,
  idempotencyKeySha256: sha256Schema,
  requestedProjectionSha256: sha256Schema,
  requestedAt: timestampSchema,
}).strict();

export const ap2ReconciliationRequestSchema = reconciliationRequestBodySchema.extend({
  requestSha256: sha256Schema,
}).strict().superRefine((request, context) => {
  const { requestSha256, ...body } = request;
  if (requestSha256 !== canonicalJsonSha256(body)) {
    context.addIssue({
      code: "custom",
      path: ["requestSha256"],
      message: "Reconciliation request digest does not match.",
    });
  }
});

export const ap2ReconciliationJobSchema = z.object({
  request: ap2ReconciliationRequestSchema,
  tenantId: opaqueIdSchema,
  ownerActorId: opaqueIdSchema,
  state: z.enum(["queued", "running", "completed", "discrepancy", "failed"]),
  attempt: z.number().int().min(0).max(10),
  maxAttempts: z.number().int().min(1).max(10),
  lifecycleRevision: z.number().int().min(1),
  result: z.object({
    projectionSha256: sha256Schema,
    canonicalStatus: opaqueIdSchema,
    discrepancy: z.boolean(),
    completedAt: timestampSchema,
  }).strict().nullable(),
  leaseTokenSha256: sha256Schema.nullable(),
  leaseExpiresAt: timestampSchema.nullable(),
  lastErrorCode: opaqueIdSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
}).strict().superRefine((job, context) => {
  if (job.attempt > job.maxAttempts) {
    context.addIssue({ code: "custom", path: ["attempt"], message: "Job attempts exceed the limit." });
  }
  const leased = job.leaseTokenSha256 !== null && job.leaseExpiresAt !== null;
  if ((job.state === "running") !== leased) {
    context.addIssue({ code: "custom", path: ["state"], message: "Job lease state is inconsistent." });
  }
  const terminal = ["completed", "discrepancy", "failed"].includes(job.state);
  if (terminal !== (job.completedAt !== null)) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "Job terminal state is inconsistent." });
  }
  if (["completed", "discrepancy"].includes(job.state) !== (job.result !== null)) {
    context.addIssue({ code: "custom", path: ["result"], message: "Job result state is inconsistent." });
  }
});

export type Ap2ReconciliationRequest = z.infer<typeof ap2ReconciliationRequestSchema>;
export type Ap2ReconciliationJob = z.infer<typeof ap2ReconciliationJobSchema>;

export type Ap2ReconciliationAdapter = Readonly<{
  authority: Ap2ReceiptAuthority;
  reconcile: (input: Readonly<{
    projection: Ap2PaymentProjection;
    request: Ap2ReconciliationRequest;
  }>) => Promise<Ap2SignedReconciliationObservation>;
}>;

export class Ap2PaymentStoreError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "database_required"
      | "not_found"
      | "conflict"
      | "grant_not_consumed"
      | "invalid_evidence"
      | "lease_mismatch",
  ) {
    super(message);
    this.name = "Ap2PaymentStoreError";
  }
}

export async function createAp2PaymentTransaction(
  reviewId: string,
  owner: MutationOwner,
) {
  const scope = exactMutationOwner(owner);
  requireDatabase();
  await ensureDatabaseSchema();
  const exactReviewId = required(reviewId, 240, "review id");
  return getSql().transaction(async (sql: Sql) => {
    await sql.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `ap2-payment:${scope.tenantId}:${scope.actorId}:${exactReviewId}`,
    ]);
    const bundle = await readMandateBundle(exactReviewId, scope, sql, true);
    if (!bundle) {
      throw new Ap2PaymentStoreError("Authorized AP2 transaction evidence was not found.", "not_found");
    }
    if (bundle.grant.state !== "consumed") {
      throw new Ap2PaymentStoreError(
        "AP2 payment evidence begins only after the one-time credential grant is consumed.",
        "grant_not_consumed",
      );
    }
    const initial = createInitialAp2PaymentProjection(bundle);
    const existing = await readProjection(initial.transactionId, scope, sql, true);
    if (existing) {
      if (
        existing.reviewId !== initial.reviewId ||
        existing.grantId !== initial.grantId ||
        existing.amountMinor !== initial.amountMinor ||
        existing.currency !== initial.currency ||
        existing.checkoutReference !== initial.checkoutReference ||
        existing.paymentReference !== initial.paymentReference
      ) {
        throw new Ap2PaymentStoreError("AP2 payment transaction conflicts with stored evidence.", "conflict");
      }
      return { projection: existing, created: false };
    }
    await insertProjection(initial, sql);
    await appendPaymentEvent({
      id: `ap2-event:payment-created:${initial.projectionSha256}`,
      type: "ap2.payment_transaction.created",
      scope: scope.executionScope,
      projection: initial,
      sql,
    });
    return { projection: initial, created: true };
  }) as Promise<{ projection: Ap2PaymentProjection; created: boolean }>;
}

export async function listAp2PaymentTransactions(owner: Owner) {
  const scope = exactOwner(owner);
  requireDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT projection FROM omni_ap2_payment_transactions
    WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
    ORDER BY updated_at DESC, transaction_id ASC LIMIT 100
  `;
  return rows.map((row) => ap2PaymentProjectionSchema.parse(row.projection));
}

export async function getAp2PaymentTransaction(transactionId: string, owner: Owner) {
  const scope = exactOwner(owner);
  requireDatabase();
  await ensureDatabaseSchema();
  return readProjection(transactionId, scope, getSql());
}

export async function recordAp2PaymentReceipt(input: {
  transactionId: string;
  kind: "checkout" | "payment";
  jwt: string;
  authority: Ap2ReceiptAuthority;
  now?: Date;
}, owner: MutationOwner) {
  const scope = exactMutationOwner(owner);
  requireDatabase();
  await ensureDatabaseSchema();
  const authority = ap2ReceiptAuthoritySchema.parse(input.authority);
  const now = input.now || new Date();
  return getSql().transaction(async (sql: Sql) => {
    const stored = await requiredProjection(input.transactionId, scope, sql, true);
    const bundle = await requiredMandateBundle(stored.reviewId, scope, sql);
    const receipt = verifyAp2ReceiptJwt({
      jwt: input.jwt,
      kind: input.kind,
      ...bundle,
      authority,
      now,
    });
    const existingRows = await sql`
      SELECT verified_receipt FROM omni_ap2_payment_receipts
      WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
        AND transaction_id = ${stored.transactionId} AND kind = ${input.kind}
      LIMIT 1
    `;
    if (existingRows[0]) {
      const existing = ap2VerifiedReceiptSchema.parse(existingRows[0].verified_receipt);
      if (existing.receiptSha256 !== receipt.receiptSha256) {
        throw new Ap2PaymentStoreError("A different final receipt already exists.", "conflict");
      }
      return { projection: stored, receipt: existing, created: false };
    }
    await sql`
      INSERT INTO omni_ap2_payment_receipts (
        tenant_id, owner_actor_id, receipt_id, transaction_id, kind,
        authority_id, jwt_sha256, receipt_sha256, receipt_jwt,
        verified_receipt, verified_at
      ) VALUES (
        ${scope.tenantId}, ${scope.actorId}, ${receipt.receiptId},
        ${stored.transactionId}, ${receipt.kind}, ${receipt.authorityId},
        ${receipt.jwtSha256}, ${receipt.receiptSha256}, ${input.jwt},
        ${receipt}::jsonb, ${receipt.verifiedAt}
      )
    `;
    const receipts = await readReceipts(stored.transactionId, scope, sql);
    const observations = await readLatestObservations(stored.transactionId, scope, sql);
    const updated = reconcileAp2PaymentProjection({
      stored,
      ...receipts,
      ...observations,
      now: monotonicDate(stored.updatedAt, now),
    });
    await updateProjection(updated, stored.lifecycleRevision, sql);
    await appendPaymentEvent({
      id: `ap2-event:receipt-recorded:${receipt.receiptSha256}`,
      type: "ap2.payment_receipt.recorded",
      scope: scope.executionScope,
      projection: updated,
      receipt,
      sql,
    });
    const job = buildAp2ReconciliationJob({
      projection: updated,
      reason: "receipt_recorded",
      idempotencyKey: `receipt:${receipt.receiptSha256}`,
      now: monotonicDate(updated.updatedAt, now),
    }, scope);
    await insertReconciliationJob(job, sql);
    await appendJobEvent("ap2.reconciliation_job.queued", job, scope.executionScope, sql);
    return { projection: updated, receipt, created: true };
  }) as Promise<{
    projection: Ap2PaymentProjection;
    receipt: Ap2VerifiedReceipt;
    created: boolean;
  }>;
}

export async function recordAp2ReconciliationObservation(input: {
  transactionId: string;
  observation: Ap2SignedReconciliationObservation;
  authority: Ap2ReceiptAuthority;
  now?: Date;
}, owner: MutationOwner) {
  const scope = exactMutationOwner(owner);
  requireDatabase();
  await ensureDatabaseSchema();
  const authority = ap2ReceiptAuthoritySchema.parse(input.authority);
  const now = input.now || new Date();
  return getSql().transaction(async (sql: Sql) => {
    const stored = await requiredProjection(input.transactionId, scope, sql, true);
    const observation = verifyAp2ReconciliationObservation({
      observation: input.observation,
      authority,
      transaction: stored,
      now,
    });
    const digestRows = await sql`
      SELECT signed_observation FROM omni_ap2_reconciliation_observations
      WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
        AND observation_sha256 = ${observation.observationSha256}
      LIMIT 1
    `;
    if (digestRows[0]) {
      return {
        projection: stored,
        observation: ap2SignedReconciliationObservationSchema.parse(digestRows[0].signed_observation),
        created: false,
      };
    }
    const latestRows = await sql`
      SELECT sequence FROM omni_ap2_reconciliation_observations
      WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
        AND transaction_id = ${stored.transactionId}
        AND authority_id = ${observation.authorityId}
      ORDER BY sequence DESC LIMIT 1
    `;
    if (latestRows[0] && Number(latestRows[0].sequence) >= observation.sequence) {
      throw new Ap2PaymentStoreError("Reconciliation sequence is stale or conflicting.", "conflict");
    }
    await sql`
      INSERT INTO omni_ap2_reconciliation_observations (
        tenant_id, owner_actor_id, observation_id, transaction_id,
        authority_id, authority_role, sequence, observation_sha256,
        signed_observation, observed_at, verified_at
      ) VALUES (
        ${scope.tenantId}, ${scope.actorId}, ${observation.observationId},
        ${stored.transactionId}, ${observation.authorityId},
        ${observation.authorityRole}, ${observation.sequence},
        ${observation.observationSha256}, ${observation}::jsonb,
        ${observation.observedAt}, ${now.toISOString()}
      )
    `;
    const receipts = await readReceipts(stored.transactionId, scope, sql);
    const priorObservations = await readLatestObservations(stored.transactionId, scope, sql);
    const updated = reconcileAp2PaymentProjection({
      stored,
      ...receipts,
      ...priorObservations,
      [observation.authorityRole === "merchant"
        ? "merchantObservation"
        : "processorObservation"]: observation,
      now: monotonicDate(stored.updatedAt, now),
    });
    await updateProjection(updated, stored.lifecycleRevision, sql);
    await appendPaymentEvent({
      id: `ap2-event:reconciliation-recorded:${observation.observationSha256}`,
      type: "ap2.payment_reconciliation.recorded",
      scope: scope.executionScope,
      projection: updated,
      observation,
      sql,
    });
    return { projection: updated, observation, created: true };
  }) as Promise<{
    projection: Ap2PaymentProjection;
    observation: Ap2SignedReconciliationObservation;
    created: boolean;
  }>;
}

export function buildAp2ReconciliationJob(input: {
  projection: Ap2PaymentProjection;
  reason: z.infer<typeof reconciliationReasonSchema>;
  idempotencyKey: string;
  now?: Date;
  maxAttempts?: number;
}, owner: Owner) {
  const scope = exactOwner(owner);
  const projection = ap2PaymentProjectionSchema.parse(input.projection);
  assertOwnedProjection(projection, scope);
  const requestedAt = (input.now || new Date()).toISOString();
  const idempotencyKeySha256 = sha256(required(input.idempotencyKey, 2_000, "idempotency key"));
  const jobId = `ap2_reconciliation_job:${deterministicUuid(
    `${projection.transactionId}\0${idempotencyKeySha256}`,
  )}`;
  const requestBody = reconciliationRequestBodySchema.parse({
    version: "p9.18-ap2-reconciliation-job:1",
    jobId,
    transactionId: projection.transactionId,
    reason: input.reason,
    idempotencyKeySha256,
    requestedProjectionSha256: projection.projectionSha256,
    requestedAt,
  });
  const request = ap2ReconciliationRequestSchema.parse({
    ...requestBody,
    requestSha256: canonicalJsonSha256(requestBody),
  });
  return ap2ReconciliationJobSchema.parse({
    request,
    tenantId: scope.tenantId,
    ownerActorId: scope.actorId,
    state: "queued",
    attempt: 0,
    maxAttempts: input.maxAttempts || 5,
    lifecycleRevision: 1,
    result: null,
    leaseTokenSha256: null,
    leaseExpiresAt: null,
    lastErrorCode: null,
    createdAt: requestedAt,
    updatedAt: requestedAt,
    completedAt: null,
  });
}

export async function enqueueAp2ReconciliationJob(input: {
  transactionId: string;
  reason: z.infer<typeof reconciliationReasonSchema>;
  idempotencyKey: string;
  now?: Date;
  maxAttempts?: number;
}, owner: MutationOwner) {
  const scope = exactMutationOwner(owner);
  requireDatabase();
  await ensureDatabaseSchema();
  return getSql().transaction(async (sql: Sql) => {
    const projection = await requiredProjection(input.transactionId, scope, sql);
    const idempotencyKeySha256 = sha256(required(input.idempotencyKey, 2_000, "idempotency key"));
    const existing = await readJobByIdempotency(idempotencyKeySha256, scope, sql);
    if (existing) {
      if (
        existing.request.transactionId !== projection.transactionId ||
        existing.request.reason !== input.reason
      ) {
        throw new Ap2PaymentStoreError("Reconciliation idempotency key conflicts.", "conflict");
      }
      return { job: existing, created: false };
    }
    const job = buildAp2ReconciliationJob({ ...input, projection }, scope);
    await insertReconciliationJob(job, sql);
    await appendJobEvent("ap2.reconciliation_job.queued", job, scope.executionScope, sql);
    return { job, created: true };
  }) as Promise<{ job: Ap2ReconciliationJob; created: boolean }>;
}

export async function claimNextAp2ReconciliationJob(input: {
  leaseToken: string;
  now?: Date;
  leaseDurationMs?: number;
}, owner: MutationOwner) {
  const scope = exactMutationOwner(owner);
  requireDatabase();
  await ensureDatabaseSchema();
  const now = input.now || new Date();
  const leaseTokenSha256 = sha256(required(input.leaseToken, 2_000, "lease token"));
  const leaseDurationMs = Math.min(Math.max(input.leaseDurationMs || 60_000, 5_000), 300_000);
  return getSql().transaction(async (sql: Sql) => {
    const staleRows = await sql`
      SELECT * FROM omni_ap2_reconciliation_jobs
      WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
        AND state = 'running' AND lease_expires_at <= ${now.toISOString()}
      ORDER BY lease_expires_at ASC, job_id ASC LIMIT 1 FOR UPDATE SKIP LOCKED
    `;
    if (staleRows[0]) {
      const stale = parseJobRow(staleRows[0]);
      const exhausted = stale.attempt >= stale.maxAttempts;
      const recovered = ap2ReconciliationJobSchema.parse({
        ...stale,
        state: exhausted ? "failed" : "queued",
        lifecycleRevision: stale.lifecycleRevision + 1,
        leaseTokenSha256: null,
        leaseExpiresAt: null,
        lastErrorCode: "lease_expired",
        updatedAt: monotonicDate(stale.updatedAt, now).toISOString(),
        completedAt: exhausted ? monotonicDate(stale.updatedAt, now).toISOString() : null,
      });
      await updateJob(recovered, stale.lifecycleRevision, sql);
      await appendJobEvent(
        exhausted ? "ap2.reconciliation_job.failed" : "ap2.reconciliation_job.recovered",
        recovered,
        scope.executionScope,
        sql,
      );
    }
    const rows = await sql`
      SELECT * FROM omni_ap2_reconciliation_jobs
      WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
        AND state = 'queued' AND attempt < max_attempts
      ORDER BY updated_at ASC, job_id ASC LIMIT 1 FOR UPDATE SKIP LOCKED
    `;
    if (!rows[0]) return null;
    const queued = parseJobRow(rows[0]);
    const updatedAt = monotonicDate(queued.updatedAt, now);
    const running = ap2ReconciliationJobSchema.parse({
      ...queued,
      state: "running",
      attempt: queued.attempt + 1,
      lifecycleRevision: queued.lifecycleRevision + 1,
      leaseTokenSha256,
      leaseExpiresAt: new Date(updatedAt.getTime() + leaseDurationMs).toISOString(),
      lastErrorCode: null,
      updatedAt: updatedAt.toISOString(),
    });
    await updateJob(running, queued.lifecycleRevision, sql);
    await appendJobEvent("ap2.reconciliation_job.claimed", running, scope.executionScope, sql);
    return running;
  }) as Promise<Ap2ReconciliationJob | null>;
}

export async function runClaimedAp2ReconciliationJob(input: {
  jobId: string;
  leaseToken: string;
  adapters: readonly Ap2ReconciliationAdapter[];
  now?: Date;
}, owner: MutationOwner) {
  const scope = exactMutationOwner(owner);
  const roles = new Set(input.adapters.map((adapter) => adapter.authority.role));
  if (roles.size !== input.adapters.length || input.adapters.length < 1 || input.adapters.length > 2) {
    throw new Ap2PaymentStoreError("Reconciliation adapters must have unique AP2 roles.", "invalid_evidence");
  }
  const job = await getRunningJob(input.jobId, input.leaseToken, scope);
  let projection = await getAp2PaymentTransaction(job.request.transactionId, scope);
  if (!projection) throw new Ap2PaymentStoreError("AP2 payment transaction not found.", "not_found");
  try {
    for (const adapter of input.adapters) {
      const authority = ap2ReceiptAuthoritySchema.parse(adapter.authority);
      const untrusted = await adapter.reconcile({ projection, request: job.request });
      const recorded = await recordAp2ReconciliationObservation({
        transactionId: projection.transactionId,
        observation: untrusted,
        authority,
        now: input.now,
      }, owner);
      projection = recorded.projection;
    }
    return completeAp2ReconciliationJob({
      jobId: job.request.jobId,
      leaseToken: input.leaseToken,
      expectedProjectionSha256: projection.projectionSha256,
      now: input.now,
    }, owner);
  } catch (error) {
    await retryOrFailAp2ReconciliationJob({
      jobId: job.request.jobId,
      leaseToken: input.leaseToken,
      errorCode: safeErrorCode(error),
      now: input.now,
    }, owner);
    throw error;
  }
}

async function completeAp2ReconciliationJob(input: {
  jobId: string;
  leaseToken: string;
  expectedProjectionSha256: string;
  now?: Date;
}, owner: MutationOwner) {
  const scope = exactMutationOwner(owner);
  return getSql().transaction(async (sql: Sql) => {
    const job = await requiredRunningJob(input.jobId, input.leaseToken, scope, sql, true);
    const projection = await requiredProjection(job.request.transactionId, scope, sql);
    if (projection.projectionSha256 !== input.expectedProjectionSha256) {
      throw new Ap2PaymentStoreError("Payment projection changed before job completion.", "conflict");
    }
    const completedAt = monotonicDate(job.updatedAt, input.now || new Date()).toISOString();
    const discrepancy = projection.canonicalStatus === "discrepancy";
    const completed = ap2ReconciliationJobSchema.parse({
      ...job,
      state: discrepancy ? "discrepancy" : "completed",
      lifecycleRevision: job.lifecycleRevision + 1,
      result: {
        projectionSha256: projection.projectionSha256,
        canonicalStatus: projection.canonicalStatus,
        discrepancy,
        completedAt,
      },
      leaseTokenSha256: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      updatedAt: completedAt,
      completedAt,
    });
    await updateJob(completed, job.lifecycleRevision, sql);
    await appendJobEvent(
      discrepancy ? "ap2.reconciliation_job.discrepancy" : "ap2.reconciliation_job.completed",
      completed,
      scope.executionScope,
      sql,
    );
    return { job: completed, projection };
  }) as Promise<{ job: Ap2ReconciliationJob; projection: Ap2PaymentProjection }>;
}

async function retryOrFailAp2ReconciliationJob(input: {
  jobId: string;
  leaseToken: string;
  errorCode: string;
  now?: Date;
}, owner: MutationOwner) {
  const scope = exactMutationOwner(owner);
  return getSql().transaction(async (sql: Sql) => {
    const job = await requiredRunningJob(input.jobId, input.leaseToken, scope, sql, true);
    const failed = job.attempt >= job.maxAttempts;
    const updatedAt = monotonicDate(job.updatedAt, input.now || new Date()).toISOString();
    const updated = ap2ReconciliationJobSchema.parse({
      ...job,
      state: failed ? "failed" : "queued",
      lifecycleRevision: job.lifecycleRevision + 1,
      result: null,
      leaseTokenSha256: null,
      leaseExpiresAt: null,
      lastErrorCode: required(input.errorCode, 240, "error code"),
      updatedAt,
      completedAt: failed ? updatedAt : null,
    });
    await updateJob(updated, job.lifecycleRevision, sql);
    await appendJobEvent(
      failed ? "ap2.reconciliation_job.failed" : "ap2.reconciliation_job.retry_queued",
      updated,
      scope.executionScope,
      sql,
    );
    return updated;
  }) as Promise<Ap2ReconciliationJob>;
}

async function readMandateBundle(
  reviewId: string,
  owner: Owner,
  sql: Sql,
  forUpdate = false,
) {
  const rows = await sql.unsafe(
    `SELECT review.review, authorization.authorization_payload, grant.grant_payload
     FROM omni_ap2_mandate_reviews review
     JOIN omni_ap2_mandate_authorizations authorization
       ON authorization.tenant_id = review.tenant_id
      AND authorization.owner_actor_id = review.owner_actor_id
      AND authorization.review_id = review.review_id
     JOIN omni_ap2_credential_grants grant
       ON grant.tenant_id = review.tenant_id
      AND grant.owner_actor_id = review.owner_actor_id
      AND grant.review_id = review.review_id
     WHERE review.tenant_id = $1 AND review.owner_actor_id = $2 AND review.review_id = $3
     LIMIT 1${forUpdate ? " FOR UPDATE OF review, authorization, grant" : ""}`,
    [owner.tenantId, owner.actorId, reviewId],
  );
  if (!rows[0]) return undefined;
  return {
    review: ap2HumanPresentReviewSchema.parse(rows[0].review),
    authorization: ap2MandateAuthorizationSchema.parse(rows[0].authorization_payload),
    grant: ap2CredentialGrantSchema.parse(rows[0].grant_payload),
  };
}

async function requiredMandateBundle(reviewId: string, owner: Owner, sql: Sql) {
  const bundle = await readMandateBundle(reviewId, owner, sql);
  if (!bundle) throw new Ap2PaymentStoreError("AP2 mandate evidence was not found.", "not_found");
  return bundle;
}

async function insertProjection(projection: Ap2PaymentProjection, sql: Sql) {
  await sql`
    INSERT INTO omni_ap2_payment_transactions (
      tenant_id, owner_actor_id, transaction_id, review_id, grant_id,
      amount_minor, currency, canonical_status, paid, discrepancy,
      lifecycle_revision, projection_sha256, projection, created_at, updated_at
    ) VALUES (
      ${projection.tenantId}, ${projection.ownerActorId}, ${projection.transactionId},
      ${projection.reviewId}, ${projection.grantId}, ${projection.amountMinor},
      ${projection.currency}, ${projection.canonicalStatus}, ${projection.paid},
      ${projection.canonicalStatus === "discrepancy"}, ${projection.lifecycleRevision},
      ${projection.projectionSha256}, ${projection}::jsonb,
      ${projection.createdAt}, ${projection.updatedAt}
    )
  `;
}

async function updateProjection(
  projection: Ap2PaymentProjection,
  priorRevision: number,
  sql: Sql,
) {
  const rows = await sql`
    UPDATE omni_ap2_payment_transactions
    SET canonical_status = ${projection.canonicalStatus}, paid = ${projection.paid},
        discrepancy = ${projection.canonicalStatus === "discrepancy"},
        lifecycle_revision = ${projection.lifecycleRevision},
        projection_sha256 = ${projection.projectionSha256},
        projection = ${projection}::jsonb, updated_at = ${projection.updatedAt}
    WHERE tenant_id = ${projection.tenantId} AND owner_actor_id = ${projection.ownerActorId}
      AND transaction_id = ${projection.transactionId}
      AND lifecycle_revision = ${priorRevision}
    RETURNING transaction_id
  `;
  if (!rows[0]) throw new Ap2PaymentStoreError("Payment projection changed concurrently.", "conflict");
}

async function readProjection(
  transactionId: string,
  owner: Owner,
  sql: Sql,
  forUpdate = false,
) {
  const rows = await sql.unsafe(
    `SELECT projection FROM omni_ap2_payment_transactions
     WHERE tenant_id = $1 AND owner_actor_id = $2 AND transaction_id = $3
     LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [owner.tenantId, owner.actorId, required(transactionId, 240, "transaction id")],
  );
  return rows[0] ? ap2PaymentProjectionSchema.parse(rows[0].projection) : undefined;
}

async function requiredProjection(
  transactionId: string,
  owner: Owner,
  sql: Sql,
  forUpdate = false,
) {
  const projection = await readProjection(transactionId, owner, sql, forUpdate);
  if (!projection) throw new Ap2PaymentStoreError("AP2 payment transaction not found.", "not_found");
  return projection;
}

async function readReceipts(transactionId: string, owner: Owner, sql: Sql) {
  const rows = await sql`
    SELECT kind, verified_receipt FROM omni_ap2_payment_receipts
    WHERE tenant_id = ${owner.tenantId} AND owner_actor_id = ${owner.actorId}
      AND transaction_id = ${transactionId}
  `;
  const result: {
    checkoutReceipt?: Ap2VerifiedReceipt;
    paymentReceipt?: Ap2VerifiedReceipt;
  } = {};
  for (const row of rows) {
    const receipt = ap2VerifiedReceiptSchema.parse(row.verified_receipt);
    if (row.kind === "checkout") result.checkoutReceipt = receipt;
    if (row.kind === "payment") result.paymentReceipt = receipt;
  }
  return result;
}

async function readLatestObservations(transactionId: string, owner: Owner, sql: Sql) {
  const rows = await sql`
    SELECT DISTINCT ON (authority_role) authority_role, signed_observation
    FROM omni_ap2_reconciliation_observations
    WHERE tenant_id = ${owner.tenantId} AND owner_actor_id = ${owner.actorId}
      AND transaction_id = ${transactionId}
    ORDER BY authority_role, sequence DESC
  `;
  const result: {
    merchantObservation?: Ap2SignedReconciliationObservation;
    processorObservation?: Ap2SignedReconciliationObservation;
  } = {};
  for (const row of rows) {
    const observation = ap2SignedReconciliationObservationSchema.parse(row.signed_observation);
    if (row.authority_role === "merchant") result.merchantObservation = observation;
    if (row.authority_role === "merchant_payment_processor") {
      result.processorObservation = observation;
    }
  }
  return result;
}

async function insertReconciliationJob(job: Ap2ReconciliationJob, sql: Sql) {
  await sql`
    INSERT INTO omni_ap2_reconciliation_jobs (
      tenant_id, owner_actor_id, job_id, transaction_id, reason,
      idempotency_key_sha256, request_sha256, state, attempt,
      max_attempts, lifecycle_revision, request_payload, result_payload,
      lease_token_sha256, lease_expires_at, last_error_code,
      created_at, updated_at, completed_at
    ) VALUES (
      ${job.tenantId}, ${job.ownerActorId}, ${job.request.jobId},
      ${job.request.transactionId}, ${job.request.reason},
      ${job.request.idempotencyKeySha256}, ${job.request.requestSha256},
      ${job.state}, ${job.attempt}, ${job.maxAttempts}, ${job.lifecycleRevision},
      ${job.request}::jsonb, ${job.result}::jsonb, ${job.leaseTokenSha256},
      ${job.leaseExpiresAt}, ${job.lastErrorCode}, ${job.createdAt},
      ${job.updatedAt}, ${job.completedAt}
    )
  `;
}

async function updateJob(job: Ap2ReconciliationJob, priorRevision: number, sql: Sql) {
  const rows = await sql`
    UPDATE omni_ap2_reconciliation_jobs
    SET state = ${job.state}, attempt = ${job.attempt},
        lifecycle_revision = ${job.lifecycleRevision},
        result_payload = ${job.result}::jsonb,
        lease_token_sha256 = ${job.leaseTokenSha256},
        lease_expires_at = ${job.leaseExpiresAt},
        last_error_code = ${job.lastErrorCode}, updated_at = ${job.updatedAt},
        completed_at = ${job.completedAt}
    WHERE tenant_id = ${job.tenantId} AND owner_actor_id = ${job.ownerActorId}
      AND job_id = ${job.request.jobId} AND lifecycle_revision = ${priorRevision}
    RETURNING job_id
  `;
  if (!rows[0]) throw new Ap2PaymentStoreError("Reconciliation job changed concurrently.", "conflict");
}

async function readJobByIdempotency(digest: string, owner: Owner, sql: Sql) {
  const rows = await sql`
    SELECT * FROM omni_ap2_reconciliation_jobs
    WHERE tenant_id = ${owner.tenantId} AND owner_actor_id = ${owner.actorId}
      AND idempotency_key_sha256 = ${digest} LIMIT 1
  `;
  return rows[0] ? parseJobRow(rows[0]) : undefined;
}

async function getRunningJob(jobId: string, leaseToken: string, owner: Owner) {
  requireDatabase();
  await ensureDatabaseSchema();
  return requiredRunningJob(jobId, leaseToken, owner, getSql());
}

async function requiredRunningJob(
  jobId: string,
  leaseToken: string,
  owner: Owner,
  sql: Sql,
  forUpdate = false,
) {
  const rows = await sql.unsafe(
    `SELECT * FROM omni_ap2_reconciliation_jobs
     WHERE tenant_id = $1 AND owner_actor_id = $2 AND job_id = $3
     LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [owner.tenantId, owner.actorId, required(jobId, 240, "job id")],
  );
  if (!rows[0]) throw new Ap2PaymentStoreError("Reconciliation job not found.", "not_found");
  const job = parseJobRow(rows[0]);
  if (job.state !== "running" || job.leaseTokenSha256 !== sha256(required(leaseToken, 2_000, "lease token"))) {
    throw new Ap2PaymentStoreError("Reconciliation job lease does not match.", "lease_mismatch");
  }
  if (Date.parse(job.leaseExpiresAt || "") <= Date.now()) {
    throw new Ap2PaymentStoreError("Reconciliation job lease has expired.", "lease_mismatch");
  }
  return job;
}

function parseJobRow(row: Record<string, unknown>) {
  return ap2ReconciliationJobSchema.parse({
    request: row.request_payload,
    tenantId: row.tenant_id,
    ownerActorId: row.owner_actor_id,
    state: row.state,
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    lifecycleRevision: Number(row.lifecycle_revision),
    result: row.result_payload,
    leaseTokenSha256: row.lease_token_sha256,
    leaseExpiresAt: asTimestamp(row.lease_expires_at),
    lastErrorCode: row.last_error_code,
    createdAt: asTimestamp(row.created_at),
    updatedAt: asTimestamp(row.updated_at),
    completedAt: asTimestamp(row.completed_at),
  });
}

async function appendPaymentEvent(input: {
  id: string;
  type: string;
  scope: ExecutionScope;
  projection: Ap2PaymentProjection;
  receipt?: Ap2VerifiedReceipt;
  observation?: Ap2SignedReconciliationObservation;
  sql: Sql;
}) {
  await appendScopedDomainEvent({
    id: input.id,
    streamId: `ap2-payment:${input.projection.transactionId}`,
    type: input.type,
    executionScope: input.scope,
    payload: {
      schemaVersion: 1,
      transactionId: input.projection.transactionId,
      projectionSha256: input.projection.projectionSha256,
      canonicalStatus: input.projection.canonicalStatus,
      paid: input.projection.paid,
      discrepancyCodeCount: input.projection.discrepancyCodes.length,
      lifecycleRevision: input.projection.lifecycleRevision,
      receiptKind: input.receipt?.kind || null,
      receiptSha256: input.receipt?.receiptSha256 || null,
      observationSha256: input.observation?.observationSha256 || null,
      authorityIdSha256: input.observation ? sha256(input.observation.authorityId) : null,
    },
  }, { sql: input.sql });
}

async function appendJobEvent(
  type: string,
  job: Ap2ReconciliationJob,
  scope: ExecutionScope,
  sql: Sql,
) {
  await appendScopedDomainEvent({
    id: `ap2-event:${type}:${job.request.requestSha256}:${job.lifecycleRevision}`,
    streamId: `ap2-reconciliation-job:${job.request.jobId}`,
    type,
    executionScope: scope,
    payload: {
      schemaVersion: 1,
      jobId: job.request.jobId,
      transactionId: job.request.transactionId,
      requestSha256: job.request.requestSha256,
      state: job.state,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      lifecycleRevision: job.lifecycleRevision,
      resultProjectionSha256: job.result?.projectionSha256 || null,
      lastErrorCode: job.lastErrorCode,
    },
  }, { sql });
}

function assertOwnedProjection(projection: Ap2PaymentProjection, owner: Owner) {
  if (projection.tenantId !== owner.tenantId || projection.ownerActorId !== owner.actorId) {
    throw new Error("AP2 payment projection belongs to a different actor scope.");
  }
}

function exactMutationOwner(owner: MutationOwner) {
  const exact = exactOwner(owner);
  assertExecutionScopeTenant(owner.executionScope, exact.tenantId);
  if (owner.executionScope.initiatingActorId !== exact.actorId) {
    throw new Error("AP2 payment execution actor does not match the owner.");
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
    throw new Ap2PaymentStoreError(
      "AP2 payment evidence requires durable database storage.",
      "database_required",
    );
  }
}

function monotonicDate(prior: string, requested: Date) {
  return new Date(Math.max(requested.getTime(), Date.parse(prior) + 1));
}

function asTimestamp(value: unknown) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function safeErrorCode(error: unknown) {
  if (error instanceof Ap2PaymentStoreError) return error.code;
  return "provider_reconciliation_failed";
}

function deterministicUuid(value: string) {
  const hex = sha256(value).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function required(value: string, maxLength: number, label: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`AP2 payment ${label} is invalid.`);
  }
  return normalized;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
