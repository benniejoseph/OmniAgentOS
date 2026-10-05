import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseSystemScope } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { parsePersistedExecutionScope } from "@/lib/security/execution-scope";
import { assertPublicHttpUrl } from "@/lib/security/network";
import { openCredentialBundle, sealCredentialBundle } from "@/lib/settings/credential-vault";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { storeMcpBearerCredential } from "./credential-store";
import { getMcpConnector, insertDisabledMcpConnector, McpConnectorInsertConflictError } from "./store";
import { assertMcpConnectorIsSupported } from "./mcp-trust";
import { evaluateConnectorSecretBinding } from "./secret-binding";
import { connectorNativeAcceptanceId, connectorNativeKeySha256, connectorNativeShaSchema,
  NativeConnectorError, type ConnectorNativeScope } from "./native-control-contracts";
import { connectorNativePrivateDigest } from "./native-control-private";
import { nativeConnectorTransaction, readNativeConnectorCurrentInTransaction, requireNativeConnectorIdentity,
  requireNativeConnectorMutationScope, type ConnectorNativeAuthority } from "./native-control-store";
import { buildConnectorNativeMcpRegistrationPreparationIntent, buildConnectorNativeMcpRegistrationIntent,
  mcpRegistrationPreparationIntentFromProof, normalizeNativeMcpRegistrationEndpoint, NATIVE_MCP_REGISTRATION_PREPARATION_TTL_MS,
  connectorNativeMcpRegistrationPrepareRequestSchema, connectorNativeMcpRegistrationPreparationId,
  connectorNativeMcpRegistrationPreparationSchema, connectorNativeMcpRegistrationPreparationIntentSchema,
  connectorNativeMcpRegistrationPreparationReadSchema, connectorNativeMcpRegistrationPreparationAbandonedReadSchema,
  connectorNativeMcpRegistrationPreparationAbandonRequestSchema, connectorNativeMcpRegistrationAbandonmentId,
  connectorNativeMcpRegistrationPreparationAbandonmentSchema, connectorNativeMcpRegistrationActionSchema,
  connectorNativeMcpRegistrationAcceptanceSchema, connectorNativeMcpRegistrationIntentSchema, connectorNativeMcpRegistrationSettlementSchema,
  type ConnectorNativeMcpRegistrationPrepareRequest, type ConnectorNativeMcpRegistrationPreparation,
  type ConnectorNativeMcpRegistrationPreparationIntent, type ConnectorNativeMcpRegistrationPreparationRead,
  type ConnectorNativeMcpRegistrationPreparationPreparedRead, type ConnectorNativeMcpRegistrationPreparationAbandonedRead,
  type ConnectorNativeMcpRegistrationPreparationAbandonRequest, type ConnectorNativeMcpRegistrationRequest,
  type ConnectorNativeMcpRegistrationAction } from "./native-mcp-registration-contracts";

type Sql = ReturnType<typeof getSql>;
type Row = Record<string, unknown>;
type Payload = { endpoint: string; bearerToken: string | null };
const same = (a: unknown, b: unknown) => canonicalJsonSha256(a) === canonicalJsonSha256(b);
function fail(message: string, status = 409): never { throw new NativeConnectorError(status === 403 ? "connector_authority" : "connector_conflict", status, message); }
function readOnly(authority: ConnectorNativeAuthority) { if (authority.executionScope) fail("Registration recovery requires read-only authority.", 400); }
async function clock(sql: Sql) {
  const [row] = await sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`;
  if (typeof row?.now !== "string" || !Number.isFinite(Date.parse(row.now))) fail("The registration clock is unavailable.", 503);
  return row.now;
}
async function preparationLock(sql: Sql, scope: ConnectorNativeScope, key: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`native-mcp-registration-preparation:${scope.tenantId}:${scope.ownerActorId}:${key}`},0))`;
}
async function targetLock(sql: Sql, connectorId: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`native-mcp-registration-target:${connectorId}`},0))`;
}
async function preparationRow(sql: Sql, scope: ConnectorNativeScope, key: string, lock = false) {
  const rows = lock
    ? await sql`SELECT * FROM omni_native_mcp_registration_preparations WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId} AND idempotency_key_sha256=${key} FOR UPDATE`
    : await sql`SELECT * FROM omni_native_mcp_registration_preparations WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId} AND idempotency_key_sha256=${key}`;
  if (rows.length > 1) fail("The original registration is inconsistent.");
  const row = rows[0];
  if (row) {
    const intent = connectorNativeMcpRegistrationPreparationIntentSchema.parse(row.intent);
    if (!same(intent.scope, scope) || intent.keySha256 !== key || row.id !== connectorNativeMcpRegistrationPreparationId(scope, key) ||
      row.canonical_actor_id !== scope.canonicalActorId || row.connector_id !== intent.connectorId) fail("The original registration scope differs.");
  }
  return row;
}
async function accepted(sql: Sql, scope: ConnectorNativeScope, key: string) {
  const rows = await sql`SELECT action,intent,acceptance,state,settlement FROM omni_native_connector_actions
    WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId} AND idempotency_key_sha256=${key}`;
  if (!rows.length) return null;
  if (rows.length !== 1) fail("The stored registration acceptance is inconsistent.");
  if (rows[0].action !== "register_mcp") return { otherAction: true as const };
  const intent = connectorNativeMcpRegistrationIntentSchema.parse(rows[0].intent);
  const action = connectorNativeMcpRegistrationActionSchema.parse({ acceptance: rows[0].acceptance, state: rows[0].state, settlement: rows[0].settlement });
  const a = action.acceptance, r = intent.request;
  if (!same(intent.scope, scope) || !same(a.scope, scope) || intent.keySha256 !== key || a.keySha256 !== key ||
    a.requestSha256 !== canonicalJsonSha256(intent) || a.reviewSha256 !== r.preparationSha256 || a.connectorId !== r.connectorId) fail("The stored registration acceptance differs from its intent.");
  const originals = await sql`SELECT intent,preparation,state,consumed_by,consumed_key_sha256 FROM omni_native_mcp_registration_preparations
    WHERE id=${r.preparationId} AND tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId}`;
  if (originals.length !== 1) fail("The original registration proof is unavailable.");
  const original = originals[0], proof = connectorNativeMcpRegistrationPreparationSchema.parse(original.preparation);
  if (!same(proof.scope, scope) || !same(mcpRegistrationPreparationIntentFromProof(proof), original.intent) ||
    proof.connectorId !== r.connectorId || proof.preparationSha256 !== r.preparationSha256 || original.state !== "consumed" ||
    original.consumed_by !== a.id || original.consumed_key_sha256 !== key || action.settlement &&
    action.settlement.result.credentialVersion !== (proof.declaration.authType === "bearer_vault" ? 1 : 0)) fail("The registration receipt differs from its original authentication mode.");
  return { otherAction: false as const, intent, action };
}
async function preparationRead(sql: Sql, scope: ConnectorNativeScope, row: Row): Promise<ConnectorNativeMcpRegistrationPreparationRead> {
  const intent = connectorNativeMcpRegistrationPreparationIntentSchema.parse(row.intent);
  if (row.state === "abandoned") return connectorNativeMcpRegistrationPreparationAbandonedReadSchema.parse({ intent,
    preparation: row.preparation, availability: "abandoned", consumedBy: null, consumedKeySha256: null, abandonment: row.abandonment });
  const proof = connectorNativeMcpRegistrationPreparationSchema.parse(row.preparation);
  if (!same(mcpRegistrationPreparationIntentFromProof(proof), intent)) fail("The registration proof differs from its intent.");
  if (row.state === "consumed") {
    const key = connectorNativeShaSchema.parse(row.consumed_key_sha256), receipt = await accepted(sql, scope, key);
    if (!receipt || receipt.otherAction || receipt.action.acceptance.id !== row.consumed_by || receipt.intent.request.preparationId !== proof.id) fail("The registration consumption receipt differs.");
    return connectorNativeMcpRegistrationPreparationReadSchema.parse({ preparation: proof, availability: "consumed", consumedBy: row.consumed_by, consumedKeySha256: key });
  }
  if (row.state !== "ready" && row.state !== "expired") fail("The registration preparation state is inconsistent.");
  const expired = row.state === "expired" || Date.parse(await clock(sql)) >= Date.parse(proof.expiresAt);
  return connectorNativeMcpRegistrationPreparationReadSchema.parse({ preparation: proof, availability: expired ? "expired" : "ready", consumedBy: null, consumedKeySha256: null });
}
export function nativeMcpRegistrationPreparationBinding(proof: ConnectorNativeMcpRegistrationPreparation) {
  return `asael:native-mcp-registration-preparation:v1:${canonicalJsonSha256({ scope: proof.scope, operation: proof.operation,
    connectorId: proof.connectorId, id: proof.id, keySha256: proof.keySha256, intentSha256: proof.intentSha256,
    configurationSha256: proof.configurationSha256, expiresAt: proof.expiresAt })}`;
}
function payloadCommitment(intent: ConnectorNativeMcpRegistrationPreparationIntent, payload: Payload) {
  return connectorNativePrivateDigest(intent.scope.tenantId, ["native-mcp-registration-payload:1", intent, payload]);
}
function configurationBinding(intent: ConnectorNativeMcpRegistrationPreparationIntent, payload: Payload) {
  return connectorNativePrivateDigest(intent.scope.tenantId, ["native-mcp-registration-configuration:1", intent.scope,
    intent.connectorId, intent.declaration, "streamable_http", payload.endpoint]);
}
function encrypted(intent: ConnectorNativeMcpRegistrationPreparationIntent) {
  return intent.declaration.authType === "bearer_vault" || intent.declaration.endpointRedacted;
}
async function admit(intent: ConnectorNativeMcpRegistrationPreparationIntent, payload: Payload, deadlineAt: number) {
  try { assertMcpConnectorIsSupported({ name: intent.declaration.name, endpoint: payload.endpoint }); }
  catch { fail("This MCP connector is not supported.", 400); }
  const remaining = Math.min(2000, Math.floor(deadlineAt - Date.now()));
  if (remaining <= 0) fail("MCP endpoint validation timed out.", 503);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([assertPublicHttpUrl(payload.endpoint, "MCP endpoint"), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("admission timeout")), remaining);
    })]);
  } catch { fail("The MCP endpoint could not be admitted.", 400); }
  finally { if (timer) clearTimeout(timer); }
  // DNS may finish after a rejected race, but it has no mutation callback.
  if (Date.now() >= deadlineAt) fail("MCP endpoint validation timed out.", 503);
  if (intent.declaration.authType === "bearer_env") {
    const decision = evaluateConnectorSecretBinding({ tenantId: intent.scope.tenantId, targetUrl: payload.endpoint,
      envName: intent.declaration.authTokenEnv! });
    if (!decision.allowed || decision.mode !== "deployer_binding") fail("The environment reference is not currently bound to this tenant and endpoint.", 409);
  }
}
async function targetAvailable(sql: Sql, scope: ConnectorNativeScope, id: string, key?: string) {
  const reserved = await sql`SELECT idempotency_key_sha256 FROM omni_native_mcp_registration_preparations WHERE connector_id=${id} AND tenant_id=${scope.tenantId}`;
  if (reserved.some((row) => row.idempotency_key_sha256 !== key)) fail("This MCP identity is reserved by another preparation.");
  const existing = await sql`SELECT id FROM omni_mcp_connectors WHERE id=${id} AND tenant_id=${scope.tenantId}`;
  if (existing.length) fail("This MCP connector identity already exists.");
}
export async function prepareNativeMcpRegistration(input: { authority: ConnectorNativeAuthority; request: ConnectorNativeMcpRegistrationPrepareRequest; idempotencyKey: string }):
Promise<{ prepared: ConnectorNativeMcpRegistrationPreparationPreparedRead; replayed: boolean }> {
  const request = connectorNativeMcpRegistrationPrepareRequestSchema.parse(input.request), scope = input.authority.scope;
  const intent = buildConnectorNativeMcpRegistrationPreparationIntent(scope, input.idempotencyKey, request);
  const execution = requireNativeConnectorMutationScope(input.authority, request.connectorId), deadlineAt = Date.now() + 25_000;
  const payload: Payload = { endpoint: normalizeNativeMcpRegistrationEndpoint(request.payload.endpoint), bearerToken: request.payload.bearerToken };
  return nativeConnectorTransaction(input.authority, false, async (sql) => {
    await preparationLock(sql, scope, intent.keySha256);
    const existing = await preparationRow(sql, scope, intent.keySha256), commitment = payloadCommitment(intent, payload);
    if (existing) {
      if (!same(existing.intent, intent)) fail("This key belongs to another registration preparation.");
      if (existing.state === "abandoned") fail("This registration preparation was permanently abandoned.");
      if (existing.payload_commitment !== commitment) fail("This preparation key cannot accept different registration input.");
      const prepared = await preparationRead(sql, scope, existing);
      if (prepared.availability === "abandoned") fail("This registration preparation was permanently abandoned.");
      return { prepared, replayed: true };
    }
    await requireNativeConnectorIdentity(sql, scope, true);
    await targetLock(sql, request.connectorId);
    await targetAvailable(sql, scope, request.connectorId);
    await admit(intent, payload, deadlineAt);
    await requireNativeConnectorIdentity(sql, scope, true);
    const preparedAt = await clock(sql), expiresAt = new Date(Date.parse(preparedAt) + NATIVE_MCP_REGISTRATION_PREPARATION_TTL_MS).toISOString();
    const { contract: _contract, ...safe } = intent;
    const body = { ...safe, contract: "asael-connector-preparation:1", id: connectorNativeMcpRegistrationPreparationId(scope, intent.keySha256),
      intentSha256: canonicalJsonSha256(intent), configurationSha256: configurationBinding(intent, payload), preparedAt, expiresAt };
    const proof = connectorNativeMcpRegistrationPreparationSchema.parse({ ...body, preparationSha256: canonicalJsonSha256(body) });
    let sealed: ReturnType<typeof sealCredentialBundle> | null = null;
    if (encrypted(intent)) {
      try { sealed = sealCredentialBundle({ registrationPayload: JSON.stringify(payload) }, nativeMcpRegistrationPreparationBinding(proof)); }
      catch { fail("Protected MCP registration staging is unavailable.", 503); }
    }
    const inserted = await sql`INSERT INTO omni_native_mcp_registration_preparations(id,tenant_id,owner_actor_id,canonical_actor_id,idempotency_key_sha256,
      connector_id,intent,preparation,state,expires_at,sealed_payload,payload_commitment)
      VALUES(${proof.id},${scope.tenantId},${scope.ownerActorId},${scope.canonicalActorId},${intent.keySha256},${request.connectorId},
        ${intent}::JSONB,${proof}::JSONB,'ready',${expiresAt},${sealed}::JSONB,${commitment}) ON CONFLICT DO NOTHING RETURNING id`;
    if (inserted.length !== 1) fail("This registration identity is already reserved.");
    await appendScopedDomainEvent({ id: `${proof.id}:prepared`, streamId: `connector-native:mcp:${request.connectorId}`,
      type: "connector.native.mcp_registration_preparation.prepared", executionScope: execution,
      payload: { schemaVersion: 1, preparationId: proof.id, preparationSha256: proof.preparationSha256, intentSha256: proof.intentSha256 } }, { sql });
    return { prepared: { preparation: proof, availability: "ready", consumedBy: null, consumedKeySha256: null }, replayed: false };
  });
}
export async function readNativeMcpRegistrationPreparation(authority: ConnectorNativeAuthority, keySha256: string): Promise<ConnectorNativeMcpRegistrationPreparationRead | null> {
  readOnly(authority); connectorNativeShaSchema.parse(keySha256);
  return nativeConnectorTransaction(authority, false, async (sql) => {
    await preparationLock(sql, authority.scope, keySha256);
    const row = await preparationRow(sql, authority.scope, keySha256);
    return row ? preparationRead(sql, authority.scope, row) : null;
  });
}
function abandonmentScope(authority: ConnectorNativeAuthority, connectorId: string) {
  const s = authority.scope, e = parsePersistedExecutionScope(authority.executionScope);
  if (!e || e.tenantId !== s.tenantId || e.initiatingActorId !== s.ownerActorId || e.executingPrincipalType !== "user" ||
    e.executingPrincipalId !== s.ownerActorId || e.workspaceId || e.projectId || e.missionId || e.delegationId || e.contextGrantIds.length ||
    e.capabilityGrantIds.length || e.purpose !== "api.connectors.native.mcp_registration_preparation.abandon" || e.causationId !== connectorId) {
    fail("Exact original-owner registration cleanup authority is required.", 403);
  }
  return e;
}
export async function abandonNativeMcpRegistrationPreparation(input: { authority: ConnectorNativeAuthority; request: ConnectorNativeMcpRegistrationPreparationAbandonRequest;
  idempotencyKey: string; keySha256: string }): Promise<{ prepared: ConnectorNativeMcpRegistrationPreparationAbandonedRead; replayed: boolean }> {
  const request = connectorNativeMcpRegistrationPreparationAbandonRequestSchema.parse(input.request), intent = request.intent, scope = input.authority.scope;
  connectorNativeShaSchema.parse(input.keySha256);
  if (!same(intent.scope, scope) || intent.keySha256 !== input.keySha256 || connectorNativeKeySha256(scope, input.idempotencyKey) !== intent.keySha256) fail("The exact original preparation key is required.");
  const execution = abandonmentScope(input.authority, intent.connectorId);
  return nativeConnectorTransaction(input.authority, false, async (sql) => {
    await preparationLock(sql, scope, intent.keySha256);
    const existing = await preparationRow(sql, scope, intent.keySha256, true);
    if (existing && !same(existing.intent, intent)) fail("This key belongs to another registration preparation.");
    if (existing?.state === "consumed") fail("This preparation was consumed. Recover its original action receipt.");
    if (existing?.state === "abandoned") return { prepared: connectorNativeMcpRegistrationPreparationAbandonedReadSchema.parse(await preparationRead(sql, scope, existing)), replayed: true };
    if (!existing) {
      await targetLock(sql, intent.connectorId);
      // An absent-key tombstone reserves its target even if an unrelated browser
      // already created it; it must never mutate or delete that existing target.
      const reserved = await sql`SELECT id FROM omni_native_mcp_registration_preparations WHERE connector_id=${intent.connectorId} AND tenant_id=${scope.tenantId}`;
      if (reserved.length) fail("This MCP identity is reserved by another preparation.");
    }
    const proof = existing ? connectorNativeMcpRegistrationPreparationSchema.parse(existing.preparation) : null;
    const body = { contract: "asael-mcp-registration-preparation-abandonment:1", id: connectorNativeMcpRegistrationAbandonmentId(scope, intent.keySha256),
      scope, keySha256: intent.keySha256, intentSha256: canonicalJsonSha256(intent), preparationSha256: proof?.preparationSha256 ?? null, abandonedAt: await clock(sql) };
    const abandonment = connectorNativeMcpRegistrationPreparationAbandonmentSchema.parse({ ...body, abandonmentSha256: canonicalJsonSha256(body) });
    const prepared = connectorNativeMcpRegistrationPreparationAbandonedReadSchema.parse({ intent, preparation: proof, availability: "abandoned", consumedBy: null, consumedKeySha256: null, abandonment });
    const changed = existing
      ? await sql`UPDATE omni_native_mcp_registration_preparations SET state='abandoned',sealed_payload=NULL,abandonment=${abandonment}::JSONB
          WHERE id=${existing.id} AND tenant_id=${scope.tenantId} AND state IN ('ready','expired') RETURNING id`
      : await sql`INSERT INTO omni_native_mcp_registration_preparations(id,tenant_id,owner_actor_id,canonical_actor_id,idempotency_key_sha256,connector_id,intent,state,abandonment)
          VALUES(${connectorNativeMcpRegistrationPreparationId(scope, intent.keySha256)},${scope.tenantId},${scope.ownerActorId},${scope.canonicalActorId},
            ${intent.keySha256},${intent.connectorId},${intent}::JSONB,'abandoned',${abandonment}::JSONB) ON CONFLICT DO NOTHING RETURNING id`;
    if (changed.length !== 1) fail("The registration preparation could not be abandoned.");
    await appendScopedDomainEvent({ id: abandonment.id, streamId: `connector-native:mcp:${intent.connectorId}`, type: "connector.native.mcp_registration_preparation.abandoned",
      executionScope: execution, payload: { schemaVersion: 1, preparationId: connectorNativeMcpRegistrationPreparationId(scope, intent.keySha256),
        intentSha256: abandonment.intentSha256, abandonmentSha256: abandonment.abandonmentSha256 } }, { sql });
    return { prepared, replayed: false };
  });
}
export async function readNativeMcpRegistration(authority: ConnectorNativeAuthority, keySha256: string): Promise<ConnectorNativeMcpRegistrationAction | null> {
  readOnly(authority); connectorNativeShaSchema.parse(keySha256);
  return nativeConnectorTransaction(authority, false, async (sql) => {
    const receipt = await accepted(sql, authority.scope, keySha256);
    return receipt && !receipt.otherAction ? receipt.action : null;
  });
}
export async function submitNativeMcpRegistration(input: { authority: ConnectorNativeAuthority; request: ConnectorNativeMcpRegistrationRequest; idempotencyKey: string }):
Promise<{ action: ConnectorNativeMcpRegistrationAction; replayed: boolean }> {
  const scope = input.authority.scope, intent = buildConnectorNativeMcpRegistrationIntent(scope, input.idempotencyKey, input.request), request = intent.request;
  const execution = requireNativeConnectorMutationScope(input.authority, request.connectorId), deadlineAt = Date.now() + 25_000;
  return nativeConnectorTransaction(input.authority, false, async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`native-connector-key:${scope.tenantId}:${scope.ownerActorId}:${intent.keySha256}`},0))`;
    const replay = await accepted(sql, scope, intent.keySha256);
    if (replay) { if (replay.otherAction || !same(replay.intent, intent)) fail("This key already accepted another connector request."); return { action: replay.action, replayed: true }; }
    await requireNativeConnectorIdentity(sql, scope, true);
    const ids = await sql`SELECT idempotency_key_sha256 FROM omni_native_mcp_registration_preparations
      WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId} AND id=${request.preparationId}`;
    if (ids.length !== 1) fail("The original registration preparation is unavailable.");
    const preparationKey = connectorNativeShaSchema.parse(ids[0].idempotency_key_sha256);
    await preparationLock(sql, scope, preparationKey);
    const row = await preparationRow(sql, scope, preparationKey, true);
    if (!row || row.state !== "ready") fail("The original registration preparation is no longer available.");
    const proof = connectorNativeMcpRegistrationPreparationSchema.parse(row.preparation), original = mcpRegistrationPreparationIntentFromProof(proof);
    if (proof.id !== request.preparationId || proof.preparationSha256 !== request.preparationSha256 || proof.connectorId !== request.connectorId ||
      !same(proof.scope, scope) || !same(original, row.intent)) fail("The confirmed registration differs from its original proof.");
    await targetLock(sql, request.connectorId);
    await targetAvailable(sql, scope, request.connectorId, preparationKey);
    const beforeOpen = await clock(sql);
    if (Date.parse(beforeOpen) < Date.parse(proof.preparedAt) || Date.parse(beforeOpen) >= Date.parse(proof.expiresAt)) fail("The registration preparation expired.");
    let payload: Payload;
    try {
      let material: unknown = { endpoint: original.declaration.endpoint, bearerToken: null };
      if (encrypted(original)) {
        const bundle = openCredentialBundle(row.sealed_payload, nativeMcpRegistrationPreparationBinding(proof));
        if (Object.keys(bundle).join() !== "registrationPayload") throw new Error("invalid staging");
        material = JSON.parse(bundle.registrationPayload);
      } else if (row.sealed_payload !== null) throw new Error("invalid staging");
      if (!material || typeof material !== "object" || Array.isArray(material) || Object.keys(material).sort().join() !== "bearerToken,endpoint") throw new Error("invalid staging");
      const parsed = connectorNativeMcpRegistrationPrepareRequestSchema.parse({ contract: "asael-connector-prepare:1", nonce: original.nonce,
        operation: original.operation, connectorId: original.connectorId, review: null, declaration: original.declaration,
        payload: { ...material, specUrl: null, specText: null } });
      payload = { endpoint: normalizeNativeMcpRegistrationEndpoint(parsed.payload.endpoint), bearerToken: parsed.payload.bearerToken };
      if (payloadCommitment(original, payload) !== row.payload_commitment || configurationBinding(original, payload) !== proof.configurationSha256) throw new Error("invalid staging");
    } catch { fail("The prepared registration could not be authenticated.", 503); }
    await admit(original, payload, deadlineAt);
    await requireNativeConnectorIdentity(sql, scope, true);
    const acceptedAt = await clock(sql);
    if (Date.parse(acceptedAt) < Date.parse(proof.preparedAt) || Date.parse(acceptedAt) >= Date.parse(proof.expiresAt)) fail("The registration preparation expired.");
    const body = { contract: "asael-connector-acceptance:1", id: connectorNativeAcceptanceId(scope, intent.keySha256), scope, keySha256: intent.keySha256,
      requestSha256: canonicalJsonSha256(intent), kind: "mcp", connectorId: request.connectorId, action: "register_mcp", reviewSha256: proof.preparationSha256, acceptedAt };
    const acceptance = connectorNativeMcpRegistrationAcceptanceSchema.parse({ ...body, acceptanceSha256: canonicalJsonSha256(body) });
    await sql`INSERT INTO omni_native_connector_actions(id,tenant_id,owner_actor_id,canonical_actor_id,idempotency_key_sha256,kind,connector_id,action,intent,acceptance,accepted_at,state)
      VALUES(${acceptance.id},${scope.tenantId},${scope.ownerActorId},${scope.canonicalActorId},${intent.keySha256},'mcp',${request.connectorId},'register_mcp',${intent}::JSONB,${acceptance}::JSONB,${acceptedAt},'accepted')`;
    const d = proof.declaration;
    try {
      await insertDisabledMcpConnector({ id: request.connectorId, tenantId: scope.tenantId, name: d.name, endpoint: payload.endpoint,
        transport: "streamable_http", authType: d.authType, authTokenEnv: d.authTokenEnv ?? undefined, status: "disabled", toolCount: 0,
        capabilities: {}, credentialConfigured: false, credentialOriginMatch: false, defaultRiskLevel: d.defaultRiskLevel,
        approvalRequired: d.approvalRequired, createdAt: acceptedAt, updatedAt: acceptedAt }, { executionScope: execution });
    } catch (error) { if (error instanceof McpConnectorInsertConflictError) fail("This MCP connector identity already exists."); throw error; }
    if (d.authType === "bearer_vault") await storeMcpBearerCredential({ tenantId: scope.tenantId, connectorId: request.connectorId,
      endpoint: payload.endpoint, bearerToken: payload.bearerToken!, executionScope: execution });
    const consumed = await sql`UPDATE omni_native_mcp_registration_preparations SET state='consumed',sealed_payload=NULL,
      consumed_by=${acceptance.id},consumed_key_sha256=${intent.keySha256} WHERE id=${proof.id} AND tenant_id=${scope.tenantId} AND state='ready' RETURNING id`;
    if (consumed.length !== 1) fail("The registration preparation could not be consumed.");
    const stored = await getMcpConnector(request.connectorId, { tenantId: scope.tenantId });
    const after = await readNativeConnectorCurrentInTransaction(sql, scope, "mcp", request.connectorId, true), vault = d.authType === "bearer_vault";
    if (!stored || !after?.pin || stored.endpoint !== payload.endpoint || stored.name !== d.name || stored.transport !== "streamable_http" ||
      stored.authType !== d.authType || (stored.authTokenEnv ?? null) !== d.authTokenEnv || stored.defaultRiskLevel !== d.defaultRiskLevel ||
      stored.approvalRequired !== d.approvalRequired || stored.lastDiscoveredAt || stored.instructions || stored.serverVersion || stored.lastError ||
      Object.keys(stored.capabilities ?? {}).length || after.connector.credentialConfigured !== vault || after.connector.credentialOriginMatch !== vault ||
      after.connector.status !== "disabled" || after.contracts.length || after.connector.contractCount || after.connector.credentialVersion !== (vault ? 1 : 0)) fail("The registered local configuration could not be confirmed.");
    const settlementBody = { contract: "asael-connector-settlement:2", acceptanceId: acceptance.id, settledAt: await clock(sql), result: {
      kind: "mcp", connectorId: request.connectorId, operation: "register_mcp", status: "complete", connectorStatus: "disabled", contractCount: 0,
      credentialVersion: after.connector.credentialVersion, connectorSha256: after.pin.connectorSha256, contractsSha256: after.pin.contractsSha256,
      configurationSha256: after.pin.configurationSha256, trash: null, failureCode: null } };
    const settlement = connectorNativeMcpRegistrationSettlementSchema.parse({ ...settlementBody, settlementSha256: canonicalJsonSha256(settlementBody) });
    const settled = await sql`UPDATE omni_native_connector_actions SET state='settled',settlement=${settlement}::JSONB WHERE id=${acceptance.id} AND tenant_id=${scope.tenantId} AND state='accepted' RETURNING id`;
    if (settled.length !== 1) fail("The registration receipt could not be settled.");
    await appendScopedDomainEvent({ id: acceptance.id, streamId: `connector-native:mcp:${request.connectorId}`, type: "connector.native.action.accepted", executionScope: execution,
      payload: { schemaVersion: 1, acceptanceId: acceptance.id, action: "register_mcp", kind: "mcp", connectorId: request.connectorId,
        requestSha256: acceptance.requestSha256, acceptanceSha256: acceptance.acceptanceSha256 } }, { sql });
    await appendScopedDomainEvent({ id: `${acceptance.id}:settled`, streamId: `connector-native:mcp:${request.connectorId}`, type: "connector.native.action.settled", executionScope: execution,
      payload: { schemaVersion: 1, acceptanceId: acceptance.id, settlementSha256: settlement.settlementSha256 } }, { sql });
    return { action: connectorNativeMcpRegistrationActionSchema.parse({ acceptance, state: "settled", settlement }), replayed: false };
  });
}

export type NativeMcpRegistrationPreparationScrub = { status: "complete" | "deferred" | "failed"; scrubbed: number; moreAvailable: boolean; oldestExpiredAt: string | null };
export async function scrubExpiredNativeMcpRegistrationPreparations(input: { tenantId: string; limit?: number; deadlineAt: number }): Promise<NativeMcpRegistrationPreparationScrub> {
  const deferred: NativeMcpRegistrationPreparationScrub = { status: "deferred", scrubbed: 0, moreAvailable: true, oldestExpiredAt: null };
  if (!hasDatabaseUrl() || Date.now() >= input.deadlineAt) return deferred;
  if (!input.tenantId || input.tenantId.trim() !== input.tenantId || input.tenantId.length > 120) fail("An exact tenant is required for registration cleanup.", 400);
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 100), 1), 100);
  await ensureDatabaseSchema();
  return runWithDatabaseSystemScope("Scrub expired MCP registration payloads for one exact tenant.", () => getSql().transaction(async (sql: Sql) => {
    const remaining = Math.min(2000, Math.floor(input.deadlineAt - Date.now()));
    if (remaining <= 0) return deferred;
    await sql`SELECT set_config('statement_timeout',${String(remaining)},true)`;
    const rows = await sql`WITH expired AS (SELECT id FROM omni_native_mcp_registration_preparations
      WHERE tenant_id=${input.tenantId} AND state='ready' AND sealed_payload IS NOT NULL AND expires_at<=clock_timestamp()
      ORDER BY expires_at,id FOR UPDATE SKIP LOCKED LIMIT ${limit}), scrubbed AS (
      UPDATE omni_native_mcp_registration_preparations target SET state='expired',sealed_payload=NULL FROM expired
      WHERE target.id=expired.id AND target.tenant_id=${input.tenantId} AND target.state='ready' AND target.expires_at<=clock_timestamp() RETURNING target.id)
      SELECT (SELECT count(*)::INTEGER FROM scrubbed) AS scrubbed,
        (SELECT to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          FROM omni_native_mcp_registration_preparations WHERE tenant_id=${input.tenantId} AND sealed_payload IS NOT NULL
            AND expires_at<=clock_timestamp() AND id NOT IN (SELECT id FROM scrubbed) ORDER BY expires_at,id LIMIT 1) AS oldest`;
    return { status: "complete" as const, scrubbed: Number(rows[0].scrubbed), moreAvailable: rows[0].oldest !== null,
      oldestExpiredAt: rows[0].oldest === null ? null : String(rows[0].oldest) };
  }) as Promise<NativeMcpRegistrationPreparationScrub>);
}
