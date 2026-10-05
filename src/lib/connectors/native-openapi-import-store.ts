import { z } from "zod";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseSystemScope } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { parsePersistedExecutionScope } from "@/lib/security/execution-scope";
import { assertPublicHttpUrl } from "@/lib/security/network";
import { credentialVaultStatus, openNativeOpenapiImportSnapshot, sealNativeOpenapiImportSnapshot } from "@/lib/settings/credential-vault";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { connectorNativeAcceptanceId, connectorNativeKeySha256, connectorNativeShaSchema, NativeConnectorError, type ConnectorNativeScope } from "./native-control-contracts";
import { connectorNativePrivateDigest } from "./native-control-private";
import { nativeConnectorTransaction, projectNativeOpenapiReview, readNativeConnectorCurrentInTransaction,
  requireNativeConnectorIdentity, requireNativeConnectorMutationScope, type ConnectorNativeAuthority } from "./native-control-store";
import * as C from "./native-openapi-import-contracts";
import { checkNativeOpenapiDeadline, importNativeOpenapiSpec, loadNativeOpenapiSpec, NativeOpenapiImportError, withNativeOpenapiDeadline } from "./native-openapi-importer";
import { getOpenApiConnector, insertDisabledOpenapiImport, listOpenApiOperations, OpenapiImportInsertConflictError } from "./openapi-store";
import { evaluateConnectorSecretBinding } from "./secret-binding";

type Sql = ReturnType<typeof getSql>;
type Row = Record<string, unknown>;
const same = (a: unknown, b: unknown) => canonicalJsonSha256(a) === canonicalJsonSha256(b);
function fail(message: string, status = 409): never { throw new NativeConnectorError(status === 403 ? "connector_authority" : "connector_conflict", status, message); }
function readOnly(authority: ConnectorNativeAuthority) { if (authority.executionScope) fail("Import recovery requires read-only authority.", 400); }
const instant = z.string().datetime(), risk = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
// Field order deliberately matches the ordinary persisted row mappers. JSONB
// normalizes nested objects once before this snapshot is projected and sealed.
const connectorSnapshot = z.object({ id: z.string(), tenantId: z.string(), name: z.string(), specUrl: z.string().optional(),
  specHash: connectorNativeShaSchema, baseUrl: z.string(), authType: z.enum(["none", "bearer_env", "api_key_header_env"]),
  authTokenEnv: z.string().optional(), authHeaderName: z.string().optional(), status: z.literal("disabled"), defaultRiskLevel: risk,
  approvalRequired: z.boolean(), operationCount: z.number().int().min(1).max(200), info: z.record(z.string(), z.unknown()),
  lastImportedAt: instant, createdAt: instant, updatedAt: instant }).strict();
const operationSnapshot = z.object({ id: z.string(), tenantId: z.string(), connectorId: z.string(), connectorName: z.string(), operationId: z.string(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]), path: z.string(), summary: z.string().optional(), description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()), requestContentType: z.string().optional(), responseContentTypes: z.array(z.string()), riskLevel: risk,
  approvalRequired: z.boolean(), status: z.literal("pending_review"), createdAt: instant, updatedAt: instant }).strict();
const snapshotSchema = z.object({ version: z.literal(1), connector: connectorSnapshot, operations: z.array(operationSnapshot).min(1).max(200) }).strict();
type Snapshot = z.infer<typeof snapshotSchema>;
function snapshotDigest(scope: ConnectorNativeScope, snapshot: Snapshot) {
  // Canonical digest is only an input to the private HMAC, never public evidence.
  return connectorNativePrivateDigest(scope.tenantId, ["native-openapi-import-snapshot:1", scope, canonicalJsonSha256(snapshot)]);
}
export function nativeOpenapiImportSnapshotBinding(proof: C.ConnectorNativeOpenapiImportPreparation) {
  return `asael:native-openapi-import-snapshot:v1:${canonicalJsonSha256({ family: "native-openapi-import", scope: proof.scope,
    connectorId: proof.connectorId, id: proof.id, keySha256: proof.keySha256, intentSha256: proof.intentSha256,
    attemptSha256: proof.attemptSha256, preparationSha256: proof.preparationSha256, expiresAt: proof.expiresAt })}`;
}
function summaryFor(scope: ConnectorNativeScope, snapshot: Snapshot) {
  return C.connectorNativeOpenapiImportSummarySchema.parse({ contract: "asael-openapi-import-summary:1", connectorId: snapshot.connector.id,
    operations: snapshot.operations.map((operation) => ({ id: operation.id, operationId: operation.operationId, method: operation.method,
      path: operation.path, riskLevel: operation.riskLevel, approvalRequired: operation.approvalRequired,
      definitionSha256: connectorNativePrivateDigest(scope.tenantId, ["native-openapi-import-definition:1", scope, snapshot.connector.id, canonicalJsonSha256(operation)]) })) });
}
function openSnapshot(row: Row, proof: C.ConnectorNativeOpenapiImportPreparation) {
  try {
    const snapshot = snapshotSchema.parse(openNativeOpenapiImportSnapshot(row.sealed_snapshot, nativeOpenapiImportSnapshotBinding(proof)));
    const summary = summaryFor(proof.scope, snapshot), connector = snapshot.connector;
    if (snapshotDigest(proof.scope, snapshot) !== proof.snapshotSha256 || canonicalJsonSha256(summary) !== proof.summarySha256 ||
      connector.id !== proof.connectorId || connector.tenantId !== proof.scope.tenantId || snapshot.operations.length !== proof.contractCount ||
      connector.operationCount !== proof.contractCount || connector.baseUrl !== proof.resolvedDeclaration.endpoint ||
      snapshot.operations.some((op) => op.tenantId !== connector.tenantId || op.connectorId !== connector.id || op.connectorName !== connector.name)) throw new Error("Snapshot differs.");
    return { snapshot, summary };
  } catch { fail("The protected import snapshot could not be authenticated.", 503); }
}
async function clock(sql: Sql) {
  const [row] = await sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`;
  if (typeof row?.now !== "string" || !Number.isFinite(Date.parse(row.now))) fail("The import clock is unavailable.", 503);
  return row.now;
}
async function preparationLock(sql: Sql, scope: ConnectorNativeScope, key: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`native-openapi-import-preparation:${scope.tenantId}:${scope.ownerActorId}:${key}`},0))`;
}
async function targetLock(sql: Sql, id: string) { await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`native-openapi-import-target:${id}`},0))`; }
async function targetAvailable(sql: Sql, scope: ConnectorNativeScope, id: string, key?: string) {
  const reserved = await sql`SELECT idempotency_key_sha256 FROM omni_native_openapi_import_preparations WHERE connector_id=${id} AND tenant_id=${scope.tenantId}`;
  if (reserved.some((row) => row.idempotency_key_sha256 !== key)) fail("This OpenAPI identity is permanently reserved by another preparation.");
  if ((await sql`SELECT id FROM omni_openapi_connectors WHERE id=${id} AND tenant_id=${scope.tenantId}`).length) fail("This OpenAPI connector identity already exists.");
}
async function preparationRow(sql: Sql, scope: ConnectorNativeScope, key: string, lock = false) {
  const rows = lock ? await sql`SELECT * FROM omni_native_openapi_import_preparations WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId} AND idempotency_key_sha256=${key} FOR UPDATE`
    : await sql`SELECT * FROM omni_native_openapi_import_preparations WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId} AND idempotency_key_sha256=${key}`;
  if (rows.length > 1) fail("The original import preparation is inconsistent.");
  if (rows[0]) {
    const i = C.connectorNativeOpenapiImportPreparationIntentSchema.parse(rows[0].intent);
    if (!same(i.scope, scope) || i.keySha256 !== key || rows[0].id !== C.connectorNativeOpenapiImportPreparationId(scope, key) ||
      rows[0].canonical_actor_id !== scope.canonicalActorId || rows[0].connector_id !== i.connectorId) fail("The original import scope differs.");
  }
  return rows[0];
}
async function accepted(sql: Sql, scope: ConnectorNativeScope, key: string) {
  const rows = await sql`SELECT action,intent,acceptance,state,settlement FROM omni_native_connector_actions
    WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId} AND idempotency_key_sha256=${key}`;
  if (!rows.length) return null;
  if (rows.length !== 1) fail("The import acceptance is inconsistent.");
  if (rows[0].action !== "import_openapi") return { otherAction: true as const };
  const intent = C.connectorNativeOpenapiImportIntentSchema.parse(rows[0].intent);
  const action = C.connectorNativeOpenapiImportActionSchema.parse({ acceptance: rows[0].acceptance, state: rows[0].state, settlement: rows[0].settlement });
  const a = action.acceptance, r = intent.request;
  if (!same(intent.scope, scope) || !same(a.scope, scope) || intent.keySha256 !== key || a.keySha256 !== key ||
    a.requestSha256 !== canonicalJsonSha256(intent) || a.reviewSha256 !== r.preparationSha256 || a.connectorId !== r.connectorId) fail("The import acceptance differs from its original intent.");
  const originals = await sql`SELECT intent,attempt,preparation,state,consumed_by,consumed_key_sha256 FROM omni_native_openapi_import_preparations
    WHERE id=${r.preparationId} AND tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId}`;
  if (originals.length !== 1 || originals[0].state !== "consumed") fail("The original import proof is unavailable.");
  const original = originals[0], read = C.connectorNativeOpenapiImportPreparationConsumedReadSchema.parse({ availability: "consumed", intent: original.intent,
    attempt: original.attempt, preparation: original.preparation, consumedBy: original.consumed_by, consumedKeySha256: original.consumed_key_sha256 });
  if (!same(read.intent.scope, scope) || read.preparation.id !== r.preparationId || read.preparation.preparationSha256 !== r.preparationSha256 ||
    read.consumedBy !== a.id || read.consumedKeySha256 !== key || action.settlement &&
    (action.settlement.result.contractCount !== read.preparation.contractCount || action.settlement.result.configurationSha256 !== read.preparation.configurationSha256)) {
    fail("The import receipt differs from its immutable consumed snapshot.");
  }
  return { otherAction: false as const, intent, action };
}
async function preparationRead(sql: Sql, scope: ConnectorNativeScope, row: Row): Promise<C.ConnectorNativeOpenapiImportPreparationRead> {
  const intent = C.connectorNativeOpenapiImportPreparationIntentSchema.parse(row.intent);
  if (row.state === "abandoned") return C.connectorNativeOpenapiImportPreparationAbandonedReadSchema.parse({ availability: "abandoned", intent,
    attempt: row.attempt, preparation: row.preparation, abandonment: row.abandonment });
  const attempt = C.connectorNativeOpenapiImportAttemptSchema.parse(row.attempt);
  if (row.state === "failed") return C.connectorNativeOpenapiImportPreparationFailedReadSchema.parse({ availability: "failed", intent, attempt, failure: row.failure });
  const proof = row.preparation === null ? null : C.connectorNativeOpenapiImportPreparationSchema.parse(row.preparation);
  if (row.state === "consumed") {
    const key = connectorNativeShaSchema.parse(row.consumed_key_sha256), receipt = await accepted(sql, scope, key);
    if (!receipt || receipt.otherAction || receipt.action.acceptance.id !== row.consumed_by) fail("The consumed import receipt is unavailable.");
    return C.connectorNativeOpenapiImportPreparationConsumedReadSchema.parse({ availability: "consumed", intent, attempt, preparation: proof,
      consumedBy: row.consumed_by, consumedKeySha256: key });
  }
  const now = Date.parse(await clock(sql)), expires = Date.parse(proof?.expiresAt ?? attempt.expiresAt);
  if (row.state === "expired" || now >= expires) return C.connectorNativeOpenapiImportPreparationExpiredReadSchema.parse({ availability: "expired", intent, attempt, preparation: proof });
  if (row.state === "preparing" && !proof) return C.connectorNativeOpenapiImportPreparationPreparingReadSchema.parse({ availability: "preparing", intent, attempt });
  if (row.state !== "ready" || !proof) fail("The import preparation state is inconsistent.");
  return C.connectorNativeOpenapiImportPreparationReadyReadSchema.parse({ availability: "ready", intent, attempt, preparation: proof, summary: openSnapshot(row, proof).summary });
}
async function admitBase(scope: ConnectorNativeScope, declaration: C.ConnectorNativeOpenapiImportDeclaration, base: string, deadlineAt: number) {
  try { await withNativeOpenapiDeadline(assertPublicHttpUrl(base, "OpenAPI base URL"), Math.min(deadlineAt, Date.now() + 2000)); }
  catch { fail("The operation base URL could not be admitted.", 400); }
  if (declaration.authType !== "none") {
    const decision = evaluateConnectorSecretBinding({ tenantId: scope.tenantId, targetUrl: base, envName: declaration.authTokenEnv! });
    if (!decision.allowed || decision.mode !== "deployer_binding") fail("The environment reference is not currently bound to this tenant and operation origin.");
  }
  checkNativeOpenapiDeadline(deadlineAt);
}
async function event(sql: Sql, authority: ConnectorNativeAuthority, id: string, type: string, target: string, payload: Record<string, unknown>) {
  await appendScopedDomainEvent({ id, streamId: `connector-native:openapi:${target}`, type,
    executionScope: authority.executionScope!, payload: { schemaVersion: 1, ...payload } }, { sql });
}

export async function prepareNativeOpenapiImport(input: { authority: ConnectorNativeAuthority; request: C.ConnectorNativeOpenapiImportPrepareRequest; idempotencyKey: string }):
Promise<{ prepared: C.ConnectorNativeOpenapiImportPreparationRead; replayed: boolean }> {
  const request = C.connectorNativeOpenapiImportPrepareRequestSchema.parse(input.request), scope = input.authority.scope;
  const intent = C.buildConnectorNativeOpenapiImportPreparationIntent(scope, input.idempotencyKey, request);
  requireNativeConnectorMutationScope(input.authority, request.connectorId);
  const sourceUrl = request.payload.specUrl === null ? null : C.normalizeNativeOpenapiImportSourceUrl(request.payload.specUrl);
  const override = request.payload.endpoint === null ? null : C.normalizeNativeOpenapiImportBaseUrl(request.payload.endpoint);
  const commitment = connectorNativePrivateDigest(scope.tenantId, ["native-openapi-import-input:1", canonicalJsonSha256(intent), override, sourceUrl, request.payload.specText]);
  const reserved = await nativeConnectorTransaction(input.authority, false, async (sql): Promise<{ existing: C.ConnectorNativeOpenapiImportPreparationRead } | { attempt: C.ConnectorNativeOpenapiImportAttempt }> => {
    await preparationLock(sql, scope, intent.keySha256);
    const existing = await preparationRow(sql, scope, intent.keySha256);
    if (existing) {
      if (!same(existing.intent, intent) || (existing.input_commitment === null
        ? existing.state !== "abandoned" || existing.attempt !== null : existing.input_commitment !== commitment)) fail("This preparation key belongs to different import input.");
      return { existing: await preparationRead(sql, scope, existing) };
    }
    await requireNativeConnectorIdentity(sql, scope, true);
    if (!credentialVaultStatus().configured) fail("Protected import staging is unavailable.", 503);
    await targetLock(sql, intent.connectorId); await targetAvailable(sql, scope, intent.connectorId);
    const startedAt = await clock(sql), expiresAt = new Date(Date.parse(startedAt) + C.NATIVE_OPENAPI_IMPORT_ATTEMPT_MS).toISOString();
    const body = { contract: "asael-openapi-import-attempt:1", id: C.connectorNativeOpenapiImportAttemptId(scope, intent.keySha256),
      scope, keySha256: intent.keySha256, intentSha256: canonicalJsonSha256(intent), startedAt, expiresAt };
    const attempt = C.connectorNativeOpenapiImportAttemptSchema.parse({ ...body, attemptSha256: canonicalJsonSha256(body) });
    const inserted = await sql`INSERT INTO omni_native_openapi_import_preparations(id,tenant_id,owner_actor_id,canonical_actor_id,idempotency_key_sha256,
      connector_id,intent,attempt,attempt_expires_at,input_commitment,state)
      VALUES(${C.connectorNativeOpenapiImportPreparationId(scope, intent.keySha256)},${scope.tenantId},${scope.ownerActorId},${scope.canonicalActorId},
        ${intent.keySha256},${intent.connectorId},${intent}::JSONB,${attempt}::JSONB,${expiresAt},${commitment},'preparing') ON CONFLICT DO NOTHING RETURNING id`;
    if (inserted.length !== 1) fail("This import identity is already reserved.");
    await event(sql, input.authority, `${attempt.id}:reserved`, "connector.native.openapi_import_preparation.reserved", intent.connectorId,
      { attemptId: attempt.id, attemptSha256: attempt.attemptSha256, intentSha256: attempt.intentSha256 });
    return { attempt };
  });
  if ("existing" in reserved) return { prepared: reserved.existing, replayed: true };
  const attempt = reserved.attempt, deadlineAt = Math.min(Date.now() + C.NATIVE_OPENAPI_IMPORT_ATTEMPT_MS, Date.parse(attempt.expiresAt));
  try {
    const specText = sourceUrl === null ? request.payload.specText! : await loadNativeOpenapiSpec(sourceUrl, deadlineAt);
    const capturedAt = new Date().toISOString(), d = intent.declaration;
    const imported = importNativeOpenapiSpec({ connector: { id: intent.connectorId, tenantId: scope.tenantId, name: d.name,
      specUrl: sourceUrl ?? undefined, baseUrl: override ?? "", authType: d.authType, status: "disabled", defaultRiskLevel: d.defaultRiskLevel,
      approvalRequired: d.approvalRequired, operationCount: 0, createdAt: capturedAt, updatedAt: capturedAt }, specText,
      baseUrlOverride: override ?? undefined, deadlineAt });
    const rawSnapshot = { version: 1, connector: { id: intent.connectorId, tenantId: scope.tenantId, name: d.name, specUrl: sourceUrl ?? undefined,
      specHash: imported.specHash, baseUrl: C.normalizeNativeOpenapiImportBaseUrl(imported.baseUrl), authType: d.authType,
      authTokenEnv: d.authTokenEnv ?? undefined, authHeaderName: d.authHeaderName ?? undefined, status: "disabled", defaultRiskLevel: d.defaultRiskLevel,
      approvalRequired: d.approvalRequired, operationCount: imported.operations.length, info: imported.info,
      lastImportedAt: capturedAt, createdAt: capturedAt, updatedAt: capturedAt },
    operations: imported.operations.map((op) => ({ ...op, createdAt: capturedAt, updatedAt: capturedAt })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
    if (Buffer.byteLength(JSON.stringify(rawSnapshot), "utf8") > C.NATIVE_OPENAPI_IMPORT_SNAPSHOT_MAX_BYTES) throw new NativeOpenapiImportError("bounds_exceeded");
    await admitBase(scope, d, rawSnapshot.connector.baseUrl, deadlineAt);
    return await nativeConnectorTransaction(input.authority, true, async (sql) => {
      await preparationLock(sql, scope, intent.keySha256);
      const row = await preparationRow(sql, scope, intent.keySha256, true);
      if (!row || !same(row.attempt, attempt) || row.input_commitment !== commitment) fail("The original import attempt changed.");
      if (row.state !== "preparing" || Date.parse(await clock(sql)) >= Date.parse(attempt.expiresAt)) return { prepared: await preparationRead(sql, scope, row), replayed: true };
      await targetLock(sql, intent.connectorId); await targetAvailable(sql, scope, intent.connectorId, intent.keySha256);
      await admitBase(scope, d, rawSnapshot.connector.baseUrl, deadlineAt);
      const [normalized] = await sql`SELECT ${rawSnapshot}::JSONB AS snapshot`;
      const snapshot = snapshotSchema.parse(normalized.snapshot), projection = projectNativeOpenapiReview(scope, snapshot.connector, snapshot.operations);
      const summary = summaryFor(scope, snapshot);
      if (!projection.pin) fail("The complete prospective import review is unavailable.");
      await requireNativeConnectorIdentity(sql, scope, true);
      const preparedAt = await clock(sql);
      if (Date.parse(preparedAt) >= Date.parse(attempt.expiresAt)) return { prepared: await preparationRead(sql, scope, row), replayed: true };
      checkNativeOpenapiDeadline(deadlineAt);
      const { contract: _contract, ...safe } = intent;
      const body = { ...safe, contract: "asael-openapi-import-preparation:1", id: C.connectorNativeOpenapiImportPreparationId(scope, intent.keySha256),
        intentSha256: canonicalJsonSha256(intent), resolvedDeclaration: { ...d, endpoint: snapshot.connector.baseUrl }, attemptSha256: attempt.attemptSha256,
        configurationSha256: projection.pin.configurationSha256, snapshotSha256: snapshotDigest(scope, snapshot), summarySha256: canonicalJsonSha256(summary),
        reviewProjectionSha256: connectorNativePrivateDigest(scope.tenantId, ["native-openapi-import-review:1", canonicalJsonSha256(projection)]),
        contractCount: snapshot.operations.length, preparedAt, expiresAt: new Date(Date.parse(preparedAt) + C.NATIVE_OPENAPI_IMPORT_PREPARATION_TTL_MS).toISOString() };
      const proof = C.connectorNativeOpenapiImportPreparationSchema.parse({ ...body, preparationSha256: canonicalJsonSha256(body) });
      const sealed = sealNativeOpenapiImportSnapshot(snapshot, nativeOpenapiImportSnapshotBinding(proof));
      checkNativeOpenapiDeadline(deadlineAt);
      const changed = await sql`UPDATE omni_native_openapi_import_preparations SET state='ready',preparation=${proof}::JSONB,
        expires_at=${proof.expiresAt},sealed_snapshot=${sealed}::JSONB WHERE id=${row.id} AND tenant_id=${scope.tenantId} AND state='preparing' RETURNING id`;
      if (changed.length !== 1) fail("The import attempt can no longer become ready.");
      await event(sql, input.authority, `${proof.id}:prepared`, "connector.native.openapi_import_preparation.prepared", intent.connectorId,
        { preparationId: proof.id, preparationSha256: proof.preparationSha256, attemptSha256: proof.attemptSha256, contractCount: proof.contractCount });
      return { prepared: C.connectorNativeOpenapiImportPreparationReadyReadSchema.parse({ availability: "ready", intent, attempt, preparation: proof, summary }), replayed: false };
    });
  } catch (error) {
    // Only this reserved handler may close its one attempt. Exception text and
    // source are never recorded. Authority loss leaves logical-expiry recovery.
    const code = error instanceof NativeOpenapiImportError ? error.reason === "fetch_failed" ? "source_unavailable" :
      error.reason === "bounds_exceeded" ? "scope_too_large" : "unsupported_spec" : "admission_failed";
    return nativeConnectorTransaction(input.authority, true, async (sql) => {
      await preparationLock(sql, scope, intent.keySha256);
      const row = await preparationRow(sql, scope, intent.keySha256, true);
      if (!row || !same(row.attempt, attempt) || row.input_commitment !== commitment) fail("The original import attempt changed.");
      const failedAt = await clock(sql);
      if (row.state !== "preparing" || Date.parse(failedAt) >= Date.parse(attempt.expiresAt)) return { prepared: await preparationRead(sql, scope, row), replayed: true };
      const failure = { code, failedAt };
      await sql`UPDATE omni_native_openapi_import_preparations SET state='failed',failure=${failure}::JSONB WHERE id=${row.id} AND tenant_id=${scope.tenantId} AND state='preparing'`;
      await event(sql, input.authority, `${attempt.id}:failed`, "connector.native.openapi_import_preparation.failed", intent.connectorId,
        { attemptId: attempt.id, attemptSha256: attempt.attemptSha256, failureCode: code });
      return { prepared: C.connectorNativeOpenapiImportPreparationFailedReadSchema.parse({ availability: "failed", intent, attempt, failure }), replayed: false };
    });
  } finally { request.payload.specText = null; request.payload.specUrl = null; request.payload.endpoint = null; }
}

export async function readNativeOpenapiImportPreparation(authority: ConnectorNativeAuthority, keySha256: string): Promise<C.ConnectorNativeOpenapiImportPreparationRead | null> {
  readOnly(authority); connectorNativeShaSchema.parse(keySha256);
  return nativeConnectorTransaction(authority, false, async (sql) => { await preparationLock(sql, authority.scope, keySha256);
    const row = await preparationRow(sql, authority.scope, keySha256); return row ? preparationRead(sql, authority.scope, row) : null; });
}
export async function readNativeOpenapiImport(authority: ConnectorNativeAuthority, keySha256: string): Promise<C.ConnectorNativeOpenapiImportAction | null> {
  readOnly(authority); connectorNativeShaSchema.parse(keySha256);
  return nativeConnectorTransaction(authority, false, async (sql) => { const receipt = await accepted(sql, authority.scope, keySha256); return receipt && !receipt.otherAction ? receipt.action : null; });
}

function abandonmentScope(authority: ConnectorNativeAuthority, connectorId: string) {
  const s = authority.scope, e = parsePersistedExecutionScope(authority.executionScope);
  if (!e || e.tenantId !== s.tenantId || e.initiatingActorId !== s.ownerActorId || e.executingPrincipalType !== "user" ||
    e.executingPrincipalId !== s.ownerActorId || e.workspaceId || e.projectId || e.missionId || e.delegationId || e.contextGrantIds.length ||
    e.capabilityGrantIds.length || e.purpose !== "api.connectors.native.openapi_import_preparation.abandon" || e.causationId !== connectorId) {
    fail("Exact original-owner import cleanup authority is required.", 403);
  }
}
export async function abandonNativeOpenapiImportPreparation(input: { authority: ConnectorNativeAuthority; request: C.ConnectorNativeOpenapiImportPreparationAbandonRequest;
  idempotencyKey: string; keySha256: string }): Promise<{ prepared: C.ConnectorNativeOpenapiImportPreparationAbandonedRead; replayed: boolean }> {
  const intent = C.connectorNativeOpenapiImportPreparationAbandonRequestSchema.parse(input.request).intent, scope = input.authority.scope;
  connectorNativeShaSchema.parse(input.keySha256);
  if (!same(intent.scope, scope) || intent.keySha256 !== input.keySha256 || connectorNativeKeySha256(scope, input.idempotencyKey) !== intent.keySha256) fail("The exact original import key is required.");
  abandonmentScope(input.authority, intent.connectorId);
  return nativeConnectorTransaction(input.authority, false, async (sql) => {
    await preparationLock(sql, scope, intent.keySha256);
    const row = await preparationRow(sql, scope, intent.keySha256, true);
    if (row && !same(row.intent, intent)) fail("This key belongs to a different import intent.");
    if (row?.state === "consumed") fail("This preparation was consumed. Recover its original final action.");
    if (row?.state === "abandoned") return { prepared: C.connectorNativeOpenapiImportPreparationAbandonedReadSchema.parse(await preparationRead(sql, scope, row)), replayed: true };
    if (!row) {
      await targetLock(sql, intent.connectorId);
      const existing = await sql`SELECT id FROM omni_native_openapi_import_preparations WHERE connector_id=${intent.connectorId} AND tenant_id=${scope.tenantId}`;
      if (existing.length) fail("This OpenAPI identity is permanently reserved by another intent.");
    }
    const attempt = row?.attempt ? C.connectorNativeOpenapiImportAttemptSchema.parse(row.attempt) : null;
    const proof = row?.preparation ? C.connectorNativeOpenapiImportPreparationSchema.parse(row.preparation) : null;
    const body = { contract: "asael-openapi-import-preparation-abandonment:1", id: C.connectorNativeOpenapiImportAbandonmentId(scope, intent.keySha256),
      scope, keySha256: intent.keySha256, intentSha256: canonicalJsonSha256(intent), attemptSha256: attempt?.attemptSha256 ?? null,
      preparationSha256: proof?.preparationSha256 ?? null, abandonedAt: await clock(sql) };
    const abandonment = C.connectorNativeOpenapiImportPreparationAbandonmentSchema.parse({ ...body, abandonmentSha256: canonicalJsonSha256(body) });
    const changed = row
      ? await sql`UPDATE omni_native_openapi_import_preparations SET state='abandoned',sealed_snapshot=NULL,abandonment=${abandonment}::JSONB
          WHERE id=${row.id} AND tenant_id=${scope.tenantId} AND state IN ('preparing','ready','expired','failed') RETURNING id`
      : await sql`INSERT INTO omni_native_openapi_import_preparations(id,tenant_id,owner_actor_id,canonical_actor_id,idempotency_key_sha256,connector_id,intent,state,abandonment)
          VALUES(${C.connectorNativeOpenapiImportPreparationId(scope, intent.keySha256)},${scope.tenantId},${scope.ownerActorId},${scope.canonicalActorId},
            ${intent.keySha256},${intent.connectorId},${intent}::JSONB,'abandoned',${abandonment}::JSONB) ON CONFLICT DO NOTHING RETURNING id`;
    if (changed.length !== 1) fail("The import preparation could not be abandoned.");
    await event(sql, input.authority, abandonment.id, "connector.native.openapi_import_preparation.abandoned", intent.connectorId,
      { preparationId: C.connectorNativeOpenapiImportPreparationId(scope, intent.keySha256), intentSha256: abandonment.intentSha256, abandonmentSha256: abandonment.abandonmentSha256 });
    return { prepared: C.connectorNativeOpenapiImportPreparationAbandonedReadSchema.parse({ availability: "abandoned", intent, attempt, preparation: proof, abandonment }), replayed: false };
  });
}

export async function submitNativeOpenapiImport(input: { authority: ConnectorNativeAuthority; request: C.ConnectorNativeOpenapiImportRequest; idempotencyKey: string }):
Promise<{ action: C.ConnectorNativeOpenapiImportAction; replayed: boolean }> {
  const scope = input.authority.scope, intent = C.buildConnectorNativeOpenapiImportIntent(scope, input.idempotencyKey, input.request), request = intent.request;
  const execution = requireNativeConnectorMutationScope(input.authority, request.connectorId), deadlineAt = Date.now() + 25_000;
  return nativeConnectorTransaction(input.authority, false, async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`native-connector-key:${scope.tenantId}:${scope.ownerActorId}:${intent.keySha256}`},0))`;
    const replay = await accepted(sql, scope, intent.keySha256);
    if (replay) { if (replay.otherAction || !same(replay.intent, intent)) fail("This key already accepted another connector request."); return { action: replay.action, replayed: true }; }
    await requireNativeConnectorIdentity(sql, scope, true);
    const ids = await sql`SELECT idempotency_key_sha256 FROM omni_native_openapi_import_preparations
      WHERE id=${request.preparationId} AND tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId}`;
    if (ids.length !== 1) fail("The original import preparation is unavailable.");
    const preparationKey = connectorNativeShaSchema.parse(ids[0].idempotency_key_sha256);
    await preparationLock(sql, scope, preparationKey);
    const row = await preparationRow(sql, scope, preparationKey, true);
    if (!row || row.state !== "ready") fail("The original import preparation is no longer ready.");
    const proof = C.connectorNativeOpenapiImportPreparationSchema.parse(row.preparation);
    if (!same(C.openapiImportPreparationIntentFromProof(proof), row.intent) || !same(proof.scope, scope) || proof.id !== request.preparationId ||
      proof.preparationSha256 !== request.preparationSha256 || proof.connectorId !== request.connectorId) fail("The confirmation differs from its original proof.");
    const beforeOpen = Date.parse(await clock(sql));
    if (beforeOpen < Date.parse(proof.preparedAt) || beforeOpen >= Date.parse(proof.expiresAt)) fail("The import preparation expired.");
    const { snapshot } = openSnapshot(row, proof);
    await targetLock(sql, request.connectorId); await targetAvailable(sql, scope, request.connectorId, preparationKey);
    await admitBase(scope, proof.resolvedDeclaration, snapshot.connector.baseUrl, deadlineAt);
    const projection = projectNativeOpenapiReview(scope, snapshot.connector, snapshot.operations);
    if (!projection.pin || projection.pin.configurationSha256 !== proof.configurationSha256 ||
      connectorNativePrivateDigest(scope.tenantId, ["native-openapi-import-review:1", canonicalJsonSha256(projection)]) !== proof.reviewProjectionSha256) {
      fail("The complete confirmed import differs from its captured review.");
    }
    await requireNativeConnectorIdentity(sql, scope, true);
    const acceptedAt = await clock(sql);
    if (Date.parse(acceptedAt) < Date.parse(proof.preparedAt) || Date.parse(acceptedAt) >= Date.parse(proof.expiresAt)) fail("The import preparation expired.");
    const body = { contract: "asael-connector-acceptance:1", id: connectorNativeAcceptanceId(scope, intent.keySha256), scope, keySha256: intent.keySha256,
      requestSha256: canonicalJsonSha256(intent), kind: "openapi", connectorId: request.connectorId, action: "import_openapi",
      reviewSha256: proof.preparationSha256, acceptedAt };
    const acceptance = C.connectorNativeOpenapiImportAcceptanceSchema.parse({ ...body, acceptanceSha256: canonicalJsonSha256(body) });
    await sql`INSERT INTO omni_native_connector_actions(id,tenant_id,owner_actor_id,canonical_actor_id,idempotency_key_sha256,kind,connector_id,action,intent,acceptance,accepted_at,state)
      VALUES(${acceptance.id},${scope.tenantId},${scope.ownerActorId},${scope.canonicalActorId},${intent.keySha256},'openapi',${request.connectorId},
        'import_openapi',${intent}::JSONB,${acceptance}::JSONB,${acceptedAt},'accepted')`;
    try { await insertDisabledOpenapiImport(snapshot, { executionScope: execution }); }
    catch (error) { if (error instanceof OpenapiImportInsertConflictError) fail("This OpenAPI identity already exists."); throw error; }
    const consumed = await sql`UPDATE omni_native_openapi_import_preparations SET state='consumed',sealed_snapshot=NULL,
      consumed_by=${acceptance.id},consumed_key_sha256=${intent.keySha256} WHERE id=${proof.id} AND tenant_id=${scope.tenantId} AND state='ready' RETURNING id`;
    if (consumed.length !== 1) fail("The import preparation could not be consumed.");
    const stored = await getOpenApiConnector(request.connectorId, { tenantId: scope.tenantId });
    const operations = (await listOpenApiOperations(request.connectorId, { tenantId: scope.tenantId })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const after = await readNativeConnectorCurrentInTransaction(sql, scope, "openapi", request.connectorId, true);
    if (!stored || !same(stored, snapshot.connector) || !same(operations, snapshot.operations) || !after?.pin ||
      after.connector.status !== "disabled" || after.contracts.length !== proof.contractCount || after.contracts.some((op) => op.status !== "pending_review") ||
      after.pin.configurationSha256 !== proof.configurationSha256 ||
      connectorNativePrivateDigest(scope.tenantId, ["native-openapi-import-review:1", canonicalJsonSha256(after)]) !== proof.reviewProjectionSha256) {
      fail("The complete stored import could not be confirmed.");
    }
    const settlementBody = { contract: "asael-connector-settlement:2", acceptanceId: acceptance.id, settledAt: await clock(sql), result: {
      kind: "openapi", connectorId: request.connectorId, operation: "import_openapi", status: "complete", connectorStatus: "disabled",
      contractCount: proof.contractCount, credentialVersion: 0, connectorSha256: after.pin.connectorSha256, contractsSha256: after.pin.contractsSha256,
      configurationSha256: after.pin.configurationSha256, trash: null, failureCode: null } };
    const settlement = C.connectorNativeOpenapiImportSettlementSchema.parse({ ...settlementBody, settlementSha256: canonicalJsonSha256(settlementBody) });
    const settled = await sql`UPDATE omni_native_connector_actions SET state='settled',settlement=${settlement}::JSONB WHERE id=${acceptance.id} AND tenant_id=${scope.tenantId} AND state='accepted' RETURNING id`;
    if (settled.length !== 1) fail("The import acceptance could not be settled.");
    await event(sql, input.authority, acceptance.id, "connector.native.action.accepted", request.connectorId,
      { acceptanceId: acceptance.id, action: "import_openapi", kind: "openapi", connectorId: request.connectorId,
        requestSha256: acceptance.requestSha256, acceptanceSha256: acceptance.acceptanceSha256 });
    await event(sql, input.authority, `${acceptance.id}:settled`, "connector.native.action.settled", request.connectorId,
      { acceptanceId: acceptance.id, settlementSha256: settlement.settlementSha256 });
    return { action: C.connectorNativeOpenapiImportActionSchema.parse({ acceptance, state: "settled", settlement }), replayed: false };
  });
}

export type NativeOpenapiImportPreparationScrub = { status: "complete" | "deferred" | "failed"; scrubbed: number; moreAvailable: boolean; oldestExpiredAt: string | null };
export async function scrubExpiredNativeOpenapiImportPreparations(input: { tenantId: string; limit?: number; deadlineAt: number }): Promise<NativeOpenapiImportPreparationScrub> {
  const deferred: NativeOpenapiImportPreparationScrub = { status: "deferred", scrubbed: 0, moreAvailable: true, oldestExpiredAt: null };
  if (!hasDatabaseUrl() || Date.now() >= input.deadlineAt) return deferred;
  if (!input.tenantId || input.tenantId.trim() !== input.tenantId || input.tenantId.length > 120) fail("An exact tenant is required for import cleanup.", 400);
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 100), 1), 100);
  await ensureDatabaseSchema();
  return runWithDatabaseSystemScope("Scrub expired OpenAPI import snapshots for one exact tenant.", () => getSql().transaction(async (sql: Sql) => {
    const remaining = Math.min(2000, Math.floor(input.deadlineAt - Date.now())); if (remaining <= 0) return deferred;
    await sql`SELECT set_config('statement_timeout',${String(remaining)},true)`;
    const rows = await sql`WITH expired AS (SELECT id FROM omni_native_openapi_import_preparations
      WHERE tenant_id=${input.tenantId} AND state='ready' AND sealed_snapshot IS NOT NULL AND expires_at<=clock_timestamp()
      ORDER BY expires_at,id FOR UPDATE SKIP LOCKED LIMIT ${limit}), scrubbed AS (
      UPDATE omni_native_openapi_import_preparations target SET state='expired',sealed_snapshot=NULL FROM expired
      WHERE target.id=expired.id AND target.tenant_id=${input.tenantId} AND target.state='ready'
        AND target.expires_at<=clock_timestamp() RETURNING target.id)
      SELECT (SELECT count(*)::INTEGER FROM scrubbed) AS scrubbed,
        (SELECT to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          FROM omni_native_openapi_import_preparations WHERE tenant_id=${input.tenantId} AND state='ready' AND sealed_snapshot IS NOT NULL
            AND expires_at<=clock_timestamp() AND id NOT IN (SELECT id FROM scrubbed)
          ORDER BY expires_at,id LIMIT 1) AS oldest`;
    return { status: "complete" as const, scrubbed: Number(rows[0].scrubbed), moreAvailable: rows[0].oldest !== null,
      oldestExpiredAt: rows[0].oldest === null ? null : String(rows[0].oldest) };
  }) as Promise<NativeOpenapiImportPreparationScrub>);
}
