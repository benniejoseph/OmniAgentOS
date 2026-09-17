import { createHash, randomBytes } from "node:crypto";

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseSystemScope,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  LOCAL_COMPUTER_COMMAND_LEASE_SECONDS,
  LOCAL_COMPUTER_COMMAND_TIMEOUT_MS,
  LOCAL_COMPUTER_DEVICE_LEASE_SECONDS,
  LOCAL_COMPUTER_NATIVE_CONTRACT_VERSION,
  LOCAL_COMPUTER_OPEN_URL_CONTRACT_VERSION,
  LOCAL_COMPUTER_PROTOCOL_VERSION,
  localComputerActionSchema,
  localComputerResultSchema,
  type LocalComputerAction,
  type LocalComputerCompletionRequest,
  type LocalComputerDeviceUpdate,
} from "@/lib/local-computer/contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import {
  deriveExecutionScope,
  executionScopeFromSecurityContext,
} from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  getToolExecution,
  openToolExecutionInput,
} from "@/lib/tools/audit-store";

type LocalComputerSql = ReturnType<typeof getSql>;
const LOCAL_COMPUTER_OBSERVATION_TTL_SECONDS = 5 * 60;

export class LocalComputerUnavailableError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "LocalComputerUnavailableError";
  }
}

export class LocalComputerCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalComputerCommandError";
    this.code = code;
  }
}

export async function updateLocalComputerDevice(
  context: SecurityContext,
  input: LocalComputerDeviceUpdate,
) {
  const native = exactMacContext(context);
  requireStorage();
  await ensureDatabaseSchema();
  const now = new Date();
  const leaseExpiresAt = new Date(
    now.getTime() + LOCAL_COMPUTER_DEVICE_LEASE_SECONDS * 1_000,
  ).toISOString();
  const permissions = input.permissions;
  const eligible = input.enabled &&
    permissions.accessibility === "granted" &&
    permissions.screenRecording === "granted";
  const rows = await getSql()`
    INSERT INTO omni_local_computer_devices (
      tenant_id, owner_actor_id, user_id, mobile_session_id, device_id,
      platform, native_contract_version, enabled, helper_version,
      permission_status, activity_state, lifecycle_revision, last_seen_at,
      lease_expires_at, stopped_at, created_at, updated_at
    )
    SELECT
      ${context.tenantId}, ${context.actorId}, ${native.userId}, session.id,
      ${native.deviceId}, 'macos', ${native.contractVersion}, ${eligible},
      ${input.helperVersion}, ${permissions}::jsonb, ${input.activityState}, 1,
      ${now.toISOString()}, ${leaseExpiresAt},
      ${eligible ? null : now.toISOString()}, ${now.toISOString()},
      ${now.toISOString()}
    FROM omni_mobile_sessions session
    WHERE session.id = ${native.sessionId}
      AND session.tenant_id = ${context.tenantId}
      AND session.user_id = ${native.userId}
      AND session.device_id = ${native.deviceId}
      AND session.revoked_at IS NULL
      AND session.refresh_expires_at > NOW()
    ON CONFLICT (tenant_id, owner_actor_id, device_id) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      mobile_session_id = EXCLUDED.mobile_session_id,
      platform = EXCLUDED.platform,
      native_contract_version = EXCLUDED.native_contract_version,
      enabled = EXCLUDED.enabled,
      helper_version = EXCLUDED.helper_version,
      permission_status = EXCLUDED.permission_status,
      activity_state = EXCLUDED.activity_state,
      lifecycle_revision = omni_local_computer_devices.lifecycle_revision + 1,
      last_seen_at = EXCLUDED.last_seen_at,
      lease_expires_at = EXCLUDED.lease_expires_at,
      stopped_at = EXCLUDED.stopped_at,
      updated_at = EXCLUDED.updated_at
    RETURNING *
  `;
  if (!rows[0]) {
    throw new LocalComputerUnavailableError(
      "The native session is no longer eligible for local Computer Use.",
    );
  }
  return publicDevice(rows[0]);
}

export async function getLocalComputerDevice(context: SecurityContext) {
  const native = exactMacContext(context);
  requireStorage();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT * FROM omni_local_computer_devices
    WHERE tenant_id = ${context.tenantId}
      AND owner_actor_id = ${context.actorId}
      AND device_id = ${native.deviceId}
      AND mobile_session_id = ${native.sessionId}
    LIMIT 1
  `;
  return rows[0] ? publicDevice(rows[0]) : null;
}

export async function startLocalComputerSession(
  context: SecurityContext,
  correlationId: string,
) {
  const native = exactMacContext(context);
  requireStorage();
  const normalizedCorrelationId = opaque(correlationId, "correlation id", 200);
  await ensureDatabaseSchema();
  const id = `local_computer_session_${digest([
    context.tenantId,
    context.actorId,
    native.deviceId,
    normalizedCorrelationId,
  ]).slice(0, 48)}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  const rows = await getSql()`
    INSERT INTO omni_local_computer_sessions (
      id, tenant_id, owner_actor_id, device_id, mobile_session_id,
      correlation_id, state, created_at, expires_at, stopped_at, updated_at
    )
    SELECT
      ${id}, device.tenant_id, device.owner_actor_id, device.device_id,
      device.mobile_session_id, ${normalizedCorrelationId}, 'active',
      ${now.toISOString()}, ${expiresAt}, NULL, ${now.toISOString()}
    FROM omni_local_computer_devices device
    WHERE device.tenant_id = ${context.tenantId}
      AND device.owner_actor_id = ${context.actorId}
      AND device.device_id = ${native.deviceId}
      AND device.mobile_session_id = ${native.sessionId}
      AND device.enabled
      AND device.lease_expires_at > NOW()
      AND device.permission_status ->> 'accessibility' = 'granted'
      AND device.permission_status ->> 'screenRecording' = 'granted'
    ON CONFLICT (tenant_id, owner_actor_id, correlation_id) DO UPDATE SET
      device_id = EXCLUDED.device_id,
      state = 'active',
      expires_at = EXCLUDED.expires_at,
      stopped_at = NULL,
      updated_at = EXCLUDED.updated_at
    WHERE omni_local_computer_sessions.mobile_session_id = EXCLUDED.mobile_session_id
    RETURNING *
  `;
  if (!rows[0]) {
    throw new LocalComputerUnavailableError(
      "This Mac is not online with both Accessibility and Screen Recording enabled.",
    );
  }
  await appendLocalComputerEvent({
    executionScope: executionScopeFromSecurityContext(context, {
      correlationId: normalizedCorrelationId,
      purpose: "local_computer.session.start",
    }),
    type: "local_computer.session.started",
    streamId: `local-computer-session:${id}`,
    eventId: `local_computer_event_${digest([id, "started"]).slice(0, 48)}`,
    payload: {
      schemaVersion: LOCAL_COMPUTER_PROTOCOL_VERSION,
      sessionId: id,
      deviceIdSha256: digest([native.deviceId]),
      expiresAt,
    },
  });
  return { id, deviceId: native.deviceId, expiresAt };
}

export async function stopLocalComputerDevice(
  context: SecurityContext,
  reason: string,
) {
  const native = exactMacContext(context);
  requireStorage();
  await ensureDatabaseSchema();
  const now = new Date().toISOString();
  return getSql().transaction(async (sql: LocalComputerSql) => {
    await sql`
      UPDATE omni_local_computer_devices
      SET enabled = FALSE, activity_state = 'stopped', stopped_at = ${now},
          lease_expires_at = ${now}, lifecycle_revision = lifecycle_revision + 1,
          updated_at = ${now}
      WHERE tenant_id = ${context.tenantId}
        AND owner_actor_id = ${context.actorId}
        AND device_id = ${native.deviceId}
        AND mobile_session_id = ${native.sessionId}
    `;
    await sql`
      UPDATE omni_local_computer_sessions
      SET state = 'stopped', stopped_at = ${now}, updated_at = ${now}
      WHERE tenant_id = ${context.tenantId}
        AND owner_actor_id = ${context.actorId}
        AND device_id = ${native.deviceId}
        AND state = 'active'
    `;
    const canceled = await sql`
      UPDATE omni_local_computer_commands command
      SET state = 'canceled', outcome = 'canceled', error_code = 'device_stopped',
          completed_at = ${now}, updated_at = ${now}
      WHERE command.tenant_id = ${context.tenantId}
        AND command.owner_actor_id = ${context.actorId}
        AND command.device_id = ${native.deviceId}
        AND command.state IN ('queued', 'claimed')
      RETURNING id
    `;
    return {
      schemaVersion: LOCAL_COMPUTER_PROTOCOL_VERSION,
      stopped: true as const,
      reason,
      canceledCommands: canceled.length,
    };
  });
}

export async function claimLocalComputerCommand(context: SecurityContext) {
  const native = exactMacContext(context);
  requireStorage();
  await ensureDatabaseSchema();
  await getSql()`
    UPDATE omni_local_computer_commands
    SET result = result - 'observation', state = 'consumed',
        consumed_at = COALESCE(consumed_at, NOW()),
        error_code = COALESCE(error_code, 'observation_expired'),
        updated_at = NOW()
    WHERE tenant_id = ${context.tenantId}
      AND owner_actor_id = ${context.actorId}
      AND device_id = ${native.deviceId}
      AND result ? 'observation'
      AND completed_at <= NOW() - (
        ${LOCAL_COMPUTER_OBSERVATION_TTL_SECONDS} * INTERVAL '1 second'
      )
  `;
  await getSql()`
    UPDATE omni_local_computer_commands command
    SET state = 'failed', outcome = 'failed',
        error_code = 'execution_indeterminate', completed_at = NOW(),
        updated_at = NOW()
    FROM omni_local_computer_sessions session
    WHERE command.tenant_id = ${context.tenantId}
      AND command.owner_actor_id = ${context.actorId}
      AND command.device_id = ${native.deviceId}
      AND session.tenant_id = command.tenant_id
      AND session.id = command.session_id
      AND session.mobile_session_id = ${native.sessionId}
      AND command.state = 'claimed'
      AND command.claim_expires_at <= NOW()
      AND command.action NOT IN ('observe', 'list_apps')
  `;
  const claimToken = randomBytes(32).toString("base64url");
  const claimTokenSha256 = digest([claimToken]);
  const claimExpiresAt = new Date(
    Date.now() + LOCAL_COMPUTER_COMMAND_LEASE_SECONDS * 1_000,
  ).toISOString();
  const rows = await getSql()`
    WITH candidate AS (
      SELECT command.tenant_id, command.id, session.run_id
      FROM omni_local_computer_commands command
      JOIN omni_local_computer_sessions session
        ON session.tenant_id = command.tenant_id
       AND session.id = command.session_id
      JOIN omni_local_computer_devices device
        ON device.tenant_id = command.tenant_id
       AND device.owner_actor_id = command.owner_actor_id
       AND device.device_id = command.device_id
      WHERE command.tenant_id = ${context.tenantId}
        AND command.owner_actor_id = ${context.actorId}
        AND command.device_id = ${native.deviceId}
        AND session.mobile_session_id = ${native.sessionId}
        AND session.run_id IS NOT NULL
        AND session.state = 'active'
        AND session.expires_at > NOW()
        AND device.enabled
        AND device.lease_expires_at > NOW()
        AND command.expires_at > NOW()
        AND (
          command.state = 'queued'
          OR (
            command.state = 'claimed'
            AND command.claim_expires_at <= NOW()
            AND command.action IN ('observe', 'list_apps')
          )
        )
      ORDER BY command.created_at, command.id COLLATE "C"
      FOR UPDATE OF command SKIP LOCKED
      LIMIT 1
    )
    UPDATE omni_local_computer_commands command
    SET state = 'claimed', claim_token_sha256 = ${claimTokenSha256},
        claim_generation = command.claim_generation + 1,
        claimed_at = NOW(), claim_expires_at = ${claimExpiresAt},
        updated_at = NOW()
    FROM candidate
    WHERE command.tenant_id = candidate.tenant_id
      AND command.id = candidate.id
    RETURNING command.*, candidate.run_id
  `;
  if (!rows[0]) {
    return {
      schemaVersion: LOCAL_COMPUTER_PROTOCOL_VERSION,
      command: null,
      pollAfterMs: 600,
    };
  }
  const row = rows[0];
  let commandInput: Record<string, unknown>;
  try {
    const execution = await getToolExecution(String(row.execution_id), {
      tenantId: context.tenantId,
    });
    if (
      !execution ||
      execution.toolId !== toolIdForLocalComputerAction(
        localComputerActionSchema.parse(row.action),
      )
    ) {
      throw new Error("The governed tool execution binding is unavailable.");
    }
    commandInput = openToolExecutionInput(execution);
    if (canonicalJsonSha256(commandInput) !== String(row.input_sha256)) {
      throw new Error("The governed tool input digest does not match.");
    }
  } catch (error) {
    await getSql()`
      UPDATE omni_local_computer_commands
      SET state = 'failed', outcome = 'failed', error_code = 'invalid_binding',
          completed_at = NOW(), updated_at = NOW()
      WHERE tenant_id = ${context.tenantId}
        AND owner_actor_id = ${context.actorId}
        AND id = ${String(row.id)}
        AND state = 'claimed'
    `;
    throw new LocalComputerCommandError(
      "invalid_binding",
      error instanceof Error
        ? error.message
        : "The governed local computer command binding is invalid.",
    );
  }
  return {
    schemaVersion: LOCAL_COMPUTER_PROTOCOL_VERSION,
    command: {
      schemaVersion: LOCAL_COMPUTER_PROTOCOL_VERSION,
      id: String(row.id),
      runId: opaque(String(row.run_id), "run id", 240),
      executionId: opaque(String(row.execution_id), "execution id", 240),
      action: localComputerActionSchema.parse(row.action),
      input: localComputerHelperInput(
        localComputerActionSchema.parse(row.action),
        commandInput,
      ),
      presentScreenshot:
        row.action === "observe" && commandInput.presentScreenshot === true,
      claimToken,
      claimGeneration: Number(row.claim_generation),
      expiresAt: dateText(row.expires_at),
    },
    pollAfterMs: 0,
  };
}

function localComputerHelperInput(
  action: LocalComputerAction,
  input: Record<string, unknown>,
) {
  if (action !== "observe") return input;
  const { presentScreenshot: _presentScreenshot, ...helperInput } = input;
  void _presentScreenshot;
  return helperInput;
}

/**
 * The fast worker calls this bounded scrub every few seconds. The ordinary
 * retention sweep remains a backstop, but screenshot bytes do not wait for
 * that multi-hour cadence.
 */
export async function scrubExpiredLocalComputerObservations(
  input: { limit?: number } = {},
) {
  if (!hasDatabaseUrl()) {
    return { scrubbed: 0, moreAvailable: false };
  }
  const limit = Math.min(Math.max(input.limit || 100, 1), 1_000);
  await ensureDatabaseSchema();
  const rows = await runWithDatabaseSystemScope(
    "ephemeral local computer observation scrub",
    () => getSql()`
      WITH expired AS (
        SELECT ctid
        FROM omni_local_computer_commands
        WHERE result ? 'observation'
          AND completed_at <= NOW() - (
            ${LOCAL_COMPUTER_OBSERVATION_TTL_SECONDS} * INTERVAL '1 second'
          )
        ORDER BY completed_at ASC, tenant_id ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE omni_local_computer_commands target
      SET result = target.result - 'observation', state = 'consumed',
          consumed_at = COALESCE(target.consumed_at, NOW()),
          error_code = COALESCE(target.error_code, 'observation_expired'),
          updated_at = NOW()
      FROM expired
      WHERE target.ctid = expired.ctid
      RETURNING target.id
    `,
  );
  return {
    scrubbed: rows.length,
    moreAvailable: rows.length >= limit,
  };
}

export async function completeLocalComputerCommand(
  context: SecurityContext,
  commandId: string,
  completion: LocalComputerCompletionRequest,
) {
  const native = exactMacContext(context);
  requireStorage();
  const id = opaque(commandId, "command id", 80);
  const result = completion.result || null;
  const resultSha256 = result ? canonicalJsonSha256(result) : null;
  await ensureDatabaseSchema();
  const rows = await getSql()`
    UPDATE omni_local_computer_commands
    SET state = ${completion.outcome === "succeeded" ? "completed" : completion.outcome},
        outcome = ${completion.outcome}, result = ${result}::jsonb,
        result_sha256 = ${resultSha256}, error_code = ${completion.errorCode || null},
        completed_at = NOW(), updated_at = NOW()
    WHERE tenant_id = ${context.tenantId}
      AND owner_actor_id = ${context.actorId}
      AND device_id = ${native.deviceId}
      AND id = ${id}
      AND state = 'claimed'
      AND claim_token_sha256 = ${digest([completion.claimToken])}
      AND claim_expires_at > NOW()
    RETURNING *
  `;
  if (!rows[0]) {
    const existing = await getSql()`
      SELECT * FROM omni_local_computer_commands
      WHERE tenant_id = ${context.tenantId}
        AND owner_actor_id = ${context.actorId}
        AND device_id = ${native.deviceId}
        AND id = ${id}
      LIMIT 1
    `;
    const row = existing[0];
    if (
      row &&
      digest([completion.claimToken]) === row.claim_token_sha256 &&
      completion.outcome === row.outcome &&
      resultSha256 === (row.result_sha256 || null)
    ) {
      return completionReceipt(row);
    }
    throw new LocalComputerUnavailableError(
      "The local computer command claim expired or no longer matches this device.",
    );
  }
  return completionReceipt(rows[0]);
}

export async function executeLocalComputerCommand(input: {
  action: LocalComputerAction;
  toolInput: Record<string, unknown>;
  executionId: string;
  runId: string;
  executionScope: ExecutionScope;
  abortSignal?: AbortSignal;
}) {
  requireStorage();
  await ensureDatabaseSchema();
  const command = await enqueueLocalComputerCommand(input);
  return waitForLocalComputerCommand(command, input);
}

async function enqueueLocalComputerCommand(input: {
  action: LocalComputerAction;
  toolInput: Record<string, unknown>;
  executionId: string;
  runId: string;
  executionScope: ExecutionScope;
}) {
  const action = localComputerActionSchema.parse(input.action);
  const executionId = opaque(input.executionId, "execution id", 240);
  const runId = opaque(input.runId, "run id", 240);
  const commandId = `local_computer_command_${digest([
    input.executionScope.tenantId,
    input.executionScope.initiatingActorId || "",
    executionId,
  ]).slice(0, 48)}`;
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + LOCAL_COMPUTER_COMMAND_TIMEOUT_MS,
  ).toISOString();
  const inputSha256 = canonicalJsonSha256(input.toolInput);
  const requiredNativeContractVersion =
    requiredNativeContractVersionForCommand(action, input.toolInput);
  // Approval resume deliberately carries no native-version authority. Resolve
  // compatibility from the exact v180 run-bound local session and its current
  // server-side device/native-login rows in the same transaction as enqueue.
  const binding = await getSql().transaction(async (sql: LocalComputerSql) => {
    const sessions = await sql`
      WITH eligible_session AS MATERIALIZED (
        SELECT
          session.tenant_id,
          session.id,
          session.device_id,
          run.id AS run_id
        FROM omni_local_computer_sessions session
        JOIN omni_local_computer_devices device
          ON device.tenant_id = session.tenant_id
         AND device.owner_actor_id = session.owner_actor_id
         AND device.device_id = session.device_id
         AND device.mobile_session_id = session.mobile_session_id
        JOIN omni_mobile_sessions native_session
          ON native_session.id = session.mobile_session_id
         AND native_session.tenant_id = session.tenant_id
         AND native_session.user_id = device.user_id
         AND native_session.device_id = session.device_id
        JOIN omni_agent_runs run
          ON run.id = ${runId}
         AND run.tenant_id = session.tenant_id
         AND run.owner_actor_id = session.owner_actor_id
        JOIN omni_events run_binding
          ON run_binding.tenant_id = run.tenant_id
         AND run_binding.actor_id = run.owner_actor_id
         AND run_binding.stream_id = 'run:' || run.id
         AND run_binding.type = 'run.scope_bound'
         AND run_binding.correlation_id = session.correlation_id
        WHERE session.tenant_id = ${input.executionScope.tenantId}
          AND session.owner_actor_id = ${input.executionScope.initiatingActorId || ""}
          AND session.correlation_id = ${input.executionScope.correlationId}
          AND session.state = 'active'
          AND session.expires_at > NOW()
          AND (session.run_id IS NULL OR session.run_id = run.id)
          AND device.platform = 'macos'
          AND device.native_contract_version >= ${requiredNativeContractVersion}
          AND device.enabled
          AND device.lease_expires_at > NOW()
          AND native_session.platform = 'macos'
          AND native_session.client_contract_version >= ${requiredNativeContractVersion}
          AND native_session.client_attested_at IS NOT NULL
          AND native_session.revoked_at IS NULL
          AND native_session.refresh_expires_at > NOW()
      )
      UPDATE omni_local_computer_sessions session
      SET run_id = eligible_session.run_id, updated_at = ${now.toISOString()}
      FROM eligible_session
      WHERE session.tenant_id = eligible_session.tenant_id
        AND session.id = eligible_session.id
      RETURNING session.id, session.device_id, session.run_id
    `;
    if (!sessions[0] || String(sessions[0].run_id) !== runId) {
      return { rows: [], sessionId: null, deviceId: null };
    }
    const sessionId = String(sessions[0].id);
    const deviceId = String(sessions[0].device_id);
    const rows = await sql`
      INSERT INTO omni_local_computer_commands (
        id, tenant_id, owner_actor_id, session_id, device_id, execution_id,
        action, input_sha256, state, claim_generation, expires_at, created_at,
        updated_at
      )
      SELECT
        ${commandId}, session.tenant_id, session.owner_actor_id, session.id,
        session.device_id, ${executionId}, ${action}, ${inputSha256},
        'queued', 0, ${expiresAt}, ${now.toISOString()}, ${now.toISOString()}
      FROM omni_local_computer_sessions session
      JOIN omni_local_computer_devices device
        ON device.tenant_id = session.tenant_id
       AND device.owner_actor_id = session.owner_actor_id
       AND device.device_id = session.device_id
       AND device.mobile_session_id = session.mobile_session_id
      JOIN omni_mobile_sessions native_session
        ON native_session.id = session.mobile_session_id
       AND native_session.tenant_id = session.tenant_id
       AND native_session.user_id = device.user_id
       AND native_session.device_id = session.device_id
      WHERE session.tenant_id = ${input.executionScope.tenantId}
        AND session.owner_actor_id = ${input.executionScope.initiatingActorId || ""}
        AND session.id = ${sessionId}
        AND session.device_id = ${deviceId}
        AND session.correlation_id = ${input.executionScope.correlationId}
        AND session.run_id = ${runId}
        AND session.state = 'active'
        AND session.expires_at > NOW()
        AND device.platform = 'macos'
        AND device.native_contract_version >= ${requiredNativeContractVersion}
        AND device.enabled
        AND device.lease_expires_at > NOW()
        AND native_session.platform = 'macos'
        AND native_session.client_contract_version >= ${requiredNativeContractVersion}
        AND native_session.client_attested_at IS NOT NULL
        AND native_session.revoked_at IS NULL
        AND native_session.refresh_expires_at > NOW()
      ON CONFLICT (tenant_id, owner_actor_id, execution_id) DO UPDATE SET
        updated_at = omni_local_computer_commands.updated_at
      RETURNING *
    `;
    return { rows, sessionId, deviceId };
  }) as {
    rows: Record<string, unknown>[];
    sessionId: string | null;
    deviceId: string | null;
  };
  const rows = binding.rows;
  if (!rows[0]) {
    throw new LocalComputerUnavailableError(
      "The exact local Mac session is offline, stopped, expired, incompatible with this action, or does not belong to this run.",
    );
  }
  const row = rows[0];
  if (
    row.action !== action ||
    String(row.input_sha256) !== inputSha256 ||
    String(row.session_id) !== binding.sessionId ||
    String(row.device_id) !== binding.deviceId
  ) {
    throw new LocalComputerCommandError(
      "command_binding_mismatch",
      "The existing local computer command does not match this governed execution.",
    );
  }
  await appendLocalComputerEvent({
    executionScope: deriveExecutionScope(input.executionScope, {
      executingPrincipalType: "system",
      executingPrincipalId: "local-computer-router",
      causationId: executionId,
      purpose: "local_computer.command.queued",
    }),
    type: "local_computer.command.queued",
    streamId: `local-computer-command:${commandId}`,
    eventId: `local_computer_event_${digest([commandId, "queued"]).slice(0, 48)}`,
    payload: {
      schemaVersion: LOCAL_COMPUTER_PROTOCOL_VERSION,
      commandId,
      sessionId: String(row.session_id),
      runId,
      deviceIdSha256: digest([String(row.device_id)]),
      executionId,
      action,
      inputSha256: canonicalJsonSha256(input.toolInput),
      expiresAt: dateText(row.expires_at),
    },
  });
  return { id: commandId, expiresAt: dateText(row.expires_at) };
}

async function waitForLocalComputerCommand(
  command: { id: string; expiresAt: string },
  input: {
    executionScope: ExecutionScope;
    executionId: string;
    abortSignal?: AbortSignal;
  },
) {
  while (Date.now() < Date.parse(command.expiresAt)) {
    if (input.abortSignal?.aborted) {
      throw input.abortSignal.reason || new DOMException("Aborted", "AbortError");
    }
    const rows = await getSql()`
      SELECT * FROM omni_local_computer_commands
      WHERE tenant_id = ${input.executionScope.tenantId}
        AND owner_actor_id = ${input.executionScope.initiatingActorId || ""}
        AND id = ${command.id}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      throw new LocalComputerCommandError(
        "command_missing",
        "The local computer command disappeared before completion.",
      );
    }
    if (row.state === "completed" || row.state === "consumed") {
      if (
        row.action === "observe" &&
        Date.now() >=
          Date.parse(dateText(row.completed_at)) +
            LOCAL_COMPUTER_OBSERVATION_TTL_SECONDS * 1_000
      ) {
        await getSql()`
          UPDATE omni_local_computer_commands
          SET result = result - 'observation', state = 'consumed',
              consumed_at = COALESCE(consumed_at, NOW()),
              error_code = COALESCE(error_code, 'observation_expired'),
              updated_at = NOW()
          WHERE tenant_id = ${input.executionScope.tenantId}
            AND owner_actor_id = ${input.executionScope.initiatingActorId || ""}
            AND id = ${command.id}
            AND result ? 'observation'
        `;
        throw new LocalComputerCommandError(
          "observation_expired",
          "The local Mac observation expired before it could be consumed.",
        );
      }
      if (row.state === "consumed" && row.action === "observe") {
        throw new LocalComputerCommandError(
          "observation_consumed",
          "The local Mac observation was already consumed. Run a fresh observe command.",
        );
      }
      const parsed = localComputerResultSchema.safeParse(row.result);
      if (!parsed.success) {
        throw new LocalComputerCommandError(
          "invalid_result",
          "The installed Mac returned an invalid bounded observation.",
        );
      }
      const result = parsed.data;
      const publicResult = stripObservation(result);
      if (row.state === "completed") {
        const consumed = await getSql()`
          UPDATE omni_local_computer_commands
          SET state = 'consumed', result = ${publicResult}::jsonb,
              consumed_at = NOW(), updated_at = NOW()
          WHERE tenant_id = ${input.executionScope.tenantId}
            AND owner_actor_id = ${input.executionScope.initiatingActorId || ""}
            AND id = ${command.id}
            AND state = 'completed'
          RETURNING id
        `;
        if (row.action === "observe" && !consumed[0]) {
          throw new LocalComputerCommandError(
            "observation_consumed",
            "The local Mac observation was already consumed. Run a fresh observe command.",
          );
        }
      }
      await appendLocalComputerEvent({
        executionScope: deriveExecutionScope(input.executionScope, {
          executingPrincipalType: "system",
          executingPrincipalId: "local-computer-router",
          causationId: input.executionId,
          purpose: "local_computer.command.completed",
        }),
        type: "local_computer.command.completed",
        streamId: `local-computer-command:${command.id}`,
        eventId: `local_computer_event_${digest([command.id, "completed"]).slice(0, 48)}`,
        payload: {
          schemaVersion: LOCAL_COMPUTER_PROTOCOL_VERSION,
          commandId: command.id,
          executionId: input.executionId,
          action: String(row.action),
          resultSha256: String(row.result_sha256),
          observationDisclosedEphemerally: Boolean(result.observation),
        },
      });
      return { publicResult, observation: result.observation };
    }
    if (["failed", "canceled", "expired"].includes(String(row.state))) {
      throw new LocalComputerCommandError(
        String(row.error_code || row.state),
        `The installed Mac did not complete the action (${row.error_code || row.state}).`,
      );
    }
    await delay(350, input.abortSignal);
  }
  await getSql()`
    UPDATE omni_local_computer_commands
    SET state = 'expired', outcome = 'failed', error_code = 'command_timeout',
        completed_at = NOW(), updated_at = NOW()
    WHERE tenant_id = ${input.executionScope.tenantId}
      AND owner_actor_id = ${input.executionScope.initiatingActorId || ""}
      AND id = ${command.id}
      AND state IN ('queued', 'claimed')
  `;
  throw new LocalComputerCommandError(
    "command_timeout",
    "The installed Mac did not acknowledge the governed action before its lease expired.",
  );
}

function stripObservation(result: ReturnType<typeof localComputerResultSchema.parse>) {
  const { observation: _observation, ...publicResult } = result;
  void _observation;
  return publicResult;
}

function exactMacContext(context: SecurityContext) {
  if (
    context.source !== "mobile" ||
    !context.native ||
    context.native.platform !== "macos" ||
    !context.auth?.userId ||
    !context.auth.sessionId ||
    (context.native.clientContractVersion || 0) <
      LOCAL_COMPUTER_NATIVE_CONTRACT_VERSION
  ) {
    throw new LocalComputerUnavailableError(
      "An authenticated macOS client on native contract v11 or later is required.",
    );
  }
  return {
    deviceId: context.native.deviceId,
    userId: context.auth.userId,
    sessionId: context.auth.sessionId,
    contractVersion: context.native.clientContractVersion!,
  } as const;
}

function requireStorage() {
  if (!hasDatabaseUrl()) {
    throw new LocalComputerUnavailableError(
      "Durable storage is required for device-bound Computer Use.",
    );
  }
}

function publicDevice(row: Record<string, unknown>) {
  const permissions = objectRecord(row.permission_status);
  const online = Boolean(row.enabled) && Date.parse(dateText(row.lease_expires_at)) > Date.now();
  return {
    schemaVersion: LOCAL_COMPUTER_PROTOCOL_VERSION,
    deviceId: String(row.device_id),
    enabled: Boolean(row.enabled),
    online,
    helperVersion: String(row.helper_version),
    permissions: {
      accessibility: String(permissions.accessibility || "unknown"),
      screenRecording: String(permissions.screenRecording || "unknown"),
    },
    activityState: String(row.activity_state),
    lifecycleRevision: Number(row.lifecycle_revision),
    lastSeenAt: dateText(row.last_seen_at),
    leaseExpiresAt: dateText(row.lease_expires_at),
  };
}

function completionReceipt(row: Record<string, unknown>) {
  return {
    schemaVersion: LOCAL_COMPUTER_PROTOCOL_VERSION,
    accepted: true as const,
    commandId: String(row.id),
    outcome: String(row.outcome),
    resultSha256: row.result_sha256 ? String(row.result_sha256) : null,
    completedAt: dateText(row.completed_at),
  };
}

async function appendLocalComputerEvent(input: {
  executionScope: ExecutionScope;
  type: string;
  streamId: string;
  eventId: string;
  payload: Record<string, unknown>;
}) {
  await appendScopedDomainEvent({
    id: input.eventId,
    streamId: input.streamId,
    type: input.type,
    executionScope: input.executionScope,
    payload: input.payload,
  });
}

function digest(parts: readonly string[]) {
  return createHash("sha256").update(parts.join("\0"), "utf8").digest("hex");
}

function toolIdForLocalComputerAction(action: LocalComputerAction) {
  return `local.macos.${action}`;
}

function requiredNativeContractVersionForCommand(
  action: LocalComputerAction,
  input: Record<string, unknown>,
) {
  return action === "open_url" ||
      (action === "observe" && input.presentScreenshot === true)
    ? LOCAL_COMPUTER_OPEN_URL_CONTRACT_VERSION
    : LOCAL_COMPUTER_NATIVE_CONTRACT_VERSION;
}

function opaque(value: string, name: string, max: number) {
  const normalized = value.trim();
  if (
    !normalized || normalized.length > max ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(normalized)
  ) {
    throw new Error(`Local computer ${name} is invalid.`);
  }
  return normalized;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function dateText(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid local computer timestamp.");
  return date.toISOString();
}

function delay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}
