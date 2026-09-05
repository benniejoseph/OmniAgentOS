import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import {
  sourceAdapterDeleteV1Schema,
  sourceAdapterOutputV1Schema,
  sourceAdapterUpsertV1Schema,
  sourceContractSha256,
  type SourceAdapterDeleteV1,
  type SourceAdapterOutputV1,
  type SourceAdapterUpsertV1,
} from "@/lib/sources/contracts";
import {
  assertCanonicalAdapterOutputReceipt,
  storedAdapterEnvelopeMatches,
  type SourceSqlClient,
} from "@/lib/sources/store";

export type CanonicalSourcePhaseRank = 0 | 1;

/**
 * Provider timestamps are deliberately absent. This tuple is the only source
 * of truth for convergence precedence.
 */
export type CanonicalSourceOrder = Readonly<{
  authorizationGeneration: number;
  rolloutGeneration: number;
  phaseRank: CanonicalSourcePhaseRank;
  pageSequence: number;
  ordinal: number;
}>;

export type PreparedCanonicalSourceUpsert = Readonly<{
  executionScope: ExecutionScope;
  order: CanonicalSourceOrder;
  output: SourceAdapterUpsertV1;
}>;

export type PreparedCanonicalSourceDelete = Readonly<{
  executionScope: ExecutionScope;
  order: CanonicalSourceOrder;
  output: SourceAdapterDeleteV1;
}>;

export type PreparedCanonicalSourceMutation =
  | PreparedCanonicalSourceUpsert
  | PreparedCanonicalSourceDelete;

export type CanonicalSourceMutationNoopReason =
  | "stale"
  | "duplicate"
  | "not_found";

export type CanonicalSourceMutationResult =
  | Readonly<{
    status: "applied";
    operation: "upsert";
    sourceItemId: string;
    sourceRevisionId: string;
    sourceTombstoneId: null;
    adapterOutputId: string;
    adapterOutputSha256: string;
    order: CanonicalSourceOrder;
  }>
  | Readonly<{
    status: "applied";
    operation: "delete";
    sourceItemId: string;
    sourceRevisionId: null;
    sourceTombstoneId: string;
    adapterOutputId: string;
    adapterOutputSha256: string;
    order: CanonicalSourceOrder;
  }>
  | Readonly<{
    status: "noop";
    operation: "upsert" | "delete";
    reason: CanonicalSourceMutationNoopReason;
    sourceItemId: string | null;
    sourceRevisionId: null;
    sourceTombstoneId: null;
    adapterOutputId: string | null;
    adapterOutputSha256: string | null;
    order: CanonicalSourceOrder;
  }>;

export type CanonicalSourceInvariantCode =
  | "scope_mismatch"
  | "identity_conflict"
  | "order_conflict"
  | "revision_predecessor_mismatch"
  | "delete_revision_mismatch"
  | "immutable_conflict"
  | "head_compare_and_swap_failed";

export class CanonicalSourceInvariantError extends Error {
  readonly code: CanonicalSourceInvariantCode;

  constructor(code: CanonicalSourceInvariantCode, message: string) {
    super(message);
    this.name = "CanonicalSourceInvariantError";
    this.code = code;
  }
}

type LockedSourceItemRow = Readonly<Record<string, unknown>>;
type LockedSourceHeadRow = Readonly<Record<string, unknown>>;

type LockedCanonicalSource = Readonly<{
  item: LockedSourceItemRow | null;
  head: LockedSourceHeadRow | null;
}>;

type CanonicalSourceTombstone = Readonly<{
  id: string;
  sha256: string;
}>;

export async function applyPreparedCanonicalSourceMutation(
  sql: SourceSqlClient,
  mutation: PreparedCanonicalSourceMutation,
): Promise<CanonicalSourceMutationResult> {
  const output = sourceAdapterOutputV1Schema.parse(mutation.output);
  if (output.operation === "upsert") {
    return applyPreparedCanonicalSourceUpsert(sql, {
      executionScope: mutation.executionScope,
      order: mutation.order,
      output,
    });
  }
  return applyPreparedCanonicalSourceDelete(sql, {
    executionScope: mutation.executionScope,
    order: mutation.order,
    output,
  });
}

/** Applies one already-built canonical upsert inside the caller's transaction. */
export async function applyPreparedCanonicalSourceUpsert(
  sql: SourceSqlClient,
  mutation: PreparedCanonicalSourceUpsert,
): Promise<CanonicalSourceMutationResult> {
  assertPostgresTransaction(sql);
  const output = sourceAdapterUpsertV1Schema.parse(mutation.output);
  const executionScope = exactMutationScope(mutation.executionScope, output);
  const order = validatedCanonicalSourceOrder(mutation.order);
  const item = output.sourceItem;
  const revision = output.sourceRevision;
  await lockCanonicalAdapterOutputIdentity(sql, output);
  const locked = await lockCanonicalSource(sql, item.tenantId, item.sourceItemId);

  if (locked.item) {
    assertStoredItemIdentity(locked.item, output);
  } else if (locked.head) {
    assertAbsenceHead(locked.head);
  }
  if (locked.head) assertStoredHeadIdentity(locked.head, output);

  const ordering = existingHeadDisposition(
    locked.head,
    order,
    output,
    null,
    false,
  );
  if (ordering === "stale") {
    return noopResult(
      "upsert",
      "stale",
      locked.item ? item.sourceItemId : null,
      order,
      null,
    );
  }
  if (ordering === "duplicate") {
    if (
      !locked.item ||
      nullableStoredId(locked.item.current_revision_id) !==
        revision.sourceRevisionId
    ) {
      throw new CanonicalSourceInvariantError(
        "identity_conflict",
        "Canonical duplicate head does not match the locked current revision.",
      );
    }
    return noopResult(
      "upsert",
      "duplicate",
      item.sourceItemId,
      order,
      output,
    );
  }

  const lockedCurrentRevisionId = locked.item
    ? nullableStoredId(locked.item.current_revision_id)
    : null;
  if (revision.previousSourceRevisionId !== lockedCurrentRevisionId) {
    throw new CanonicalSourceInvariantError(
      "revision_predecessor_mismatch",
      "Prepared source revision does not extend the locked current revision.",
    );
  }

  await assertCanonicalAdapterOutputReceipt(sql, output);
  await persistConvergentSourceItem(sql, output, Boolean(locked.item));
  await persistConvergentSourceRevision(sql, output);
  await persistConvergentEvidenceUnits(sql, output);

  const advancedItem = await sql`
    UPDATE omni_source_items
    SET current_revision_id = ${revision.sourceRevisionId},
        updated_at = NOW()
    WHERE tenant_id = ${item.tenantId}
      AND id = ${item.sourceItemId}
      AND current_revision_id IS NOT DISTINCT FROM ${lockedCurrentRevisionId}
    RETURNING id
  `;
  if (advancedItem.length !== 1) {
    throw new CanonicalSourceInvariantError(
      "revision_predecessor_mismatch",
      "Canonical source current revision changed while it was locked.",
    );
  }

  await compareAndSwapCanonicalHead(sql, {
    output,
    order,
    sourceRevisionId: revision.sourceRevisionId,
    sourceTombstoneId: null,
    absenceObserved: false,
  });

  await appendScopedDomainEvent({
    id: canonicalSourceMutationEventId(output, order),
    streamId: `source:${item.sourceItemId}`,
    type: "source.revision.canonical_applied",
    executionScope,
    payload: {
      schemaVersion: 1,
      mutationStatus: "applied",
      operation: "upsert",
      sourceItemId: item.sourceItemId,
      sourceRevisionId: revision.sourceRevisionId,
      sourceItemSha256: item.sourceItemSha256,
      sourceRevisionSha256: revision.sourceRevisionSha256,
      adapterOutputId: output.adapterOutputId,
      adapterOutputSha256: output.adapterOutputSha256,
      connectionId: item.connectionId,
      adapterId: output.adapterId,
      evidenceUnitCount: output.evidenceUnits.length,
      evidenceUnitSetSha256: sourceContractSha256(
        output.evidenceUnits.map((evidence) => evidence.evidenceUnitId),
      ),
      ...order,
    },
  }, { sql });

  return Object.freeze({
    status: "applied" as const,
    operation: "upsert" as const,
    sourceItemId: item.sourceItemId,
    sourceRevisionId: revision.sourceRevisionId,
    sourceTombstoneId: null,
    adapterOutputId: output.adapterOutputId,
    adapterOutputSha256: output.adapterOutputSha256,
    order,
  });
}

/** Applies one already-built canonical delete inside the caller's transaction. */
export async function applyPreparedCanonicalSourceDelete(
  sql: SourceSqlClient,
  mutation: PreparedCanonicalSourceDelete,
): Promise<CanonicalSourceMutationResult> {
  assertPostgresTransaction(sql);
  const output = sourceAdapterDeleteV1Schema.parse(mutation.output);
  const executionScope = exactMutationScope(mutation.executionScope, output);
  const order = validatedCanonicalSourceOrder(mutation.order);
  await lockCanonicalAdapterOutputIdentity(sql, output);
  const locked = await lockCanonicalSource(
    sql,
    output.tenantId,
    output.sourceItemId,
  );

  if (!locked.item) {
    if (locked.head) {
      assertAbsenceHead(locked.head);
      assertStoredHeadIdentity(locked.head, output);
    }
    const ordering = existingHeadDisposition(
      locked.head,
      order,
      output,
      null,
      true,
    );
    if (ordering === "stale") {
      return noopResult("delete", "stale", null, order, null);
    }
    if (ordering === "duplicate") {
      return noopResult("delete", "duplicate", null, order, output);
    }

    await assertCanonicalAdapterOutputReceipt(sql, output);
    await compareAndSwapCanonicalHead(sql, {
      output,
      order,
      sourceRevisionId: null,
      sourceTombstoneId: null,
      absenceObserved: true,
    });
    await appendScopedDomainEvent({
      id: canonicalSourceMutationEventId(output, order),
      streamId: `source:${output.sourceItemId}`,
      type: "source.absence.canonical_observed",
      executionScope,
      payload: {
        schemaVersion: 1,
        mutationStatus: "noop",
        operation: "delete",
        noopReason: "not_found",
        sourceState: "absent",
        sourceItemId: output.sourceItemId,
        providerItemKeySha256: output.providerItemKeySha256,
        adapterOutputId: output.adapterOutputId,
        adapterOutputSha256: output.adapterOutputSha256,
        connectionId: output.connectionId,
        adapterId: output.adapterId,
        evidenceUnitCount: 0,
        ...order,
      },
    }, { sql });
    return noopResult("delete", "not_found", null, order, output);
  }
  const tombstone = canonicalSourceTombstone(output);
  assertStoredDeleteIdentity(locked.item, output);
  if (locked.head) assertStoredHeadIdentity(locked.head, output);

  const ordering = existingHeadDisposition(
    locked.head,
    order,
    output,
    tombstone.id,
    false,
  );
  if (ordering === "stale") {
    return noopResult("delete", "stale", output.sourceItemId, order, null);
  }
  assertStoredDeleteBinding(locked.item, output);
  if (ordering === "duplicate") {
    if (
      output.lastKnownSourceRevisionId !==
        nullableStoredId(locked.item.current_revision_id)
    ) {
      throw new CanonicalSourceInvariantError(
        "delete_revision_mismatch",
        "Canonical duplicate delete does not match the locked current revision.",
      );
    }
    return noopResult(
      "delete",
      "duplicate",
      output.sourceItemId,
      order,
      output,
    );
  }

  const lockedCurrentRevisionId = nullableStoredId(
    locked.item.current_revision_id,
  );
  if (output.lastKnownSourceRevisionId !== lockedCurrentRevisionId) {
    throw new CanonicalSourceInvariantError(
      "delete_revision_mismatch",
      "Prepared source delete does not name the locked current revision.",
    );
  }

  await assertCanonicalAdapterOutputReceipt(sql, output);
  await persistCanonicalSourceTombstone(sql, output, tombstone);
  await compareAndSwapCanonicalHead(sql, {
    output,
    order,
    sourceRevisionId: null,
    sourceTombstoneId: tombstone.id,
    absenceObserved: false,
  });

  await appendScopedDomainEvent({
    id: canonicalSourceMutationEventId(output, order),
    streamId: `source:${output.sourceItemId}`,
    type: "source.tombstone.canonical_applied",
    executionScope,
    payload: {
      schemaVersion: 1,
      mutationStatus: "applied",
      operation: "delete",
      deleteReason: output.deleteReason,
      sourceItemId: output.sourceItemId,
      lastKnownSourceRevisionId: output.lastKnownSourceRevisionId,
      sourceTombstoneId: tombstone.id,
      sourceTombstoneSha256: tombstone.sha256,
      adapterOutputId: output.adapterOutputId,
      adapterOutputSha256: output.adapterOutputSha256,
      connectionId: output.connectionId,
      adapterId: output.adapterId,
      evidenceUnitCount: 0,
      ...order,
    },
  }, { sql });

  return Object.freeze({
    status: "applied" as const,
    operation: "delete" as const,
    sourceItemId: output.sourceItemId,
    sourceRevisionId: null,
    sourceTombstoneId: tombstone.id,
    adapterOutputId: output.adapterOutputId,
    adapterOutputSha256: output.adapterOutputSha256,
    order,
  });
}

export function compareCanonicalSourceOrder(
  left: CanonicalSourceOrder,
  right: CanonicalSourceOrder,
): -1 | 0 | 1 {
  const leftValues = canonicalSourceOrderValues(left);
  const rightValues = canonicalSourceOrderValues(right);
  for (let index = 0; index < leftValues.length; index += 1) {
    if (leftValues[index] < rightValues[index]) return -1;
    if (leftValues[index] > rightValues[index]) return 1;
  }
  return 0;
}

function assertPostgresTransaction(sql: SourceSqlClient) {
  if (!sql.transactionScoped) {
    throw new Error(
      "Canonical source convergence requires an existing Postgres transaction.",
    );
  }
}

function exactMutationScope(
  scopeValue: ExecutionScope,
  output: SourceAdapterOutputV1,
) {
  const scope = parsePersistedExecutionScope(scopeValue);
  if (!scope?.initiatingActorId) {
    throw new CanonicalSourceInvariantError(
      "scope_mismatch",
      "Canonical source convergence requires an initiating actor.",
    );
  }
  if (
    scope.tenantId !== output.tenantId ||
    scope.initiatingActorId !== output.ownerActorId ||
    scope.workspaceId !== output.workspaceId ||
    scope.projectId !== output.projectId ||
    scope.missionId !== output.missionId ||
    scope.contextGrantIds.length !== 1 ||
    scope.contextGrantIds[0] !== output.connectionId
  ) {
    throw new CanonicalSourceInvariantError(
      "scope_mismatch",
      "Canonical source mutation does not match its exact execution scope and connection grant.",
    );
  }
  return scope;
}

function validatedCanonicalSourceOrder(
  order: CanonicalSourceOrder,
): CanonicalSourceOrder {
  const authorizationGeneration = boundedSafeInteger(
    order.authorizationGeneration,
    1,
    Number.MAX_SAFE_INTEGER,
    "authorization generation",
  );
  const rolloutGeneration = boundedSafeInteger(
    order.rolloutGeneration,
    1,
    Number.MAX_SAFE_INTEGER,
    "rollout generation",
  );
  const phaseRank = boundedSafeInteger(order.phaseRank, 0, 1, "phase rank") as
    CanonicalSourcePhaseRank;
  const pageSequence = boundedSafeInteger(
    order.pageSequence,
    0,
    Number.MAX_SAFE_INTEGER,
    "page sequence",
  );
  const ordinal = boundedSafeInteger(order.ordinal, 0, 999, "ordinal");
  return Object.freeze({
    authorizationGeneration,
    rolloutGeneration,
    phaseRank,
    pageSequence,
    ordinal,
  });
}

async function lockCanonicalSource(
  sql: SourceSqlClient,
  tenantId: string,
  sourceItemId: string,
): Promise<LockedCanonicalSource> {
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${tenantId}),
      hashtext(${sourceItemId})
    )
  `;
  const itemRows = await sql`
    SELECT
      id, tenant_id, owner_actor_id, workspace_id, project_id, mission_id,
      connection_id, visibility, sensitivity, permission_grant_ids,
      allowed_purpose_ids, retention_policy_id, retention_expires_at,
      permission_set_sha256, purpose_set_sha256, source_kind,
      provider_item_key_sha256, current_revision_id
    FROM omni_source_items
    WHERE tenant_id = ${tenantId}
      AND id = ${sourceItemId}
    FOR UPDATE
  `;
  const headRows = await sql`
    SELECT
      tenant_id, source_item_id, owner_actor_id, connection_id, source_kind,
      provider_item_key_sha256, authorization_generation,
      rollout_generation, phase_rank, page_sequence, ordinal, operation,
      source_revision_id, source_tombstone_id, adapter_output_id,
      adapter_output_sha256, absence_observed
    FROM omni_source_sync_heads
    WHERE tenant_id = ${tenantId}
      AND source_item_id = ${sourceItemId}
    FOR UPDATE
  `;
  if (itemRows.length > 1 || headRows.length > 1) {
    throw new CanonicalSourceInvariantError(
      "identity_conflict",
      "Canonical source identity resolved to multiple stored rows.",
    );
  }
  return {
    item: itemRows[0] || null,
    head: headRows[0] || null,
  };
}

async function lockCanonicalAdapterOutputIdentity(
  sql: SourceSqlClient,
  output: SourceAdapterOutputV1,
) {
  // Receipt locking comes first to retain the P2.1 lock order and avoid a
  // source-row/receipt lock inversion with legacy shadow writers.
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${output.tenantId}),
      hashtext(${output.adapterOutputId})
    )
  `;
}

function existingHeadDisposition(
  head: LockedSourceHeadRow | null,
  incomingOrder: CanonicalSourceOrder,
  output: SourceAdapterOutputV1,
  sourceTombstoneId: string | null,
  absenceObserved: boolean,
): "newer" | "stale" | "duplicate" {
  if (!head) return "newer";
  const storedOrder = storedCanonicalSourceOrder(head);
  const comparison = compareCanonicalSourceOrder(incomingOrder, storedOrder);
  if (comparison < 0) return "stale";
  if (comparison > 0) return "newer";

  const sameEnvelope =
    head.adapter_output_id === output.adapterOutputId &&
    head.adapter_output_sha256 === output.adapterOutputSha256;
  const storedAbsenceObserved = storedBoolean(
    head.absence_observed,
    "absence_observed",
  );
  const sameTarget = output.operation === "upsert"
    ? !absenceObserved &&
      !storedAbsenceObserved &&
      head.operation === "upsert" &&
      head.source_revision_id === output.sourceRevision.sourceRevisionId &&
      nullableStoredId(head.source_tombstone_id) === null
    : head.operation === "delete" &&
      storedAbsenceObserved === absenceObserved &&
      nullableStoredId(head.source_revision_id) === null &&
      (
        absenceObserved
          ? nullableStoredId(head.source_tombstone_id) === null
          : head.source_tombstone_id === sourceTombstoneId
      );
  if (sameEnvelope && sameTarget) return "duplicate";

  throw new CanonicalSourceInvariantError(
    "order_conflict",
    "Canonical source order is already bound to a different operation or target.",
  );
}

function storedCanonicalSourceOrder(
  row: LockedSourceHeadRow,
): CanonicalSourceOrder {
  return validatedCanonicalSourceOrder({
    authorizationGeneration: storedSafeInteger(row.authorization_generation),
    rolloutGeneration: storedSafeInteger(row.rollout_generation),
    phaseRank: storedSafeInteger(row.phase_rank) as CanonicalSourcePhaseRank,
    pageSequence: storedSafeInteger(row.page_sequence),
    ordinal: storedSafeInteger(row.ordinal),
  });
}

function assertStoredItemIdentity(
  row: LockedSourceItemRow,
  output: SourceAdapterUpsertV1,
) {
  const item = output.sourceItem;
  if (
    row.tenant_id !== item.tenantId ||
    row.id !== item.sourceItemId ||
    row.owner_actor_id !== item.ownerActorId ||
    nullableStoredId(row.workspace_id) !== item.workspaceId ||
    nullableStoredId(row.project_id) !== item.projectId ||
    nullableStoredId(row.mission_id) !== item.missionId ||
    row.connection_id !== item.connectionId ||
    row.source_kind !== item.sourceKind ||
    row.provider_item_key_sha256 !== item.providerItemKeySha256
  ) {
    throw new CanonicalSourceInvariantError(
      "identity_conflict",
      "Canonical SourceItem ID is bound to a different stored identity.",
    );
  }
}

function assertStoredHeadIdentity(
  row: LockedSourceHeadRow,
  output: SourceAdapterOutputV1,
) {
  const sourceItemId = output.operation === "upsert"
    ? output.sourceItem.sourceItemId
    : output.sourceItemId;
  const sourceKind = output.operation === "upsert"
    ? output.sourceItem.sourceKind
    : output.sourceKind;
  const providerItemKeySha256 = output.operation === "upsert"
    ? output.sourceItem.providerItemKeySha256
    : output.providerItemKeySha256;
  if (
    row.tenant_id !== output.tenantId ||
    row.source_item_id !== sourceItemId ||
    row.owner_actor_id !== output.ownerActorId ||
    row.connection_id !== output.connectionId ||
    row.source_kind !== sourceKind ||
    row.provider_item_key_sha256 !== providerItemKeySha256
  ) {
    throw new CanonicalSourceInvariantError(
      "identity_conflict",
      "Canonical source head is bound to a different stored identity.",
    );
  }
}

function assertAbsenceHead(row: LockedSourceHeadRow) {
  if (
    !storedBoolean(row.absence_observed, "absence_observed") ||
    row.operation !== "delete" ||
    nullableStoredId(row.source_revision_id) !== null ||
    nullableStoredId(row.source_tombstone_id) !== null
  ) {
    throw new CanonicalSourceInvariantError(
      "identity_conflict",
      "Canonical source head without a SourceItem is not an absence head.",
    );
  }
}

function assertStoredDeleteBinding(
  row: LockedSourceItemRow,
  output: SourceAdapterDeleteV1,
) {
  const sameBinding =
    row.tenant_id === output.tenantId &&
    row.id === output.sourceItemId &&
    row.owner_actor_id === output.ownerActorId &&
    nullableStoredId(row.workspace_id) === output.workspaceId &&
    nullableStoredId(row.project_id) === output.projectId &&
    nullableStoredId(row.mission_id) === output.missionId &&
    row.connection_id === output.connectionId &&
    row.visibility === output.visibility &&
    row.sensitivity === output.sensitivity &&
    equalStoredIds(row.permission_grant_ids, output.permissionGrantIds) &&
    equalStoredIds(row.allowed_purpose_ids, output.allowedPurposeIds) &&
    row.retention_policy_id === output.retentionPolicyId &&
    canonicalStoredTimestamp(row.retention_expires_at) ===
      output.retentionExpiresAt &&
    row.permission_set_sha256 === output.permissionSetSha256 &&
    row.purpose_set_sha256 === output.purposeSetSha256 &&
    row.source_kind === output.sourceKind &&
    row.provider_item_key_sha256 === output.providerItemKeySha256;
  if (!sameBinding) {
    throw new CanonicalSourceInvariantError(
      "identity_conflict",
      "Canonical delete does not reuse the locked SourceItem binding.",
    );
  }
}

function assertStoredDeleteIdentity(
  row: LockedSourceItemRow,
  output: SourceAdapterDeleteV1,
) {
  if (
    row.tenant_id !== output.tenantId ||
    row.id !== output.sourceItemId ||
    row.owner_actor_id !== output.ownerActorId ||
    nullableStoredId(row.workspace_id) !== output.workspaceId ||
    nullableStoredId(row.project_id) !== output.projectId ||
    nullableStoredId(row.mission_id) !== output.missionId ||
    row.connection_id !== output.connectionId ||
    row.source_kind !== output.sourceKind ||
    row.provider_item_key_sha256 !== output.providerItemKeySha256
  ) {
    throw new CanonicalSourceInvariantError(
      "identity_conflict",
      "Canonical delete does not match the locked SourceItem identity.",
    );
  }
}

async function persistConvergentSourceItem(
  sql: SourceSqlClient,
  output: SourceAdapterUpsertV1,
  exists: boolean,
) {
  const item = output.sourceItem;
  const extractor = item.extractorIdentity;
  const rows = exists
    ? await sql`
      UPDATE omni_source_items
      SET workspace_id = ${item.workspaceId},
          project_id = ${item.projectId},
          mission_id = ${item.missionId},
          visibility = ${item.visibility},
          sensitivity = ${item.sensitivity},
          permission_grant_ids = ${item.permissionGrantIds},
          allowed_purpose_ids = ${item.allowedPurposeIds},
          retention_policy_id = ${item.retentionPolicyId},
          retention_expires_at = ${item.retentionExpiresAt},
          permission_set_sha256 = ${item.permissionSetSha256},
          purpose_set_sha256 = ${item.purposeSetSha256},
          metadata_sha256 = ${item.metadataSha256},
          source_created_at = ${item.sourceCreatedAt},
          source_updated_at = ${item.sourceUpdatedAt},
          captured_at = ${item.capturedAt},
          extractor_id = ${extractor.extractorId},
          extractor_version_id = ${extractor.extractorVersionId},
          extractor_config_sha256 = ${extractor.extractorConfigSha256},
          model_version_id = ${extractor.modelVersionId},
          source_item_sha256 = ${item.sourceItemSha256},
          adapter_output_id = ${output.adapterOutputId},
          adapter_output_sha256 = ${output.adapterOutputSha256},
          adapter_operation = ${output.operation},
          adapter_id = ${output.adapterId},
          adapter_version_id = ${output.adapterVersionId},
          adapter_config_sha256 = ${output.adapterConfigSha256},
          adapter_event_key_sha256 = ${output.adapterEventKeySha256},
          adapter_observed_at = ${output.observedAt},
          updated_at = NOW()
      WHERE tenant_id = ${item.tenantId}
        AND id = ${item.sourceItemId}
        AND owner_actor_id = ${item.ownerActorId}
        AND connection_id = ${item.connectionId}
        AND source_kind = ${item.sourceKind}
        AND provider_item_key_sha256 = ${item.providerItemKeySha256}
      RETURNING id
    `
    : await sql`
      INSERT INTO omni_source_items (
        id, schema_version, contract_kind, tenant_id, owner_actor_id,
        workspace_id, project_id, mission_id, connection_id, visibility,
        sensitivity, permission_grant_ids, allowed_purpose_ids,
        retention_policy_id, retention_expires_at, permission_set_sha256,
        purpose_set_sha256, source_kind, provider_item_key_sha256,
        metadata_sha256, source_created_at, source_updated_at, captured_at,
        extractor_id, extractor_version_id, extractor_config_sha256,
        model_version_id, source_item_sha256, current_revision_id,
        adapter_output_id, adapter_output_sha256, adapter_operation,
        adapter_id, adapter_version_id, adapter_config_sha256,
        adapter_event_key_sha256, adapter_observed_at
      ) VALUES (
        ${item.sourceItemId}, ${item.schemaVersion}, ${item.contractKind},
        ${item.tenantId}, ${item.ownerActorId}, ${item.workspaceId},
        ${item.projectId}, ${item.missionId}, ${item.connectionId},
        ${item.visibility}, ${item.sensitivity}, ${item.permissionGrantIds},
        ${item.allowedPurposeIds}, ${item.retentionPolicyId},
        ${item.retentionExpiresAt}, ${item.permissionSetSha256},
        ${item.purposeSetSha256}, ${item.sourceKind},
        ${item.providerItemKeySha256}, ${item.metadataSha256},
        ${item.sourceCreatedAt}, ${item.sourceUpdatedAt}, ${item.capturedAt},
        ${extractor.extractorId}, ${extractor.extractorVersionId},
        ${extractor.extractorConfigSha256}, ${extractor.modelVersionId},
        ${item.sourceItemSha256}, NULL, ${output.adapterOutputId},
        ${output.adapterOutputSha256}, ${output.operation},
        ${output.adapterId}, ${output.adapterVersionId},
        ${output.adapterConfigSha256}, ${output.adapterEventKeySha256},
        ${output.observedAt}
      )
      RETURNING id
    `;
  if (rows.length !== 1) {
    throw new CanonicalSourceInvariantError(
      "identity_conflict",
      "Canonical SourceItem could not be persisted under its locked identity.",
    );
  }
}

async function persistConvergentSourceRevision(
  sql: SourceSqlClient,
  output: SourceAdapterUpsertV1,
) {
  const revision = output.sourceRevision;
  const extractor = revision.extractorIdentity;
  const inserted = await sql`
    INSERT INTO omni_source_revisions (
      id, schema_version, contract_kind, tenant_id, source_item_id,
      previous_source_revision_id, owner_actor_id, workspace_id, project_id,
      mission_id, connection_id, visibility, sensitivity,
      permission_grant_ids, allowed_purpose_ids, retention_policy_id,
      retention_expires_at, permission_set_sha256, purpose_set_sha256,
      source_kind, provider_item_key_sha256, provider_revision_key_sha256,
      content_sha256, content_byte_length, media_type, metadata_sha256,
      source_created_at, source_updated_at, captured_at, extractor_id,
      extractor_version_id, extractor_config_sha256, model_version_id,
      source_revision_sha256, adapter_output_id, adapter_output_sha256,
      adapter_operation, adapter_id, adapter_version_id,
      adapter_config_sha256, adapter_event_key_sha256, adapter_observed_at
    ) VALUES (
      ${revision.sourceRevisionId}, ${revision.schemaVersion},
      ${revision.contractKind}, ${revision.tenantId}, ${revision.sourceItemId},
      ${revision.previousSourceRevisionId}, ${revision.ownerActorId},
      ${revision.workspaceId}, ${revision.projectId}, ${revision.missionId},
      ${revision.connectionId}, ${revision.visibility}, ${revision.sensitivity},
      ${revision.permissionGrantIds}, ${revision.allowedPurposeIds},
      ${revision.retentionPolicyId}, ${revision.retentionExpiresAt},
      ${revision.permissionSetSha256}, ${revision.purposeSetSha256},
      ${revision.sourceKind}, ${revision.providerItemKeySha256},
      ${revision.providerRevisionKeySha256}, ${revision.contentSha256},
      ${revision.contentByteLength}, ${revision.mediaType},
      ${revision.metadataSha256}, ${revision.sourceCreatedAt},
      ${revision.sourceUpdatedAt}, ${revision.capturedAt},
      ${extractor.extractorId}, ${extractor.extractorVersionId},
      ${extractor.extractorConfigSha256}, ${extractor.modelVersionId},
      ${revision.sourceRevisionSha256}, ${output.adapterOutputId},
      ${output.adapterOutputSha256}, ${output.operation}, ${output.adapterId},
      ${output.adapterVersionId}, ${output.adapterConfigSha256},
      ${output.adapterEventKeySha256}, ${output.observedAt}
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;
  if (inserted.length) return;

  const existing = await sql`
    SELECT
      source_revision_sha256, tenant_id, connection_id, adapter_output_id,
      adapter_output_sha256, adapter_operation, adapter_id,
      adapter_version_id, adapter_config_sha256, adapter_event_key_sha256,
      adapter_observed_at
    FROM omni_source_revisions
    WHERE tenant_id = ${revision.tenantId}
      AND id = ${revision.sourceRevisionId}
    LIMIT 1
  `;
  if (
    existing.length !== 1 ||
    existing[0].source_revision_sha256 !== revision.sourceRevisionSha256 ||
    !storedAdapterEnvelopeMatches(existing[0], output)
  ) {
    throw new CanonicalSourceInvariantError(
      "immutable_conflict",
      "Canonical source revision ID is bound to different immutable data.",
    );
  }
}

async function persistConvergentEvidenceUnits(
  sql: SourceSqlClient,
  output: SourceAdapterUpsertV1,
) {
  if (!output.evidenceUnits.length) return;
  const payload = output.evidenceUnits.map((evidence) => {
    const extractor = evidence.extractorIdentity;
    return {
      id: evidence.evidenceUnitId,
      schema_version: evidence.schemaVersion,
      contract_kind: evidence.contractKind,
      tenant_id: evidence.tenantId,
      source_item_id: evidence.sourceItemId,
      source_revision_id: evidence.sourceRevisionId,
      owner_actor_id: evidence.ownerActorId,
      workspace_id: evidence.workspaceId,
      project_id: evidence.projectId,
      mission_id: evidence.missionId,
      connection_id: evidence.connectionId,
      visibility: evidence.visibility,
      sensitivity: evidence.sensitivity,
      permission_grant_ids: evidence.permissionGrantIds,
      allowed_purpose_ids: evidence.allowedPurposeIds,
      retention_policy_id: evidence.retentionPolicyId,
      retention_expires_at: evidence.retentionExpiresAt,
      permission_set_sha256: evidence.permissionSetSha256,
      purpose_set_sha256: evidence.purposeSetSha256,
      source_kind: evidence.sourceKind,
      provider_item_key_sha256: evidence.providerItemKeySha256,
      evidence_content_sha256: evidence.evidenceContentSha256,
      evidence_byte_length: evidence.evidenceByteLength,
      locator: evidence.locator,
      locator_sha256: evidence.locatorSha256,
      source_created_at: evidence.sourceCreatedAt,
      source_updated_at: evidence.sourceUpdatedAt,
      captured_at: evidence.capturedAt,
      extracted_at: evidence.extractedAt,
      extractor_id: extractor.extractorId,
      extractor_version_id: extractor.extractorVersionId,
      extractor_config_sha256: extractor.extractorConfigSha256,
      model_version_id: extractor.modelVersionId,
      evidence_unit_sha256: evidence.evidenceUnitSha256,
      adapter_output_id: output.adapterOutputId,
      adapter_output_sha256: output.adapterOutputSha256,
      adapter_operation: output.operation,
      adapter_id: output.adapterId,
      adapter_version_id: output.adapterVersionId,
      adapter_config_sha256: output.adapterConfigSha256,
      adapter_event_key_sha256: output.adapterEventKeySha256,
      adapter_observed_at: output.observedAt,
    };
  });
  await sql`
    INSERT INTO omni_evidence_units (
      id, schema_version, contract_kind, tenant_id, source_item_id,
      source_revision_id, owner_actor_id, workspace_id, project_id,
      mission_id, connection_id, visibility, sensitivity,
      permission_grant_ids, allowed_purpose_ids, retention_policy_id,
      retention_expires_at, permission_set_sha256, purpose_set_sha256,
      source_kind, provider_item_key_sha256, evidence_content_sha256,
      evidence_byte_length, locator, locator_sha256, source_created_at,
      source_updated_at, captured_at, extracted_at, extractor_id,
      extractor_version_id, extractor_config_sha256, model_version_id,
      evidence_unit_sha256, adapter_output_id, adapter_output_sha256,
      adapter_operation, adapter_id, adapter_version_id,
      adapter_config_sha256, adapter_event_key_sha256, adapter_observed_at
    )
    SELECT
      id, schema_version, contract_kind, tenant_id, source_item_id,
      source_revision_id, owner_actor_id, workspace_id, project_id,
      mission_id, connection_id, visibility, sensitivity,
      permission_grant_ids, allowed_purpose_ids, retention_policy_id,
      retention_expires_at, permission_set_sha256, purpose_set_sha256,
      source_kind, provider_item_key_sha256, evidence_content_sha256,
      evidence_byte_length, locator, locator_sha256, source_created_at,
      source_updated_at, captured_at, extracted_at, extractor_id,
      extractor_version_id, extractor_config_sha256, model_version_id,
      evidence_unit_sha256, adapter_output_id, adapter_output_sha256,
      adapter_operation, adapter_id, adapter_version_id,
      adapter_config_sha256, adapter_event_key_sha256, adapter_observed_at
    FROM jsonb_to_recordset(${payload}::jsonb) AS input(
      id text, schema_version integer, contract_kind text, tenant_id text,
      source_item_id text, source_revision_id text, owner_actor_id text,
      workspace_id text, project_id text, mission_id text,
      connection_id text, visibility text, sensitivity text,
      permission_grant_ids text[], allowed_purpose_ids text[],
      retention_policy_id text, retention_expires_at timestamptz,
      permission_set_sha256 text, purpose_set_sha256 text,
      source_kind text, provider_item_key_sha256 text,
      evidence_content_sha256 text, evidence_byte_length bigint,
      locator jsonb, locator_sha256 text, source_created_at timestamptz,
      source_updated_at timestamptz, captured_at timestamptz,
      extracted_at timestamptz, extractor_id text,
      extractor_version_id text, extractor_config_sha256 text,
      model_version_id text, evidence_unit_sha256 text,
      adapter_output_id text, adapter_output_sha256 text,
      adapter_operation text, adapter_id text, adapter_version_id text,
      adapter_config_sha256 text, adapter_event_key_sha256 text,
      adapter_observed_at timestamptz
    )
    ON CONFLICT (id) DO NOTHING
  `;

  const evidenceIds = output.evidenceUnits.map((item) => item.evidenceUnitId);
  const persisted = await sql`
    SELECT
      id, evidence_unit_sha256, tenant_id, connection_id, adapter_output_id,
      adapter_output_sha256, adapter_operation, adapter_id,
      adapter_version_id, adapter_config_sha256, adapter_event_key_sha256,
      adapter_observed_at
    FROM omni_evidence_units
    WHERE tenant_id = ${output.tenantId}
      AND source_revision_id = ${output.sourceRevision.sourceRevisionId}
      AND id = ANY(${evidenceIds})
  `;
  const persistedById = new Map(
    persisted.map((row) => [String(row.id), row]),
  );
  for (const evidence of output.evidenceUnits) {
    const row = persistedById.get(evidence.evidenceUnitId);
    if (
      !row ||
      row.evidence_unit_sha256 !== evidence.evidenceUnitSha256 ||
      !storedAdapterEnvelopeMatches(row, output)
    ) {
      throw new CanonicalSourceInvariantError(
        "immutable_conflict",
        "Canonical evidence unit ID is bound to different immutable data.",
      );
    }
  }
}

async function persistCanonicalSourceTombstone(
  sql: SourceSqlClient,
  output: SourceAdapterDeleteV1,
  tombstone: CanonicalSourceTombstone,
) {
  const inserted = await sql`
    INSERT INTO omni_source_tombstones (
      id, schema_version, contract_kind, tenant_id, owner_actor_id,
      workspace_id, project_id, mission_id, connection_id, visibility,
      sensitivity, permission_grant_ids, allowed_purpose_ids,
      retention_policy_id, retention_expires_at, permission_set_sha256,
      purpose_set_sha256, source_item_id, source_kind,
      provider_item_key_sha256, last_known_source_revision_id,
      delete_reason, tombstone_sha256, adapter_output_id,
      adapter_output_sha256, adapter_operation, adapter_id,
      adapter_version_id, adapter_config_sha256, adapter_event_key_sha256,
      adapter_observed_at
    ) VALUES (
      ${tombstone.id}, ${output.schemaVersion}, ${"source_tombstone"},
      ${output.tenantId}, ${output.ownerActorId}, ${output.workspaceId},
      ${output.projectId}, ${output.missionId}, ${output.connectionId},
      ${output.visibility}, ${output.sensitivity},
      ${output.permissionGrantIds}, ${output.allowedPurposeIds},
      ${output.retentionPolicyId}, ${output.retentionExpiresAt},
      ${output.permissionSetSha256}, ${output.purposeSetSha256},
      ${output.sourceItemId}, ${output.sourceKind},
      ${output.providerItemKeySha256}, ${output.lastKnownSourceRevisionId},
      ${output.deleteReason}, ${tombstone.sha256}, ${output.adapterOutputId},
      ${output.adapterOutputSha256}, ${output.operation}, ${output.adapterId},
      ${output.adapterVersionId}, ${output.adapterConfigSha256},
      ${output.adapterEventKeySha256}, ${output.observedAt}
    )
    ON CONFLICT (tenant_id, id) DO NOTHING
    RETURNING id
  `;
  if (inserted.length) return;

  const existing = await sql`
    SELECT
      id, tombstone_sha256, tenant_id, connection_id, adapter_output_id,
      adapter_output_sha256, adapter_operation, adapter_id,
      adapter_version_id, adapter_config_sha256, adapter_event_key_sha256,
      adapter_observed_at
    FROM omni_source_tombstones
    WHERE tenant_id = ${output.tenantId}
      AND id = ${tombstone.id}
    LIMIT 1
  `;
  if (
    existing.length !== 1 ||
    existing[0].tombstone_sha256 !== tombstone.sha256 ||
    !storedAdapterEnvelopeMatches(existing[0], output)
  ) {
    throw new CanonicalSourceInvariantError(
      "immutable_conflict",
      "Canonical tombstone ID is bound to different immutable data.",
    );
  }
}

async function compareAndSwapCanonicalHead(
  sql: SourceSqlClient,
  input: Readonly<{
    output: SourceAdapterOutputV1;
    order: CanonicalSourceOrder;
    sourceRevisionId: string | null;
    sourceTombstoneId: string | null;
    absenceObserved: boolean;
  }>,
) {
  const sourceItemId = input.output.operation === "upsert"
    ? input.output.sourceItem.sourceItemId
    : input.output.sourceItemId;
  const sourceKind = input.output.operation === "upsert"
    ? input.output.sourceItem.sourceKind
    : input.output.sourceKind;
  const providerItemKeySha256 = input.output.operation === "upsert"
    ? input.output.sourceItem.providerItemKeySha256
    : input.output.providerItemKeySha256;
  const rows = await sql`
    INSERT INTO omni_source_sync_heads (
      schema_version, tenant_id, source_item_id, owner_actor_id, connection_id,
      source_kind, provider_item_key_sha256, authorization_generation,
      rollout_generation, phase_rank, page_sequence, ordinal, operation,
      source_revision_id, source_tombstone_id, adapter_output_id,
      adapter_output_sha256, absence_observed
    ) VALUES (
      ${1}, ${input.output.tenantId}, ${sourceItemId},
      ${input.output.ownerActorId}, ${input.output.connectionId},
      ${sourceKind}, ${providerItemKeySha256},
      ${input.order.authorizationGeneration},
      ${input.order.rolloutGeneration}, ${input.order.phaseRank},
      ${input.order.pageSequence}, ${input.order.ordinal},
      ${input.output.operation}, ${input.sourceRevisionId},
      ${input.sourceTombstoneId}, ${input.output.adapterOutputId},
      ${input.output.adapterOutputSha256}, ${input.absenceObserved}
    )
    ON CONFLICT (tenant_id, source_item_id) DO UPDATE SET
      owner_actor_id = EXCLUDED.owner_actor_id,
      connection_id = EXCLUDED.connection_id,
      source_kind = EXCLUDED.source_kind,
      provider_item_key_sha256 = EXCLUDED.provider_item_key_sha256,
      authorization_generation = EXCLUDED.authorization_generation,
      rollout_generation = EXCLUDED.rollout_generation,
      phase_rank = EXCLUDED.phase_rank,
      page_sequence = EXCLUDED.page_sequence,
      ordinal = EXCLUDED.ordinal,
      operation = EXCLUDED.operation,
      source_revision_id = EXCLUDED.source_revision_id,
      source_tombstone_id = EXCLUDED.source_tombstone_id,
      adapter_output_id = EXCLUDED.adapter_output_id,
      adapter_output_sha256 = EXCLUDED.adapter_output_sha256,
      absence_observed = EXCLUDED.absence_observed,
      updated_at = NOW()
    WHERE (
      omni_source_sync_heads.authorization_generation,
      omni_source_sync_heads.rollout_generation,
      omni_source_sync_heads.phase_rank,
      omni_source_sync_heads.page_sequence,
      omni_source_sync_heads.ordinal
    ) < (
      EXCLUDED.authorization_generation,
      EXCLUDED.rollout_generation,
      EXCLUDED.phase_rank,
      EXCLUDED.page_sequence,
      EXCLUDED.ordinal
    )
    RETURNING source_item_id
  `;
  if (rows.length !== 1) {
    throw new CanonicalSourceInvariantError(
      "head_compare_and_swap_failed",
      "Canonical source head compare-and-swap did not advance.",
    );
  }
}

function canonicalSourceTombstone(
  output: SourceAdapterDeleteV1,
): CanonicalSourceTombstone {
  const id = `source_tombstone_${sourceContractSha256({
    tenantId: output.tenantId,
    sourceItemId: output.sourceItemId,
    adapterOutputId: output.adapterOutputId,
    adapterOutputSha256: output.adapterOutputSha256,
  }).slice(0, 56)}`;
  const {
    schemaVersion: _adapterSchemaVersion,
    contractKind: _adapterContractKind,
    ...deleteBody
  } = output;
  void _adapterSchemaVersion;
  void _adapterContractKind;
  return Object.freeze({
    id,
    sha256: sourceContractSha256({
      schemaVersion: 1,
      contractKind: "source_tombstone",
      tombstoneId: id,
      ...deleteBody,
    }),
  });
}

function canonicalSourceMutationEventId(
  output: SourceAdapterOutputV1,
  order: CanonicalSourceOrder,
) {
  const sourceItemId = output.operation === "upsert"
    ? output.sourceItem.sourceItemId
    : output.sourceItemId;
  return `source_convergence_event_${sourceContractSha256({
    sourceItemId,
    adapterOutputId: output.adapterOutputId,
    adapterOutputSha256: output.adapterOutputSha256,
    operation: output.operation,
    order,
  }).slice(0, 56)}`;
}

function noopResult(
  operation: "upsert" | "delete",
  reason: CanonicalSourceMutationNoopReason,
  sourceItemId: string | null,
  order: CanonicalSourceOrder,
  receiptOutput: SourceAdapterOutputV1 | null,
): CanonicalSourceMutationResult {
  return Object.freeze({
    status: "noop" as const,
    operation,
    reason,
    sourceItemId,
    sourceRevisionId: null,
    sourceTombstoneId: null,
    adapterOutputId: receiptOutput?.adapterOutputId || null,
    adapterOutputSha256: receiptOutput?.adapterOutputSha256 || null,
    order,
  });
}

function canonicalSourceOrderValues(order: CanonicalSourceOrder) {
  return [
    order.authorizationGeneration,
    order.rolloutGeneration,
    order.phaseRank,
    order.pageSequence,
    order.ordinal,
  ] as const;
}

function boundedSafeInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string,
) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Canonical source ${field} is invalid.`);
  }
  return value;
}

function storedSafeInteger(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CanonicalSourceInvariantError(
      "identity_conflict",
      "Stored canonical source order is invalid.",
    );
  }
  return parsed;
}

function nullableStoredId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string" && value) return value;
  throw new CanonicalSourceInvariantError(
    "identity_conflict",
    "Stored canonical source identifier is invalid.",
  );
}

function equalStoredIds(value: unknown, expected: readonly string[]) {
  return Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index]);
}

function storedBoolean(value: unknown, field: string) {
  if (typeof value === "boolean") return value;
  throw new CanonicalSourceInvariantError(
    "identity_conflict",
    `Stored canonical source ${field} is invalid.`,
  );
}

function canonicalStoredTimestamp(value: unknown) {
  if (value === null || value === undefined) return null;
  if (!(value instanceof Date) && typeof value !== "string") return undefined;
  const timestamp = value instanceof Date ? value : new Date(value);
  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp.toISOString();
}
