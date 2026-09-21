import "server-only";

import { createHash, randomBytes } from "node:crypto";

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
  runWithDatabaseSystemScope,
} from "@/lib/db/client";
import {
  MOLTBOOK_API_ORIGIN,
  MOLTBOOK_DISCLOSURE_VERSION,
  MOLTBOOK_HEARTBEAT_INTERVAL_MS,
  isExactMoltbookAgentCapabilityBoundary,
  MOLTBOOK_TOOL_IDS,
  moltbookConnectionStatusSchema,
  type MoltbookActivityProjection,
  type MoltbookConnectionProjection,
  type MoltbookConnectionStatus,
  type MoltbookRateLimitProjection,
  type MoltbookToolId,
} from "@/lib/moltbook/contracts";
import {
  createMoltbookClient,
  isOpaqueMoltbookApiKey,
  MoltbookProviderError,
  registerMoltbookAgent,
} from "@/lib/moltbook/http-client";
import {
  moltbookConnectionIdentityPinsEqual,
  type MoltbookConnectionIdentityPin,
} from "@/lib/moltbook/identity-boundary";
import {
  credentialBinding,
  credentialVaultStatus,
  openCredentialBundle,
  sealCredentialBundle,
} from "@/lib/settings/credential-vault";

type Sql = ReturnType<typeof getSql>;
type SqlRow = Record<string, unknown>;
type FetchLike = typeof fetch;

const PROVIDER = "moltbook";
const CREDENTIAL_VERSION = 1;
const MAX_ACTIVITY_LIMIT = 100;

export type MoltbookOwner = Readonly<{
  tenantId: string;
  actorId: string;
}>;

export type MoltbookPrincipalAuthority = Readonly<{
  owner: MoltbookOwner;
  logicalAgentId: string;
  principalId: string;
  principalGeneration: number;
}>;

export class MoltbookConnectionError extends Error {
  readonly status: 400 | 404 | 409 | 503;
  readonly code: string;

  constructor(
    message: string,
    options: {
      status?: 400 | 404 | 409 | 503;
      code?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "MoltbookConnectionError";
    this.status = options.status || 409;
    this.code = options.code || "moltbook_connection_error";
  }
}

export type MoltbookConnectionAccess = Readonly<{
  connectionId: string;
  tenantId: string;
  ownerActorId: string;
  agentId: string;
  externalName: string;
  apiKey: string;
}>;

export type MoltbookEffectStatus =
  | "succeeded"
  | "failed"
  | "uncertain"
  | "pending_verification"
  | "published";

export type MoltbookEffectEvidence = Readonly<{
  status: MoltbookEffectStatus;
  toolId: MoltbookToolId;
  toolExecutionId: string;
  toolInputSha256: string;
  effectTargetId: string;
  requestSha256: string;
  responseSha256?: string;
  providerObject?: Readonly<{ type: string; ref: string; url?: string }>;
  errorCode?: string;
}>;

export async function resolveMoltbookAgentOwner(input: {
  tenantId: string;
  agentId: string;
  readableOwnerActorIds: readonly string[];
}): Promise<MoltbookOwner> {
  requireDatabase();
  await ensureDatabaseSchema();
  const readableOwnerActorIds = [...new Set(
    input.readableOwnerActorIds.map((actorId) => actorId.trim()),
  )].filter(Boolean);
  if (
    !readableOwnerActorIds.length ||
    readableOwnerActorIds.length > 8 ||
    readableOwnerActorIds.some((actorId) =>
      actorId.length > 320 || actorId.includes("\0")
    )
  ) {
    throw unresolvedAgentOwner();
  }
  const rows = await runWithDatabaseActorScope(
    input.tenantId,
    readableOwnerActorIds,
    () => getSql()`
      SELECT actor_id
      FROM omni_custom_agents
      WHERE tenant_id = ${input.tenantId}
        AND id = ${input.agentId}
        AND actor_id = ANY(${readableOwnerActorIds}::text[])
      LIMIT 2
    `,
  );
  if (rows.length !== 1) throw unresolvedAgentOwner();
  const actorId = String(rows[0].actor_id || "");
  if (!readableOwnerActorIds.includes(actorId)) throw unresolvedAgentOwner();
  return { tenantId: input.tenantId, actorId };
}

/** Resolves an immutable execution principal to its logical Agent and physical owner. */
export async function resolveMoltbookPrincipalAuthority(input: {
  tenantId: string;
  principalId: string;
  principalGeneration: number;
  authUserId: string;
  canonicalActorId: string;
  readableOwnerActorIds: readonly string[];
}): Promise<MoltbookPrincipalAuthority> {
  requireDatabase();
  await ensureDatabaseSchema();
  const readableOwnerActorIds = [...new Set(
    input.readableOwnerActorIds.map((actorId) => actorId.trim()),
  )].filter(Boolean);
  if (
    !input.principalId.trim() ||
    input.principalId.length > 240 ||
    !Number.isSafeInteger(input.principalGeneration) ||
    input.principalGeneration < 1 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      input.authUserId,
    ) ||
    input.canonicalActorId !== `actor:${input.authUserId}` ||
    !readableOwnerActorIds.length ||
    readableOwnerActorIds.length > 8 ||
    readableOwnerActorIds.some((actorId) =>
      actorId.length > 320 || actorId.includes("\0")
    )
  ) {
    throw unresolvedAgentOwner();
  }
  const rows = await runWithDatabaseActorScope(
    input.tenantId,
    readableOwnerActorIds,
    () => getSql()`
      SELECT principal.principal_id, principal.principal_generation,
             principal.controller_actor_id,
             principal.agent_definition_id, agent.actor_id
      FROM omni_tenant_execution_principals principal
      JOIN omni_agent_principal_policies policy
        ON policy.tenant_id = principal.tenant_id
        AND policy.principal_id = principal.principal_id
        AND policy.principal_generation = principal.principal_generation
      JOIN omni_custom_agents agent
        ON agent.tenant_id = principal.tenant_id
        AND agent.id = principal.agent_definition_id
        AND agent.actor_id = ANY(${readableOwnerActorIds}::text[])
      JOIN omni_auth_users auth_user
        ON auth_user.actor_id = principal.controller_actor_id
        AND auth_user.id::text = ${input.authUserId}
        AND auth_user.status = 'active'
      JOIN omni_auth_memberships membership
        ON membership.user_id = auth_user.id
        AND membership.tenant_id = principal.tenant_id
        AND membership.status = 'active'
      WHERE principal.tenant_id = ${input.tenantId}
        AND principal.principal_id = ${input.principalId}
        AND principal.principal_generation = ${input.principalGeneration}
        AND principal.controller_actor_id = ${input.canonicalActorId}
        AND principal.principal_kind = 'agent'
        AND principal.state = 'active'
        AND public.omni_actor_scope_v1_allows_canonical(
          principal.tenant_id,
          principal.controller_actor_id
        )
        AND cardinality(policy.context_grant_ids) = 0
        AND cardinality(policy.capability_grant_ids) = 0
      LIMIT 2
    `,
  );
  if (rows.length !== 1) throw unresolvedAgentOwner();
  const ownerActorId = String(rows[0].actor_id || "");
  const logicalAgentId = String(rows[0].agent_definition_id || "");
  const principalGeneration = Number(rows[0].principal_generation);
  if (
    String(rows[0].principal_id || "") !== input.principalId ||
    principalGeneration !== input.principalGeneration ||
    String(rows[0].controller_actor_id || "") !== input.canonicalActorId ||
    !readableOwnerActorIds.includes(ownerActorId) ||
    !logicalAgentId ||
    !Number.isSafeInteger(principalGeneration) ||
    principalGeneration < 1
  ) {
    throw unresolvedAgentOwner();
  }
  return Object.freeze({
    owner: { tenantId: input.tenantId, actorId: ownerActorId },
    logicalAgentId,
    principalId: input.principalId,
    principalGeneration,
  });
}

export async function assertMoltbookAgentMayBeDeleted(input: {
  owner: MoltbookOwner;
  agentId: string;
}) {
  // File-backed development Agents cannot have a durable Moltbook connection.
  if (!hasDatabaseUrl()) return;
  await ensureDatabaseSchema();
  const rows = await runWithDatabaseActorScope(
    input.owner.tenantId,
    [input.owner.actorId],
    () => getSql()`
      SELECT id
      FROM omni_moltbook_connections
      WHERE tenant_id = ${input.owner.tenantId}
        AND owner_actor_id = ${input.owner.actorId}
        AND agent_id = ${input.agentId}
      LIMIT 2
    `,
  );
  if (rows.length > 0) {
    throw new MoltbookConnectionError(
      "This Agent retains a private Moltbook connection and append-only activity history, so it cannot be moved to Trash.",
      { status: 409, code: "linked_agent_trash_blocked" },
    );
  }
}

export async function listMoltbookConnection(input: {
  owner: MoltbookOwner;
  agentId: string;
  limit?: number;
  cursor?: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(
    input.owner.tenantId,
    [input.owner.actorId],
    async () => {
      const sql = getSql();
      await assertOwnedAgent(sql, input.owner, input.agentId);
      const rows = await sql`
        SELECT * FROM omni_moltbook_connections
        WHERE tenant_id = ${input.owner.tenantId}
          AND owner_actor_id = ${input.owner.actorId}
          AND agent_id = ${input.agentId}
        LIMIT 2
      `;
      if (rows.length > 1) {
        throw new MoltbookConnectionError(
          "Moltbook connection ownership is ambiguous.",
          { code: "connection_ambiguous" },
        );
      }
      const connection = rows[0]
        ? projectConnection(rows[0], { includeClaim: true })
        : null;
      const activities = rows[0]
        ? await listActivities(sql, {
            owner: input.owner,
            agentId: input.agentId,
            limit: input.limit,
            cursor: input.cursor,
          })
        : { activities: [], nextCursor: null };
      return { connection, ...activities };
    },
  );
}

export async function registerMoltbookConnection(input: {
  owner: MoltbookOwner;
  agentId: string;
  identityPin: MoltbookConnectionIdentityPin;
  externalName: string;
  description: string;
  heartbeatEnabled?: boolean;
  disclosureAccepted: true;
  disclosureVersion: typeof MOLTBOOK_DISCLOSURE_VERSION;
  fetchImpl?: FetchLike;
  abortSignal?: AbortSignal;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  if (!credentialVaultStatus().configured) {
    throw new MoltbookConnectionError(
      "The credential vault must be configured before joining Moltbook.",
      { status: 503, code: "credential_vault_unavailable" },
    );
  }
  const connectionId = connectionIdFor(input.owner, input.agentId);
  const now = new Date().toISOString();
  const registrationRequestSha256 = registrationRequestDigest(input);
  await runWithDatabaseActorScope(
    input.owner.tenantId,
    [input.owner.actorId],
    () => getSql().transaction(async (sql: Sql) => {
      await assertOwnedAgent(sql, input.owner, input.agentId, {
        requireActive: true,
        requireMoltbookBoundary: true,
      });
      assertRegistrationIdentityPin(input.agentId, input.identityPin);
      const existing = await sql`
        SELECT id FROM omni_moltbook_connections
        WHERE tenant_id = ${input.owner.tenantId}
          AND owner_actor_id = ${input.owner.actorId}
          AND agent_id = ${input.agentId}
        LIMIT 1
      `;
      if (existing[0]) {
        throw new MoltbookConnectionError(
          "This Agent already has a Moltbook connection or registration attempt.",
          { code: "connection_exists" },
        );
      }
      await sql`
        INSERT INTO omni_moltbook_connections (
          id, tenant_id, owner_actor_id, agent_id, external_name,
          principal_id, principal_generation, principal_sha256,
          definition_version, definition_sha256, policy_boundary_sha256,
          description, status, claim_state, heartbeat_enabled,
          disclosure_version, disclosure_accepted_at,
          registration_request_sha256,
          credential_version, sealed_credentials, next_heartbeat_at,
          consecutive_failures, rate_limit_projection, created_at, updated_at
        ) VALUES (
          ${connectionId}, ${input.owner.tenantId}, ${input.owner.actorId},
          ${input.agentId}, ${input.externalName},
          ${input.identityPin.principalId},
          ${input.identityPin.principalGeneration},
          ${input.identityPin.principalSha256},
          ${input.identityPin.definitionVersion},
          ${input.identityPin.definitionSha256},
          ${input.identityPin.policyBoundarySha256},
          ${input.description},
          'registering', 'unavailable', ${input.heartbeatEnabled !== false},
          ${input.disclosureVersion}, ${now}, ${registrationRequestSha256},
          ${CREDENTIAL_VERSION}, NULL, NULL, 0, NULL, ${now}, ${now}
        )
      `;
    }),
  );

  return completeMoltbookRegistration({ ...input, connectionId });
}

async function completeMoltbookRegistration(input: {
  owner: MoltbookOwner;
  agentId: string;
  connectionId: string;
  externalName: string;
  description: string;
  fetchImpl?: FetchLike;
  abortSignal?: AbortSignal;
}) {
  let providerResult: Awaited<ReturnType<typeof registerMoltbookAgent>>;
  try {
    // Registration is intentionally called once. Ambiguous failures are not retried.
    providerResult = await registerMoltbookAgent({
      name: input.externalName,
      description: input.description,
    }, {
      fetchImpl: input.fetchImpl,
      abortSignal: input.abortSignal,
    });
    const sealed = sealCredentialBundle({
      apiKey: providerResult.data.apiKey,
      claimUrl: providerResult.data.claimUrl,
      verificationCode: providerResult.data.verificationCode,
    }, moltbookCredentialBinding({
      connectionId: input.connectionId,
      owner: input.owner,
    }));
    const saved = await runWithDatabaseActorScope(
      input.owner.tenantId,
      [input.owner.actorId],
      () => getSql().transaction(async (sql: Sql) => {
        const updated = await sql`
          UPDATE omni_moltbook_connections SET
            status = 'pending_claim', claim_state = 'pending',
            sealed_credentials = ${sealed}::jsonb,
            credential_key_id = ${sealed.keyId},
            rate_limit_projection = ${providerResult.rateLimit || null}::jsonb,
            next_heartbeat_at = ${nextHeartbeatAt(new Date().toISOString())},
            last_error_code = NULL, updated_at = ${new Date().toISOString()}
          WHERE id = ${input.connectionId}
            AND tenant_id = ${input.owner.tenantId}
            AND owner_actor_id = ${input.owner.actorId}
            AND agent_id = ${input.agentId}
            AND status = 'registering'
          RETURNING *
        `;
        if (!updated[0]) {
          throw new MoltbookConnectionError(
            "The Moltbook registration state changed before it could be saved.",
            { code: "registration_state_conflict" },
          );
        }
        await appendActivity(sql, {
          owner: input.owner,
          agentId: input.agentId,
          connectionId: input.connectionId,
          kind: "registration",
          status: "succeeded",
          summary: "Moltbook registration created; human claim is pending.",
          requestSha256: providerResult.requestSha256,
          responseSha256: providerResult.responseSha256,
        });
        return updated[0];
      }),
    ) as SqlRow;
    const connection = projectConnection(saved, { includeClaim: true });
    if (!connection.claimUrl || !connection.verificationCode) {
      throw new MoltbookConnectionError(
        "The sealed Moltbook claim details could not be projected.",
        { code: "claim_projection_unavailable" },
      );
    }
    return {
      connection,
      claim: {
        url: connection.claimUrl,
        verificationCode: connection.verificationCode,
      },
    };
  } catch (error) {
    await recordRegistrationFailure({
      owner: input.owner,
      agentId: input.agentId,
      connectionId: input.connectionId,
      error,
    }).catch(() => undefined);
    throw normalizeConnectionError(error, "Moltbook registration did not complete.");
  }
}

export async function refreshMoltbookConnection(input: {
  owner: MoltbookOwner;
  agentId: string;
  fetchImpl?: FetchLike;
  abortSignal?: AbortSignal;
}) {
  return observeMoltbookConnection(input);
}

export async function pauseMoltbookConnection(input: {
  owner: MoltbookOwner;
  agentId: string;
}) {
  return transitionConnectionLocally(input, "pause");
}

export async function resumeMoltbookConnection(input: {
  owner: MoltbookOwner;
  agentId: string;
}) {
  return transitionConnectionLocally(input, "resume");
}

export async function resolveMoltbookConnectionForTool(input: {
  tenantId: string;
  ownerActorId: string;
  executingAgentId: string;
  identityPin: MoltbookConnectionIdentityPin;
}): Promise<MoltbookConnectionAccess> {
  requireDatabase();
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(
    input.tenantId,
    [input.ownerActorId],
    async () => {
      const row = await exactMoltbookConnectionRow(getSql(), input);
      const credentials = openMoltbookCredentials(row);
      return { ...publicConnectionAccess(row), apiKey: credentials.apiKey };
    },
  );
}

/**
 * Resolves the exact linked connection without opening its credential. Receipt
 * reconciliation is deliberately credential-free so it cannot call Moltbook.
 */
export async function resolveMoltbookConnectionForReceipt(input: {
  tenantId: string;
  ownerActorId: string;
  executingAgentId: string;
  identityPin: MoltbookConnectionIdentityPin;
}): Promise<Omit<MoltbookConnectionAccess, "apiKey">> {
  requireDatabase();
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(
    input.tenantId,
    [input.ownerActorId],
    async () => publicConnectionAccess(
      await exactMoltbookConnectionRow(getSql(), input),
    ),
  );
}

export async function appendMoltbookToolActivity(input: {
  access: Omit<MoltbookConnectionAccess, "apiKey">;
  kind: string;
  status: MoltbookEffectStatus;
  summary: string;
  providerObjectType?: string;
  providerObjectRef?: string;
  providerObjectUrl?: string;
  toolExecutionId: string;
  agentRunId?: string;
  requestSha256?: string;
  responseSha256?: string;
  errorCode?: string;
  effect?: boolean;
  toolId?: MoltbookToolId;
  toolInputSha256?: string;
  effectTargetId?: string;
}) {
  return runWithDatabaseActorScope(
    input.access.tenantId,
    [input.access.ownerActorId],
    () => getSql().transaction(async (sql: Sql) => {
      await appendActivity(sql, {
        owner: {
          tenantId: input.access.tenantId,
          actorId: input.access.ownerActorId,
        },
        agentId: input.access.agentId,
        connectionId: input.access.connectionId,
        kind: input.kind,
        status: input.status,
        summary: input.summary,
        providerObjectType: input.providerObjectType,
        providerObjectRef: input.providerObjectRef,
        providerObjectUrl: input.providerObjectUrl,
        toolExecutionId: input.toolExecutionId,
        agentRunId: input.agentRunId,
        requestSha256: input.requestSha256,
        responseSha256: input.responseSha256,
        errorCode: input.errorCode,
      });
      if (input.effect) {
        await appendEffectReceipt(sql, input);
      }
    }),
  );
}

export async function readMoltbookEffectEvidence(input: {
  access: Omit<MoltbookConnectionAccess, "apiKey">;
  toolId: MoltbookToolId;
  toolExecutionId: string;
  toolInputSha256: string;
  effectTargetId: string;
  requestSha256: string;
}): Promise<MoltbookEffectEvidence | undefined> {
  requireDatabase();
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(
    input.access.tenantId,
    [input.access.ownerActorId],
    async () => {
      const rows = await getSql()`
        SELECT connection_id, effect_status, tool_id, tool_execution_id,
          tool_input_sha256, effect_target_id, request_sha256,
          response_sha256, provider_object_type, provider_object_ref,
          error_code
        FROM omni_moltbook_effect_receipts
        WHERE tenant_id = ${input.access.tenantId}
          AND owner_actor_id = ${input.access.ownerActorId}
          AND agent_id = ${input.access.agentId}
          AND tool_execution_id = ${input.toolExecutionId}
        LIMIT 2
      `;
      if (rows.length > 1) {
        throw new MoltbookConnectionError(
          "Moltbook effect evidence is ambiguous for this execution.",
          { code: "effect_receipt_ambiguous" },
        );
      }
      const row = rows[0];
      if (!row) return undefined;
      const status = String(row.effect_status) as MoltbookEffectStatus;
      const responseSha256 = optionalDigest(row.response_sha256);
      const errorCode = optionalSafeToken(row.error_code) || undefined;
      if (
        !["succeeded", "failed", "uncertain", "pending_verification", "published"].includes(status) ||
        String(row.connection_id) !== input.access.connectionId ||
        String(row.tool_id) !== input.toolId ||
        String(row.tool_execution_id) !== input.toolExecutionId ||
        String(row.tool_input_sha256) !== input.toolInputSha256 ||
        String(row.effect_target_id) !== input.effectTargetId ||
        String(row.request_sha256) !== input.requestSha256 ||
        (["succeeded", "pending_verification", "published"].includes(status) && !responseSha256) ||
        (["failed", "uncertain"].includes(status) !== Boolean(errorCode))
      ) {
        throw new MoltbookConnectionError(
          "Moltbook effect evidence failed its exact execution binding.",
          { code: "effect_receipt_invalid" },
        );
      }
      const providerType = optionalSafeToken(row.provider_object_type);
      const providerRef = optionalProviderRef(row.provider_object_ref);
      const providerObject = providerType && providerRef
        ? {
            type: providerType,
            ref: providerRef,
            ...(providerType === "post"
              ? { url: `${MOLTBOOK_API_ORIGIN}/post/${encodeURIComponent(providerRef)}` }
              : {}),
          }
        : undefined;
      return {
        status,
        toolId: input.toolId,
        toolExecutionId: input.toolExecutionId,
        toolInputSha256: input.toolInputSha256,
        effectTargetId: input.effectTargetId,
        requestSha256: input.requestSha256,
        ...(responseSha256 ? { responseSha256 } : {}),
        ...(providerObject ? { providerObject } : {}),
        ...(errorCode ? { errorCode } : {}),
      };
    },
  );
}

export async function observeMoltbookRateLimit(input: {
  access: Omit<MoltbookConnectionAccess, "apiKey">;
  rateLimit?: MoltbookRateLimitProjection;
}) {
  if (!input.rateLimit) return;
  await runWithDatabaseActorScope(
    input.access.tenantId,
    [input.access.ownerActorId],
    () => getSql()`
      UPDATE omni_moltbook_connections SET
        rate_limit_projection = ${input.rateLimit}::jsonb,
        updated_at = ${new Date().toISOString()}
      WHERE id = ${input.access.connectionId}
        AND tenant_id = ${input.access.tenantId}
        AND owner_actor_id = ${input.access.ownerActorId}
        AND agent_id = ${input.access.agentId}
    `,
  );
}

export async function processDueMoltbookHeartbeats(options: {
  tenantId: string;
  limit?: number;
  now?: Date;
  abortSignal?: AbortSignal;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  const now = options.now || new Date();
  const limit = Math.min(Math.max(Math.trunc(options.limit || 2), 1), 10);
  const candidates = await runWithDatabaseSystemScope(
    `Claim due read-only Moltbook heartbeats for tenant ${options.tenantId}.`,
    () => getSql().transaction(async (sql: Sql) => {
      const nextAt = new Date(
        now.getTime() + MOLTBOOK_HEARTBEAT_INTERVAL_MS,
      ).toISOString();
      return sql`
        WITH due AS (
          SELECT connection.id
          FROM omni_moltbook_connections connection
          JOIN omni_custom_agents agent
            ON agent.tenant_id = connection.tenant_id
           AND agent.actor_id = connection.owner_actor_id
           AND agent.id = connection.agent_id
          WHERE connection.tenant_id = ${options.tenantId}
            AND connection.heartbeat_enabled = TRUE
            AND connection.status IN ('pending_claim', 'claimed')
            AND connection.claim_state IN ('pending', 'claimed')
            AND connection.next_heartbeat_at <= ${now.toISOString()}
            AND agent.status <> 'paused'
          ORDER BY connection.next_heartbeat_at, connection.id
          FOR UPDATE OF connection SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE omni_moltbook_connections connection SET
          next_heartbeat_at = ${nextAt},
          updated_at = ${now.toISOString()}
        FROM due
        WHERE connection.id = due.id
        RETURNING connection.tenant_id, connection.owner_actor_id,
          connection.agent_id, connection.status, connection.claim_state
      `;
    }),
  ) as SqlRow[];
  const result = { processed: 0, healthy: 0, failed: 0, skipped: 0 };
  for (const candidate of candidates) {
    if (options.abortSignal?.aborted) break;
    result.processed += 1;
    try {
      await refreshMoltbookConnection({
        owner: {
          tenantId: String(candidate.tenant_id),
          actorId: String(candidate.owner_actor_id),
        },
        agentId: String(candidate.agent_id),
        abortSignal: options.abortSignal,
      });
      result.healthy += 1;
    } catch (error) {
      if (error instanceof MoltbookConnectionError &&
        ["agent_paused", "connection_paused", "connection_unclaimed"]
          .includes(error.code)) {
        result.skipped += 1;
      } else {
        result.failed += 1;
      }
    }
  }
  return result;
}

async function observeMoltbookConnection(input: {
  owner: MoltbookOwner;
  agentId: string;
  fetchImpl?: FetchLike;
  abortSignal?: AbortSignal;
}) {
  const access = await resolveConnectionForObservation(input.owner, input.agentId);
  const client = createMoltbookClient({
    apiKey: access.apiKey,
    fetchImpl: input.fetchImpl,
    abortSignal: input.abortSignal,
  });
  try {
    const statusResult = await client.status();
    const claimState = claimStateFromProvider(statusResult.data);
    const now = new Date().toISOString();
    const rateLimit = statusResult.rateLimit;
    const row = await runWithDatabaseActorScope(
      input.owner.tenantId,
      [input.owner.actorId],
      () => getSql().transaction(async (sql: Sql) => {
        await assertOwnedAgent(sql, input.owner, input.agentId, { requireActive: true });
        const updated = await sql`
          UPDATE omni_moltbook_connections SET
            status = ${claimState === "claimed" ? "claimed" : "pending_claim"},
            claim_state = ${claimState},
            last_heartbeat_at = ${now},
            next_heartbeat_at = ${nextHeartbeatAt(now)},
            consecutive_failures = 0, last_error_code = NULL,
            rate_limit_projection = ${rateLimit || null}::jsonb,
            updated_at = ${now}
          WHERE id = ${access.connectionId}
            AND tenant_id = ${input.owner.tenantId}
            AND owner_actor_id = ${input.owner.actorId}
            AND agent_id = ${input.agentId}
            AND status IN ('registering', 'pending_claim', 'claimed', 'error')
          RETURNING *
        `;
        if (!updated[0]) {
          throw new MoltbookConnectionError(
            "The Moltbook connection was paused or changed before observation.",
            { code: "connection_state_conflict" },
          );
        }
        await appendActivity(sql, {
          owner: input.owner,
          agentId: input.agentId,
          connectionId: access.connectionId,
          kind: "connection_check",
          status: "succeeded",
          summary: "Moltbook connection and claim status checked.",
          requestSha256: statusResult.requestSha256,
          responseSha256: statusResult.responseSha256,
        });
        return updated[0];
      }),
    ) as SqlRow;
    return projectConnection(row, { includeClaim: true });
  } catch (error) {
    await recordObservationFailure({
      owner: input.owner,
      agentId: input.agentId,
      connectionId: access.connectionId,
      kind: "connection_check",
      error,
    }).catch(() => undefined);
    throw normalizeConnectionError(error, "Moltbook could not be refreshed.");
  }
}

async function transitionConnectionLocally(
  input: { owner: MoltbookOwner; agentId: string },
  action: "pause" | "resume",
) {
  requireDatabase();
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(
    input.owner.tenantId,
    [input.owner.actorId],
    () => getSql().transaction(async (sql: Sql) => {
      await assertOwnedAgent(sql, input.owner, input.agentId);
      const now = new Date().toISOString();
      const rows = action === "pause"
        ? await sql`
            UPDATE omni_moltbook_connections SET
              status = 'paused', paused_at = ${now}, updated_at = ${now}
            WHERE tenant_id = ${input.owner.tenantId}
              AND owner_actor_id = ${input.owner.actorId}
              AND agent_id = ${input.agentId}
              AND status IN ('pending_claim', 'claimed', 'error')
            RETURNING *
          `
        : await sql`
            UPDATE omni_moltbook_connections SET
              status = CASE
                WHEN claim_state = 'claimed' THEN 'claimed'
                WHEN claim_state = 'pending' THEN 'pending_claim'
                ELSE 'error'
              END,
              paused_at = NULL,
              next_heartbeat_at = CASE
                WHEN heartbeat_enabled THEN ${nextHeartbeatAt(now)}::timestamptz
                ELSE next_heartbeat_at
              END,
              updated_at = ${now}
            WHERE tenant_id = ${input.owner.tenantId}
              AND owner_actor_id = ${input.owner.actorId}
              AND agent_id = ${input.agentId}
              AND status = 'paused'
            RETURNING *
          `;
      if (!rows[0]) {
        throw new MoltbookConnectionError(
          `The Moltbook connection cannot ${action} from its current state.`,
          { code: "connection_state_conflict" },
        );
      }
      await appendActivity(sql, {
        owner: input.owner,
        agentId: input.agentId,
        connectionId: String(rows[0].id),
        kind: action,
        status: "succeeded",
        summary: action === "pause"
          ? "Moltbook activity was paused by its owner."
          : "Moltbook activity was resumed by its owner.",
      });
      return projectConnection(rows[0], { includeClaim: true });
    }),
  );
}

async function resolveConnectionForObservation(
  owner: MoltbookOwner,
  agentId: string,
) {
  requireDatabase();
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(owner.tenantId, [owner.actorId], async () => {
    const sql = getSql();
    await assertOwnedAgent(sql, owner, agentId, { requireActive: true });
    const rows = await sql`
      SELECT * FROM omni_moltbook_connections
      WHERE tenant_id = ${owner.tenantId}
        AND owner_actor_id = ${owner.actorId}
        AND agent_id = ${agentId}
      LIMIT 2
    `;
    if (rows.length !== 1) {
      throw new MoltbookConnectionError(
        "The exact Moltbook connection could not be resolved.",
        { status: 404, code: "connection_not_found" },
      );
    }
    if (String(rows[0].status) === "paused") {
      throw new MoltbookConnectionError(
        "The Moltbook connection is paused.",
        { code: "connection_paused" },
      );
    }
    const credentials = openMoltbookCredentials(rows[0]);
    return {
      connectionId: String(rows[0].id),
      apiKey: credentials.apiKey,
    };
  });
}

async function assertOwnedAgent(
  sql: Sql,
  owner: MoltbookOwner,
  agentId: string,
  options: { requireActive?: boolean; requireMoltbookBoundary?: boolean } = {},
) {
  const rows = await sql`
    SELECT id, status, skill_ids, tool_ids, memory_scope, autonomy,
      approval_policy
    FROM omni_custom_agents
    WHERE tenant_id = ${owner.tenantId}
      AND actor_id = ${owner.actorId}
      AND id = ${agentId}
    LIMIT 2
  `;
  if (rows.length !== 1) {
    throw new MoltbookConnectionError(
      "The exact custom Agent could not be resolved for this owner.",
      { status: 404, code: "agent_not_found" },
    );
  }
  if (options.requireActive && String(rows[0].status) === "paused") {
    throw new MoltbookConnectionError(
      "The linked Asael Agent is paused.",
      { code: "agent_paused" },
    );
  }
  if (options.requireMoltbookBoundary) assertExactMoltbookBoundary(rows[0]);
}

async function exactMoltbookConnectionRow(
  sql: Sql,
  input: {
    tenantId: string;
    ownerActorId: string;
    executingAgentId: string;
    identityPin: MoltbookConnectionIdentityPin;
  },
) {
  const rows = await sql`
    SELECT connection.*, agent.status AS agent_status,
      agent.skill_ids, agent.tool_ids, agent.memory_scope,
      agent.autonomy, agent.approval_policy
    FROM omni_moltbook_connections connection
    JOIN omni_custom_agents agent
      ON agent.tenant_id = connection.tenant_id
     AND agent.actor_id = connection.owner_actor_id
     AND agent.id = connection.agent_id
    WHERE connection.tenant_id = ${input.tenantId}
      AND connection.owner_actor_id = ${input.ownerActorId}
      AND connection.agent_id = ${input.executingAgentId}
    LIMIT 2
  `;
  if (rows.length !== 1) {
    throw new MoltbookConnectionError(
      "The exact Moltbook Agent connection could not be resolved.",
      { status: 404, code: "connection_not_found" },
    );
  }
  const row = rows[0];
  if (!storedIdentityPinMatches(row, input.identityPin)) {
    throw new MoltbookConnectionError(
      "The Moltbook connection is bound to another Agent authority generation.",
      { code: "connection_identity_pin_mismatch" },
    );
  }
  if (String(row.agent_status) === "paused") {
    throw new MoltbookConnectionError(
      "The linked Asael Agent is paused.",
      { code: "agent_paused" },
    );
  }
  assertExactMoltbookBoundary(row);
  if (String(row.status) === "paused") {
    throw new MoltbookConnectionError(
      "The Moltbook connection is paused.",
      { code: "connection_paused" },
    );
  }
  if (String(row.status) !== "claimed" || String(row.claim_state) !== "claimed") {
    throw new MoltbookConnectionError(
      "The Moltbook Agent must be claimed before it can use social tools.",
      { code: "connection_unclaimed" },
    );
  }
  return row;
}

function publicConnectionAccess(
  row: SqlRow,
): Omit<MoltbookConnectionAccess, "apiKey"> {
  return {
    connectionId: String(row.id),
    tenantId: String(row.tenant_id),
    ownerActorId: String(row.owner_actor_id),
    agentId: String(row.agent_id),
    externalName: String(row.external_name),
  };
}

function assertExactMoltbookBoundary(row: SqlRow) {
  if (isExactMoltbookAgentCapabilityBoundary({
    skillIds: row.skill_ids,
    toolIds: row.tool_ids,
    memoryScope: row.memory_scope,
    autonomy: row.autonomy,
    approvalPolicy: row.approval_policy,
  })) return;
  throw new MoltbookConnectionError(
    `Moltbook registration requires no skills, session memory, governed autonomy, ` +
      `risk-based or always approval, and exactly ${MOLTBOOK_TOOL_IDS.length} Moltbook tools.`,
    { code: "agent_capability_boundary_invalid" },
  );
}

function assertRegistrationIdentityPin(
  logicalAgentId: string,
  pin: MoltbookConnectionIdentityPin,
) {
  if (
    pin.logicalAgentId !== logicalAgentId ||
    !pin.principalId ||
    pin.principalId.length > 240 ||
    !Number.isSafeInteger(pin.principalGeneration) ||
    pin.principalGeneration < 1 ||
    !Number.isSafeInteger(pin.definitionVersion) ||
    pin.definitionVersion < 1 ||
    !isSha256(pin.principalSha256) ||
    !isSha256(pin.definitionSha256) ||
    !isSha256(pin.policyBoundarySha256)
  ) {
    throw new MoltbookConnectionError(
      "The Moltbook connection identity pin is invalid.",
      { code: "connection_identity_pin_invalid" },
    );
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function storedIdentityPinMatches(
  row: SqlRow,
  expected: MoltbookConnectionIdentityPin,
) {
  try {
    return moltbookConnectionIdentityPinsEqual({
      logicalAgentId: String(row.agent_id),
      principalId: String(row.principal_id),
      principalGeneration: Number(row.principal_generation),
      principalSha256: String(row.principal_sha256),
      definitionVersion: Number(row.definition_version),
      definitionSha256: String(row.definition_sha256),
      policyBoundarySha256: String(row.policy_boundary_sha256),
    }, expected);
  } catch {
    return false;
  }
}

async function listActivities(
  sql: Sql,
  input: {
    owner: MoltbookOwner;
    agentId: string;
    limit?: number;
    cursor?: string;
  },
) {
  const limit = Math.min(
    Math.max(Math.trunc(input.limit || 25), 1),
    MAX_ACTIVITY_LIMIT,
  );
  const cursor = parseMoltbookActivityCursor(input.cursor);
  const rows = cursor
    ? await sql`
        SELECT * FROM omni_moltbook_activities
        WHERE tenant_id = ${input.owner.tenantId}
          AND owner_actor_id = ${input.owner.actorId}
          AND agent_id = ${input.agentId}
          AND (created_at, id) < (${cursor.createdAt}::timestamptz, ${cursor.id})
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit + 1}
      `
    : await sql`
        SELECT * FROM omni_moltbook_activities
        WHERE tenant_id = ${input.owner.tenantId}
          AND owner_actor_id = ${input.owner.actorId}
          AND agent_id = ${input.agentId}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit + 1}
      `;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    activities: page.map(projectActivity),
    nextCursor: rows.length > limit && last
      ? createMoltbookActivityCursor(String(last.created_at), String(last.id))
      : null,
  };
}

async function appendActivity(
  sql: Sql,
  input: {
    owner: MoltbookOwner;
    agentId: string;
    connectionId: string;
    kind: string;
    status: MoltbookEffectStatus;
    summary: string;
    providerObjectType?: string;
    providerObjectRef?: string;
    providerObjectUrl?: string;
    toolExecutionId?: string;
    agentRunId?: string;
    requestSha256?: string;
    responseSha256?: string;
    errorCode?: string;
  },
) {
  const providerUrl = safeProviderUrl(input.providerObjectUrl);
  await sql`
    INSERT INTO omni_moltbook_activities (
      id, tenant_id, owner_actor_id, agent_id, connection_id,
      kind, status, summary, provider_object_type, provider_object_ref,
      provider_object_url, tool_execution_id, agent_run_id,
      request_sha256, response_sha256, error_code, created_at
    ) VALUES (
      ${randomId("moltbook_activity")}, ${input.owner.tenantId},
      ${input.owner.actorId}, ${input.agentId}, ${input.connectionId},
      ${safeToken(input.kind, "activity")}, ${input.status},
      ${safeSummary(input.summary)},
      ${optionalSafeToken(input.providerObjectType)},
      ${optionalProviderRef(input.providerObjectRef)}, ${providerUrl || null},
      ${optionalOpaqueId(input.toolExecutionId)},
      ${optionalOpaqueId(input.agentRunId)},
      ${optionalDigest(input.requestSha256)},
      ${optionalDigest(input.responseSha256)},
      ${optionalSafeToken(input.errorCode)}, ${new Date().toISOString()}
    )
  `;
}

async function appendEffectReceipt(
  sql: Sql,
  input: {
    access: Omit<MoltbookConnectionAccess, "apiKey">;
    kind: string;
    status: MoltbookEffectStatus;
    providerObjectType?: string;
    providerObjectRef?: string;
    toolExecutionId: string;
    agentRunId?: string;
    requestSha256?: string;
    responseSha256?: string;
    errorCode?: string;
    toolId?: MoltbookToolId;
    toolInputSha256?: string;
    effectTargetId?: string;
  },
) {
  if (
    !input.requestSha256 ||
    !input.toolId ||
    !input.toolInputSha256 ||
    !input.effectTargetId
  ) {
    throw new MoltbookConnectionError(
      "Moltbook mutation receipts require a request digest.",
      { code: "effect_digest_missing" },
    );
  }
  await sql`
    INSERT INTO omni_moltbook_effect_receipts (
      id, tenant_id, owner_actor_id, agent_id, connection_id,
      effect_kind, effect_status, provider_object_type, provider_object_ref,
      tool_id, tool_execution_id, tool_input_sha256, effect_target_id,
      agent_run_id, request_sha256, response_sha256, error_code, created_at
    ) VALUES (
      ${effectReceiptId(input)}, ${input.access.tenantId},
      ${input.access.ownerActorId}, ${input.access.agentId},
      ${input.access.connectionId}, ${safeToken(input.kind, "effect")},
      ${input.status}, ${optionalSafeToken(input.providerObjectType)},
      ${optionalProviderRef(input.providerObjectRef)},
      ${input.toolId},
      ${optionalOpaqueId(input.toolExecutionId)},
      ${input.toolInputSha256}, ${input.effectTargetId},
      ${optionalOpaqueId(input.agentRunId)}, ${input.requestSha256},
      ${optionalDigest(input.responseSha256)},
      ${optionalSafeToken(input.errorCode)}, ${new Date().toISOString()}
    )
  `;
}

function effectReceiptId(input: {
  access: Omit<MoltbookConnectionAccess, "apiKey">;
  toolExecutionId: string;
}) {
  return `moltbook_effect_${createHash("sha256").update([
    input.access.tenantId,
    input.access.ownerActorId,
    input.access.agentId,
    input.toolExecutionId,
  ].join("\0")).digest("hex").slice(0, 48)}`;
}

async function recordRegistrationFailure(input: {
  owner: MoltbookOwner;
  agentId: string;
  connectionId: string;
  error: unknown;
}) {
  const provider = input.error instanceof MoltbookProviderError
    ? input.error
    : undefined;
  const errorCode = safeToken(
    provider?.code || "registration_outcome_unknown",
    "registration_outcome_unknown",
  );
  return runWithDatabaseActorScope(
    input.owner.tenantId,
    [input.owner.actorId],
    () => getSql().transaction(async (sql: Sql) => {
      await sql`
        UPDATE omni_moltbook_connections SET
          status = 'error', consecutive_failures = consecutive_failures + 1,
          last_error_code = ${errorCode},
          rate_limit_projection = ${provider?.rateLimit || null}::jsonb,
          updated_at = ${new Date().toISOString()}
        WHERE id = ${input.connectionId}
          AND tenant_id = ${input.owner.tenantId}
          AND owner_actor_id = ${input.owner.actorId}
          AND agent_id = ${input.agentId}
          AND status = 'registering'
      `;
      await appendActivity(sql, {
        owner: input.owner,
        agentId: input.agentId,
        connectionId: input.connectionId,
        kind: "registration",
        status: "failed",
        summary:
          "Moltbook registration outcome is unverified; retry is blocked to prevent a duplicate identity.",
        requestSha256: provider?.requestSha256,
        responseSha256: provider?.responseSha256,
        errorCode,
      });
    }),
  );
}

async function recordObservationFailure(input: {
  owner: MoltbookOwner;
  agentId: string;
  connectionId: string;
  kind: string;
  error: unknown;
}) {
  const provider = input.error instanceof MoltbookProviderError
    ? input.error
    : undefined;
  const code = provider?.code ||
    (input.error instanceof MoltbookConnectionError
      ? input.error.code
      : "observation_failed");
  return runWithDatabaseActorScope(
    input.owner.tenantId,
    [input.owner.actorId],
    () => getSql().transaction(async (sql: Sql) => {
      await sql`
        UPDATE omni_moltbook_connections SET
          consecutive_failures = consecutive_failures + 1,
          last_error_code = ${safeToken(code, "observation_failed")},
          rate_limit_projection = COALESCE(
            ${provider?.rateLimit || null}::jsonb, rate_limit_projection
          ),
          next_heartbeat_at = ${nextHeartbeatAt(new Date().toISOString())},
          updated_at = ${new Date().toISOString()}
        WHERE id = ${input.connectionId}
          AND tenant_id = ${input.owner.tenantId}
          AND owner_actor_id = ${input.owner.actorId}
          AND agent_id = ${input.agentId}
      `;
      await appendActivity(sql, {
        owner: input.owner,
        agentId: input.agentId,
        connectionId: input.connectionId,
        kind: input.kind,
        status: "failed",
        summary: "The read-only Moltbook observation did not complete.",
        requestSha256: provider?.requestSha256,
        responseSha256: provider?.responseSha256,
        errorCode: code,
      });
    }),
  );
}

function projectConnection(
  row: SqlRow,
  options: { includeClaim: boolean },
): MoltbookConnectionProjection {
  const status = moltbookConnectionStatusSchema.parse(row.status);
  const claimState = row.claim_state === "claimed"
    ? "claimed" as const
    : row.claim_state === "pending"
      ? "pending" as const
      : "unavailable" as const;
  const credentialConfigured = Boolean(row.sealed_credentials);
  if (row.disclosure_version !== MOLTBOOK_DISCLOSURE_VERSION) {
    throw new MoltbookConnectionError(
      "Stored Moltbook disclosure binding is invalid.",
      { code: "disclosure_binding_invalid" },
    );
  }
  let claim: { claimUrl?: string; verificationCode?: string } = {};
  if (
    options.includeClaim &&
    status === "pending_claim" &&
    claimState === "pending" &&
    credentialConfigured
  ) {
    const credentials = openMoltbookCredentials(row);
    claim = {
      claimUrl: credentials.claimUrl,
      verificationCode: credentials.verificationCode,
    };
  }
  return {
    agentId: String(row.agent_id),
    status,
    health: connectionHealth(status, Number(row.consecutive_failures || 0)),
    externalName: String(row.external_name),
    claimState,
    ...claim,
    heartbeatEnabled: Boolean(row.heartbeat_enabled),
    ...(optionalIso(row.last_heartbeat_at)
      ? { lastHeartbeatAt: optionalIso(row.last_heartbeat_at) }
      : {}),
    ...(optionalIso(row.next_heartbeat_at)
      ? { nextHeartbeatAt: optionalIso(row.next_heartbeat_at) }
      : {}),
    ...(rateLimitFromRow(row.rate_limit_projection)
      ? { rateLimit: rateLimitFromRow(row.rate_limit_projection) }
      : {}),
    consecutiveFailures: Math.max(0, Number(row.consecutive_failures || 0)),
    disclosureAccepted: Boolean(row.disclosure_accepted_at),
    disclosureVersion: MOLTBOOK_DISCLOSURE_VERSION,
    ...(optionalString(row.last_error_code)
      ? { lastErrorCode: optionalString(row.last_error_code) }
      : {}),
    credentialConfigured,
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
  };
}

function projectActivity(row: SqlRow): MoltbookActivityProjection {
  const type = optionalString(row.provider_object_type);
  const ref = optionalString(row.provider_object_ref);
  return {
    id: String(row.id),
    kind: String(row.kind),
    status: String(row.status) as MoltbookActivityProjection["status"],
    summary: String(row.summary),
    ...(type && ref
      ? {
          providerObject: {
            type,
            ref,
            ...(optionalString(row.provider_object_url)
              ? { url: optionalString(row.provider_object_url) }
              : {}),
          },
        }
      : {}),
    ...(optionalString(row.agent_run_id)
      ? { runId: optionalString(row.agent_run_id) }
      : {}),
    createdAt: requiredIso(row.created_at),
  };
}

function openMoltbookCredentials(row: SqlRow) {
  if (!row.sealed_credentials) {
    throw new MoltbookConnectionError(
      "The Moltbook credential is not configured.",
      { status: 503, code: "credential_missing" },
    );
  }
  const opened = openCredentialBundle(
    row.sealed_credentials,
    moltbookCredentialBinding({
      connectionId: String(row.id),
      owner: {
        tenantId: String(row.tenant_id),
        actorId: String(row.owner_actor_id),
      },
    }),
  );
  if (
    !isOpaqueMoltbookApiKey(opened.apiKey) ||
    !safeProviderUrl(opened.claimUrl) ||
    !/^[A-Za-z0-9_.:-]{3,240}$/.test(opened.verificationCode || "")
  ) {
    throw new MoltbookConnectionError(
      "The sealed Moltbook credential bundle is invalid.",
      { status: 503, code: "credential_invalid" },
    );
  }
  return {
    apiKey: opened.apiKey,
    claimUrl: opened.claimUrl,
    verificationCode: opened.verificationCode,
  };
}

function moltbookCredentialBinding(input: {
  owner: MoltbookOwner;
  connectionId: string;
}) {
  return credentialBinding({
    tenantId: input.owner.tenantId,
    actorId: input.owner.actorId,
    connectionId: input.connectionId,
    provider: PROVIDER,
    credentialVersion: CREDENTIAL_VERSION,
  });
}

function connectionIdFor(owner: MoltbookOwner, agentId: string) {
  return `moltbook_connection_${sha256(
    `moltbook-connection-v1\0${owner.tenantId}\0${owner.actorId}\0${agentId}`,
  ).slice(0, 48)}`;
}

function registrationRequestDigest(input: {
  owner: MoltbookOwner;
  agentId: string;
  externalName: string;
  description: string;
  heartbeatEnabled?: boolean;
  disclosureVersion: typeof MOLTBOOK_DISCLOSURE_VERSION;
}) {
  return sha256([
    "moltbook-registration-v1",
    input.owner.tenantId,
    input.owner.actorId,
    input.agentId,
    input.externalName,
    input.description,
    input.heartbeatEnabled === false ? "disabled" : "enabled",
    input.disclosureVersion,
  ].join("\0"));
}

function randomId(prefix: "moltbook_activity" | "moltbook_effect") {
  return `${prefix}_${randomBytes(24).toString("hex")}`;
}

function claimStateFromProvider(data: unknown): "pending" | "claimed" {
  const record = data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
  const nested = record.agent &&
      typeof record.agent === "object" &&
      !Array.isArray(record.agent)
    ? record.agent as Record<string, unknown>
    : {};
  const value = String(record.status || nested.status || "").toLowerCase();
  if (value === "claimed" || record.is_claimed === true || nested.is_claimed === true) {
    return "claimed";
  }
  if (value === "pending_claim" || value === "pending") return "pending";
  throw new MoltbookConnectionError(
    "Moltbook returned an unknown claim state.",
    { code: "claim_state_invalid" },
  );
}

function connectionHealth(
  status: MoltbookConnectionStatus,
  failures: number,
): MoltbookConnectionProjection["health"] {
  if (status === "paused") return "paused";
  if (status === "revoked") return "revoked";
  if (status === "error" || failures > 0) return "error";
  if (status === "claimed") return "healthy";
  return "pending";
}

function nextHeartbeatAt(now: string) {
  return new Date(Date.parse(now) + MOLTBOOK_HEARTBEAT_INTERVAL_MS).toISOString();
}

function safeProviderUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.origin === MOLTBOOK_API_ORIGIN &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      value.length <= 2_048
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function safeToken(value: unknown, fallback: string) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9_.:-]{1,80}$/.test(normalized) ? normalized : fallback;
}

function optionalSafeToken(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  return safeToken(value, "unknown");
}

function optionalProviderRef(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[A-Za-z0-9_.:-]{1,240}$/.test(normalized) ? normalized : null;
}

function optionalOpaqueId(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= 240 ? normalized : null;
}

function optionalDigest(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
    ? value
    : null;
}

function safeSummary(value: string) {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ").trim();
  return (normalized || "Moltbook activity recorded.").slice(0, 1_000);
}

function rateLimitFromRow(value: unknown): MoltbookRateLimitProjection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const observedAt = optionalIso(record.observedAt);
  if (!observedAt) return undefined;
  return {
    ...(Number.isSafeInteger(record.limit) ? { limit: Number(record.limit) } : {}),
    ...(Number.isSafeInteger(record.remaining)
      ? { remaining: Number(record.remaining) }
      : {}),
    ...(optionalIso(record.resetAt) ? { resetAt: optionalIso(record.resetAt) } : {}),
    ...(Number.isSafeInteger(record.retryAfterSeconds)
      ? { retryAfterSeconds: Number(record.retryAfterSeconds) }
      : {}),
    observedAt,
  };
}

export function createMoltbookActivityCursor(createdAt: string, id: string) {
  return Buffer.from(JSON.stringify({ createdAt, id }), "utf8").toString("base64url");
}

export function parseMoltbookActivityCursor(value?: string) {
  if (!value) return undefined;
  if (!/^[A-Za-z0-9_-]{8,500}$/.test(value)) {
    throw new MoltbookConnectionError("Invalid activity cursor.", {
      status: 400,
      code: "cursor_invalid",
    });
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort().join(",");
    if (
      keys !== "createdAt,id" ||
      !optionalIso(record.createdAt) ||
      typeof record.id !== "string" ||
      !/^moltbook_activity_[a-f0-9]{48}$/.test(record.id)
    ) throw new Error();
    return { createdAt: String(record.createdAt), id: record.id };
  } catch {
    throw new MoltbookConnectionError("Invalid activity cursor.", {
      status: 400,
      code: "cursor_invalid",
    });
  }
}

function requiredIso(value: unknown) {
  const parsed = optionalIso(value);
  if (!parsed) throw new MoltbookConnectionError("Stored Moltbook time is invalid.");
  return parsed;
}

function optionalIso(value: unknown) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== "string" || !value.trim()) return undefined;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function unresolvedAgentOwner() {
  return new MoltbookConnectionError(
    "The exact stored owner for this Moltbook Agent could not be resolved.",
    { code: "agent_owner_unresolved" },
  );
}

function normalizeConnectionError(error: unknown, fallback: string) {
  if (error instanceof MoltbookConnectionError) return error;
  if (error instanceof MoltbookProviderError) {
    return new MoltbookConnectionError(fallback, {
      status: error.statusCode === 404 ? 404 : 503,
      code: error.code,
      cause: error,
    });
  }
  return new MoltbookConnectionError(fallback, {
    status: 503,
    code: "moltbook_unavailable",
    cause: error,
  });
}

function requireDatabase() {
  if (!hasDatabaseUrl()) {
    throw new MoltbookConnectionError(
      "Moltbook Agent connections require the canonical database.",
      { status: 503, code: "database_required" },
    );
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
