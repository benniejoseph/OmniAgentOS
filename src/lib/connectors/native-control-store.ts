import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseActorScope, runWithManagedDatabaseTransaction } from "@/lib/db/client";
import { getMcpConnector, listMcpTools, promoteMcpContracts, updateMcpConnector } from "@/lib/connectors/store";
import { getOpenApiConnector, listOpenApiOperations, promoteOpenApiContracts } from "@/lib/connectors/openapi-store";
import { mcpContractReviewSummary, mcpToolContractFingerprint, openApiContractReviewSummary, openApiOperationContractFingerprint } from "@/lib/connectors/contract-review";
import { assertMcpConnectorIsSupported } from "@/lib/connectors/mcp-trust";
import { buildConnectorNativeIntent, connectorNativeAcceptanceId, connectorNativeAcceptanceSchema, connectorNativeActionSchema,
  connectorNativeContractSchema, connectorNativeIdSchema, connectorNativeIntentSchema, connectorNativeKindSchema,
  connectorNativeReviewSchema, connectorNativeScopeSchema, connectorNativeSettlementSchema, connectorNativeShaSchema,
  connectorNativeSummarySchema, connectorNativeRequestSchema, connectorNativeRequestReviewSha, NativeConnectorError, sealConnectorNativePin,
  type ConnectorNativeAction, type ConnectorNativeKind, type ConnectorNativeRequest, type ConnectorNativeScope } from "@/lib/connectors/native-control-contracts";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { parsePersistedExecutionScope, type ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { connectorNativePrivateDigest, connectorNativePrivateFingerprint, connectorNativePublicEndpoint } from "@/lib/connectors/native-control-private";
import { evaluateConnectorSecretBinding } from "@/lib/connectors/secret-binding";
import type { OpenApiConnectorRecord, OpenApiOperationRecord } from "@/lib/connectors/openapi-types";
import type { McpConnectorRecord, McpToolRecord } from "@/lib/connectors/types";

type Sql = ReturnType<typeof getSql>;
export type ConnectorNativeAuthority = { scope: ConnectorNativeScope; executionScope?: ExecutionScope };
function fail(message: string, code = "connector_conflict", status = 409): never { throw new NativeConnectorError(code, status, message); }
const same = (a: unknown, b: unknown) => canonicalJsonSha256(a) === canonicalJsonSha256(b);
function readOnly(authority: ConnectorNativeAuthority) { if (authority.executionScope) fail("Connector reads require read-only authority.", "connector_read_authority", 400); }
function mutationScope(authority: ConnectorNativeAuthority, connectorId: string) {
  const e = parsePersistedExecutionScope(authority.executionScope), s = authority.scope;
  if (!e || e.tenantId !== s.tenantId || e.initiatingActorId !== s.ownerActorId || e.executingPrincipalType !== "user" ||
    e.executingPrincipalId !== s.ownerActorId || e.workspaceId || e.projectId || e.missionId || e.delegationId || e.contextGrantIds.length || e.capabilityGrantIds.length ||
    e.purpose !== "api.connectors.native.action" || e.causationId !== connectorId) fail("Exact human connector authority is required.", "connector_authority", 403);
  return e;
}
async function identity(sql: Sql, scope: ConnectorNativeScope, management: boolean) {
  const rows = await sql`SELECT public.omni_native_connector_actor_v1(${scope.tenantId},${scope.ownerActorId},${scope.canonicalActorId},${management}) AS allowed`;
  if (rows.length !== 1 || rows[0].allowed !== true) fail("Current connector access is unavailable.", "connector_authority", 403);
}
async function transaction<T>(authority: ConnectorNativeAuthority, management: boolean, work: (sql: Sql) => Promise<T>): Promise<T> {
  connectorNativeScopeSchema.parse(authority.scope);
  if (!hasDatabaseUrl()) fail("Durable connector controls require the canonical database.", "connector_database", 503);
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(authority.scope.tenantId, [...new Set([authority.scope.ownerActorId, authority.scope.canonicalActorId])], () =>
    getSql().transaction((sql: Sql) => runWithManagedDatabaseTransaction(sql, async () => {
      const joined = getSql(); await identity(joined, authority.scope, management); return work(joined);
    })) as Promise<T>);
}
/** Parent FOR UPDATE prevents contract inserts through their foreign keys.
 * Existing contract rows are then locked in a stable order before inspection. */
async function current(sql: Sql, scope: ConnectorNativeScope, kind: ConnectorNativeKind, connectorId: string, lock: boolean) {
  connectorNativeKindSchema.parse(kind); connectorNativeIdSchema.parse(connectorId);
  const tenantId = scope.tenantId;
  const parents = kind === "mcp"
    ? lock ? await sql`SELECT id FROM omni_mcp_connectors WHERE tenant_id=${tenantId} AND id=${connectorId} FOR UPDATE`
      : await sql`SELECT id FROM omni_mcp_connectors WHERE tenant_id=${tenantId} AND id=${connectorId}`
    : lock ? await sql`SELECT id FROM omni_openapi_connectors WHERE tenant_id=${tenantId} AND id=${connectorId} FOR UPDATE`
      : await sql`SELECT id FROM omni_openapi_connectors WHERE tenant_id=${tenantId} AND id=${connectorId}`;
  if (!parents.length) return null;
  const children = kind === "mcp"
    ? lock ? await sql`SELECT id FROM omni_mcp_tools WHERE tenant_id=${tenantId} AND connector_id=${connectorId} ORDER BY id COLLATE "C" LIMIT 201 FOR UPDATE`
      : await sql`SELECT id FROM omni_mcp_tools WHERE tenant_id=${tenantId} AND connector_id=${connectorId} ORDER BY id COLLATE "C" LIMIT 201`
    : lock ? await sql`SELECT id FROM omni_openapi_operations WHERE tenant_id=${tenantId} AND connector_id=${connectorId} ORDER BY id COLLATE "C" LIMIT 201 FOR UPDATE`
      : await sql`SELECT id FROM omni_openapi_operations WHERE tenant_id=${tenantId} AND connector_id=${connectorId} ORDER BY id COLLATE "C" LIMIT 201`;
  const mcp = kind === "mcp" ? await getMcpConnector(connectorId, { tenantId }) : null;
  const openapi = kind === "openapi" ? await getOpenApiConnector(connectorId, { tenantId }) : null;
  const connector = mcp || openapi; if (!connector) fail("The connector changed during review.");
  const summary = connectorNativeSummarySchema.parse({ kind, id: connector.id, name: connector.name,
    ...connectorNativePublicEndpoint(mcp?.endpoint ?? openapi!.baseUrl),
    status: connector.status, authType: connector.authType, authTokenEnv: connector.authTokenEnv ?? null, authHeaderName: openapi?.authHeaderName ?? null,
    credentialConfigured: Boolean(mcp?.credentialConfigured), credentialVersion: mcp?.credentialVersion ?? 0, credentialOriginMatch: Boolean(mcp?.credentialOriginMatch),
    defaultRiskLevel: connector.defaultRiskLevel, approvalRequired: connector.approvalRequired,
    contractCount: mcp?.toolCount ?? openapi?.operationCount ?? 0, discoveredAt: mcp?.lastDiscoveredAt ?? openapi?.lastImportedAt ?? null, updatedAt: connector.updatedAt });
  if (children.length > 200) return connectorNativeReviewSchema.parse({ connector: summary, contracts: [], pin: null, availableActions: [], unavailableReason: "scope_too_large" });
  const tools = mcp ? await listMcpTools(connectorId, { tenantId }) : [];
  const operations = openapi ? await listOpenApiOperations(connectorId, { tenantId }) : [];
  if (tools.length + operations.length !== children.length) fail("The complete connector contract set changed during review.");
  let supported = true;
  if (mcp) { try { assertMcpConnectorIsSupported(mcp); } catch { supported = false; } }
  const rows = mcp ? nativeMcpContractRows(tenantId, mcp, tools)
    : nativeOpenapiContractRows(tenantId, openapi!, operations);
  rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (Buffer.byteLength(JSON.stringify(rows), "utf8") > 1_048_576 || rows.some((row) => !connectorNativeContractSchema.safeParse(row).success)) {
    return connectorNativeReviewSchema.parse({ connector: summary, contracts: [], pin: null, availableActions: [], unavailableReason: "scope_too_large" });
  }
  if (!supported) return connectorNativeReviewSchema.parse({ connector: summary, contracts: [], pin: null, availableActions: [], unavailableReason: "unsupported_connector" });
  const contracts = rows.map((row) => connectorNativeContractSchema.parse(row));
  const review = mcp ? mcpContractReviewSummary(tools, mcp) : openApiContractReviewSummary(operations, openapi!);
  const pin = sealConnectorNativePin({ kind, connectorId, connectorSha256: canonicalJsonSha256(summary), contractsSha256: canonicalJsonSha256(contracts),
    configurationSha256: connectorNativePrivateDigest(tenantId, ["connector-configuration:1", kind, connector]),
    credentialVersion: summary.credentialVersion, reviewFingerprint: review.fingerprint ? connectorNativePrivateFingerprint(tenantId, review.fingerprint) : null });
  const envBinding = evaluateConnectorSecretBinding({ tenantId, targetUrl: mcp?.endpoint ?? openapi!.baseUrl,
    envName: connector.authType === "bearer_env" || connector.authType === "api_key_header_env" ? connector.authTokenEnv : undefined });
  const validCredential = envBinding.allowed && (!mcp || mcp.authType !== "bearer_vault" || mcp.credentialConfigured && mcp.credentialOriginMatch);
  const availableActions: Array<ConnectorNativeRequest["action"]> = [];
  if (review.pendingCount > 0 && validCredential) availableActions.push("review_contracts");
  if (mcp) {
    if (mcp.status !== "active" && mcp.lastDiscoveredAt && review.pendingCount === 0 && validCredential) availableActions.push("enable");
    if (mcp.status !== "disabled") availableActions.push("disable");
  }
  return connectorNativeReviewSchema.parse({ connector: summary, contracts, pin, availableActions, unavailableReason: null });
}
async function accepted(sql: Sql, scope: ConnectorNativeScope, keySha256: string, conflictOnOtherAction = false) {
  const rows = await sql`SELECT action,intent,acceptance,state,settlement FROM omni_native_connector_actions
    WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId} AND idempotency_key_sha256=${keySha256}`;
  if (!rows.length) return null;
  // A lifecycle key is not a v40 state-action receipt. Never widen its parser.
  if (rows[0].action === "remove_credential" || rows[0].action === "trash" || rows[0].action === "rotate_mcp" || rows[0].action === "register_mcp" || rows[0].action === "import_openapi") {
    if (conflictOnOtherAction) fail("This key already accepted another connector request.");
    return null;
  }
  const intent = connectorNativeIntentSchema.parse(rows[0].intent), action = connectorNativeActionSchema.parse({ acceptance: rows[0].acceptance, state: rows[0].state, settlement: rows[0].settlement });
  const a = action.acceptance;
  if (rows.length !== 1 || !same(intent.scope, scope) || !same(a.scope, scope) || intent.keySha256 !== keySha256 || a.keySha256 !== keySha256 ||
    a.requestSha256 !== canonicalJsonSha256(intent) || a.reviewSha256 !== connectorNativeRequestReviewSha(intent.request) || a.kind !== intent.request.kind ||
    a.connectorId !== intent.request.connectorId || a.action !== intent.request.action) fail("The stored connector acceptance is inconsistent.");
  return { intent, action };
}

function nativeOpenapiContractRows(tenantId: string, connector: OpenApiConnectorRecord, operations: OpenApiOperationRecord[]) {
  return operations.map((operation) => ({ id: operation.id, name: operation.operationId, description: operation.description ?? null, status: operation.status,
    riskLevel: operation.riskLevel, approvalRequired: operation.approvalRequired,
    fingerprint: connectorNativePrivateFingerprint(tenantId, openApiOperationContractFingerprint(operation, connector)),
    definition: { summary: operation.summary ?? null, method: operation.method, path: operation.path, inputSchema: operation.inputSchema,
      requestContentType: operation.requestContentType ?? null, responseContentTypes: operation.responseContentTypes } }));
}

function nativeMcpContractRows(tenantId: string, connector: McpConnectorRecord, tools: McpToolRecord[]) {
  return tools.map((tool) => ({ id: tool.id, name: tool.name, description: tool.description ?? null, status: tool.status,
    riskLevel: tool.riskLevel, approvalRequired: tool.approvalRequired,
    fingerprint: connectorNativePrivateFingerprint(tenantId, mcpToolContractFingerprint(tool, connector)),
    definition: { title: tool.title ?? null, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema ?? null, annotations: tool.annotations ?? null } }));
}

/** Complete prospective native review; it opens no database or provider call. */
export function projectNativeMcpReview(scope: ConnectorNativeScope, connector: McpConnectorRecord, tools: McpToolRecord[]) {
  if (connector.tenantId !== scope.tenantId || connector.status !== "disabled" || connector.toolCount !== tools.length || tools.length > 200 ||
    tools.some((tool) => tool.tenantId !== scope.tenantId || tool.connectorId !== connector.id || tool.connectorName !== connector.name)) {
    fail("The complete disabled MCP review is unavailable.");
  }
  assertMcpConnectorIsSupported(connector);
  const summary = connectorNativeSummarySchema.parse({ kind: "mcp", id: connector.id, name: connector.name,
    ...connectorNativePublicEndpoint(connector.endpoint), status: connector.status, authType: connector.authType,
    authTokenEnv: connector.authTokenEnv ?? null, authHeaderName: null, credentialConfigured: Boolean(connector.credentialConfigured),
    credentialVersion: connector.credentialVersion ?? 0, credentialOriginMatch: Boolean(connector.credentialOriginMatch),
    defaultRiskLevel: connector.defaultRiskLevel, approvalRequired: connector.approvalRequired, contractCount: tools.length,
    discoveredAt: connector.lastDiscoveredAt ?? null, updatedAt: connector.updatedAt });
  const rows = nativeMcpContractRows(scope.tenantId, connector, tools).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (Buffer.byteLength(JSON.stringify(rows), "utf8") > 1_048_576) fail("The complete native MCP review is too large.");
  const contracts = rows.map((row) => connectorNativeContractSchema.parse(row)), review = mcpContractReviewSummary(tools, connector);
  const pin = sealConnectorNativePin({ kind: "mcp", connectorId: connector.id, connectorSha256: canonicalJsonSha256(summary),
    contractsSha256: canonicalJsonSha256(contracts), configurationSha256: connectorNativePrivateDigest(scope.tenantId, ["connector-configuration:1", "mcp", connector]),
    credentialVersion: summary.credentialVersion, reviewFingerprint: review.fingerprint ? connectorNativePrivateFingerprint(scope.tenantId, review.fingerprint) : null });
  return connectorNativeReviewSchema.parse({ connector: summary, contracts, pin, availableActions: [], unavailableReason: null });
}

/** Pure prospective projection for the native import's complete immutable
 * snapshot. It shares contract rows with exact GET and does not create a row. */
export function projectNativeOpenapiReview(scope: ConnectorNativeScope, connector: OpenApiConnectorRecord, operations: OpenApiOperationRecord[]) {
  if (connector.tenantId !== scope.tenantId || operations.some((operation) => operation.tenantId !== scope.tenantId || operation.connectorId !== connector.id) ||
    connector.operationCount !== operations.length || operations.length < 1 || operations.length > 200) fail("The complete OpenAPI review is unavailable.");
  const summary = connectorNativeSummarySchema.parse({ kind: "openapi", id: connector.id, name: connector.name,
    ...connectorNativePublicEndpoint(connector.baseUrl), status: connector.status, authType: connector.authType,
    authTokenEnv: connector.authTokenEnv ?? null, authHeaderName: connector.authHeaderName ?? null,
    credentialConfigured: false, credentialVersion: 0, credentialOriginMatch: false, defaultRiskLevel: connector.defaultRiskLevel,
    approvalRequired: connector.approvalRequired, contractCount: operations.length, discoveredAt: connector.lastImportedAt ?? null, updatedAt: connector.updatedAt });
  const contracts = nativeOpenapiContractRows(scope.tenantId, connector, operations)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((row) => connectorNativeContractSchema.parse(row));
  const review = openApiContractReviewSummary(operations, connector);
  const pin = sealConnectorNativePin({ kind: "openapi", connectorId: connector.id, connectorSha256: canonicalJsonSha256(summary),
    contractsSha256: canonicalJsonSha256(contracts), configurationSha256: connectorNativePrivateDigest(scope.tenantId, ["connector-configuration:1", "openapi", connector]),
    credentialVersion: 0, reviewFingerprint: review.fingerprint ? connectorNativePrivateFingerprint(scope.tenantId, review.fingerprint) : null });
  const allowed = evaluateConnectorSecretBinding({ tenantId: scope.tenantId, targetUrl: connector.baseUrl,
    envName: connector.authType === "none" ? undefined : connector.authTokenEnv }).allowed;
  const result = connectorNativeReviewSchema.parse({ connector: summary, contracts, pin,
    availableActions: review.pendingCount > 0 && allowed ? ["review_contracts"] : [], unavailableReason: null });
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 1_048_576) fail("This complete import exceeds native review bounds. Use the browser.", "connector_bounds", 400);
  return result;
}
export async function listNativeConnectors(authority: ConnectorNativeAuthority) {
  readOnly(authority);
  return transaction(authority, false, async (sql) => {
    const rows = await sql`SELECT kind,id FROM (SELECT 'mcp' AS kind,id FROM omni_mcp_connectors WHERE tenant_id=${authority.scope.tenantId}
      UNION ALL SELECT 'openapi' AS kind,id FROM omni_openapi_connectors WHERE tenant_id=${authority.scope.tenantId}) targets ORDER BY kind,id COLLATE "C" LIMIT 51`;
    const connectors = [];
    for (const row of rows.slice(0, 50)) { const review = await current(sql, authority.scope, connectorNativeKindSchema.parse(row.kind), String(row.id), false);
      if (review && review.unavailableReason !== "unsupported_connector") connectors.push(review.connector); }
    return { connectors, hasMore: rows.length > 50 };
  });
}
export async function reviewNativeConnector(authority: ConnectorNativeAuthority, kind: ConnectorNativeKind, connectorId: string) {
  readOnly(authority); return transaction(authority, false, (sql) => current(sql, authority.scope, kind, connectorId, false));
}
export async function readNativeConnectorAction(authority: ConnectorNativeAuthority, keySha256: string): Promise<ConnectorNativeAction | null> {
  readOnly(authority); connectorNativeShaSchema.parse(keySha256);
  return transaction(authority, false, async (sql) => (await accepted(sql, authority.scope, keySha256))?.action ?? null);
}
export async function submitNativeConnectorAction(input: { authority: ConnectorNativeAuthority; request: ConnectorNativeRequest; idempotencyKey: string }) {
  const { authority } = input, scope = authority.scope, intent = buildConnectorNativeIntent(scope, input.idempotencyKey, input.request), request = connectorNativeRequestSchema.parse(intent.request);
  const execution = mutationScope(authority, request.connectorId);
  return transaction(authority, true, async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`native-connector-key:${scope.tenantId}:${scope.ownerActorId}:${intent.keySha256}`},0))`;
    const replay = await accepted(sql, scope, intent.keySha256, true);
    if (replay) { if (!same(replay.intent, intent)) fail("This key already accepted another connector request."); return { action: replay.action, replayed: true }; }
    const reviewed = await current(sql, scope, request.kind, request.connectorId, true);
    if (!reviewed?.pin || !same(reviewed.pin, request.review) || !reviewed.availableActions.includes(request.action)) fail("The reviewed connector changed or this action is unavailable.");
    await identity(sql, scope, true);
    const acceptedAt = new Date().toISOString(), body = { contract: "asael-connector-acceptance:1", id: connectorNativeAcceptanceId(scope, intent.keySha256), scope,
      keySha256: intent.keySha256, requestSha256: canonicalJsonSha256(intent), kind: request.kind, connectorId: request.connectorId,
      action: request.action, reviewSha256: request.review.reviewSha256, acceptedAt };
    const acceptance = connectorNativeAcceptanceSchema.parse({ ...body, acceptanceSha256: canonicalJsonSha256(body) });
    await sql`INSERT INTO omni_native_connector_actions(id,tenant_id,owner_actor_id,canonical_actor_id,idempotency_key_sha256,kind,connector_id,action,intent,acceptance,accepted_at,state)
      VALUES(${acceptance.id},${scope.tenantId},${scope.ownerActorId},${scope.canonicalActorId},${intent.keySha256},${request.kind},${request.connectorId},${request.action},
        ${intent}::JSONB,${acceptance}::JSONB,${acceptedAt},'accepted')`;
    let promotedCount = 0;
    if (request.action === "review_contracts") {
      if (!request.review.reviewFingerprint) fail("The exact pending contract fingerprint is missing.");
      const internalConnector = request.kind === "mcp" ? await getMcpConnector(request.connectorId, { tenantId: scope.tenantId }) : null;
      const internalOpenApi = request.kind === "openapi" ? await getOpenApiConnector(request.connectorId, { tenantId: scope.tenantId }) : null;
      const internalFingerprint = internalConnector ? mcpContractReviewSummary(await listMcpTools(request.connectorId, { tenantId: scope.tenantId }), internalConnector).fingerprint
        : internalOpenApi ? openApiContractReviewSummary(await listOpenApiOperations(request.connectorId, { tenantId: scope.tenantId }), internalOpenApi).fingerprint : undefined;
      if (!internalFingerprint || connectorNativePrivateFingerprint(scope.tenantId, internalFingerprint) !== request.review.reviewFingerprint) fail("The pending contracts changed.");
      const promoted = await (request.kind === "mcp" ? promoteMcpContracts : promoteOpenApiContracts)({ connectorId: request.connectorId,
        expectedFingerprint: internalFingerprint }, { executionScope: execution });
      if (!promoted) fail("The reviewed connector disappeared."); promotedCount = promoted.promoted;
    } else {
      if (request.kind !== "mcp") fail("Only MCP connection state is available here.");
      if (!await updateMcpConnector(request.connectorId, { status: request.action === "enable" ? "active" : "disabled" }, { executionScope: execution })) fail("The reviewed connector disappeared.");
    }
    const after = await current(sql, scope, request.kind, request.connectorId, true);
    if (!after?.pin) fail("The completed connector state could not be confirmed.");
    const settlementBody = { contract: "asael-connector-settlement:1", acceptanceId: acceptance.id, settledAt: new Date().toISOString(),
      result: { kind: request.kind, connectorId: request.connectorId, status: after.connector.status, contractCount: after.contracts.length, promotedCount,
        connectorSha256: after.pin.connectorSha256, contractsSha256: after.pin.contractsSha256 } };
    const settlement = connectorNativeSettlementSchema.parse({ ...settlementBody, settlementSha256: canonicalJsonSha256(settlementBody) });
    const settled = await sql`UPDATE omni_native_connector_actions SET state='settled',settlement=${settlement}::JSONB WHERE id=${acceptance.id} AND tenant_id=${scope.tenantId} AND state='accepted' RETURNING id`;
    if (settled.length !== 1) fail("The accepted connector action could not be settled.");
    await appendScopedDomainEvent({ id: acceptance.id, streamId: `connector-native:${request.kind}:${request.connectorId}`, type: "connector.native.action.accepted",
      executionScope: execution, payload: { schemaVersion: 1, acceptanceId: acceptance.id, action: request.action, kind: request.kind,
        connectorId: request.connectorId, requestSha256: acceptance.requestSha256, acceptanceSha256: acceptance.acceptanceSha256 } }, { sql });
    await appendScopedDomainEvent({ id: `${acceptance.id}:settled`, streamId: `connector-native:${request.kind}:${request.connectorId}`, type: "connector.native.action.settled",
      executionScope: execution, payload: { schemaVersion: 1, acceptanceId: acceptance.id, settlementSha256: settlement.settlementSha256 } }, { sql });
    return { action: connectorNativeActionSchema.parse({ acceptance, state: "settled", settlement }), replayed: false };
  });
}

/** Internal seams for the same reviewed connector admission graph. They do
 * not install authority or open another connection when called by its owner. */
export const nativeConnectorTransaction = transaction;
export const requireNativeConnectorIdentity = identity;
export const requireNativeConnectorMutationScope = mutationScope;
export const readNativeConnectorCurrentInTransaction = current;
export const readNativeConnectorAcceptedInTransaction = accepted;
