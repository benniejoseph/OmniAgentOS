import { getSql } from "@/lib/db/client";
import {
  appendNotificationDigestEvent,
  appendNotificationDispositionEvent,
} from "@/lib/mobile/notification-decision-events";
import {
  completeDigestDispositionV1,
  buildNotificationDispositionRecordV1,
  NOTIFICATION_DIGEST_WINDOW_MINUTES,
  notificationDeliveryBindingSha256,
  notificationDigestDeliveryV1Schema,
  notificationDispositionCoordinatesSchema,
  notificationDispositionEligible,
  notificationDispositionId,
  notificationDispositionRecordV1Schema,
  type NotificationDigestDeliveryV1,
  type NotificationDispositionCoordinates,
  type NotificationDispositionDeliveryKind,
  type NotificationDispositionRecordV1,
} from "@/lib/mobile/notification-disposition";
import {
  notificationDecisionV1Schema,
  type NotificationDecisionV1,
} from "@/lib/mobile/notification-decision";
import {
  createExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { enqueueMobilePush } from "@/lib/mobile/push-store";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

type NotificationDispositionSql = ReturnType<typeof getSql>;

export type NotificationDirectDeliveryResult = Readonly<{
  deliveryKind: Exclude<
    NotificationDispositionDeliveryKind,
    "digest_ledger"
  >;
  deliveryIds: readonly string[];
  targetSha256: string;
}>;

export type NotificationDispositionApplyResult = Readonly<{
  record: NotificationDispositionRecordV1;
  applied: boolean;
  deliveryIds: readonly string[];
}>;

/**
 * Records exactly one durable disposition for a candidate occurrence. The
 * transaction lock is taken before any delivery side effect, so retrying a
 * tick cannot enqueue a second notification or re-emit a terminal receipt.
 */
export async function applyNotificationDispositionDecision(input: {
  coordinates: NotificationDispositionCoordinates;
  decision: NotificationDecisionV1;
  executionScope: ExecutionScope;
  directDelivery?: (
    sql: NotificationDispositionSql,
  ) => Promise<NotificationDirectDeliveryResult>;
  sql?: NotificationDispositionSql;
  now?: Date;
}): Promise<NotificationDispositionApplyResult> {
  const coordinates = notificationDispositionCoordinatesSchema.parse(
    input.coordinates,
  );
  const decision = notificationDecisionV1Schema.parse(input.decision);
  if (coordinates.candidateSha256 !== decision.candidateSha256) {
    throw new Error("Notification disposition candidate binding is invalid.");
  }
  const operation = (sql: NotificationDispositionSql) =>
    applyInTransaction({ ...input, coordinates, decision, sql });
  return input.sql
    ? operation(input.sql)
    : getSql().transaction(operation) as Promise<NotificationDispositionApplyResult>;
}

export async function listDueNotificationDigestActors(input: {
  tenantId: string;
  now?: Date;
  limit?: number;
  sql?: NotificationDispositionSql;
}) {
  const tenantId = requiredText(input.tenantId, 240, "tenant");
  const cutoff = digestCutoff(input.now || new Date());
  const limit = Math.min(Math.max(Math.trunc(input.limit || 100), 1), 500);
  const sql = input.sql || getSql();
  const rows = await sql`
    SELECT owner_actor_id, MIN(evaluated_at) AS first_evaluated_at
    FROM omni_notification_dispositions
    WHERE tenant_id = ${tenantId}
      AND outcome = 'digest'
      AND state = 'pending'
      AND evaluated_at <= ${cutoff}
    GROUP BY owner_actor_id
    ORDER BY first_evaluated_at, owner_actor_id COLLATE "C"
    LIMIT ${limit}
  `;
  return rows.flatMap((row) => {
    const actorId = optionalText(row.owner_actor_id, 320);
    return actorId ? [actorId] : [];
  });
}

/**
 * Terminalizes up to 100 actor-owned digest dispositions behind a monotonic
 * actor watermark. The digest contains only hashes and counts; content stays
 * in its canonical source table.
 */
export async function flushDueNotificationDigest(input: {
  tenantId: string;
  ownerActorId: string;
  now?: Date;
  sql?: NotificationDispositionSql;
}): Promise<NotificationDigestDeliveryV1 | undefined> {
  const tenantId = requiredText(input.tenantId, 240, "tenant");
  const ownerActorId = requiredText(input.ownerActorId, 320, "actor");
  const now = input.now || new Date();
  const operation = (sql: NotificationDispositionSql) =>
    flushDigestInTransaction({ tenantId, ownerActorId, now, sql });
  return input.sql
    ? operation(input.sql)
    : getSql().transaction(operation) as Promise<NotificationDigestDeliveryV1 | undefined>;
}

async function applyInTransaction(input: {
  coordinates: NotificationDispositionCoordinates;
  decision: NotificationDecisionV1;
  executionScope: ExecutionScope;
  directDelivery?: (
    sql: NotificationDispositionSql,
  ) => Promise<NotificationDirectDeliveryResult>;
  sql: NotificationDispositionSql;
  now?: Date;
}): Promise<NotificationDispositionApplyResult> {
  const { coordinates, decision, sql } = input;
  const dispositionId = notificationDispositionId(coordinates);
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`notification-occurrence:${coordinates.tenantId}:${coordinates.ownerActorId}:${coordinates.occurrenceSha256}`}, 0)
    )
  `;
  const existingRows = await sql`
    SELECT *
    FROM omni_notification_dispositions
    WHERE tenant_id = ${coordinates.tenantId}
      AND owner_actor_id = ${coordinates.ownerActorId}
      AND id = ${dispositionId}
    LIMIT 1
    FOR UPDATE
  `;
  const prior = existingRows[0]
    ? notificationDispositionFromRow(existingRows[0])
    : undefined;
  const now = (input.now || new Date()).toISOString();
  if (prior && !notificationDispositionEligible(prior, now)) {
    return { record: prior, applied: false, deliveryIds: [] };
  }

  let directDelivery: NotificationDirectDeliveryResult | undefined;
  if (decision.outcome === "send") {
    if (!input.directDelivery) {
      throw new Error("A direct notification decision requires a delivery binding.");
    }
    directDelivery = await input.directDelivery(sql);
    if (!directDelivery.deliveryIds.length) directDelivery = undefined;
  }
  const deliveryBindingSha256 = directDelivery
    ? notificationDeliveryBindingSha256({
        deliveryKind: directDelivery.deliveryKind,
        decisionReceiptSha256: decision.receiptSha256,
        deliveryIds: directDelivery.deliveryIds,
        targetSha256: directDelivery.targetSha256,
      })
    : undefined;
  const record = buildRecord({
    coordinates,
    decision,
    prior,
    now,
    deliveryKind: directDelivery?.deliveryKind,
    deliveryBindingSha256,
  });
  const rows = prior
    ? await updateDisposition(sql, record, prior.lifecycleRevision)
    : await insertDisposition(sql, record);
  if (!rows[0]) {
    throw new Error("Notification disposition changed concurrently.");
  }
  const persisted = notificationDispositionFromRow(rows[0]);
  await appendNotificationDispositionEvent({
    decision,
    disposition: persisted,
    executionScope: input.executionScope,
    sql,
  });
  return {
    record: persisted,
    applied: true,
    deliveryIds: directDelivery?.deliveryIds || [],
  };
}

async function flushDigestInTransaction(input: {
  tenantId: string;
  ownerActorId: string;
  now: Date;
  sql: NotificationDispositionSql;
}) {
  const { tenantId, ownerActorId, sql } = input;
  const now = input.now.toISOString();
  const cutoff = digestCutoff(input.now);
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`notification-digest:${tenantId}:${ownerActorId}`}, 0)
    )
  `;
  await sql`
    INSERT INTO omni_notification_digest_watermarks (
      schema_version, tenant_id, owner_actor_id, sequence_number,
      lifecycle_revision, created_at, updated_at
    ) VALUES (1, ${tenantId}, ${ownerActorId}, 0, 0, ${now}, ${now})
    ON CONFLICT (tenant_id, owner_actor_id) DO NOTHING
  `;
  const watermarkRows = await sql`
    SELECT *
    FROM omni_notification_digest_watermarks
    WHERE tenant_id = ${tenantId}
      AND owner_actor_id = ${ownerActorId}
    LIMIT 1
    FOR UPDATE
  `;
  const watermark = digestWatermarkFromRow(watermarkRows[0]);
  const rows = await sql`
    SELECT *
    FROM omni_notification_dispositions
    WHERE tenant_id = ${tenantId}
      AND owner_actor_id = ${ownerActorId}
      AND outcome = 'digest'
      AND state = 'pending'
      AND evaluated_at <= ${cutoff}
    ORDER BY evaluated_at, id COLLATE "C"
    LIMIT 100
    FOR UPDATE
  `;
  const dispositions = rows.map(notificationDispositionFromRow);
  if (!dispositions.length) return undefined;

  const sequence = watermark.sequence + 1;
  const batchWindowEndedAt = latestInstant(
    watermark.lastWindowEndedAt,
    dispositions.at(-1)!.evaluatedAt,
  );
  const candidateManifestSha256 = canonicalJsonSha256(
    dispositions.map((record) => ({
      dispositionId: record.id,
      candidateSha256: record.candidateSha256,
      decisionReceiptSha256: record.decisionReceiptSha256,
    })),
  );
  const digestId = `notification_digest_${canonicalJsonSha256({
    tenantId,
    ownerActorId,
    sequence,
    candidateManifestSha256,
  }).slice(0, 48)}`;
  const executionScope = createExecutionScope({
    tenantId,
    initiatingActorId: ownerActorId,
    executingPrincipalType: "system",
    executingPrincipalId: "notification-digest-batcher",
    correlationId: `notification-digest:${digestId}`,
    causationId: digestId,
    purpose: "notification.digest.delivery",
  });
  const digestTarget = {
    kind: "notification" as const,
    id: digestId,
  };
  const mobileDeliveries = await enqueueMobilePush({
    tenantId,
    actorId: ownerActorId,
    target: digestTarget,
    occurrenceKey: `digest:${sequence}:${candidateManifestSha256}`,
    executionScope,
    sql,
  });
  // A digest remains pending until it has a real actor-owned delivery target.
  // The next runtime tick may retry after a device registration becomes active.
  if (!mobileDeliveries.length) return undefined;
  const deliveryBindingSha256 = canonicalJsonSha256({
    deliveryKind: "mobile_push_outbox",
    digestId,
    sequence,
    candidateManifestSha256,
    targetSha256: canonicalJsonSha256(digestTarget),
    deliveryIdSha256s: mobileDeliveries
      .map((delivery) => canonicalJsonSha256(delivery.id))
      .sort(),
  });
  const delivery = notificationDigestDeliveryV1Schema.parse({
    schemaVersion: 1,
    id: digestId,
    tenantId,
    ownerActorId,
    sequence,
    windowStartedAt: watermark.lastWindowEndedAt || dispositions[0].evaluatedAt,
    windowEndedAt: batchWindowEndedAt,
    candidateCount: dispositions.length,
    candidateManifestSha256,
    deliveryBindingSha256,
    recordedAt: now,
    contentIncluded: false,
    decisionGrantsAuthority: false,
  });
  await sql`
    INSERT INTO omni_notification_digest_deliveries (
      schema_version, id, tenant_id, owner_actor_id, sequence_number,
      window_started_at, window_ended_at, candidate_count,
      candidate_manifest_sha256, delivery_binding_sha256, recorded_at,
      content_included, decision_grants_authority
    ) VALUES (
      ${delivery.schemaVersion}, ${delivery.id}, ${delivery.tenantId},
      ${delivery.ownerActorId}, ${delivery.sequence},
      ${delivery.windowStartedAt}, ${delivery.windowEndedAt},
      ${delivery.candidateCount}, ${delivery.candidateManifestSha256},
      ${delivery.deliveryBindingSha256}, ${delivery.recordedAt}, FALSE, FALSE
    )
  `;
  for (const disposition of dispositions) {
    const completed = completeDigestDispositionV1({
      record: disposition,
      digestDelivery: delivery,
      now,
    });
    const updated = await updateDisposition(
      sql,
      completed,
      disposition.lifecycleRevision,
    );
    if (!updated[0]) {
      throw new Error("Digest disposition changed concurrently.");
    }
  }
  const watermarkUpdates = await sql`
    UPDATE omni_notification_digest_watermarks
    SET sequence_number = ${sequence},
        last_window_ended_at = ${batchWindowEndedAt},
        last_delivery_id = ${delivery.id},
        last_candidate_manifest_sha256 = ${candidateManifestSha256},
        lifecycle_revision = lifecycle_revision + 1,
        updated_at = ${now}
    WHERE tenant_id = ${tenantId}
      AND owner_actor_id = ${ownerActorId}
      AND lifecycle_revision = ${watermark.lifecycleRevision}
    RETURNING tenant_id
  `;
  if (!watermarkUpdates[0]) {
    throw new Error("Notification digest watermark changed concurrently.");
  }
  await appendNotificationDigestEvent({
    delivery,
    executionScope,
    sql,
  });
  return Object.freeze(delivery);
}

function buildRecord(input: {
  coordinates: NotificationDispositionCoordinates;
  decision: NotificationDecisionV1;
  prior?: NotificationDispositionRecordV1;
  now: string;
  deliveryKind?: NotificationDispositionDeliveryKind;
  deliveryBindingSha256?: string;
}) {
  return buildNotificationDispositionRecordV1(input);
}

async function insertDisposition(
  sql: NotificationDispositionSql,
  record: NotificationDispositionRecordV1,
) {
  return sql`
    INSERT INTO omni_notification_dispositions (
      schema_version, id, tenant_id, owner_actor_id, source_kind, source_id,
      occurrence_key, occurrence_sha256, candidate_sha256, outcome, state,
      reason, must_send, critical, policy_sha256, decision_receipt_sha256,
      evaluated_at, due_at, digest_delivery_id, delivery_kind,
      delivery_binding_sha256, lifecycle_revision, created_at, updated_at,
      terminal_at, content_included, decision_grants_authority
    ) VALUES (
      ${record.schemaVersion}, ${record.id}, ${record.tenantId},
      ${record.ownerActorId}, ${record.sourceKind}, ${record.sourceId},
      ${record.occurrenceKey}, ${record.occurrenceSha256},
      ${record.candidateSha256}, ${record.outcome}, ${record.state},
      ${record.reason}, ${record.mustSend}, ${record.critical},
      ${record.policySha256}, ${record.decisionReceiptSha256},
      ${record.evaluatedAt}, ${record.dueAt}, ${record.digestDeliveryId},
      ${record.deliveryKind}, ${record.deliveryBindingSha256},
      ${record.lifecycleRevision}, ${record.createdAt}, ${record.updatedAt},
      ${record.terminalAt}, FALSE, FALSE
    )
    RETURNING *
  `;
}

async function updateDisposition(
  sql: NotificationDispositionSql,
  record: NotificationDispositionRecordV1,
  expectedRevision: number,
) {
  return sql`
    UPDATE omni_notification_dispositions
    SET outcome = ${record.outcome}, state = ${record.state},
        reason = ${record.reason}, must_send = ${record.mustSend},
        critical = ${record.critical}, policy_sha256 = ${record.policySha256},
        decision_receipt_sha256 = ${record.decisionReceiptSha256},
        evaluated_at = ${record.evaluatedAt}, due_at = ${record.dueAt},
        digest_delivery_id = ${record.digestDeliveryId},
        delivery_kind = ${record.deliveryKind},
        delivery_binding_sha256 = ${record.deliveryBindingSha256},
        lifecycle_revision = ${record.lifecycleRevision},
        updated_at = ${record.updatedAt}, terminal_at = ${record.terminalAt}
    WHERE tenant_id = ${record.tenantId}
      AND owner_actor_id = ${record.ownerActorId}
      AND id = ${record.id}
      AND lifecycle_revision = ${expectedRevision}
    RETURNING *
  `;
}

export function notificationDispositionFromRow(
  row: Record<string, unknown>,
): NotificationDispositionRecordV1 {
  return Object.freeze(notificationDispositionRecordV1Schema.parse({
    schemaVersion: Number(row.schema_version),
    id: row.id,
    tenantId: row.tenant_id,
    ownerActorId: row.owner_actor_id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    occurrenceKey: row.occurrence_key,
    occurrenceSha256: row.occurrence_sha256,
    candidateSha256: row.candidate_sha256,
    outcome: row.outcome,
    state: row.state,
    reason: row.reason,
    mustSend: row.must_send === true,
    critical: row.critical === true,
    policySha256: row.policy_sha256,
    decisionReceiptSha256: row.decision_receipt_sha256,
    evaluatedAt: timestamp(row.evaluated_at),
    dueAt: nullableTimestamp(row.due_at),
    digestDeliveryId: nullableText(row.digest_delivery_id),
    deliveryKind: nullableText(row.delivery_kind),
    deliveryBindingSha256: nullableText(row.delivery_binding_sha256),
    lifecycleRevision: Number(row.lifecycle_revision),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    terminalAt: nullableTimestamp(row.terminal_at),
    contentIncluded: row.content_included === true,
    decisionGrantsAuthority: row.decision_grants_authority === true,
  }));
}

function digestWatermarkFromRow(row: Record<string, unknown> | undefined) {
  if (!row) throw new Error("Notification digest watermark was not created.");
  const sequence = Number(row.sequence_number);
  const lifecycleRevision = Number(row.lifecycle_revision);
  if (
    !Number.isSafeInteger(sequence) || sequence < 0 ||
    !Number.isSafeInteger(lifecycleRevision) || lifecycleRevision !== sequence
  ) {
    throw new Error("Notification digest watermark is invalid.");
  }
  return {
    sequence,
    lifecycleRevision,
    lastWindowEndedAt: nullableTimestamp(row.last_window_ended_at),
  };
}

function digestCutoff(now: Date) {
  return new Date(
    now.getTime() - NOTIFICATION_DIGEST_WINDOW_MINUTES * 60_000,
  ).toISOString();
}

function latestInstant(left: string | null, right: string) {
  return left && Date.parse(left) > Date.parse(right) ? left : right;
}

function timestamp(value: unknown) {
  const result = value instanceof Date ? value.toISOString() : String(value || "");
  if (!Number.isFinite(Date.parse(result))) {
    throw new Error("Notification disposition timestamp is invalid.");
  }
  return new Date(result).toISOString();
}

function nullableTimestamp(value: unknown) {
  return value === null || value === undefined ? null : timestamp(value);
}

function nullableText(value: unknown) {
  return value === null || value === undefined ? null : String(value);
}

function optionalText(value: unknown, max: number) {
  const result = String(value || "").trim();
  return result && result.length <= max ? result : undefined;
}

function requiredText(value: string, max: number, label: string) {
  const result = optionalText(value, max);
  if (!result) throw new Error(`Notification ${label} identity is invalid.`);
  return result;
}
