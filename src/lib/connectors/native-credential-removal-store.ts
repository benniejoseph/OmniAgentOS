import { getSql } from "@/lib/db/client";
import { removeMcpBearerCredential } from "@/lib/connectors/credential-store";
import { connectorNativeAcceptanceId, connectorNativeShaSchema, NativeConnectorError, type ConnectorNativeScope } from "@/lib/connectors/native-control-contracts";
import { nativeConnectorTransaction, readNativeConnectorCurrentInTransaction, requireNativeConnectorIdentity,
  requireNativeConnectorMutationScope, type ConnectorNativeAuthority } from "@/lib/connectors/native-control-store";
import { buildConnectorNativeCredentialRemovalIntent, canRemoveNativeConnectorCredential,
  connectorNativeCredentialRemovalAcceptanceSchema, connectorNativeCredentialRemovalActionSchema,
  connectorNativeCredentialRemovalIntentSchema, connectorNativeCredentialRemovalSettlementSchema,
  type ConnectorNativeCredentialRemovalAction, type ConnectorNativeCredentialRemovalRequest } from "@/lib/connectors/native-credential-removal-contracts";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

type Sql = ReturnType<typeof getSql>;
const same = (left: unknown, right: unknown) => canonicalJsonSha256(left) === canonicalJsonSha256(right);
function conflict(message: string): never { throw new NativeConnectorError("connector_conflict", 409, message); }

async function accepted(sql: Sql, scope: ConnectorNativeScope, keySha256: string) {
  const rows = await sql`SELECT action,intent,acceptance,state,settlement FROM omni_native_connector_actions
    WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId} AND idempotency_key_sha256=${keySha256}`;
  if (!rows.length) return null;
  if (rows.length !== 1) conflict("The stored connector acceptance is inconsistent.");
  if (rows[0].action !== "remove_credential") return { otherAction: true as const };
  const intent = connectorNativeCredentialRemovalIntentSchema.parse(rows[0].intent);
  const action = connectorNativeCredentialRemovalActionSchema.parse({ acceptance: rows[0].acceptance, state: rows[0].state, settlement: rows[0].settlement });
  const a = action.acceptance;
  if (!same(intent.scope, scope) || !same(a.scope, scope) || intent.keySha256 !== keySha256 || a.keySha256 !== keySha256 ||
    a.requestSha256 !== canonicalJsonSha256(intent) || a.reviewSha256 !== intent.request.review.reviewSha256 ||
    a.connectorId !== intent.request.connectorId || action.settlement &&
    action.settlement.result.credentialVersion !== intent.request.review.credentialVersion + 1) {
    conflict("The stored credential removal acceptance is inconsistent.");
  }
  return { otherAction: false as const, intent, action };
}

export async function readNativeConnectorCredentialRemoval(authority: ConnectorNativeAuthority, keySha256: string): Promise<ConnectorNativeCredentialRemovalAction | null> {
  if (authority.executionScope) throw new NativeConnectorError("connector_read_authority", 400, "Connector receipt reads require read-only authority.");
  connectorNativeShaSchema.parse(keySha256);
  return nativeConnectorTransaction(authority, false, async (sql) => {
    const receipt = await accepted(sql, authority.scope, keySha256);
    return receipt && !receipt.otherAction ? receipt.action : null;
  });
}

export async function submitNativeConnectorCredentialRemoval(input: {
  authority: ConnectorNativeAuthority; request: ConnectorNativeCredentialRemovalRequest; idempotencyKey: string;
}): Promise<{ action: ConnectorNativeCredentialRemovalAction; replayed: boolean }> {
  const { authority } = input, scope = authority.scope;
  const intent = buildConnectorNativeCredentialRemovalIntent(scope, input.idempotencyKey, input.request), request = intent.request;
  const execution = requireNativeConnectorMutationScope(authority, request.connectorId);
  return nativeConnectorTransaction(authority, false, async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`native-connector-key:${scope.tenantId}:${scope.ownerActorId}:${intent.keySha256}`},0))`;
    // Historical same-key recovery comes before fresh availability/management admission.
    const replay = await accepted(sql, scope, intent.keySha256);
    if (replay) {
      if (replay.otherAction || !same(replay.intent, intent)) conflict("This key already accepted another connector request.");
      return { action: replay.action, replayed: true };
    }
    await requireNativeConnectorIdentity(sql, scope, true);
    const reviewed = await readNativeConnectorCurrentInTransaction(sql, scope, "mcp", request.connectorId, true);
    if (!reviewed || !canRemoveNativeConnectorCredential(reviewed) || !same(reviewed.pin, request.review)) {
      conflict("The reviewed connector changed or saved credential removal is unavailable.");
    }
    await requireNativeConnectorIdentity(sql, scope, true);
    const acceptedAt = new Date().toISOString();
    const body = { contract: "asael-connector-acceptance:1", id: connectorNativeAcceptanceId(scope, intent.keySha256), scope,
      keySha256: intent.keySha256, requestSha256: canonicalJsonSha256(intent), kind: "mcp", connectorId: request.connectorId,
      action: "remove_credential", reviewSha256: request.review.reviewSha256, acceptedAt };
    const acceptance = connectorNativeCredentialRemovalAcceptanceSchema.parse({ ...body, acceptanceSha256: canonicalJsonSha256(body) });
    await sql`INSERT INTO omni_native_connector_actions(id,tenant_id,owner_actor_id,canonical_actor_id,idempotency_key_sha256,kind,connector_id,action,intent,acceptance,accepted_at,state)
      VALUES(${acceptance.id},${scope.tenantId},${scope.ownerActorId},${scope.canonicalActorId},${intent.keySha256},'mcp',${request.connectorId},'remove_credential',
        ${intent}::JSONB,${acceptance}::JSONB,${acceptedAt},'accepted')`;
    // The entire awaited helper (including its credential event) joins this managed transaction.
    const removed = await removeMcpBearerCredential({ tenantId: scope.tenantId, connectorId: request.connectorId, executionScope: execution });
    const nextVersion = request.review.credentialVersion + 1;
    if (!removed.removed || removed.credential.configured || removed.credential.version !== nextVersion) {
      conflict("The exact reviewed saved credential was not removed.");
    }
    const after = await readNativeConnectorCurrentInTransaction(sql, scope, "mcp", request.connectorId, true);
    if (!after?.pin || after.connector.status !== "disabled" || after.connector.credentialConfigured ||
      after.connector.credentialVersion !== nextVersion || after.connector.contractCount !== 0 || after.contracts.length !== 0 ||
      after.connector.discoveredAt !== null) conflict("The completed credential removal could not be confirmed.");
    const settlementBody = { contract: "asael-connector-settlement:2", acceptanceId: acceptance.id, settledAt: new Date().toISOString(),
      result: { kind: "mcp", connectorId: request.connectorId, operation: "remove_credential", status: "complete", connectorStatus: "disabled",
        contractCount: 0, credentialVersion: nextVersion, connectorSha256: after.pin.connectorSha256, contractsSha256: after.pin.contractsSha256,
        configurationSha256: after.pin.configurationSha256, trash: null, failureCode: null } };
    const settlement = connectorNativeCredentialRemovalSettlementSchema.parse({ ...settlementBody, settlementSha256: canonicalJsonSha256(settlementBody) });
    const settled = await sql`UPDATE omni_native_connector_actions SET state='settled',settlement=${settlement}::JSONB
      WHERE id=${acceptance.id} AND tenant_id=${scope.tenantId} AND state='accepted' RETURNING id`;
    if (settled.length !== 1) conflict("The accepted credential removal could not be settled.");
    await appendScopedDomainEvent({ id: acceptance.id, streamId: `connector-native:mcp:${request.connectorId}`, type: "connector.native.action.accepted",
      executionScope: execution, payload: { schemaVersion: 1, acceptanceId: acceptance.id, action: request.action, kind: "mcp",
        connectorId: request.connectorId, requestSha256: acceptance.requestSha256, acceptanceSha256: acceptance.acceptanceSha256 } }, { sql });
    await appendScopedDomainEvent({ id: `${acceptance.id}:settled`, streamId: `connector-native:mcp:${request.connectorId}`, type: "connector.native.action.settled",
      executionScope: execution, payload: { schemaVersion: 1, acceptanceId: acceptance.id, settlementSha256: settlement.settlementSha256 } }, { sql });
    return { action: connectorNativeCredentialRemovalActionSchema.parse({ acceptance, state: "settled", settlement }), replayed: false };
  });
}
