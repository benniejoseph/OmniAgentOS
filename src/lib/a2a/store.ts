import { createHash } from "node:crypto";

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import {
  credentialBinding,
  openCredentialBundle,
  sealCredentialBundle,
  type SealedCredentialPayload,
} from "@/lib/settings/credential-vault";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  buildA2APeerRolloutV1,
  parseA2APeerRolloutV1,
  transitionA2APeerRolloutV1,
  type A2APeerRolloutV1,
} from "@/lib/a2a/rollout";
import {
  externalA2AAgentCardV1Schema,
  type ExternalA2AAgentCardV1,
} from "@/lib/a2a/v1-contracts";

type A2ASql = ReturnType<typeof getSql>;

export class A2APeerStoreError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 503 = 400,
  ) {
    super(message);
    this.name = "A2APeerStoreError";
  }
}

export async function registerA2APeer(input: {
  tenantId: string;
  ownerActorId: string;
  peerId: string;
  direction: A2APeerRolloutV1["direction"];
  mode: A2APeerRolloutV1["mode"];
  card: ExternalA2AAgentCardV1;
  interfaceUrl: string;
  inboundServiceApiKeyId?: string;
  outboundBearerToken?: string;
  allowedSkillIds: readonly string[];
  allowedInboundAgentIds?: A2APeerRolloutV1["allowedInboundAgentIds"];
  maxTaskDurationMs?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  executionScope: ExecutionScope;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertOwnerScope(input.executionScope, input.tenantId, input.ownerActorId);
  const card = externalA2AAgentCardV1Schema.parse(input.card);
  const selectedInterface = card.supportedInterfaces.find(
    (candidate) => candidate.url === normalizeInterfaceUrl(input.interfaceUrl),
  );
  if (!selectedInterface) {
    throw new A2APeerStoreError(
      "The selected A2A interface is not present in the reviewed Agent Card.",
    );
  }
  const knownSkills = new Set(card.skills.map((skill) => skill.id));
  if (
    !input.allowedSkillIds.length ||
    input.allowedSkillIds.some((skillId) => !knownSkills.has(skillId))
  ) {
    throw new A2APeerStoreError(
      "Every allowed A2A skill must exist in the reviewed Agent Card.",
    );
  }
  const needsInbound = input.direction !== "outbound";
  const needsOutbound = input.direction !== "inbound";
  if (needsInbound && !input.inboundServiceApiKeyId?.trim()) {
    throw new A2APeerStoreError("Inbound A2A peers require a service API key binding.");
  }
  const outboundBearerToken = input.outboundBearerToken?.trim();
  if (needsOutbound && !validBearerToken(outboundBearerToken)) {
    throw new A2APeerStoreError("Outbound A2A peers require a valid Bearer token.");
  }

  return getSql().transaction(async (sql: A2ASql) => {
    const current = await sql`
      SELECT generation, status
      FROM omni_a2a_peer_rollouts
      WHERE tenant_id = ${input.tenantId}
        AND owner_actor_id = ${input.ownerActorId}
        AND peer_id = ${input.peerId}
      ORDER BY generation DESC
      LIMIT 1 FOR UPDATE
    `;
    if (current[0] && String(current[0].status) !== "revoked") {
      throw new A2APeerStoreError(
        "Revoke the current A2A peer rollout before registering a new generation.",
        409,
      );
    }
    if (needsInbound) {
      const keyRows = await sql`
        SELECT id, scopes, status, expires_at
        FROM omni_service_api_keys
        WHERE id = ${input.inboundServiceApiKeyId!}
          AND tenant_id = ${input.tenantId}
          AND actor_id = ${input.ownerActorId}
        LIMIT 1
      `;
      const key = keyRows[0];
      const scopes = Array.isArray(key?.scopes) ? key.scopes.map(String) : [];
      if (
        !key ||
        key.status !== "active" ||
        (key.expires_at && Date.parse(String(key.expires_at)) <= Date.now()) ||
        !scopes.includes("a2a:discover") ||
        !scopes.includes("a2a:tasks:read") ||
        !scopes.includes("a2a:tasks:write")
      ) {
        throw new A2APeerStoreError(
          "The inbound service API key must be active and grant all A2A scopes.",
          403,
        );
      }
    }
    const generation = current[0] ? Number(current[0].generation) + 1 : 1;
    const now = new Date().toISOString();
    const rollout = buildA2APeerRolloutV1({
      tenantId: input.tenantId,
      ownerActorId: input.ownerActorId,
      peerId: input.peerId,
      generation,
      direction: input.direction,
      mode: input.mode,
      interfaceUrl: selectedInterface.url,
      agentCardSha256: canonicalJsonSha256(card),
      inboundServiceApiKeyId: input.inboundServiceApiKeyId || null,
      outboundCredentialConfigured: Boolean(outboundBearerToken),
      allowedSkillIds: input.allowedSkillIds,
      allowedInboundAgentIds: input.allowedInboundAgentIds,
      maxTaskDurationMs: input.maxTaskDurationMs,
      maxInputBytes: input.maxInputBytes,
      maxOutputBytes: input.maxOutputBytes,
      createdAt: now,
    });
    const credentialVersion = outboundBearerToken ? 1 : null;
    const credentialOrigin = outboundBearerToken
      ? new URL(rollout.interfaceUrl).origin
      : null;
    const sealedCredential = outboundBearerToken
      ? sealCredentialBundle(
          { bearerToken: outboundBearerToken },
          rolloutCredentialBinding(rollout, credentialVersion!),
        )
      : null;
    const credentialFingerprint = outboundBearerToken
      ? createHash("sha256").update(outboundBearerToken).digest("hex")
      : null;
    await sql`
      INSERT INTO omni_a2a_peer_rollouts (
        schema_version, tenant_id, owner_actor_id, peer_id, generation,
        rollout_id, rollout_sha256, direction, mode, status, lifecycle_revision,
        interface_url, interface_origin, agent_card_sha256, protocol_version,
        protocol_binding, adapter_release, adapter_artifact_sha256,
        inbound_service_api_key_id, outbound_credential_configured,
        credential_version, credential_origin, credential_fingerprint,
        sealed_credential, allowed_skill_ids, allowed_inbound_agent_ids,
        max_task_duration_ms,
        max_input_bytes, max_output_bytes, rollout, created_at, updated_at
      ) VALUES (
        1, ${rollout.tenantId}, ${rollout.ownerActorId}, ${rollout.peerId},
        ${rollout.generation}, ${rollout.rolloutId}, ${rollout.rolloutSha256},
        ${rollout.direction}, ${rollout.mode}, ${rollout.status},
        ${rollout.lifecycleRevision}, ${rollout.interfaceUrl},
        ${new URL(rollout.interfaceUrl).origin}, ${rollout.agentCardSha256},
        ${rollout.protocolVersion}, ${rollout.protocolBinding},
        ${rollout.adapterRelease}, ${rollout.adapterArtifactSha256},
        ${rollout.inboundServiceApiKeyId},
        ${rollout.outboundCredentialConfigured}, ${credentialVersion},
        ${credentialOrigin}, ${credentialFingerprint},
        ${sealedCredential}::jsonb, ${rollout.allowedSkillIds},
        ${rollout.allowedInboundAgentIds},
        ${rollout.maxTaskDurationMs}, ${rollout.maxInputBytes},
        ${rollout.maxOutputBytes}, ${rollout}::jsonb,
        ${rollout.createdAt}, ${rollout.updatedAt}
      )
    `;
    await appendRolloutEvent(sql, rollout, "a2a.peer.registered", input.executionScope);
    return rollout;
  }) as Promise<A2APeerRolloutV1>;
}

export async function transitionA2APeer(input: {
  tenantId: string;
  ownerActorId: string;
  rolloutId: string;
  expectedRevision: number;
  to: "active" | "paused" | "revoked";
  executionScope: ExecutionScope;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertOwnerScope(input.executionScope, input.tenantId, input.ownerActorId);
  return getSql().transaction(async (sql: A2ASql) => {
    const current = await readRollout(sql, input);
    if (current.lifecycleRevision !== input.expectedRevision) {
      throw new A2APeerStoreError("The A2A peer rollout changed. Refresh and retry.", 409);
    }
    const next = transitionA2APeerRolloutV1({ rollout: current, to: input.to });
    const rows = await sql`
      UPDATE omni_a2a_peer_rollouts
      SET status = ${next.status},
          lifecycle_revision = ${next.lifecycleRevision},
          rollout_sha256 = ${next.rolloutSha256},
          rollout = ${next}::jsonb,
          updated_at = ${next.updatedAt}
      WHERE tenant_id = ${input.tenantId}
        AND owner_actor_id = ${input.ownerActorId}
        AND rollout_id = ${input.rolloutId}
        AND lifecycle_revision = ${input.expectedRevision}
      RETURNING rollout
    `;
    if (rows.length !== 1) {
      throw new A2APeerStoreError("The A2A peer rollout changed. Refresh and retry.", 409);
    }
    const saved = parseA2APeerRolloutV1(rows[0].rollout);
    await appendRolloutEvent(sql, saved, `a2a.peer.${input.to}`, input.executionScope);
    return saved;
  }) as Promise<A2APeerRolloutV1>;
}

export async function listA2APeers(input: {
  tenantId: string;
  ownerActorId: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT rollout
    FROM omni_a2a_peer_rollouts
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.ownerActorId}
    ORDER BY peer_id, generation DESC
    LIMIT 200
  `;
  return rows.map((row) => parseA2APeerRolloutV1(row.rollout));
}

export async function getA2APeer(input: {
  tenantId: string;
  ownerActorId: string;
  rolloutId: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  return readRollout(getSql(), input);
}

export async function getActiveInboundA2APeer(input: {
  tenantId: string;
  ownerActorId: string;
  serviceApiKeyId: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT rollout
    FROM omni_a2a_peer_rollouts
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.ownerActorId}
      AND inbound_service_api_key_id = ${input.serviceApiKeyId}
      AND status = 'active'
      AND mode = 'enabled'
      AND direction IN ('inbound', 'bidirectional')
    ORDER BY generation DESC
    LIMIT 2
  `;
  if (rows.length !== 1) {
    throw new A2APeerStoreError("No unique active A2A peer is bound to this service identity.", 403);
  }
  return parseA2APeerRolloutV1(rows[0].rollout);
}

export async function resolveA2APeerBearerToken(input: {
  tenantId: string;
  ownerActorId: string;
  rolloutId: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT rollout, credential_version, credential_origin, sealed_credential
    FROM omni_a2a_peer_rollouts
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.ownerActorId}
      AND rollout_id = ${input.rolloutId}
      AND status = 'active'
      AND mode = 'enabled'
      AND direction IN ('outbound', 'bidirectional')
    LIMIT 1
  `;
  if (rows.length !== 1) throw new A2APeerStoreError("The outbound A2A peer is unavailable.", 404);
  const rollout = parseA2APeerRolloutV1(rows[0].rollout);
  const credentialVersion = Number(rows[0].credential_version);
  if (
    !Number.isInteger(credentialVersion) ||
    credentialVersion < 1 ||
    String(rows[0].credential_origin) !== new URL(rollout.interfaceUrl).origin
  ) {
    throw new A2APeerStoreError("The outbound A2A credential binding is invalid.", 409);
  }
  const credentials = openCredentialBundle(
    rows[0].sealed_credential,
    rolloutCredentialBinding(rollout, credentialVersion),
  );
  if (!validBearerToken(credentials.bearerToken)) {
    throw new A2APeerStoreError("The outbound A2A credential is invalid.", 409);
  }
  return credentials.bearerToken;
}

async function readRollout(
  sql: A2ASql,
  input: { tenantId: string; ownerActorId: string; rolloutId: string },
) {
  const rows = await sql`
    SELECT rollout
    FROM omni_a2a_peer_rollouts
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.ownerActorId}
      AND rollout_id = ${input.rolloutId}
    LIMIT 1 FOR UPDATE
  `;
  if (rows.length !== 1) throw new A2APeerStoreError("A2A peer rollout not found.", 404);
  return parseA2APeerRolloutV1(rows[0].rollout);
}

function appendRolloutEvent(
  sql: A2ASql,
  rollout: A2APeerRolloutV1,
  type: string,
  executionScope: ExecutionScope,
) {
  return appendScopedDomainEvent({
    id: `${type}:${rollout.rolloutSha256}`,
    streamId: `a2a-peer:${rollout.peerId}`,
    type,
    payload: {
      version: rollout.version,
      rolloutId: rollout.rolloutId,
      rolloutSha256: rollout.rolloutSha256,
      peerId: rollout.peerId,
      generation: rollout.generation,
      direction: rollout.direction,
      mode: rollout.mode,
      status: rollout.status,
      lifecycleRevision: rollout.lifecycleRevision,
      interfaceOriginSha256: canonicalJsonSha256({
        origin: new URL(rollout.interfaceUrl).origin,
      }),
      agentCardSha256: rollout.agentCardSha256,
      adapterRelease: rollout.adapterRelease,
      adapterArtifactSha256: rollout.adapterArtifactSha256,
    },
    executionScope,
  }, { sql });
}

function rolloutCredentialBinding(
  rollout: A2APeerRolloutV1,
  credentialVersion: number,
) {
  return credentialBinding({
    tenantId: rollout.tenantId,
    actorId: rollout.ownerActorId,
    connectionId: rollout.rolloutId,
    provider: `a2a:${new URL(rollout.interfaceUrl).origin}`,
    credentialVersion,
  });
}

function assertOwnerScope(
  scope: ExecutionScope,
  tenantId: string,
  ownerActorId: string,
) {
  if (
    scope.tenantId !== tenantId ||
    scope.initiatingActorId !== ownerActorId ||
    scope.executingPrincipalId !== ownerActorId
  ) {
    throw new A2APeerStoreError("The A2A peer operation is outside the owner scope.", 403);
  }
}

function normalizeInterfaceUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

function validBearerToken(value?: string) {
  return Boolean(value && value.length <= 8_192 && !/[\r\n\s]/.test(value));
}

function requireDatabase() {
  if (!hasDatabaseUrl()) {
    throw new A2APeerStoreError("A2A peer rollouts require the canonical database authority.", 503);
  }
}

export function a2aPeerCredentialDigestForTest(
  payload: SealedCredentialPayload,
) {
  return canonicalJsonSha256(payload);
}
