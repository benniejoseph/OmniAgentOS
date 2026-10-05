import { getSql } from "@/lib/db/client";
import { deleteMcpConnector, getMcpConnector, listMcpTools } from "@/lib/connectors/store";
import { isRemoteBrowserMcpTool } from "@/lib/connectors/mcp-trust";
import { connectorNativeAcceptanceId, connectorNativeIdSchema, connectorNativeShaSchema, connectorNativeTrashTarget,
  NativeConnectorError, type ConnectorNativeReview, type ConnectorNativeScope } from "@/lib/connectors/native-control-contracts";
import { nativeConnectorTransaction, readNativeConnectorCurrentInTransaction, requireNativeConnectorIdentity,
  requireNativeConnectorMutationScope, type ConnectorNativeAuthority } from "@/lib/connectors/native-control-store";
import { buildConnectorNativeTrashIntent, canTrashNativeConnector, CONNECTOR_NATIVE_TRASH_PREVIEW_MS,
  connectorNativeTrashAcceptanceSchema, connectorNativeTrashActionSchema, connectorNativeTrashCompensation,
  connectorNativeTrashEffectSummary, connectorNativeTrashIntentSchema, connectorNativeTrashPreviewSchema,
  connectorNativeTrashSettlementSchema, type ConnectorNativeTrashAction, type ConnectorNativeTrashPreview,
  type ConnectorNativeTrashRequest } from "@/lib/connectors/native-trash-contracts";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { compensationForSnapshot, type RestorableResourceSnapshot } from "@/lib/trash/resources";
import { createTrashEntry, createTrashPreview, getTrashLifecycleResultByPreview } from "@/lib/trash/store";
import { trashEffectReceiptV1Schema, trashItemV1Schema } from "@/lib/trash/contracts";

type Sql = ReturnType<typeof getSql>;
const same = (a: unknown, b: unknown) => canonicalJsonSha256(a) === canonicalJsonSha256(b);
function conflict(message: string): never { throw new NativeConnectorError("connector_conflict", 409, message); }
function readOnly(authority: ConnectorNativeAuthority) {
  if (authority.executionScope) throw new NativeConnectorError("connector_read_authority", 400, "Trash reads require read-only authority.");
}

/** Called only after the native parent/complete child locks. Getters expose metadata, never vault ciphertext. */
async function captureLocked(scope: ConnectorNativeScope, review: ConnectorNativeReview): Promise<RestorableResourceSnapshot> {
  const resource = await getMcpConnector(review.connector.id, { tenantId: scope.tenantId });
  const children = await listMcpTools(review.connector.id, { tenantId: scope.tenantId });
  const ids = children.map((child) => child.id).sort();
  if (!resource || resource.tenantId !== scope.tenantId || resource.id !== review.connector.id || resource.id.length > 240 ||
    children.length > 200 || children.some((child) => child.tenantId !== scope.tenantId || child.connectorId !== resource.id) ||
    ids.some((id) => id.length < 1 || id.length > 240 || id.trim() !== id) ||
    !same(ids, review.contracts.map((child) => child.id).sort())) conflict("The complete restorable MCP target changed or exceeds this bounded snapshot.");
  if (children.some(isRemoteBrowserMcpTool)) conflict("This MCP contract set is not supported by Trash restore.");
  const snapshot = { resourceType: "mcp_connector" as const, resource: { ...resource },
    children: children.map((child) => ({ ...child })), affectedResourceIds: ids };
  // This bound includes private configuration, which the public review projection does not contain.
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > 1_000_000) conflict("The restorable MCP snapshot exceeds the one-megabyte limit.");
  return snapshot;
}

export async function previewNativeConnectorTrash(authority: ConnectorNativeAuthority, connectorId: string): Promise<ConnectorNativeTrashPreview> {
  readOnly(authority); connectorNativeIdSchema.parse(connectorId);
  return nativeConnectorTransaction(authority, true, async (sql) => {
    const review = await readNativeConnectorCurrentInTransaction(sql, authority.scope, "mcp", connectorId, true);
    if (!review || !canTrashNativeConnector(review)) return connectorNativeTrashPreviewSchema.parse({ review, preview: null, compensation: null });
    const snapshot = await captureLocked(authority.scope, review);
    const compensation = compensationForSnapshot(snapshot);
    await requireNativeConnectorIdentity(sql, authority.scope, true);
    return connectorNativeTrashPreviewSchema.parse({ review, compensation,
      preview: createTrashPreview({ resourceType: "mcp_connector", resourceId: connectorId,
        target: connectorNativeTrashTarget(review.pin!), effectSummary: connectorNativeTrashEffectSummary(review),
        previewWindowMs: CONNECTOR_NATIVE_TRASH_PREVIEW_MS }) });
  });
}

async function accepted(sql: Sql, scope: ConnectorNativeScope, keySha256: string) {
  const rows = await sql`SELECT action,intent,acceptance,state,settlement FROM omni_native_connector_actions
    WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId} AND idempotency_key_sha256=${keySha256}`;
  if (!rows.length) return null;
  if (rows.length !== 1) conflict("The stored connector acceptance is inconsistent.");
  if (rows[0].action !== "trash") return { otherAction: true as const };
  const intent = connectorNativeTrashIntentSchema.parse(rows[0].intent);
  const action = connectorNativeTrashActionSchema.parse({ acceptance: rows[0].acceptance, state: rows[0].state, settlement: rows[0].settlement });
  const a = action.acceptance;
  if (!same(intent.scope, scope) || !same(a.scope, scope) || intent.keySha256 !== keySha256 || a.keySha256 !== keySha256 ||
    a.requestSha256 !== canonicalJsonSha256(intent) || a.reviewSha256 !== intent.request.review.reviewSha256 || a.connectorId !== intent.request.connectorId) {
    conflict("The stored Trash acceptance is inconsistent.");
  }
  return { otherAction: false as const, intent, action };
}

export async function readNativeConnectorTrash(authority: ConnectorNativeAuthority, keySha256: string): Promise<ConnectorNativeTrashAction | null> {
  readOnly(authority); connectorNativeShaSchema.parse(keySha256);
  return nativeConnectorTransaction(authority, false, async (sql) => {
    const receipt = await accepted(sql, authority.scope, keySha256);
    return receipt && !receipt.otherAction ? receipt.action : null;
  });
}

export async function submitNativeConnectorTrash(input: {
  authority: ConnectorNativeAuthority; request: ConnectorNativeTrashRequest; idempotencyKey: string;
}): Promise<{ action: ConnectorNativeTrashAction; replayed: boolean }> {
  const { authority } = input, scope = authority.scope;
  const intent = buildConnectorNativeTrashIntent(scope, input.idempotencyKey, input.request), request = intent.request;
  const execution = requireNativeConnectorMutationScope(authority, request.connectorId);
  return nativeConnectorTransaction(authority, false, async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`native-connector-key:${scope.tenantId}:${scope.ownerActorId}:${intent.keySha256}`},0))`;
    // The connector and preview may no longer exist/be fresh after an accepted operation.
    const replay = await accepted(sql, scope, intent.keySha256);
    if (replay) {
      if (replay.otherAction || !same(replay.intent, intent)) conflict("This key already accepted another connector request.");
      return { action: replay.action, replayed: true };
    }
    await requireNativeConnectorIdentity(sql, scope, true);
    const reviewed = await readNativeConnectorCurrentInTransaction(sql, scope, "mcp", request.connectorId, true);
    if (!reviewed || !canTrashNativeConnector(reviewed) || !same(reviewed.pin, request.review) ||
      request.preview.effectSummary !== connectorNativeTrashEffectSummary(reviewed)) conflict("The reviewed connector or Trash effect changed.");
    const now = Date.now();
    if (now < Date.parse(request.preview.issuedAt) || now >= Date.parse(request.preview.expiresAt)) conflict("The Trash preview is not current. Review it again.");
    const snapshot = await captureLocked(scope, reviewed), compensation = compensationForSnapshot(snapshot);
    if (!same(compensation, connectorNativeTrashCompensation(reviewed))) conflict("The reviewed Trash compensation changed.");
    if (await getTrashLifecycleResultByPreview(request.preview.previewSha256, { executionScope: execution })) {
      conflict("This preview already has a Trash receipt and cannot be adopted by another native action.");
    }
    await requireNativeConnectorIdentity(sql, scope, true);
    const acceptedAt = new Date().toISOString();
    const body = { contract: "asael-connector-acceptance:1", id: connectorNativeAcceptanceId(scope, intent.keySha256), scope,
      keySha256: intent.keySha256, requestSha256: canonicalJsonSha256(intent), kind: "mcp", connectorId: request.connectorId,
      action: "trash", reviewSha256: request.review.reviewSha256, acceptedAt };
    const acceptance = connectorNativeTrashAcceptanceSchema.parse({ ...body, acceptanceSha256: canonicalJsonSha256(body) });
    await sql`INSERT INTO omni_native_connector_actions(id,tenant_id,owner_actor_id,canonical_actor_id,idempotency_key_sha256,kind,connector_id,action,intent,acceptance,accepted_at,state)
      VALUES(${acceptance.id},${scope.tenantId},${scope.ownerActorId},${scope.canonicalActorId},${intent.keySha256},'mcp',${request.connectorId},'trash',
        ${intent}::JSONB,${acceptance}::JSONB,${acceptedAt},'accepted')`;
    const target = connectorNativeTrashTarget(request.review);
    // Both helpers and all their events resolve this adopted transaction. No compensation wrapper is needed.
    const moved = await createTrashEntry({ preview: request.preview, displayLabel: reviewed.connector.name, target, snapshot, compensation }, { executionScope: execution });
    const item = trashItemV1Schema.parse(moved.item), proof = trashEffectReceiptV1Schema.parse(moved.receipt);
    if (item.tenantId !== scope.tenantId || item.ownerActorId !== scope.ownerActorId || item.resourceType !== "mcp_connector" ||
      item.resourceId !== request.connectorId || item.targetSha256 !== request.preview.targetSha256 || item.snapshotSha256 !== canonicalJsonSha256(snapshot) ||
      item.state !== "retained" || item.lifecycleRevision !== 1 || !same(item.compensation, compensation) ||
      proof.trashId !== item.trashId || proof.resourceType !== item.resourceType || proof.resourceId !== item.resourceId || proof.targetSha256 !== item.targetSha256 ||
      proof.previewSha256 !== request.preview.previewSha256 || proof.action !== "trash" || proof.beforeState !== null || proof.afterState !== "retained" ||
      proof.beforeRevision !== 0 || proof.afterRevision !== 1 || proof.outcome !== "applied" || !same(proof.affectedResourceIds, [request.connectorId])) {
      conflict("The Trash proof does not bind this exact captured target.");
    }
    if (!await deleteMcpConnector(request.connectorId, { executionScope: execution })) conflict("The reviewed connector could not be moved to Trash.");
    const [remaining] = await sql`SELECT
      EXISTS(SELECT 1 FROM omni_mcp_connectors WHERE tenant_id=${scope.tenantId} AND id=${request.connectorId}) AS connector,
      EXISTS(SELECT 1 FROM omni_mcp_tools WHERE tenant_id=${scope.tenantId} AND connector_id=${request.connectorId}) AS tools`;
    if (!remaining || remaining.connector !== false || remaining.tools !== false) conflict("The completed Trash move could not be confirmed.");
    await requireNativeConnectorIdentity(sql, scope, true);
    const settlementBody = { contract: "asael-connector-settlement:2", acceptanceId: acceptance.id, settledAt: new Date().toISOString(),
      result: { kind: "mcp", connectorId: request.connectorId, operation: "trash", status: "complete", connectorStatus: null,
        contractCount: null, credentialVersion: null, connectorSha256: null, contractsSha256: null, configurationSha256: null, failureCode: null,
        trash: { trashId: item.trashId, proofSha256: proof.receiptSha256, restoreUntil: item.restoreUntil,
          compensation: item.compensation.kind, limitation: item.compensation.limitation } } };
    const settlement = connectorNativeTrashSettlementSchema.parse({ ...settlementBody, settlementSha256: canonicalJsonSha256(settlementBody) });
    const settled = await sql`UPDATE omni_native_connector_actions SET state='settled',settlement=${settlement}::JSONB
      WHERE id=${acceptance.id} AND tenant_id=${scope.tenantId} AND state='accepted' RETURNING id`;
    if (settled.length !== 1) conflict("The accepted Trash move could not be settled.");
    await appendScopedDomainEvent({ id: acceptance.id, streamId: `connector-native:mcp:${request.connectorId}`, type: "connector.native.action.accepted",
      executionScope: execution, payload: { schemaVersion: 1, acceptanceId: acceptance.id, action: "trash", kind: "mcp", connectorId: request.connectorId,
        requestSha256: acceptance.requestSha256, acceptanceSha256: acceptance.acceptanceSha256 } }, { sql });
    await appendScopedDomainEvent({ id: `${acceptance.id}:settled`, streamId: `connector-native:mcp:${request.connectorId}`, type: "connector.native.action.settled",
      executionScope: execution, payload: { schemaVersion: 1, acceptanceId: acceptance.id, settlementSha256: settlement.settlementSha256 } }, { sql });
    return { action: connectorNativeTrashActionSchema.parse({ acceptance, state: "settled", settlement }), replayed: false };
  });
}
