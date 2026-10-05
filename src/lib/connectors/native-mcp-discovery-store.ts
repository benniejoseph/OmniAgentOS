import { randomBytes } from "node:crypto";
import { getSql } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { parsePersistedExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { connectorNativeKeySha256, connectorNativeShaSchema, NativeConnectorError, type ConnectorNativeScope } from "./native-control-contracts";
import { connectorNativePrivateDigest } from "./native-control-private";
import { nativeConnectorTransaction, projectNativeMcpReview, readNativeConnectorCurrentInTransaction,
  requireNativeConnectorIdentity, nativeConnectorProviderAttemptPending,
  type ConnectorNativeAuthority } from "./native-control-store";
import { resolveMcpBearerCredential } from "./credential-store";
import { discoverMcpTools } from "./mcp-client";
import { isRemoteBrowserMcpTool } from "./mcp-trust";
import { evaluateConnectorSecretBinding } from "./secret-binding";
import { createMcpToolId, getMcpConnector, listMcpTools, parseMcpToolId, preserveReviewedMcpToolPolicy, replaceDisabledNativeMcpCatalog } from "./store";
import type { McpConnectorRecord, McpToolRecord } from "./types";
import * as C from "./native-mcp-discovery-contracts";

type Sql = ReturnType<typeof getSql>;
type Row = Record<string, unknown>;
type ProviderCatalog = Awaited<ReturnType<typeof discoverMcpTools>>;
const same = (a: unknown, b: unknown) => canonicalJsonSha256(a) === canonicalJsonSha256(b);
function conflict(message: string, status = 409): never { throw new NativeConnectorError(status === 403 ? "connector_authority" : "connector_conflict", status, message); }
function mutation(authority: ConnectorNativeAuthority, connectorId: string, close = false) {
  const e = parsePersistedExecutionScope(authority.executionScope), s = authority.scope;
  if (!e || e.tenantId !== s.tenantId || e.initiatingActorId !== s.ownerActorId || e.executingPrincipalType !== "user" ||
    e.executingPrincipalId !== s.ownerActorId || e.workspaceId || e.projectId || e.missionId || e.delegationId ||
    e.contextGrantIds.length || e.capabilityGrantIds.length || e.causationId !== connectorId ||
    e.purpose !== (close ? "api.connectors.native.mcp_discovery_close" : "api.connectors.native.mcp_discovery")) {
    conflict("Exact human MCP discovery authority is required.", 403);
  }
  return e;
}
async function clock(sql: Sql) {
  const [row] = await sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`;
  if (typeof row?.now !== "string" || !Number.isFinite(Date.parse(row.now))) conflict("The discovery clock is unavailable.", 503);
  return row.now;
}
async function keyLock(sql: Sql, scope: ConnectorNativeScope, key: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`native-mcp-discovery-key:${scope.tenantId}:${scope.ownerActorId}:${key}`},0))`;
}
async function targetLock(sql: Sql, scope: ConnectorNativeScope, connectorId: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`native-mcp-discovery-target:${scope.tenantId}:${connectorId}`},0))`;
}
async function rowFor(sql: Sql, scope: ConnectorNativeScope, key: string, lock = false) {
  const rows = lock ? await sql`SELECT * FROM omni_native_mcp_discoveries WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId}
    AND idempotency_key_sha256=${key} FOR UPDATE` : await sql`SELECT * FROM omni_native_mcp_discoveries WHERE tenant_id=${scope.tenantId}
    AND owner_actor_id=${scope.ownerActorId} AND idempotency_key_sha256=${key}`;
  if (rows.length > 1) conflict("The original discovery identity is inconsistent.");
  if (!rows[0]) return null;
  const row = rows[0], intent = C.connectorNativeMcpDiscoveryIntentSchema.parse(row.intent);
  if (!same(intent.scope, scope) || intent.keySha256 !== key || row.id !== C.connectorNativeMcpDiscoveryAttemptId(scope, key) ||
    row.canonical_actor_id !== scope.canonicalActorId || row.connector_id !== intent.request.connectorId) {
    conflict("The original discovery scope differs.");
  }
  return row;
}
async function readRow(sql: Sql, row: Row): Promise<C.ConnectorNativeMcpDiscoveryRead> {
  const base = { intent: row.intent, attempt: row.attempt };
  if (row.state === "settled") return C.connectorNativeMcpDiscoveryReadSchema.parse({ ...base, state: "settled", settlement: row.settlement });
  if (row.state === "closed") return C.connectorNativeMcpDiscoveryReadSchema.parse({ ...base, state: "closed", closure: row.closure });
  if (row.state !== "pending") conflict("The stored discovery state is inconsistent.");
  const attempt = C.connectorNativeMcpDiscoveryAttemptSchema.parse(row.attempt);
  return C.connectorNativeMcpDiscoveryReadSchema.parse({ ...base, state: Date.parse(await clock(sql)) >= Date.parse(attempt.expiresAt) ? "expired" : "pending" });
}
function credentialDigest(scope: ConnectorNativeScope, connector: McpConnectorRecord, secrets: readonly string[]) {
  return connectorNativePrivateDigest(scope.tenantId, ["native-mcp-discovery-credential:1", connector.id, connector.endpoint,
    connector.authType, connector.authTokenEnv ?? null, secrets]);
}
async function currentCredential(scope: ConnectorNativeScope, connector: McpConnectorRecord) {
  if (connector.authType === "none") return credentialDigest(scope, connector, []);
  if (connector.authType === "bearer_env") {
    const binding = evaluateConnectorSecretBinding({ tenantId: scope.tenantId, targetUrl: connector.endpoint, envName: connector.authTokenEnv });
    if (!binding.allowed || binding.mode !== "deployer_binding" || !connector.authTokenEnv) conflict("The current environment credential binding is unavailable.");
    const token = process.env[connector.authTokenEnv.trim().toUpperCase()];
    if (!token) conflict("The current environment credential is unavailable.");
    return credentialDigest(scope, connector, [token]);
  }
  if (connector.authType !== "bearer_vault" || !connector.credentialConfigured || !connector.credentialOriginMatch) {
    conflict("The current MCP credential is unavailable.");
  }
  return credentialDigest(scope, connector, [await resolveMcpBearerCredential(connector)]);
}
async function event(sql: Sql, authority: ConnectorNativeAuthority, intent: C.ConnectorNativeMcpDiscoveryIntent,
  suffix: string, type: string, payload: Record<string, unknown>) {
  await appendScopedDomainEvent({ id: `${C.connectorNativeMcpDiscoveryAttemptId(intent.scope, intent.keySha256)}:${suffix}`,
    streamId: `connector-native:mcp:${intent.request.connectorId}`, type, executionScope: authority.executionScope!,
    payload: { schemaVersion: 1, connectorId: intent.request.connectorId, keySha256: intent.keySha256, ...payload } }, { sql });
}
function catalogFor(scope: ConnectorNativeScope, connector: McpConnectorRecord, existing: McpToolRecord[], result: ProviderCatalog, capturedAt: string) {
  if (result.tools.length > C.NATIVE_MCP_DISCOVERY_MAX_TOOLS || new Set(result.tools.map((tool) => tool.name)).size !== result.tools.length ||
    new Set(result.tools.map((tool) => tool.id)).size !== result.tools.length || result.tools.some((tool) => {
      const decoded = parseMcpToolId(tool.id);
      return tool.id !== createMcpToolId(connector.id, tool.name) || !decoded || decoded.connectorId !== connector.id ||
        decoded.toolName !== tool.name || isRemoteBrowserMcpTool(tool);
    })) throw new Error("The complete MCP catalog is not reviewable.");
  const next: McpConnectorRecord = { ...connector, status: "disabled", toolCount: result.tools.length, capabilities: result.capabilities || {},
    instructions: result.instructions || undefined, serverVersion: result.serverVersion || undefined,
    lastDiscoveredAt: capturedAt, lastError: undefined, updatedAt: capturedAt };
  const tools = preserveReviewedMcpToolPolicy({ connector: next, reviewedConnector: connector, existing, discovered: result.tools }).map((tool) => ({
    ...tool, title: tool.title || undefined, description: tool.description || undefined, updatedAt: capturedAt,
  }));
  const prospective = projectNativeMcpReview(scope, next, tools);
  return { connector: next, tools, prospective };
}
async function settle(sql: Sql, authority: ConnectorNativeAuthority, row: Row, intent: C.ConnectorNativeMcpDiscoveryIntent,
  attempt: C.ConnectorNativeMcpDiscoveryAttempt, result: C.ConnectorNativeMcpDiscoverySettlement["result"]) {
  const body = { contract: "asael-mcp-discovery-settlement:1", attemptId: attempt.id, attemptSha256: attempt.attemptSha256,
    settledAt: await clock(sql), result };
  const settlement = C.connectorNativeMcpDiscoverySettlementSchema.parse({ ...body, settlementSha256: canonicalJsonSha256(body) });
  const discovery = C.connectorNativeMcpDiscoveryReadSchema.parse({ state: "settled", intent, attempt, settlement });
  const rows = await sql`UPDATE omni_native_mcp_discoveries SET state='settled',publication_token=NULL,settlement=${settlement}::JSONB
    WHERE id=${row.id} AND tenant_id=${intent.scope.tenantId} AND owner_actor_id=${intent.scope.ownerActorId}
      AND state='pending' AND publication_token=${row.publication_token} RETURNING id`;
  if (rows.length !== 1) conflict("The discovery publication reservation changed.");
  await event(sql, authority, intent, "settled", "connector.native.mcp_discovery.settled", { attemptSha256: attempt.attemptSha256, settlementSha256: settlement.settlementSha256 });
  return { discovery, replayed: false };
}

export async function submitNativeMcpDiscovery(input: { authority: ConnectorNativeAuthority; request: C.ConnectorNativeMcpDiscoveryRequest; idempotencyKey: string }):
Promise<{ discovery: C.ConnectorNativeMcpDiscoveryRead; replayed: boolean }> {
  const { authority } = input, scope = authority.scope;
  const request = C.connectorNativeMcpDiscoveryRequestSchema.parse(input.request), intent = C.buildConnectorNativeMcpDiscoveryIntent(scope, input.idempotencyKey, request);
  const execution = mutation(authority, request.connectorId);
  const admission = await nativeConnectorTransaction(authority, false, async (sql) => {
    await keyLock(sql, scope, intent.keySha256);
    const prior = await rowFor(sql, scope, intent.keySha256, true);
    if (prior) {
      if (!same(prior.intent, intent)) conflict("This discovery key already binds another request.");
      return { type: "replay" as const, discovery: await readRow(sql, prior) };
    }
    await targetLock(sql, scope, request.connectorId);
    await requireNativeConnectorIdentity(sql, scope, true);
    if (await nativeConnectorProviderAttemptPending(sql, scope, request.connectorId)) {
      conflict("The earlier provider attempt must settle or close before MCP discovery.");
    }
    const review = await readNativeConnectorCurrentInTransaction(sql, scope, "mcp", request.connectorId, true);
    if (!review || !C.canDiscoverNativeMcpConnector(review) || !same(review.pin, request.review)) conflict("The disabled MCP review changed or discovery is unavailable.");
    const connector = await getMcpConnector(request.connectorId, { tenantId: scope.tenantId });
    if (!connector) conflict("The reviewed MCP connector is unavailable.");
    const binding = await currentCredential(scope, connector), startedAt = await clock(sql), expiresAt = new Date(Date.parse(startedAt) + C.NATIVE_MCP_DISCOVERY_ATTEMPT_MS).toISOString();
    const body = { contract: "asael-mcp-discovery-attempt:1", id: C.connectorNativeMcpDiscoveryAttemptId(scope, intent.keySha256), scope,
      keySha256: intent.keySha256, intentSha256: canonicalJsonSha256(intent), kind: "mcp", connectorId: request.connectorId,
      reviewSha256: request.review.reviewSha256, startedAt, expiresAt };
    const attempt = C.connectorNativeMcpDiscoveryAttemptSchema.parse({ ...body, attemptSha256: canonicalJsonSha256(body) });
    const token = randomBytes(32).toString("hex");
    const inserted = await sql`INSERT INTO omni_native_mcp_discoveries(id,tenant_id,owner_actor_id,canonical_actor_id,idempotency_key_sha256,
      connector_id,intent,attempt,attempt_expires_at,publication_token,credential_binding_sha256,state)
      VALUES(${attempt.id},${scope.tenantId},${scope.ownerActorId},${scope.canonicalActorId},${intent.keySha256},${request.connectorId},
        ${intent}::JSONB,${attempt}::JSONB,${expiresAt},${token},${binding},'pending') ON CONFLICT DO NOTHING RETURNING id`;
    if (inserted.length !== 1) conflict("Another discovery must be recovered and explicitly closed before starting this attempt.");
    await event(sql, authority, intent, "admitted", "connector.native.mcp_discovery.admitted", { intentSha256: attempt.intentSha256, attemptSha256: attempt.attemptSha256 });
    return { type: "admitted" as const, connector, attempt, token, binding };
  });
  if (admission.type === "replay") return { discovery: admission.discovery, replayed: true };
  const { attempt, token, connector, binding } = admission;
  const deadlineAt = Math.min(Date.now() + C.NATIVE_MCP_DISCOVERY_ATTEMPT_MS, Date.parse(attempt.expiresAt));
  let result: ProviderCatalog | null = null;
  let failure: C.ConnectorNativeMcpDiscoveryFailureCode | null = null;
  let credentialChanged = false;
  try {
    result = await discoverMcpTools(connector, { deadlineAt, verifyCredential: (secrets) => {
      if (credentialDigest(scope, connector, secrets) !== binding) {
        credentialChanged = true; throw new Error("The admitted credential changed.");
      }
    } });
  } catch {
    failure = credentialChanged ? "target_changed" : Date.now() >= deadlineAt ? "deadline_exceeded" : "discovery_failed";
  }
  return nativeConnectorTransaction(authority, false, async (sql) => {
    await keyLock(sql, scope, intent.keySha256);
    const row = await rowFor(sql, scope, intent.keySha256, true);
    if (!row || !same(row.intent, intent) || !same(row.attempt, attempt)) conflict("The admitted discovery identity changed.");
    if (row.state !== "pending") return { discovery: await readRow(sql, row), replayed: true };
    if (row.publication_token !== token || row.credential_binding_sha256 !== binding) conflict("The admitted discovery publication token changed.");
    await targetLock(sql, scope, request.connectorId);
    await requireNativeConnectorIdentity(sql, scope, true);
    const review = await readNativeConnectorCurrentInTransaction(sql, scope, "mcp", request.connectorId, true);
    const now = await clock(sql);
    if (Date.parse(now) >= Date.parse(attempt.expiresAt)) failure = "deadline_exceeded";
    else {
      // Only the database clock can attest that the durable deadline expired.
      if (failure === "deadline_exceeded") failure = "discovery_failed";
      if (!review || !C.canDiscoverNativeMcpConnector(review) || !same(review.pin, request.review)) failure = "target_changed";
    }
    const current = await getMcpConnector(request.connectorId, { tenantId: scope.tenantId });
    if (!failure && current) {
      try { if (await currentCredential(scope, current) !== binding) failure = "target_changed"; }
      catch { failure = "target_changed"; }
    }
    if (failure || !result || !current) return settle(sql, authority, row, intent, attempt,
      { status: "failed", kind: "mcp", connectorId: request.connectorId, failureCode: failure ?? "target_changed" });
    const existing = await listMcpTools(request.connectorId, { tenantId: scope.tenantId });
    let catalog: ReturnType<typeof catalogFor>;
    try { catalog = catalogFor(scope, current, existing, result, now); }
    catch { return settle(sql, authority, row, intent, attempt,
      { status: "failed", kind: "mcp", connectorId: request.connectorId, failureCode: "catalog_unreviewable" }); }
    // All writes and both event families join this managed transaction. Any
    // event/readback/deadline failure rolls back the previous catalog intact.
    await replaceDisabledNativeMcpCatalog(catalog.connector, catalog.tools, { executionScope: execution, sql });
    const after = await readNativeConnectorCurrentInTransaction(sql, scope, "mcp", request.connectorId, true);
    if (!after?.pin || after.connector.status !== "disabled" || after.connector.credentialVersion !== request.review.credentialVersion ||
      after.pin.connectorSha256 !== catalog.prospective.pin?.connectorSha256 || after.pin.contractsSha256 !== catalog.prospective.pin?.contractsSha256 ||
      !same(await getMcpConnector(request.connectorId, { tenantId: scope.tenantId }), catalog.connector)) {
      conflict("The complete persisted MCP discovery could not be confirmed.");
    }
    return settle(sql, authority, row, intent, attempt, { status: "complete", kind: "mcp", connectorId: request.connectorId,
      connectorStatus: "disabled", contractCount: after.contracts.length, pendingCount: after.contracts.filter((tool) => tool.status === "pending_review").length,
      credentialVersion: after.connector.credentialVersion, review: after.pin });
  });
}

export async function readNativeMcpDiscovery(authority: ConnectorNativeAuthority, keySha256: string): Promise<C.ConnectorNativeMcpDiscoveryRead | null> {
  if (authority.executionScope) conflict("Discovery recovery requires read-only authority.", 400);
  connectorNativeShaSchema.parse(keySha256);
  return nativeConnectorTransaction(authority, false, async (sql) => {
    const row = await rowFor(sql, authority.scope, keySha256);
    return row ? readRow(sql, row) : null;
  });
}
export async function closeNativeMcpDiscovery(input: { authority: ConnectorNativeAuthority; request: C.ConnectorNativeMcpDiscoveryCloseRequest;
  idempotencyKey: string; keySha256: string }): Promise<{ discovery: C.ConnectorNativeMcpDiscoveryCloseRead; replayed: boolean }> {
  const { authority } = input, scope = authority.scope;
  const request = C.connectorNativeMcpDiscoveryCloseRequestSchema.parse(input.request), intent = request.intent;
  mutation(authority, intent.request.connectorId, true);
  if (!same(intent.scope, scope) || intent.keySha256 !== connectorNativeKeySha256(scope, input.idempotencyKey) || intent.keySha256 !== input.keySha256) {
    conflict("The original owner, key and safe discovery intent are required.");
  }
  return nativeConnectorTransaction(authority, false, async (sql) => {
    await keyLock(sql, scope, intent.keySha256);
    const row = await rowFor(sql, scope, intent.keySha256, true);
    if (row && !same(row.intent, intent)) conflict("This discovery key already binds another request.");
    if (row && row.state !== "pending") return { discovery: C.connectorNativeMcpDiscoveryCloseReadSchema.parse(await readRow(sql, row)), replayed: true };
    await targetLock(sql, scope, intent.request.connectorId);
    const attempt = row ? C.connectorNativeMcpDiscoveryAttemptSchema.parse(row.attempt) : null;
    const body = { contract: "asael-mcp-discovery-closure:1", scope, keySha256: intent.keySha256, intentSha256: canonicalJsonSha256(intent),
      attemptId: attempt?.id ?? null, attemptSha256: attempt?.attemptSha256 ?? null, closedAt: await clock(sql) };
    const closure = C.connectorNativeMcpDiscoveryClosureSchema.parse({ ...body, closureSha256: canonicalJsonSha256(body) });
    if (row) {
      const changed = await sql`UPDATE omni_native_mcp_discoveries SET state='closed',publication_token=NULL,closure=${closure}::JSONB
        WHERE id=${row.id} AND tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId} AND state='pending' RETURNING id`;
      if (changed.length !== 1) conflict("The discovery closure reservation changed.");
    } else {
      await sql`INSERT INTO omni_native_mcp_discoveries(id,tenant_id,owner_actor_id,canonical_actor_id,idempotency_key_sha256,
        connector_id,intent,state,closure) VALUES(${C.connectorNativeMcpDiscoveryAttemptId(scope, intent.keySha256)},${scope.tenantId},${scope.ownerActorId},
        ${scope.canonicalActorId},${intent.keySha256},${intent.request.connectorId},${intent}::JSONB,'closed',${closure}::JSONB)`;
    }
    await event(sql, authority, intent, "closed", "connector.native.mcp_discovery.closed", { intentSha256: closure.intentSha256, closureSha256: closure.closureSha256, admitted: attempt !== null });
    return { discovery: C.connectorNativeMcpDiscoveryCloseReadSchema.parse({ state: "closed", intent, attempt, closure }), replayed: false };
  });
}
