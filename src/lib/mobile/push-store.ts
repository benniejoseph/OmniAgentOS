import { createHash, randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseSystemScope,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  createMobilePushEnvelope,
  mobilePushDedupeKey,
  mobilePushEnvelopeSchema,
  mobilePushTargetSchema,
  type MobilePushPreviewPolicy,
  type MobilePushTarget,
} from "@/lib/mobile/push-contract";
import {
  deliverMobilePush,
  MobilePushProviderError,
  mobilePushProviderConfiguration,
} from "@/lib/mobile/push-providers";
import {
  credentialBinding,
  openCredentialBundle,
  sealCredentialBundle,
} from "@/lib/settings/credential-vault";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

type PushSql = ReturnType<typeof getSql>;
type PushProvider = "apns" | "fcm";
type PushEnvironment = "sandbox" | "production";

export type MobilePushRegistrationInput = Readonly<{
  provider: PushProvider;
  environment: PushEnvironment;
  token: string;
  previewPolicy: MobilePushPreviewPolicy;
  idempotencyKey: string;
}>;

type MobilePushRegistration = Readonly<{
  id: string;
  tenantId: string;
  ownerActorId: string;
  userId: string;
  mobileSessionId: string;
  deviceId: string;
  platform: "android" | "ios" | "macos";
  provider: PushProvider;
  environment: PushEnvironment;
  tokenSha256: string;
  credentialVersion: number;
  tokenBundle: unknown;
  previewPolicy: MobilePushPreviewPolicy;
  state: "active" | "revoked";
  lifecycleRevision: number;
  lastRegisteredAt: string;
  lastDeliveredAt?: string;
  revokedAt?: string;
  createdAt: string;
  updatedAt: string;
}>;

type MobilePushDelivery = Readonly<{
  id: string;
  tenantId: string;
  ownerActorId: string;
  registrationId: string;
  notificationId?: string;
  target: MobilePushTarget;
  deepLink: string;
  dedupeKey: string;
  payload: unknown;
  status: "queued" | "running" | "delivered" | "acknowledged" | "failed";
  attempt: number;
  maxAttempts: number;
  runAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  lastError?: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
  createdAt: string;
  updatedAt: string;
}>;

export class MobilePushStorageRequiredError extends Error {
  readonly status = 503;

  constructor() {
    super("Durable database storage is required for mobile push delivery.");
    this.name = "MobilePushStorageRequiredError";
  }
}

export async function registerMobilePushDevice(
  context: SecurityContext,
  input: MobilePushRegistrationInput,
) {
  const native = exactNativeContext(context);
  requirePushStorage();
  validatePushToken(input.provider, input.token);
  if (
    input.provider === "apns" &&
    native.platform !== "ios" &&
    native.platform !== "macos"
  ) {
    throw new Error("APNs registration requires an Apple native session.");
  }
  const tokenSha256 = sha256(input.token);
  const registrationId = `mobile_push_registration_${mobilePushDedupeKey({
    tenantId: context.tenantId,
    actorId: context.actorId,
    deviceId: native.deviceId,
    provider: input.provider,
  }).slice(0, 48)}`;
  const credentialVersion = 1;
  const tokenBundle = sealCredentialBundle(
    { token: input.token },
    pushCredentialBinding({
      tenantId: context.tenantId,
      actorId: context.actorId,
      registrationId,
      provider: input.provider,
      credentialVersion,
    }),
  );
  await ensureDatabaseSchema();
  const result = await getSql().transaction(async (sql: PushSql) => {
    const existingRows = await sql`
      SELECT * FROM omni_mobile_push_registrations
      WHERE tenant_id = ${context.tenantId}
        AND owner_actor_id = ${context.actorId}
        AND device_id = ${native.deviceId}
        AND provider = ${input.provider}
      LIMIT 1
      FOR UPDATE
    `;
    const existing = existingRows[0]
      ? registrationFromRow(existingRows[0])
      : undefined;
    if (
      existing?.state === "active" &&
      existing.userId === native.userId &&
      existing.mobileSessionId === native.sessionId &&
      existing.platform === native.platform &&
      existing.environment === input.environment &&
      existing.tokenSha256 === tokenSha256 &&
      existing.previewPolicy === input.previewPolicy
    ) {
      return { registration: existing, changed: false };
    }
    const now = new Date().toISOString();
    const rows = await sql`
      INSERT INTO omni_mobile_push_registrations (
        id, tenant_id, owner_actor_id, user_id, mobile_session_id, device_id,
        platform, provider, environment, token_sha256, credential_version,
        token_bundle, preview_policy, state, lifecycle_revision,
        last_registered_at, revoked_at, created_at, updated_at
      )
      SELECT
        ${registrationId}, ${context.tenantId}, ${context.actorId},
        ${native.userId}, session.id, ${native.deviceId}, ${native.platform},
        ${input.provider}, ${input.environment}, ${tokenSha256},
        ${credentialVersion}, ${tokenBundle}::jsonb, ${input.previewPolicy},
        'active', 1, ${now}, NULL, ${now}, ${now}
      FROM omni_mobile_sessions session
      WHERE session.id = ${native.sessionId}
        AND session.tenant_id = ${context.tenantId}
        AND session.user_id = ${native.userId}
        AND session.device_id = ${native.deviceId}
        AND session.revoked_at IS NULL
        AND session.refresh_expires_at > NOW()
      ON CONFLICT (tenant_id, owner_actor_id, device_id, provider) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        mobile_session_id = EXCLUDED.mobile_session_id,
        platform = EXCLUDED.platform,
        environment = EXCLUDED.environment,
        token_sha256 = EXCLUDED.token_sha256,
        credential_version = EXCLUDED.credential_version,
        token_bundle = EXCLUDED.token_bundle,
        preview_policy = EXCLUDED.preview_policy,
        state = 'active',
        lifecycle_revision = omni_mobile_push_registrations.lifecycle_revision + 1,
        last_registered_at = EXCLUDED.last_registered_at,
        revoked_at = NULL,
        updated_at = EXCLUDED.updated_at
      RETURNING *
    `;
    if (!rows[0]) {
      throw new Error("The native session is no longer eligible for push registration.");
    }
    const registration = registrationFromRow(rows[0]);
    await appendPushEvent({
      type: "mobile.push_registration_upserted",
      context,
      idempotencyKey: input.idempotencyKey,
      causationId: registration.id,
      streamId: `mobile-push-registration:${registration.id}`,
      eventKey: `${registration.id}:${registration.lifecycleRevision}`,
      payload: {
        schemaVersion: 1,
        registrationId: registration.id,
        deviceIdSha256: sha256(registration.deviceId),
        provider: registration.provider,
        platform: registration.platform,
        environment: registration.environment,
        previewPolicy: registration.previewPolicy,
        lifecycleRevision: registration.lifecycleRevision,
        tokenSha256: registration.tokenSha256,
      },
      sql,
    });
    return { registration, changed: true };
  }) as { registration: MobilePushRegistration; changed: boolean };
  return {
    schemaVersion: 1 as const,
    registration: publicRegistration(result.registration),
    changed: result.changed,
    providers: mobilePushProviderConfiguration(),
  };
}

export async function listMobilePushDevices(context: SecurityContext) {
  exactNativeContext(context);
  requirePushStorage();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT * FROM omni_mobile_push_registrations
    WHERE tenant_id = ${context.tenantId}
      AND owner_actor_id = ${context.actorId}
      AND device_id = ${context.native!.deviceId}
    ORDER BY updated_at DESC, id COLLATE "C"
    LIMIT 10
  `;
  return {
    schemaVersion: 1 as const,
    registrations: rows.map((row) => publicRegistration(registrationFromRow(row))),
    providers: mobilePushProviderConfiguration(),
  };
}

export async function revokeMobilePushDevice(
  context: SecurityContext,
  registrationId: string,
  idempotencyKey: string,
) {
  const native = exactNativeContext(context);
  requirePushStorage();
  await ensureDatabaseSchema();
  return getSql().transaction(async (sql: PushSql) => {
    const rows = await sql`
      UPDATE omni_mobile_push_registrations
      SET state = 'revoked',
          lifecycle_revision = lifecycle_revision + 1,
          revoked_at = NOW(),
          updated_at = NOW()
      WHERE id = ${registrationId}
        AND tenant_id = ${context.tenantId}
        AND owner_actor_id = ${context.actorId}
        AND device_id = ${native.deviceId}
        AND state = 'active'
      RETURNING *
    `;
    const registration = rows[0]
      ? registrationFromRow(rows[0])
      : undefined;
    if (!registration) return undefined;
    await appendPushEvent({
      type: "mobile.push_registration_revoked",
      context,
      idempotencyKey,
      causationId: registration.id,
      streamId: `mobile-push-registration:${registration.id}`,
      eventKey: `${registration.id}:${registration.lifecycleRevision}`,
      payload: {
        schemaVersion: 1,
        registrationId: registration.id,
        lifecycleRevision: registration.lifecycleRevision,
      },
      sql,
    });
    return publicRegistration(registration);
  }) as Promise<ReturnType<typeof publicRegistration> | undefined>;
}

export async function enqueueMobilePush(input: {
  tenantId: string;
  actorId: string;
  target: MobilePushTarget;
  occurrenceKey: string;
  notificationId?: string;
  sql?: PushSql;
}) {
  requirePushStorage();
  const target = mobilePushTargetSchema.parse(input.target);
  if (!input.sql) await ensureDatabaseSchema();
  const sql = input.sql || getSql();
  const registrations = await sql`
    SELECT registration.*
    FROM omni_mobile_push_registrations registration
    JOIN omni_mobile_sessions session
      ON session.id = registration.mobile_session_id
      AND session.tenant_id = registration.tenant_id
      AND session.user_id = registration.user_id
      AND session.device_id = registration.device_id
      AND session.revoked_at IS NULL
      AND session.refresh_expires_at > NOW()
    WHERE registration.tenant_id = ${input.tenantId}
      AND registration.owner_actor_id = ${input.actorId}
      AND registration.state = 'active'
    ORDER BY registration.id COLLATE "C"
    LIMIT 20
  `;
  const queued: MobilePushDelivery[] = [];
  for (const row of registrations) {
    const registration = registrationFromRow(row);
    const dedupeKey = mobilePushDedupeKey({
      tenantId: input.tenantId,
      actorId: input.actorId,
      registrationId: registration.id,
      notificationId: input.notificationId,
      target,
      occurrenceKey: input.occurrenceKey,
    });
    const deliveryId = `mobile_push_delivery_${dedupeKey.slice(0, 48)}`;
    const envelope = createMobilePushEnvelope({
      deliveryId,
      notificationId: input.notificationId,
      target,
    });
    const rows = await sql`
      INSERT INTO omni_mobile_push_deliveries (
        id, tenant_id, owner_actor_id, registration_id, notification_id,
        cause_kind, cause_id, parent_id, deep_link, dedupe_key, payload,
        status, attempt, max_attempts, run_at, created_at, updated_at
      ) VALUES (
        ${deliveryId}, ${input.tenantId}, ${input.actorId}, ${registration.id},
        ${input.notificationId || null}, ${target.kind}, ${target.id},
        ${target.kind === "work_item" ? target.parentId || null : null},
        ${envelope.deepLink}, ${dedupeKey}, ${envelope}::jsonb,
        'queued', 0, 5, NOW(), NOW(), NOW()
      )
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING *
    `;
    if (rows[0]) queued.push(deliveryFromRow(rows[0]));
  }
  return queued;
}

export async function dispatchMobilePushDeliveries(options: {
  tenantId: string;
  limit?: number;
}) {
  requirePushStorage();
  await ensureDatabaseSchema();
  return runWithDatabaseSystemScope(
    `Dispatch actor-private mobile push outbox for tenant ${options.tenantId}.`,
    async () => {
      await repairExpiredPushLeases(options.tenantId);
      const deliveries = await leasePushDeliveries(
        options.tenantId,
        options.limit,
      );
      const outcome = { processed: deliveries.length, delivered: 0, retried: 0, failed: 0 };
      for (const delivery of deliveries) {
        try {
          const registration = await activeRegistrationForDelivery(delivery);
          if (!registration) {
            throw new MobilePushProviderError(
              "The registered native session is no longer active.",
              true,
              "registration_inactive",
            );
          }
          const credentials = openCredentialBundle(
            registration.tokenBundle,
            pushCredentialBinding({
              tenantId: registration.tenantId,
              actorId: registration.ownerActorId,
              registrationId: registration.id,
              provider: registration.provider,
              credentialVersion: registration.credentialVersion,
            }),
          );
          validatePushToken(registration.provider, credentials.token || "");
          const title = delivery.notificationId
            ? await notificationTitle(delivery)
            : undefined;
          const result = await deliverMobilePush({
            provider: registration.provider,
            environment: registration.environment,
            token: credentials.token,
            target: delivery.target,
            envelope: mobilePushEnvelopeSchema.parse(delivery.payload),
            previewPolicy: registration.previewPolicy,
            sensitiveTitle: title,
          });
          await completePushDelivery(delivery, registration, result.messageId);
          outcome.delivered += 1;
        } catch (error) {
          const result = await failPushDelivery(delivery, error);
          outcome[result] += 1;
        }
      }
      return outcome;
    },
  );
}

export async function acknowledgeMobilePushDelivery(
  context: SecurityContext,
  deliveryId: string,
  idempotencyKey: string,
) {
  const native = exactNativeContext(context);
  requirePushStorage();
  await ensureDatabaseSchema();
  return getSql().transaction(async (sql: PushSql) => {
    const currentRows = await sql`
      SELECT * FROM omni_mobile_push_deliveries
      WHERE id = ${deliveryId}
        AND tenant_id = ${context.tenantId}
        AND owner_actor_id = ${context.actorId}
        AND EXISTS (
          SELECT 1 FROM omni_mobile_push_registrations registration
          WHERE registration.id = omni_mobile_push_deliveries.registration_id
            AND registration.tenant_id = omni_mobile_push_deliveries.tenant_id
            AND registration.owner_actor_id = omni_mobile_push_deliveries.owner_actor_id
            AND registration.device_id = ${native.deviceId}
            AND registration.mobile_session_id = ${native.sessionId}
        )
      LIMIT 1
      FOR UPDATE
    `;
    const current = currentRows[0]
      ? deliveryFromRow(currentRows[0])
      : undefined;
    if (!current) return undefined;
    if (current.status === "acknowledged") {
      return { delivery: current, newlyAcknowledged: false };
    }
    if (current.status !== "delivered") {
      throw new Error("Push delivery is not ready to acknowledge.");
    }
    const rows = await sql`
      UPDATE omni_mobile_push_deliveries
      SET status = 'acknowledged', acknowledged_at = NOW(), updated_at = NOW()
      WHERE id = ${deliveryId}
        AND tenant_id = ${context.tenantId}
        AND owner_actor_id = ${context.actorId}
        AND status = 'delivered'
        AND EXISTS (
          SELECT 1 FROM omni_mobile_push_registrations registration
          WHERE registration.id = omni_mobile_push_deliveries.registration_id
            AND registration.tenant_id = omni_mobile_push_deliveries.tenant_id
            AND registration.owner_actor_id = omni_mobile_push_deliveries.owner_actor_id
            AND registration.device_id = ${native.deviceId}
            AND registration.mobile_session_id = ${native.sessionId}
        )
      RETURNING *
    `;
    const delivery = deliveryFromRow(rows[0]);
    await appendPushEvent({
      type: "mobile.push_delivery_acknowledged",
      context,
      idempotencyKey,
      causationId: delivery.id,
      streamId: `mobile-push-delivery:${delivery.id}`,
      eventKey: delivery.id,
      payload: {
        schemaVersion: 1,
        deliveryId: delivery.id,
        notificationId: delivery.notificationId || null,
        causeKind: delivery.target.kind,
        causeId: delivery.target.id,
        deepLinkSha256: sha256(delivery.deepLink),
      },
      sql,
    });
    return { delivery, newlyAcknowledged: true };
  }) as Promise<{
    delivery: MobilePushDelivery;
    newlyAcknowledged: boolean;
  } | undefined>;
}

export async function getMobilePushAcknowledgementCandidate(
  context: SecurityContext,
  deliveryId: string,
) {
  const native = exactNativeContext(context);
  requirePushStorage();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT * FROM omni_mobile_push_deliveries
    WHERE id = ${deliveryId}
      AND tenant_id = ${context.tenantId}
      AND owner_actor_id = ${context.actorId}
      AND status IN ('delivered', 'acknowledged')
      AND EXISTS (
        SELECT 1 FROM omni_mobile_push_registrations registration
        WHERE registration.id = omni_mobile_push_deliveries.registration_id
          AND registration.tenant_id = omni_mobile_push_deliveries.tenant_id
          AND registration.owner_actor_id = omni_mobile_push_deliveries.owner_actor_id
          AND registration.device_id = ${native.deviceId}
          AND registration.mobile_session_id = ${native.sessionId}
      )
    LIMIT 1
  `;
  return rows[0] ? deliveryFromRow(rows[0]) : undefined;
}

async function leasePushDeliveries(tenantId: string, limit = 20) {
  const bounded = Math.min(Math.max(limit, 1), 50);
  const leaseOwner = `mobile-push:${randomUUID()}`;
  const leaseExpiresAt = new Date(Date.now() + 30_000).toISOString();
  const rows = await getSql()`
    WITH next_deliveries AS (
      SELECT id
      FROM omni_mobile_push_deliveries
      WHERE tenant_id = ${tenantId}
        AND status = 'queued'
        AND run_at <= NOW()
      ORDER BY run_at, created_at, id COLLATE "C"
      LIMIT ${bounded}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE omni_mobile_push_deliveries delivery
    SET status = 'running',
        attempt = delivery.attempt + 1,
        lease_owner = ${leaseOwner},
        lease_expires_at = ${leaseExpiresAt},
        last_error = NULL,
        updated_at = NOW()
    FROM next_deliveries
    WHERE delivery.id = next_deliveries.id
    RETURNING delivery.*
  `;
  return rows.map(deliveryFromRow);
}

async function activeRegistrationForDelivery(delivery: MobilePushDelivery) {
  const rows = await getSql()`
    SELECT registration.*
    FROM omni_mobile_push_registrations registration
    JOIN omni_mobile_sessions session
      ON session.id = registration.mobile_session_id
      AND session.tenant_id = registration.tenant_id
      AND session.user_id = registration.user_id
      AND session.device_id = registration.device_id
      AND session.revoked_at IS NULL
      AND session.refresh_expires_at > NOW()
    WHERE registration.id = ${delivery.registrationId}
      AND registration.tenant_id = ${delivery.tenantId}
      AND registration.owner_actor_id = ${delivery.ownerActorId}
      AND registration.state = 'active'
    LIMIT 1
  `;
  return rows[0] ? registrationFromRow(rows[0]) : undefined;
}

async function notificationTitle(delivery: MobilePushDelivery) {
  const rows = await getSql()`
    SELECT title FROM omni_personal_notifications
    WHERE id = ${delivery.notificationId!}
      AND tenant_id = ${delivery.tenantId}
      AND actor_id = ${delivery.ownerActorId}
    LIMIT 1
  `;
  return rows[0]?.title ? String(rows[0].title) : undefined;
}

async function completePushDelivery(
  delivery: MobilePushDelivery,
  registration: MobilePushRegistration,
  providerMessageId: string,
) {
  if (!delivery.leaseOwner) throw new Error("Push delivery lease is missing.");
  await getSql().transaction(async (sql: PushSql) => {
    const rows = await sql`
      UPDATE omni_mobile_push_deliveries
      SET status = 'delivered',
          lease_owner = NULL,
          lease_expires_at = NULL,
          provider_message_id_sha256 = ${sha256(providerMessageId)},
          delivered_at = NOW(),
          updated_at = NOW()
      WHERE id = ${delivery.id}
        AND tenant_id = ${delivery.tenantId}
        AND status = 'running'
        AND lease_owner = ${delivery.leaseOwner}
        AND lease_expires_at > NOW()
      RETURNING id
    `;
    if (!rows[0]) throw new Error("Push delivery lease was lost before completion.");
    await sql`
      UPDATE omni_mobile_push_registrations
      SET last_delivered_at = NOW(), updated_at = NOW()
      WHERE id = ${registration.id}
        AND tenant_id = ${registration.tenantId}
        AND owner_actor_id = ${registration.ownerActorId}
        AND state = 'active'
    `;
  });
}

async function failPushDelivery(
  delivery: MobilePushDelivery,
  error: unknown,
): Promise<"retried" | "failed"> {
  if (!delivery.leaseOwner) throw new Error("Push delivery lease is missing.");
  const providerError = error instanceof MobilePushProviderError
    ? error
    : new MobilePushProviderError(
        error instanceof Error ? error.message : "Push delivery failed.",
        false,
        "delivery_failed",
      );
  const retry = !providerError.permanent && delivery.attempt < delivery.maxAttempts;
  const delaySeconds = [30, 120, 600, 1_800][Math.min(delivery.attempt - 1, 3)];
  const rows = await getSql()`
    UPDATE omni_mobile_push_deliveries
    SET status = ${retry ? "queued" : "failed"},
        run_at = ${retry
          ? new Date(Date.now() + delaySeconds * 1_000).toISOString()
          : delivery.runAt},
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error = ${`${providerError.code}: ${providerError.message}`.slice(0, 500)},
        updated_at = NOW()
    WHERE id = ${delivery.id}
      AND tenant_id = ${delivery.tenantId}
      AND status = 'running'
      AND lease_owner = ${delivery.leaseOwner}
      AND lease_expires_at > NOW()
    RETURNING id
  `;
  if (!rows[0]) throw new Error("Push delivery lease was lost before failure handling.");
  if (invalidTokenCode(providerError.code)) {
    await getSql()`
      UPDATE omni_mobile_push_registrations
      SET state = 'revoked',
          lifecycle_revision = lifecycle_revision + 1,
          revoked_at = NOW(),
          updated_at = NOW()
      WHERE id = ${delivery.registrationId}
        AND tenant_id = ${delivery.tenantId}
        AND owner_actor_id = ${delivery.ownerActorId}
        AND state = 'active'
    `;
  }
  return retry ? "retried" : "failed";
}

async function repairExpiredPushLeases(tenantId: string) {
  await getSql()`
    UPDATE omni_mobile_push_deliveries
    SET status = CASE WHEN attempt < max_attempts THEN 'queued' ELSE 'failed' END,
        run_at = CASE WHEN attempt < max_attempts THEN NOW() ELSE run_at END,
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error = COALESCE(last_error, 'delivery_lease_expired'),
        updated_at = NOW()
    WHERE tenant_id = ${tenantId}
      AND status = 'running'
      AND lease_expires_at <= NOW()
  `;
}

async function appendPushEvent(input: {
  type: string;
  context: SecurityContext;
  idempotencyKey: string;
  causationId: string;
  streamId: string;
  eventKey: string;
  payload: Record<string, unknown>;
  sql: PushSql;
}) {
  const executionScope = createExecutionScope({
    tenantId: input.context.tenantId,
    initiatingActorId: input.context.actorId,
    executingPrincipalType: "user",
    executingPrincipalId: input.context.actorId,
    correlationId: input.idempotencyKey,
    causationId: input.causationId,
    purpose: input.type,
  });
  await appendScopedDomainEvent({
    id: `mobile_push_event_${mobilePushDedupeKey({
      type: input.type,
      eventKey: input.eventKey,
    })}`,
    streamId: input.streamId,
    type: input.type,
    executionScope,
    payload: input.payload,
  }, { sql: input.sql });
}

function exactNativeContext(context: SecurityContext) {
  if (
    context.source !== "mobile" ||
    !context.native ||
    !context.auth?.userId ||
    !context.auth.sessionId
  ) {
    throw new Error("An authenticated native session is required.");
  }
  return {
    deviceId: context.native.deviceId,
    platform: context.native.platform,
    userId: context.auth.userId,
    sessionId: context.auth.sessionId,
  } as const;
}

function publicRegistration(registration: MobilePushRegistration) {
  return {
    id: registration.id,
    deviceId: registration.deviceId,
    platform: registration.platform,
    provider: registration.provider,
    environment: registration.environment,
    previewPolicy: registration.previewPolicy,
    state: registration.state,
    lifecycleRevision: registration.lifecycleRevision,
    lastRegisteredAt: registration.lastRegisteredAt,
    lastDeliveredAt: registration.lastDeliveredAt || null,
    revokedAt: registration.revokedAt || null,
  };
}

function registrationFromRow(row: Record<string, unknown>): MobilePushRegistration {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    ownerActorId: String(row.owner_actor_id),
    userId: String(row.user_id),
    mobileSessionId: String(row.mobile_session_id),
    deviceId: String(row.device_id),
    platform: mobilePushPlatform(row.platform),
    provider: row.provider === "apns" ? "apns" : "fcm",
    environment: row.environment === "sandbox" ? "sandbox" : "production",
    tokenSha256: String(row.token_sha256),
    credentialVersion: Number(row.credential_version),
    tokenBundle: row.token_bundle,
    previewPolicy: previewPolicy(row.preview_policy),
    state: row.state === "revoked" ? "revoked" : "active",
    lifecycleRevision: Number(row.lifecycle_revision),
    lastRegisteredAt: dateValue(row.last_registered_at),
    lastDeliveredAt: optionalDate(row.last_delivered_at),
    revokedAt: optionalDate(row.revoked_at),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
  };
}

function deliveryFromRow(row: Record<string, unknown>): MobilePushDelivery {
  const target = mobilePushTargetSchema.parse(
    row.cause_kind === "work_item"
      ? {
          kind: row.cause_kind,
          id: row.cause_id,
          parentId: row.parent_id || undefined,
        }
      : { kind: row.cause_kind, id: row.cause_id },
  );
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    ownerActorId: String(row.owner_actor_id),
    registrationId: String(row.registration_id),
    notificationId: row.notification_id ? String(row.notification_id) : undefined,
    target,
    deepLink: String(row.deep_link),
    dedupeKey: String(row.dedupe_key),
    payload: row.payload,
    status: String(row.status) as MobilePushDelivery["status"],
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    runAt: dateValue(row.run_at),
    leaseOwner: row.lease_owner ? String(row.lease_owner) : undefined,
    leaseExpiresAt: optionalDate(row.lease_expires_at),
    lastError: row.last_error ? String(row.last_error) : undefined,
    deliveredAt: optionalDate(row.delivered_at),
    acknowledgedAt: optionalDate(row.acknowledged_at),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
  };
}

function pushCredentialBinding(input: {
  tenantId: string;
  actorId: string;
  registrationId: string;
  provider: PushProvider;
  credentialVersion: number;
}) {
  return credentialBinding({
    tenantId: input.tenantId,
    actorId: input.actorId,
    connectionId: input.registrationId,
    provider: `mobile_push_${input.provider}`,
    credentialVersion: input.credentialVersion,
  });
}

function validatePushToken(provider: PushProvider, token: string) {
  const valid = provider === "apns"
    ? /^[a-fA-F0-9]{64,200}$/.test(token)
    : token.length >= 20 && token.length <= 4_096 && /^[A-Za-z0-9_:.-]+$/.test(token);
  if (!valid) throw new Error(`The ${provider.toUpperCase()} registration token is invalid.`);
}

function previewPolicy(value: unknown): MobilePushPreviewPolicy {
  return value === "generic" || value === "title" ? value : "hidden";
}

function mobilePushPlatform(
  value: unknown,
): MobilePushRegistration["platform"] {
  if (value === "android" || value === "ios" || value === "macos") {
    return value;
  }
  throw new Error("Native push registration platform is invalid.");
}

function invalidTokenCode(code: string) {
  return [
    "UNREGISTERED",
    "BadDeviceToken",
    "DeviceTokenNotForTopic",
    "Unregistered",
    "registration_inactive",
  ].includes(code);
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requirePushStorage() {
  if (!hasDatabaseUrl()) throw new MobilePushStorageRequiredError();
}

function optionalDate(value: unknown) {
  return value ? dateValue(value) : undefined;
}

function dateValue(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}
