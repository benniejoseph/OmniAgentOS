import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseSystemScope } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { parsePersistedExecutionScope } from "@/lib/security/execution-scope";
import { openCredentialBundle, sealCredentialBundle } from "@/lib/settings/credential-vault";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { storeMcpBearerCredential } from "./credential-store";
import { getMcpConnector } from "./store";
import { connectorNativeAcceptanceId, connectorNativeKeySha256, connectorNativePreparationId, connectorNativeShaSchema,
  NativeConnectorError, type ConnectorNativeScope } from "./native-control-contracts";
import { connectorNativePrivateDigest } from "./native-control-private";
import { nativeConnectorTransaction, readNativeConnectorCurrentInTransaction, requireNativeConnectorIdentity,
  requireNativeConnectorMutationScope, type ConnectorNativeAuthority } from "./native-control-store";
import { buildConnectorNativeCredentialPreparationIntent, buildConnectorNativeCredentialRotationIntent, canPrepareNativeConnectorCredential,
  credentialPreparationIntentFromProof, nativeCredentialPreparationDeclaration, NATIVE_CREDENTIAL_PREPARATION_TTL_MS,
  connectorNativeCredentialPrepareRequestSchema, connectorNativeCredentialPreparationSchema, connectorNativeCredentialPreparationIntentSchema,
  connectorNativeCredentialPreparationReadSchema, connectorNativeCredentialPreparationAbandonedReadSchema,
  connectorNativeCredentialPreparationAbandonRequestSchema, connectorNativeCredentialPreparationAbandonmentId,
  connectorNativeCredentialPreparationAbandonmentSchema, connectorNativeCredentialRotationActionSchema,
  connectorNativeCredentialRotationAcceptanceSchema, connectorNativeCredentialRotationIntentSchema, connectorNativeCredentialRotationSettlementSchema,
  type ConnectorNativeCredentialPrepareRequest, type ConnectorNativeCredentialPreparation,
  type ConnectorNativeCredentialPreparationIntent, type ConnectorNativeCredentialPreparationRead,
  type ConnectorNativeCredentialPreparationPreparedRead, type ConnectorNativeCredentialPreparationAbandonedRead,
  type ConnectorNativeCredentialPreparationAbandonRequest, type ConnectorNativeCredentialRotationRequest,
  type ConnectorNativeCredentialRotationAction } from "./native-credential-rotation-contracts";

type Sql = ReturnType<typeof getSql>;
type Row = Record<string, unknown>;
const same = (a: unknown, b: unknown) => canonicalJsonSha256(a) === canonicalJsonSha256(b);
function fail(message: string, status = 409): never { throw new NativeConnectorError(status === 403 ? "connector_authority" : "connector_conflict", status, message); }
function readOnly(authority: ConnectorNativeAuthority) { if (authority.executionScope) fail("Preparation and action recovery require read-only authority.", 400); }
async function clock(sql: Sql) {
  const rows = await sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`;
  const now = rows[0]?.now;
  if (typeof now !== "string" || !Number.isFinite(Date.parse(now))) fail("The credential preparation clock is unavailable.", 503);
  return now;
}
async function preparationLock(sql: Sql, scope: ConnectorNativeScope, key: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`native-credential-preparation:${scope.tenantId}:${scope.ownerActorId}:${key}`},0))`;
}
async function preparationRow(sql: Sql, scope: ConnectorNativeScope, key: string, lock = false) {
  const rows = lock
    ? await sql`SELECT * FROM omni_native_connector_credential_preparations WHERE tenant_id=${scope.tenantId}
        AND owner_actor_id=${scope.ownerActorId} AND idempotency_key_sha256=${key} FOR UPDATE`
    : await sql`SELECT * FROM omni_native_connector_credential_preparations WHERE tenant_id=${scope.tenantId}
        AND owner_actor_id=${scope.ownerActorId} AND idempotency_key_sha256=${key}`;
  if (rows.length > 1) fail("The original preparation is inconsistent.");
  const row = rows[0];
  if (row) {
    const intent = connectorNativeCredentialPreparationIntentSchema.parse(row.intent);
    if (!same(intent.scope, scope) || intent.keySha256 !== key || row.id !== connectorNativePreparationId(scope, key) ||
      row.canonical_actor_id !== scope.canonicalActorId || row.connector_id !== intent.connectorId) fail("The original preparation scope differs.");
  }
  return row;
}
async function accepted(sql: Sql, scope: ConnectorNativeScope, key: string) {
  const rows = await sql`SELECT action,intent,acceptance,state,settlement FROM omni_native_connector_actions
    WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId} AND idempotency_key_sha256=${key}`;
  if (!rows.length) return null;
  if (rows.length !== 1) fail("The stored credential acceptance is inconsistent.");
  if (rows[0].action !== "rotate_mcp") return { otherAction: true as const };
  const intent = connectorNativeCredentialRotationIntentSchema.parse(rows[0].intent);
  const action = connectorNativeCredentialRotationActionSchema.parse({ acceptance: rows[0].acceptance, state: rows[0].state, settlement: rows[0].settlement });
  const a = action.acceptance, r = intent.request;
  if (!same(intent.scope, scope) || !same(a.scope, scope) || intent.keySha256 !== key || a.keySha256 !== key ||
    a.requestSha256 !== canonicalJsonSha256(intent) || a.reviewSha256 !== r.preparationSha256 || a.connectorId !== r.connectorId ||
    action.settlement && action.settlement.result.credentialVersion !== r.review.credentialVersion + 1) fail("The stored credential acceptance differs from its intent.");
  return { otherAction: false as const, intent, action };
}
async function preparationRead(sql: Sql, scope: ConnectorNativeScope, row: Row): Promise<ConnectorNativeCredentialPreparationRead> {
  const intent = connectorNativeCredentialPreparationIntentSchema.parse(row.intent);
  if (row.state === "abandoned") return connectorNativeCredentialPreparationAbandonedReadSchema.parse({ intent,
    preparation: row.preparation, availability: "abandoned", consumedBy: null, consumedKeySha256: null, abandonment: row.abandonment });
  const proof = connectorNativeCredentialPreparationSchema.parse(row.preparation);
  if (!same(credentialPreparationIntentFromProof(proof), intent)) fail("The stored preparation proof differs.");
  if (row.state === "consumed") {
    const key = connectorNativeShaSchema.parse(row.consumed_key_sha256), receipt = await accepted(sql, scope, key);
    if (!receipt || receipt.otherAction || receipt.action.acceptance.id !== row.consumed_by ||
      receipt.intent.request.preparationId !== proof.id || receipt.intent.request.preparationSha256 !== proof.preparationSha256 ||
      !same(receipt.intent.request.review, proof.review)) fail("The preparation consumption receipt differs.");
    return connectorNativeCredentialPreparationReadSchema.parse({ preparation: proof, availability: "consumed", consumedBy: row.consumed_by, consumedKeySha256: key });
  }
  if (row.state !== "ready" && row.state !== "expired") fail("The preparation state is inconsistent.");
  const expired = row.state === "expired" || Date.parse(await clock(sql)) >= Date.parse(proof.expiresAt);
  return connectorNativeCredentialPreparationReadSchema.parse({ preparation: proof, availability: expired ? "expired" : "ready", consumedBy: null, consumedKeySha256: null });
}

/** The vault truncates long bindings. Hash the complete tuple before passing it. */
export function nativeCredentialPreparationBinding(proof: ConnectorNativeCredentialPreparation) {
  return `asael:native-credential-preparation:v1:${canonicalJsonSha256({ scope: proof.scope, operation: proof.operation,
    connectorId: proof.connectorId, review: proof.review, id: proof.id, keySha256: proof.keySha256,
    origin: new URL(proof.declaration.endpoint!).origin, configurationSha256: proof.configurationSha256, expiresAt: proof.expiresAt })}`;
}
function payloadCommitment(intent: ConnectorNativeCredentialPreparationIntent, token: string) {
  return connectorNativePrivateDigest(intent.scope.tenantId, ["native-credential-preparation-payload:1", intent.scope, intent.keySha256, token]);
}
export async function prepareNativeConnectorCredential(input: { authority: ConnectorNativeAuthority; request: ConnectorNativeCredentialPrepareRequest; idempotencyKey: string }):
Promise<{ prepared: ConnectorNativeCredentialPreparationPreparedRead; replayed: boolean }> {
  const request = connectorNativeCredentialPrepareRequestSchema.parse(input.request), scope = input.authority.scope;
  const intent = buildConnectorNativeCredentialPreparationIntent(scope, input.idempotencyKey, request);
  const execution = requireNativeConnectorMutationScope(input.authority, request.connectorId);
  return nativeConnectorTransaction(input.authority, false, async (sql) => {
    await preparationLock(sql, scope, intent.keySha256);
    const existing = await preparationRow(sql, scope, intent.keySha256);
    const commitment = payloadCommitment(intent, request.payload.bearerToken);
    if (existing) {
      if (!same(existing.intent, intent)) fail("This key belongs to another preparation.");
      if (existing.state === "abandoned") fail("This preparation was permanently abandoned.");
      if (existing.payload_commitment !== commitment) fail("This preparation key cannot accept different credential input.");
      const prepared = await preparationRead(sql, scope, existing);
      if (prepared.availability === "abandoned") fail("This preparation was permanently abandoned.");
      return { prepared, replayed: true };
    }
    await requireNativeConnectorIdentity(sql, scope, true);
    const current = await readNativeConnectorCurrentInTransaction(sql, scope, "mcp", request.connectorId, true);
    if (!current || !canPrepareNativeConnectorCredential(current) || !same(current.pin, request.review) ||
      !same(nativeCredentialPreparationDeclaration(current), request.declaration)) fail("The reviewed connector configuration changed.");
    await requireNativeConnectorIdentity(sql, scope, true);
    const preparedAt = await clock(sql), expiresAt = new Date(Date.parse(preparedAt) + NATIVE_CREDENTIAL_PREPARATION_TTL_MS).toISOString();
    const { contract: _contract, ...safe } = intent;
    const body = { ...safe, contract: "asael-connector-preparation:1", id: connectorNativePreparationId(scope, intent.keySha256),
      intentSha256: canonicalJsonSha256(intent), configurationSha256: request.review.configurationSha256, preparedAt, expiresAt };
    const proof = connectorNativeCredentialPreparationSchema.parse({ ...body, preparationSha256: canonicalJsonSha256(body) });
    const sealed = sealCredentialBundle({ bearerToken: request.payload.bearerToken }, nativeCredentialPreparationBinding(proof));
    await sql`INSERT INTO omni_native_connector_credential_preparations(id,tenant_id,owner_actor_id,canonical_actor_id,idempotency_key_sha256,
      connector_id,intent,preparation,state,expires_at,sealed_payload,payload_commitment)
      VALUES(${proof.id},${scope.tenantId},${scope.ownerActorId},${scope.canonicalActorId},${intent.keySha256},${request.connectorId},
        ${intent}::JSONB,${proof}::JSONB,'ready',${expiresAt},${sealed}::JSONB,${commitment})`;
    await appendScopedDomainEvent({ id: `${proof.id}:prepared`, streamId: `connector-native:mcp:${request.connectorId}`,
      type: "connector.native.credential_preparation.prepared", executionScope: execution,
      payload: { schemaVersion: 1, preparationId: proof.id, preparationSha256: proof.preparationSha256, intentSha256: proof.intentSha256 } }, { sql });
    const prepared: ConnectorNativeCredentialPreparationPreparedRead = { preparation: proof, availability: "ready", consumedBy: null, consumedKeySha256: null };
    return { prepared, replayed: false };
  });
}
export async function readNativeConnectorCredentialPreparation(authority: ConnectorNativeAuthority, keySha256: string): Promise<ConnectorNativeCredentialPreparationRead | null> {
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
    e.capabilityGrantIds.length || e.purpose !== "api.connectors.native.preparation.abandon" || e.causationId !== connectorId) {
    fail("Exact original-owner preparation cleanup authority is required.", 403);
  }
  return e;
}
export async function abandonNativeConnectorCredentialPreparation(input: { authority: ConnectorNativeAuthority; request: ConnectorNativeCredentialPreparationAbandonRequest;
  idempotencyKey: string; keySha256: string }): Promise<{ prepared: ConnectorNativeCredentialPreparationAbandonedRead; replayed: boolean }> {
  const request = connectorNativeCredentialPreparationAbandonRequestSchema.parse(input.request), intent = request.intent, scope = input.authority.scope;
  connectorNativeShaSchema.parse(input.keySha256);
  if (!same(intent.scope, scope) || intent.keySha256 !== input.keySha256 || connectorNativeKeySha256(scope, input.idempotencyKey) !== intent.keySha256) fail("The exact original preparation key is required.");
  const execution = abandonmentScope(input.authority, intent.connectorId);
  return nativeConnectorTransaction(input.authority, false, async (sql) => {
    await preparationLock(sql, scope, intent.keySha256);
    const existing = await preparationRow(sql, scope, intent.keySha256, true);
    if (existing && !same(existing.intent, intent)) fail("This key belongs to another preparation.");
    if (existing?.state === "consumed") fail("This preparation was consumed. Recover its original action receipt.");
    if (existing?.state === "abandoned") return { prepared: connectorNativeCredentialPreparationAbandonedReadSchema.parse(await preparationRead(sql, scope, existing)), replayed: true };
    const proof = existing ? connectorNativeCredentialPreparationSchema.parse(existing.preparation) : null;
    const body = { contract: "asael-connector-credential-preparation-abandonment:1", id: connectorNativeCredentialPreparationAbandonmentId(scope, intent.keySha256),
      scope, keySha256: intent.keySha256, intentSha256: canonicalJsonSha256(intent), preparationSha256: proof?.preparationSha256 ?? null, abandonedAt: await clock(sql) };
    const abandonment = connectorNativeCredentialPreparationAbandonmentSchema.parse({ ...body, abandonmentSha256: canonicalJsonSha256(body) });
    const prepared = connectorNativeCredentialPreparationAbandonedReadSchema.parse({ intent, preparation: proof, availability: "abandoned",
      consumedBy: null, consumedKeySha256: null, abandonment });
    if (existing) {
      const updated = await sql`UPDATE omni_native_connector_credential_preparations SET state='abandoned',sealed_payload=NULL,abandonment=${abandonment}::JSONB
        WHERE id=${existing.id} AND tenant_id=${scope.tenantId} AND state IN ('ready','expired') RETURNING id`;
      if (updated.length !== 1) fail("The preparation could not be abandoned.");
    } else {
      await sql`INSERT INTO omni_native_connector_credential_preparations(id,tenant_id,owner_actor_id,canonical_actor_id,idempotency_key_sha256,
        connector_id,intent,state,abandonment) VALUES(${connectorNativePreparationId(scope, intent.keySha256)},${scope.tenantId},${scope.ownerActorId},
        ${scope.canonicalActorId},${intent.keySha256},${intent.connectorId},${intent}::JSONB,'abandoned',${abandonment}::JSONB)`;
    }
    await appendScopedDomainEvent({ id: abandonment.id, streamId: `connector-native:mcp:${intent.connectorId}`, type: "connector.native.credential_preparation.abandoned",
      executionScope: execution, payload: { schemaVersion: 1, preparationId: connectorNativePreparationId(scope, intent.keySha256),
        intentSha256: abandonment.intentSha256, abandonmentSha256: abandonment.abandonmentSha256 } }, { sql });
    return { prepared, replayed: false };
  });
}
export async function readNativeConnectorCredentialRotation(authority: ConnectorNativeAuthority, keySha256: string): Promise<ConnectorNativeCredentialRotationAction | null> {
  readOnly(authority); connectorNativeShaSchema.parse(keySha256);
  return nativeConnectorTransaction(authority, false, async (sql) => {
    const receipt = await accepted(sql, authority.scope, keySha256);
    return receipt && !receipt.otherAction ? receipt.action : null;
  });
}
export async function submitNativeConnectorCredentialRotation(input: { authority: ConnectorNativeAuthority; request: ConnectorNativeCredentialRotationRequest; idempotencyKey: string }):
Promise<{ action: ConnectorNativeCredentialRotationAction; replayed: boolean }> {
  const scope = input.authority.scope, intent = buildConnectorNativeCredentialRotationIntent(scope, input.idempotencyKey, input.request), request = intent.request;
  const execution = requireNativeConnectorMutationScope(input.authority, request.connectorId);
  return nativeConnectorTransaction(input.authority, false, async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`native-connector-key:${scope.tenantId}:${scope.ownerActorId}:${intent.keySha256}`},0))`;
    const replay = await accepted(sql, scope, intent.keySha256);
    if (replay) { if (replay.otherAction || !same(replay.intent, intent)) fail("This key already accepted another connector request."); return { action: replay.action, replayed: true }; }
    await requireNativeConnectorIdentity(sql, scope, true);
    const ids = await sql`SELECT idempotency_key_sha256 FROM omni_native_connector_credential_preparations
      WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId} AND id=${request.preparationId}`;
    if (ids.length !== 1) fail("The original credential preparation is unavailable.");
    const preparationKey = connectorNativeShaSchema.parse(ids[0].idempotency_key_sha256);
    await preparationLock(sql, scope, preparationKey);
    const row = await preparationRow(sql, scope, preparationKey, true);
    if (!row || row.state !== "ready" || !row.sealed_payload) fail("The original credential preparation is no longer available.");
    const proof = connectorNativeCredentialPreparationSchema.parse(row.preparation);
    if (proof.id !== request.preparationId || proof.preparationSha256 !== request.preparationSha256 ||
      proof.connectorId !== request.connectorId || !same(proof.review, request.review)) fail("The confirmed preparation differs from the original proof.");
    const current = await readNativeConnectorCurrentInTransaction(sql, scope, "mcp", request.connectorId, true);
    if (!current || !canPrepareNativeConnectorCredential(current) || !same(current.pin, proof.review) ||
      !same(nativeCredentialPreparationDeclaration(current), proof.declaration)) fail("The reviewed connector configuration changed.");
    const connector = await getMcpConnector(request.connectorId, { tenantId: scope.tenantId });
    if (!connector) fail("The reviewed connector is unavailable.");
    await requireNativeConnectorIdentity(sql, scope, true);
    const acceptedAt = await clock(sql);
    if (Date.parse(acceptedAt) < Date.parse(proof.preparedAt) || Date.parse(acceptedAt) >= Date.parse(proof.expiresAt)) fail("The credential preparation expired.");
    let token: string;
    try {
      const payload = openCredentialBundle(row.sealed_payload, nativeCredentialPreparationBinding(proof));
      if (Object.keys(payload).length !== 1 || typeof payload.bearerToken !== "string" || payloadCommitment(credentialPreparationIntentFromProof(proof), payload.bearerToken) !== row.payload_commitment) throw new Error("invalid prepared credential");
      token = payload.bearerToken;
    } catch { fail("The prepared credential could not be authenticated.", 503); }
    const body = { contract: "asael-connector-acceptance:1", id: connectorNativeAcceptanceId(scope, intent.keySha256), scope, keySha256: intent.keySha256,
      requestSha256: canonicalJsonSha256(intent), kind: "mcp", connectorId: request.connectorId, action: "rotate_mcp", reviewSha256: proof.preparationSha256, acceptedAt };
    const acceptance = connectorNativeCredentialRotationAcceptanceSchema.parse({ ...body, acceptanceSha256: canonicalJsonSha256(body) });
    await sql`INSERT INTO omni_native_connector_actions(id,tenant_id,owner_actor_id,canonical_actor_id,idempotency_key_sha256,kind,connector_id,action,intent,acceptance,accepted_at,state)
      VALUES(${acceptance.id},${scope.tenantId},${scope.ownerActorId},${scope.canonicalActorId},${intent.keySha256},'mcp',${request.connectorId},'rotate_mcp',${intent}::JSONB,${acceptance}::JSONB,${acceptedAt},'accepted')`;
    const consumed = await sql`UPDATE omni_native_connector_credential_preparations SET state='consumed',sealed_payload=NULL,
      consumed_by=${acceptance.id},consumed_key_sha256=${intent.keySha256} WHERE id=${proof.id} AND tenant_id=${scope.tenantId} AND state='ready' RETURNING id`;
    if (consumed.length !== 1) fail("The original preparation could not be consumed.");
    await storeMcpBearerCredential({ tenantId: scope.tenantId, connectorId: request.connectorId, endpoint: connector.endpoint, bearerToken: token, executionScope: execution });
    const after = await readNativeConnectorCurrentInTransaction(sql, scope, "mcp", request.connectorId, true);
    if (!after?.pin || after.connector.authType !== "bearer_vault" || !after.connector.credentialConfigured || !after.connector.credentialOriginMatch ||
      after.connector.status !== "disabled" || after.contracts.length !== 0 || after.connector.contractCount !== 0 ||
      after.connector.credentialVersion !== request.review.credentialVersion + 1) fail("The saved credential state could not be confirmed.");
    const settlementBody = { contract: "asael-connector-settlement:2", acceptanceId: acceptance.id, settledAt: await clock(sql), result: {
      kind: "mcp", connectorId: request.connectorId, operation: "rotate_mcp", status: "complete", connectorStatus: "disabled", contractCount: 0,
      credentialVersion: after.connector.credentialVersion, connectorSha256: after.pin.connectorSha256, contractsSha256: after.pin.contractsSha256,
      configurationSha256: after.pin.configurationSha256, trash: null, failureCode: null } };
    const settlement = connectorNativeCredentialRotationSettlementSchema.parse({ ...settlementBody, settlementSha256: canonicalJsonSha256(settlementBody) });
    const settled = await sql`UPDATE omni_native_connector_actions SET state='settled',settlement=${settlement}::JSONB WHERE id=${acceptance.id} AND tenant_id=${scope.tenantId} AND state='accepted' RETURNING id`;
    if (settled.length !== 1) fail("The credential rotation receipt could not be settled.");
    await appendScopedDomainEvent({ id: acceptance.id, streamId: `connector-native:mcp:${request.connectorId}`, type: "connector.native.action.accepted",
      executionScope: execution, payload: { schemaVersion: 1, acceptanceId: acceptance.id, action: "rotate_mcp", kind: "mcp", connectorId: request.connectorId,
        requestSha256: acceptance.requestSha256, acceptanceSha256: acceptance.acceptanceSha256 } }, { sql });
    await appendScopedDomainEvent({ id: `${acceptance.id}:settled`, streamId: `connector-native:mcp:${request.connectorId}`, type: "connector.native.action.settled",
      executionScope: execution, payload: { schemaVersion: 1, acceptanceId: acceptance.id, settlementSha256: settlement.settlementSha256 } }, { sql });
    return { action: connectorNativeCredentialRotationActionSchema.parse({ acceptance, state: "settled", settlement }), replayed: false };
  });
}

export type NativeCredentialPreparationScrub = { status: "complete" | "deferred" | "failed"; scrubbed: number; moreAvailable: boolean; oldestExpiredAt: string | null };
export async function scrubExpiredNativeConnectorCredentialPreparations(input: { tenantId: string; limit?: number; deadlineAt: number }): Promise<NativeCredentialPreparationScrub> {
  const deferred: NativeCredentialPreparationScrub = { status: "deferred", scrubbed: 0, moreAvailable: true, oldestExpiredAt: null };
  if (!hasDatabaseUrl() || Date.now() >= input.deadlineAt) return deferred;
  if (!input.tenantId || input.tenantId.trim() !== input.tenantId || input.tenantId.length > 120) fail("An exact tenant is required for preparation cleanup.", 400);
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 100), 1), 100);
  await ensureDatabaseSchema();
  return runWithDatabaseSystemScope("Scrub expired native credential preparations for one exact tenant.", () => getSql().transaction(async (sql: Sql) => {
    const remaining = Math.min(2000, Math.floor(input.deadlineAt - Date.now()));
    if (remaining <= 0) return deferred;
    await sql`SELECT set_config('statement_timeout',${String(remaining)},true)`;
    // One statement owns the entire scrub/backlog timeout, not one budget per query.
    const rows = await sql`WITH expired AS (SELECT id FROM omni_native_connector_credential_preparations
      WHERE tenant_id=${input.tenantId} AND state='ready' AND sealed_payload IS NOT NULL AND expires_at<=clock_timestamp()
      ORDER BY expires_at,id FOR UPDATE SKIP LOCKED LIMIT ${limit}), scrubbed AS (
      UPDATE omni_native_connector_credential_preparations target SET state='expired',sealed_payload=NULL FROM expired
      WHERE target.id=expired.id AND target.tenant_id=${input.tenantId} AND target.state='ready' AND target.expires_at<=clock_timestamp() RETURNING target.id)
      SELECT (SELECT count(*)::INTEGER FROM scrubbed) AS scrubbed,
        (SELECT to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          FROM omni_native_connector_credential_preparations WHERE tenant_id=${input.tenantId} AND sealed_payload IS NOT NULL
            AND expires_at<=clock_timestamp() AND id NOT IN (SELECT id FROM scrubbed)
          ORDER BY expires_at,id LIMIT 1) AS oldest`;
    return { status: "complete" as const, scrubbed: Number(rows[0].scrubbed), moreAvailable: rows[0].oldest !== null,
      oldestExpiredAt: rows[0].oldest === null ? null : String(rows[0].oldest) };
  }) as Promise<NativeCredentialPreparationScrub>);
}
