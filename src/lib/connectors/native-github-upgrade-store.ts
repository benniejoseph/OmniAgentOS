import { randomBytes } from "node:crypto";
import { getSql } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { parsePersistedExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { connectorNativeIdSchema, connectorNativeKeySha256, connectorNativeShaSchema,
  NativeConnectorError, type ConnectorNativeScope } from "./native-control-contracts";
import { connectorNativePrivateDigest } from "./native-control-private";
import { nativeConnectorTransaction, projectNativeMcpReview, readNativeConnectorCurrentInTransaction,
  requireNativeConnectorIdentity, nativeConnectorProviderAttemptPending,
  type ConnectorNativeAuthority } from "./native-control-store";
import { resolveMcpBearerCredential } from "./credential-store";
import { discoverMcpTools } from "./mcp-client";
import { isLegacyOfficialGitHubMcpConnector, isRemoteBrowserMcpTool, OFFICIAL_GITHUB_MCP_ALL_ENDPOINT } from "./mcp-trust";
import { evaluateConnectorSecretBinding } from "./secret-binding";
import { createMcpToolId, getMcpConnector, listMcpTools, parseMcpToolId,
  publishNativeGithubMcpUpgrade, resetMcpToolPolicyForReview } from "./store";
import type { McpConnectorRecord, McpToolRecord } from "./types";
import * as C from "./native-github-upgrade-contracts";

type Sql = ReturnType<typeof getSql>;
type Row = Record<string, unknown>;
type ProviderCatalog = Awaited<ReturnType<typeof discoverMcpTools>>;
const same = (a: unknown, b: unknown) => canonicalJsonSha256(a) === canonicalJsonSha256(b);
function conflict(message: string, status = 409): never {
  throw new NativeConnectorError(status === 403 ? "connector_authority" : status === 503 ? "connector_database" : "connector_conflict", status, message);
}
function mutation(authority: ConnectorNativeAuthority, connectorId: string, close = false) {
  const e = parsePersistedExecutionScope(authority.executionScope), s = authority.scope;
  if (!e || e.tenantId !== s.tenantId || e.initiatingActorId !== s.ownerActorId ||
    e.executingPrincipalType !== "user" || e.executingPrincipalId !== s.ownerActorId ||
    e.workspaceId || e.projectId || e.missionId || e.delegationId ||
    e.contextGrantIds.length || e.capabilityGrantIds.length ||
    e.causationId !== connectorId ||
    e.purpose !== (close ? "api.connectors.native.github_upgrade_close" : "api.connectors.native.github_upgrade")) {
    conflict("Exact human GitHub upgrade authority is required.", 403);
  }
  return e;
}
async function clock(sql: Sql) {
  const [row] = await sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`;
  if (typeof row?.now !== "string" || !Number.isFinite(Date.parse(row.now))) conflict("The upgrade clock is unavailable.", 503);
  return row.now;
}
async function keyLock(sql: Sql, scope: ConnectorNativeScope, key: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`native-github-upgrade-key:${scope.tenantId}:${scope.ownerActorId}:${key}`},0))`;
}
async function targetLock(sql: Sql, scope: ConnectorNativeScope, connectorId: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`native-mcp-discovery-target:${scope.tenantId}:${connectorId}`},0))`;
}
async function rowFor(sql: Sql, scope: ConnectorNativeScope, key: string, lock = false) {
  const rows = lock
    ? await sql`SELECT * FROM omni_native_github_upgrades WHERE tenant_id=${scope.tenantId}
        AND owner_actor_id=${scope.ownerActorId} AND idempotency_key_sha256=${key} FOR UPDATE`
    : await sql`SELECT * FROM omni_native_github_upgrades WHERE tenant_id=${scope.tenantId}
        AND owner_actor_id=${scope.ownerActorId} AND idempotency_key_sha256=${key}`;
  if (rows.length > 1) conflict("The original GitHub upgrade identity is inconsistent.");
  if (!rows[0]) return null;
  const row = rows[0], intent = C.connectorNativeGithubUpgradeIntentSchema.parse(row.intent);
  if (!same(intent.scope, scope) || intent.keySha256 !== key ||
    row.id !== C.connectorNativeGithubUpgradeAttemptId(scope, key) ||
    row.canonical_actor_id !== scope.canonicalActorId || row.connector_id !== intent.request.connectorId) {
    conflict("The original GitHub upgrade scope differs.");
  }
  return row;
}
async function readRow(sql: Sql, row: Row): Promise<C.ConnectorNativeGithubUpgradeRead> {
  const base = { intent: row.intent, attempt: row.attempt };
  if (row.state === "closed") {
    return C.connectorNativeGithubUpgradeReadSchema.parse({ ...base, state: "closed", closure: row.closure });
  }
  if (row.state === "settled") {
    return C.connectorNativeGithubUpgradeReadSchema.parse({ ...base, state: "settled", settlement: row.settlement });
  }
  if (row.state !== "pending") conflict("The stored GitHub upgrade state is inconsistent.");
  const attempt = C.connectorNativeGithubUpgradeAttemptSchema.parse(row.attempt);
  return C.connectorNativeGithubUpgradeReadSchema.parse({
    ...base, state: Date.parse(await clock(sql)) >= Date.parse(attempt.expiresAt) ? "expired" : "pending",
  });
}
function credentialDigest(scope: ConnectorNativeScope, connector: McpConnectorRecord, secrets: readonly string[]) {
  return connectorNativePrivateDigest(scope.tenantId, ["native-github-upgrade-credential:1",
    connector.id, connector.endpoint, connector.authType, connector.authTokenEnv ?? null, secrets]);
}
async function currentCredential(scope: ConnectorNativeScope, connector: McpConnectorRecord) {
  if (connector.authType === "none") return credentialDigest(scope, connector, []);
  if (connector.authType === "bearer_env") {
    const binding = evaluateConnectorSecretBinding({
      tenantId: scope.tenantId, targetUrl: OFFICIAL_GITHUB_MCP_ALL_ENDPOINT, envName: connector.authTokenEnv,
    });
    if (!binding.allowed || binding.mode !== "deployer_binding" || !connector.authTokenEnv) {
      conflict("The current GitHub environment credential binding is unavailable.");
    }
    const token = process.env[connector.authTokenEnv.trim().toUpperCase()];
    if (!token) conflict("The current GitHub environment credential is unavailable.");
    return credentialDigest(scope, connector, [token]);
  }
  if (connector.authType !== "bearer_vault" || !connector.credentialConfigured || !connector.credentialOriginMatch) {
    conflict("The current GitHub credential is unavailable.");
  }
  return credentialDigest(scope, connector, [await resolveMcpBearerCredential(connector)]);
}
async function event(sql: Sql, authority: ConnectorNativeAuthority, intent: C.ConnectorNativeGithubUpgradeIntent,
  suffix: string, type: string, payload: Record<string, unknown>) {
  await appendScopedDomainEvent({
    id: `${C.connectorNativeGithubUpgradeAttemptId(intent.scope, intent.keySha256)}:${suffix}`,
    streamId: `connector-native:mcp:${intent.request.connectorId}`, type,
    executionScope: authority.executionScope!,
    payload: { schemaVersion: 1, connectorId: intent.request.connectorId, keySha256: intent.keySha256, ...payload },
  }, { sql });
}
function catalogFor(scope: ConnectorNativeScope, legacy: McpConnectorRecord, existing: McpToolRecord[],
  result: ProviderCatalog, capturedAt: string) {
  if (result.tools.length < 1 || result.tools.length > C.NATIVE_GITHUB_UPGRADE_MAX_TOOLS ||
    new Set(result.tools.map((tool) => tool.name)).size !== result.tools.length ||
    new Set(result.tools.map((tool) => tool.id)).size !== result.tools.length ||
    result.tools.some((tool) => {
      const decoded = parseMcpToolId(tool.id);
      return tool.id !== createMcpToolId(legacy.id, tool.name) || !decoded ||
        decoded.connectorId !== legacy.id || decoded.toolName !== tool.name || isRemoteBrowserMcpTool(tool);
    })) throw new Error("The complete GitHub catalog is not reviewable.");
  const next: McpConnectorRecord = {
    ...legacy, tenantId: scope.tenantId,
    endpoint: OFFICIAL_GITHUB_MCP_ALL_ENDPOINT, status: "disabled",
    defaultRiskLevel: 2, approvalRequired: false, toolCount: result.tools.length,
    capabilities: result.capabilities || {}, instructions: result.instructions || undefined,
    serverVersion: result.serverVersion || undefined, lastDiscoveredAt: capturedAt,
    lastError: undefined, updatedAt: capturedAt,
  };
  // Match the browser's resetPolicy=official-github branch: carry no previous
  // reviewed tool policy into the broader all-toolsets endpoint.
  const tools: McpToolRecord[] = resetMcpToolPolicyForReview({
    discovered: result.tools, existing, connector: next,
  }).map((tool) => ({ ...tool, updatedAt: capturedAt }));
  const prospective = projectNativeMcpReview(scope, next, tools);
  return { connector: next, tools, prospective };
}
async function settle(sql: Sql, authority: ConnectorNativeAuthority, row: Row,
  intent: C.ConnectorNativeGithubUpgradeIntent, attempt: C.ConnectorNativeGithubUpgradeAttempt,
  result: C.ConnectorNativeGithubUpgradeSettlement["result"]) {
  const body = { contract: "asael-github-upgrade-settlement:1", attemptId: attempt.id,
    attemptSha256: attempt.attemptSha256, settledAt: await clock(sql), result };
  const settlement = C.connectorNativeGithubUpgradeSettlementSchema.parse({
    ...body, settlementSha256: canonicalJsonSha256(body),
  });
  const upgrade = C.connectorNativeGithubUpgradeReadSchema.parse({ state: "settled", intent, attempt, settlement });
  const rows = await sql`UPDATE omni_native_github_upgrades SET state='settled',publication_token=NULL,
    settlement=${settlement}::JSONB WHERE id=${row.id} AND tenant_id=${intent.scope.tenantId}
    AND owner_actor_id=${intent.scope.ownerActorId} AND state='pending'
    AND publication_token=${row.publication_token} RETURNING id`;
  if (rows.length !== 1) conflict("The GitHub upgrade publication reservation changed.");
  await event(sql, authority, intent, "settled", "connector.native.github_upgrade.settled",
    { attemptSha256: attempt.attemptSha256, settlementSha256: settlement.settlementSha256 });
  return { upgrade, replayed: false };
}

export async function submitNativeGithubUpgrade(input: {
  authority: ConnectorNativeAuthority; request: C.ConnectorNativeGithubUpgradeRequest; idempotencyKey: string;
}): Promise<{ upgrade: C.ConnectorNativeGithubUpgradeRead; replayed: boolean }> {
  const { authority } = input, scope = authority.scope;
  const request = C.connectorNativeGithubUpgradeRequestSchema.parse(input.request);
  const intent = C.buildConnectorNativeGithubUpgradeIntent(scope, input.idempotencyKey, request);
  const execution = mutation(authority, request.connectorId);
  const admission = await nativeConnectorTransaction(authority, false, async (sql) => {
    await keyLock(sql, scope, intent.keySha256);
    const prior = await rowFor(sql, scope, intent.keySha256, true);
    if (prior) {
      if (!same(prior.intent, intent)) conflict("This GitHub upgrade key already binds another request.");
      return { type: "replay" as const, upgrade: await readRow(sql, prior) };
    }
    await targetLock(sql, scope, request.connectorId);
    await requireNativeConnectorIdentity(sql, scope, true);
    if (await nativeConnectorProviderAttemptPending(sql, scope, request.connectorId)) {
      conflict("The earlier provider attempt must settle or close before another key can be used.");
    }
    const review = await readNativeConnectorCurrentInTransaction(sql, scope, "mcp", request.connectorId, true);
    if (!review || !C.canUpgradeNativeGithubConnector(review) || !same(review.pin, request.review)) {
      conflict("The legacy official GitHub review changed or upgrade is unavailable.");
    }
    const connector = await getMcpConnector(request.connectorId, { tenantId: scope.tenantId });
    if (!connector || !isLegacyOfficialGitHubMcpConnector(connector)) {
      conflict("The legacy official GitHub connector is unavailable.");
    }
    const binding = await currentCredential(scope, connector);
    const startedAt = await clock(sql);
    const expiresAt = new Date(Date.parse(startedAt) + C.NATIVE_GITHUB_UPGRADE_ATTEMPT_MS).toISOString();
    const body = { contract: "asael-github-upgrade-attempt:1",
      id: C.connectorNativeGithubUpgradeAttemptId(scope, intent.keySha256),
      scope, keySha256: intent.keySha256, intentSha256: canonicalJsonSha256(intent),
      connectorId: request.connectorId, reviewSha256: request.review.reviewSha256,
      targetEndpoint: OFFICIAL_GITHUB_MCP_ALL_ENDPOINT, startedAt, expiresAt };
    const attempt = C.connectorNativeGithubUpgradeAttemptSchema.parse({
      ...body, attemptSha256: canonicalJsonSha256(body),
    });
    const token = randomBytes(32).toString("hex");
    const inserted = await sql`INSERT INTO omni_native_github_upgrades(id,tenant_id,owner_actor_id,
      canonical_actor_id,idempotency_key_sha256,connector_id,intent,attempt,attempt_expires_at,
      publication_token,credential_binding_sha256,state)
      VALUES(${attempt.id},${scope.tenantId},${scope.ownerActorId},${scope.canonicalActorId},
      ${intent.keySha256},${request.connectorId},${intent}::JSONB,${attempt}::JSONB,${expiresAt},
      ${token},${binding},'pending') RETURNING id`;
    if (inserted.length !== 1) conflict("The GitHub upgrade attempt was not admitted.");
    await event(sql, authority, intent, "admitted", "connector.native.github_upgrade.admitted",
      { intentSha256: attempt.intentSha256, attemptSha256: attempt.attemptSha256 });
    return { type: "admitted" as const, connector, attempt, token, binding };
  });
  if (admission.type === "replay") return { upgrade: admission.upgrade, replayed: true };
  const { connector, attempt, token, binding } = admission;
  const deadlineAt = Math.min(Date.now() + C.NATIVE_GITHUB_UPGRADE_ATTEMPT_MS, Date.parse(attempt.expiresAt));
  const target: McpConnectorRecord = { ...connector, endpoint: OFFICIAL_GITHUB_MCP_ALL_ENDPOINT,
    status: "disabled", defaultRiskLevel: 2, approvalRequired: false };
  let result: ProviderCatalog | null = null;
  let failure: C.ConnectorNativeGithubUpgradeFailureCode | null = null;
  let credentialChanged = false;
  try {
    result = await discoverMcpTools(target, { deadlineAt, verifyCredential: (secrets) => {
      if (credentialDigest(scope, connector, secrets) !== binding) {
        credentialChanged = true;
        throw new Error("The admitted GitHub credential changed.");
      }
    } });
  } catch {
    failure = credentialChanged ? "target_changed" : Date.now() >= deadlineAt ? "deadline_exceeded" : "discovery_failed";
  }
  return nativeConnectorTransaction(authority, false, async (sql) => {
    await keyLock(sql, scope, intent.keySha256);
    const row = await rowFor(sql, scope, intent.keySha256, true);
    if (!row || !same(row.intent, intent) || !same(row.attempt, attempt)) {
      conflict("The admitted GitHub upgrade identity changed.");
    }
    if (row.state !== "pending") return { upgrade: await readRow(sql, row), replayed: true };
    if (row.publication_token !== token || row.credential_binding_sha256 !== binding) {
      conflict("The admitted GitHub upgrade publication token changed.");
    }
    await targetLock(sql, scope, request.connectorId);
    await requireNativeConnectorIdentity(sql, scope, true);
    const review = await readNativeConnectorCurrentInTransaction(sql, scope, "mcp", request.connectorId, true);
    const now = await clock(sql);
    if (Date.parse(now) >= Date.parse(attempt.expiresAt)) failure = "deadline_exceeded";
    else {
      if (failure === "deadline_exceeded") failure = "discovery_failed";
      if (!review || !C.canUpgradeNativeGithubConnector(review) || !same(review.pin, request.review)) failure = "target_changed";
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
    await publishNativeGithubMcpUpgrade(catalog.connector, catalog.tools, { executionScope: execution, sql });
    const after = await readNativeConnectorCurrentInTransaction(sql, scope, "mcp", request.connectorId, true);
    if (!after?.pin || after.connector.status !== "disabled" ||
      after.connector.endpoint !== OFFICIAL_GITHUB_MCP_ALL_ENDPOINT ||
      after.connector.defaultRiskLevel !== 2 || after.connector.approvalRequired ||
      after.connector.credentialVersion !== request.review.credentialVersion ||
      after.contracts.length !== catalog.tools.length ||
      after.contracts.some((tool) => tool.status !== "pending_review") ||
      after.pin.connectorSha256 !== catalog.prospective.pin?.connectorSha256 ||
      after.pin.contractsSha256 !== catalog.prospective.pin?.contractsSha256 ||
      !same(await getMcpConnector(request.connectorId, { tenantId: scope.tenantId }), catalog.connector)) {
      conflict("The complete persisted GitHub upgrade could not be confirmed.");
    }
    return settle(sql, authority, row, intent, attempt, { status: "complete", kind: "mcp",
      connectorId: request.connectorId, connectorStatus: "disabled",
      endpoint: OFFICIAL_GITHUB_MCP_ALL_ENDPOINT, defaultRiskLevel: 2, approvalRequired: false,
      contractCount: after.contracts.length, pendingCount: after.contracts.length,
      credentialVersion: after.connector.credentialVersion, review: after.pin });
  });
}

export async function readNativeGithubUpgrade(authority: ConnectorNativeAuthority, keySha256: string):
Promise<C.ConnectorNativeGithubUpgradeRead | null> {
  if (authority.executionScope) conflict("GitHub upgrade recovery requires read-only authority.", 400);
  connectorNativeShaSchema.parse(keySha256);
  return nativeConnectorTransaction(authority, false, async (sql) => {
    const row = await rowFor(sql, authority.scope, keySha256);
    return row ? readRow(sql, row) : null;
  });
}

/** A v47-only preview bound to the raw stored endpoint and the exact current
 * private configuration pin. Native v46 review/list shapes stay unchanged. */
export async function reviewNativeGithubUpgrade(authority: ConnectorNativeAuthority, connectorId: string) {
  if (authority.executionScope) conflict("GitHub upgrade review requires read-only authority.", 400);
  connectorNativeIdSchema.parse(connectorId);
  const scope = authority.scope;
  return nativeConnectorTransaction(authority, false, async (sql) => {
    await requireNativeConnectorIdentity(sql, scope, true);
    const review = await readNativeConnectorCurrentInTransaction(sql, scope, "mcp", connectorId, false);
    if (!review) return null;
    const raw = await getMcpConnector(connectorId, { tenantId: scope.tenantId });
    const rawConfigurationSha256 = raw ? connectorNativePrivateDigest(scope.tenantId,
      ["connector-configuration:1", "mcp", raw]) : null;
    let eligible = Boolean(raw && review.pin &&
      review.pin.configurationSha256 === rawConfigurationSha256 &&
      isLegacyOfficialGitHubMcpConnector(raw) &&
      C.canUpgradeNativeGithubConnector(review));
    if (eligible && raw) {
      try { await currentCredential(scope, raw); }
      catch { eligible = false; }
    }
    return { connectorId, eligible, reason: eligible ? "eligible" as const : "unavailable" as const,
      review: review.pin };
  });
}

export async function closeNativeGithubUpgrade(input: {
  authority: ConnectorNativeAuthority; request: C.ConnectorNativeGithubUpgradeCloseRequest;
  idempotencyKey: string; keySha256: string;
}): Promise<{ upgrade: C.ConnectorNativeGithubUpgradeCloseRead; replayed: boolean }> {
  const { authority } = input, scope = authority.scope;
  const request = C.connectorNativeGithubUpgradeCloseRequestSchema.parse(input.request), intent = request.intent;
  mutation(authority, intent.request.connectorId, true);
  if (!same(intent.scope, scope) ||
    intent.keySha256 !== connectorNativeKeySha256(scope, input.idempotencyKey) ||
    intent.keySha256 !== input.keySha256) {
    conflict("The original owner, key and safe GitHub upgrade intent are required.");
  }
  return nativeConnectorTransaction(authority, false, async (sql) => {
    await keyLock(sql, scope, intent.keySha256);
    const row = await rowFor(sql, scope, intent.keySha256, true);
    if (row && !same(row.intent, intent)) conflict("This GitHub upgrade key already binds another request.");
    if (row && row.state !== "pending") {
      return { upgrade: C.connectorNativeGithubUpgradeCloseReadSchema.parse(await readRow(sql, row)), replayed: true };
    }
    await targetLock(sql, scope, intent.request.connectorId);
    const attempt = row ? C.connectorNativeGithubUpgradeAttemptSchema.parse(row.attempt) : null;
    const body = { contract: "asael-github-upgrade-closure:1", scope, keySha256: intent.keySha256,
      intentSha256: canonicalJsonSha256(intent), attemptId: attempt?.id ?? null,
      attemptSha256: attempt?.attemptSha256 ?? null, closedAt: await clock(sql) };
    const closure = C.connectorNativeGithubUpgradeClosureSchema.parse({
      ...body, closureSha256: canonicalJsonSha256(body),
    });
    if (row) {
      const changed = await sql`UPDATE omni_native_github_upgrades SET state='closed',publication_token=NULL,
        closure=${closure}::JSONB WHERE id=${row.id} AND tenant_id=${scope.tenantId}
        AND owner_actor_id=${scope.ownerActorId} AND state='pending' RETURNING id`;
      if (changed.length !== 1) conflict("The GitHub upgrade closure reservation changed.");
    } else {
      await sql`INSERT INTO omni_native_github_upgrades(id,tenant_id,owner_actor_id,canonical_actor_id,
        idempotency_key_sha256,connector_id,intent,state,closure)
        VALUES(${C.connectorNativeGithubUpgradeAttemptId(scope, intent.keySha256)},
          ${scope.tenantId},${scope.ownerActorId},${scope.canonicalActorId},${intent.keySha256},
          ${intent.request.connectorId},${intent}::JSONB,'closed',${closure}::JSONB)`;
    }
    await event(sql, authority, intent, "closed", "connector.native.github_upgrade.closed",
      { intentSha256: closure.intentSha256, closureSha256: closure.closureSha256, admitted: attempt !== null });
    return { upgrade: C.connectorNativeGithubUpgradeCloseReadSchema.parse({
      state: "closed", intent, attempt, closure,
    }), replayed: false };
  });
}
