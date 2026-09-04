import { beforeEach, describe, expect, it, vi } from "vitest";

const eventMocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(async () => undefined),
}));

vi.mock("@/lib/events/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/events/store")>()),
  appendScopedDomainEvent: eventMocks.appendScopedDomainEvent,
}));

import { createExecutionScope } from "@/lib/security/execution-scope";
import {
  buildSourceAdapterDeleteV1,
  buildSourceAdapterUpsertV1,
  buildSourceItemV1,
  buildSourceRevisionV1,
  sourceContractSha256,
  type SourceAdapterDeleteV1,
  type SourceAdapterUpsertV1,
} from "@/lib/sources/contracts";
import {
  applyPreparedCanonicalSourceDelete,
  applyPreparedCanonicalSourceUpsert,
  CanonicalSourceInvariantError,
  compareCanonicalSourceOrder,
  type CanonicalSourceOrder,
} from "@/lib/sources/convergence-store";
import {
  assertCanonicalAdapterOutputReceipt,
  storedAdapterEnvelopeMatches,
  type SourceSqlClient,
} from "@/lib/sources/store";

const SOURCE_CREATED_AT = "2026-01-02T03:04:05.000Z";
const SOURCE_UPDATED_AT = "2026-01-03T03:04:05.000Z";
const CAPTURED_AT = "2026-01-04T03:04:05.000Z";
const OBSERVED_AT = "2026-01-04T03:06:05.000Z";
const RETENTION_EXPIRES_AT = "2027-01-04T03:04:05.000Z";

const binding = {
  tenantId: "tenant_source_convergence",
  ownerActorId: "actor_source_owner",
  workspaceId: "workspace_source_test",
  projectId: "project_source_test",
  missionId: null,
  connectionId: "connection_drive_test",
  visibility: "project_shared" as const,
  sensitivity: "confidential" as const,
  permissionGrantIds: ["grant_drive_read", "grant_project_member"],
  allowedPurposeIds: ["purpose_context", "purpose_search"],
  retentionPolicyId: "retention_standard",
  retentionExpiresAt: RETENTION_EXPIRES_AT,
};

const extractorIdentity = {
  extractorId: "extractor_plain_text",
  extractorVersionId: "extractor_plain_text_v1",
  extractorConfigSha256: digest("extractor-config"),
  modelVersionId: null,
};

const defaultOrder = {
  authorizationGeneration: 2,
  rolloutGeneration: 3,
  phaseRank: 0,
  pageSequence: 4,
  ordinal: 5,
} as const satisfies CanonicalSourceOrder;

type Query = Readonly<{ text: string; params: readonly unknown[] }>;

describe("P2.3 canonical source convergence", () => {
  beforeEach(() => {
    eventMocks.appendScopedDomainEvent.mockClear();
  });

  it("compares only the explicit five-field lexicographic order", () => {
    expect(compareCanonicalSourceOrder(defaultOrder, {
      ...defaultOrder,
      authorizationGeneration: 1,
      rolloutGeneration: 999,
    })).toBe(1);
    expect(compareCanonicalSourceOrder(defaultOrder, {
      ...defaultOrder,
      phaseRank: 1,
      pageSequence: 0,
    })).toBe(-1);
    expect(compareCanonicalSourceOrder(defaultOrder, defaultOrder)).toBe(0);
  });

  it("requires a transaction-scoped Postgres client", async () => {
    const output = upsertOutput();
    const { sql } = fakeSql(() => [], false);

    await expect(applyPreparedCanonicalSourceUpsert(sql, {
      executionScope: executionScope(),
      order: defaultOrder,
      output,
    })).rejects.toThrow(/existing Postgres transaction/i);
  });

  it("requires exactly the output connection as the execution context grant", async () => {
    const output = upsertOutput();
    const { sql, queries } = fakeSql(() => []);

    await expect(applyPreparedCanonicalSourceUpsert(sql, {
      executionScope: executionScope([
        binding.connectionId,
        "connection_unrelated",
      ]),
      order: defaultOrder,
      output,
    })).rejects.toMatchObject({
      name: "CanonicalSourceInvariantError",
      code: "scope_mismatch",
    });
    expect(queries).toHaveLength(0);
  });

  it("reports a tenant-scope mismatch as a typed invariant", async () => {
    const output = upsertOutput();
    const { sql, queries } = fakeSql(() => []);

    await expect(applyPreparedCanonicalSourceUpsert(sql, {
      executionScope: executionScope(
        [binding.connectionId],
        "tenant_unrelated",
      ),
      order: defaultOrder,
      output,
    })).rejects.toMatchObject({
      name: "CanonicalSourceInvariantError",
      code: "scope_mismatch",
    });
    expect(queries).toHaveLength(0);
  });

  it("records an ordered receipt-bound absence for an unknown delete without inventing an item", async () => {
    const upsert = upsertOutput();
    const output = deleteOutput(upsert);
    const { sql, queries } = successfulMutationSql(output, null);

    await expect(applyPreparedCanonicalSourceDelete(sql, {
      executionScope: executionScope(),
      order: defaultOrder,
      output,
    })).resolves.toMatchObject({
      status: "noop",
      operation: "delete",
      reason: "not_found",
      sourceItemId: null,
      adapterOutputId: output.adapterOutputId,
      adapterOutputSha256: output.adapterOutputSha256,
    });
    expect(queries.some((query) =>
      /INSERT INTO omni_source_(items|tombstones)/.test(query.text)
    )).toBe(false);
    expect(queries.some((query) =>
      query.text.includes("INSERT INTO omni_source_sync_heads") &&
      query.params.includes(true)
    )).toBe(true);
    expect(queries.some((query) =>
      query.text.includes("omni_source_adapter_output_receipts")
    )).toBe(true);
    expect(eventMocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "source.absence.canonical_observed",
        payload: expect.objectContaining({
          mutationStatus: "noop",
          noopReason: "not_found",
          sourceState: "absent",
          providerItemKeySha256: output.providerItemKeySha256,
        }),
      }),
      { sql },
    );
  });

  it("uses an absence head to fence a later-delivered older upsert", async () => {
    const output = upsertOutput();
    const deletion = deleteOutput(output);
    const absenceOrder = { ...defaultOrder, ordinal: 6 } as const;
    const { sql, queries } = fakeSql((query) => {
      if (query.text.includes("FROM omni_source_items")) return [];
      if (query.text.includes("FROM omni_source_sync_heads")) {
        return [storedHead(deletion, absenceOrder, {
          absence_observed: true,
        })];
      }
      return [];
    });

    await expect(applyPreparedCanonicalSourceUpsert(sql, {
      executionScope: executionScope(),
      order: defaultOrder,
      output,
    })).resolves.toMatchObject({
      status: "noop",
      operation: "upsert",
      reason: "stale",
      sourceItemId: null,
      adapterOutputId: null,
    });
    expect(queries.some((query) => query.text.startsWith("INSERT"))).toBe(false);
  });

  it("classifies a repeated absence observation as duplicate", async () => {
    const output = deleteOutput(upsertOutput());
    const { sql } = fakeSql((query) => {
      if (query.text.includes("FROM omni_source_items")) return [];
      if (query.text.includes("FROM omni_source_sync_heads")) {
        return [storedHead(output, defaultOrder, {
          absence_observed: true,
        })];
      }
      return [];
    });

    await expect(applyPreparedCanonicalSourceDelete(sql, {
      executionScope: executionScope(),
      order: defaultOrder,
      output,
    })).resolves.toMatchObject({
      status: "noop",
      reason: "duplicate",
      sourceItemId: null,
      adapterOutputId: output.adapterOutputId,
    });
  });

  it("classifies an older absence observation as stale", async () => {
    const output = deleteOutput(upsertOutput());
    const newerOrder = { ...defaultOrder, ordinal: 6 } as const;
    const { sql } = fakeSql((query) => {
      if (query.text.includes("FROM omni_source_items")) return [];
      if (query.text.includes("FROM omni_source_sync_heads")) {
        return [storedHead(output, newerOrder, { absence_observed: true })];
      }
      return [];
    });

    await expect(applyPreparedCanonicalSourceDelete(sql, {
      executionScope: executionScope(),
      order: defaultOrder,
      output,
    })).resolves.toMatchObject({
      status: "noop",
      reason: "stale",
      sourceItemId: null,
      adapterOutputId: null,
    });
  });

  it("rejects a conflicting absence observation at the same tuple", async () => {
    const upsert = upsertOutput();
    const output = deleteOutput(upsert);
    const conflicting = deleteOutput(upsert, "conflicting-delete-event");
    const { sql } = fakeSql((query) => {
      if (query.text.includes("FROM omni_source_items")) return [];
      if (query.text.includes("FROM omni_source_sync_heads")) {
        return [storedHead(conflicting, defaultOrder, {
          absence_observed: true,
        })];
      }
      return [];
    });

    await expect(applyPreparedCanonicalSourceDelete(sql, {
      executionScope: executionScope(),
      order: defaultOrder,
      output,
    })).rejects.toMatchObject({ code: "order_conflict" });
  });

  it("lets a newer upsert replace an ordered absence head", async () => {
    const output = upsertOutput();
    const deletion = deleteOutput(output);
    const absenceOrder = { ...defaultOrder, rolloutGeneration: 2 } as const;
    const { sql, queries } = successfulMutationSql(
      output,
      null,
      storedHead(deletion, absenceOrder, { absence_observed: true }),
    );

    await expect(applyPreparedCanonicalSourceUpsert(sql, {
      executionScope: executionScope(),
      order: defaultOrder,
      output,
    })).resolves.toMatchObject({
      status: "applied",
      operation: "upsert",
      sourceItemId: output.sourceItem.sourceItemId,
    });
    expect(queries.some((query) =>
      query.text.includes("INSERT INTO omni_source_sync_heads") &&
      query.params.includes(false)
    )).toBe(true);
  });

  it("noops a stale tuple even when provider timestamps are newer", async () => {
    const output = upsertOutput({
      sourceUpdatedAt: "2026-08-01T00:00:00.000Z",
      capturedAt: "2026-08-01T00:01:00.000Z",
      observedAt: "2026-08-01T00:02:00.000Z",
    });
    const storedOrder = { ...defaultOrder, ordinal: 6 } as const;
    const { sql, queries } = fakeSql((query) => {
      if (query.text.includes("FROM omni_source_items")) {
        return [storedItem(output, output.sourceRevision.sourceRevisionId)];
      }
      if (query.text.includes("FROM omni_source_sync_heads")) {
        return [storedHead(output, storedOrder)];
      }
      return [];
    });

    await expect(applyPreparedCanonicalSourceUpsert(sql, {
      executionScope: executionScope(),
      order: defaultOrder,
      output,
    })).resolves.toMatchObject({ status: "noop", reason: "stale" });
    expect(queries.some((query) => query.text.startsWith("INSERT"))).toBe(false);
    expect(eventMocks.appendScopedDomainEvent).not.toHaveBeenCalled();
  });

  it("classifies a delayed delete as stale before checking mutable item policy", async () => {
    const upsert = upsertOutput();
    const output = deleteOutput(upsert);
    const storedOrder = { ...defaultOrder, ordinal: 6 } as const;
    const { sql } = fakeSql((query) => {
      if (query.text.includes("FROM omni_source_items")) {
        return [{
          ...storedItem(upsert, upsert.sourceRevision.sourceRevisionId),
          visibility: "user_private",
          permission_grant_ids: ["grant_drive_read"],
          permission_set_sha256: digest("newer-permission-policy"),
        }];
      }
      if (query.text.includes("FROM omni_source_sync_heads")) {
        return [storedHead(upsert, storedOrder)];
      }
      return [];
    });

    await expect(applyPreparedCanonicalSourceDelete(sql, {
      executionScope: executionScope(),
      order: defaultOrder,
      output,
    })).resolves.toMatchObject({
      status: "noop",
      operation: "delete",
      reason: "stale",
    });
  });

  it("returns duplicate only for the same tuple, envelope, operation, and target", async () => {
    const output = upsertOutput();
    const { sql } = fakeSql((query) => {
      if (query.text.includes("FROM omni_source_items")) {
        return [storedItem(output, output.sourceRevision.sourceRevisionId)];
      }
      if (query.text.includes("FROM omni_source_sync_heads")) {
        return [storedHead(output, defaultOrder)];
      }
      return [];
    });

    await expect(applyPreparedCanonicalSourceUpsert(sql, {
      executionScope: executionScope(),
      order: defaultOrder,
      output,
    })).resolves.toMatchObject({ status: "noop", reason: "duplicate" });
  });

  it("raises a typed invariant error for a conflicting output at the same tuple", async () => {
    const output = upsertOutput();
    const conflicting = upsertOutput({
      adapterEventSeed: "conflicting-adapter-event",
      contentSeed: "conflicting-content",
    });
    const { sql } = fakeSql((query) => {
      if (query.text.includes("FROM omni_source_items")) {
        return [storedItem(output, output.sourceRevision.sourceRevisionId)];
      }
      if (query.text.includes("FROM omni_source_sync_heads")) {
        return [storedHead(conflicting, defaultOrder)];
      }
      return [];
    });

    const error = await applyPreparedCanonicalSourceUpsert(sql, {
      executionScope: executionScope(),
      order: defaultOrder,
      output,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(CanonicalSourceInvariantError);
    expect(error).toMatchObject({ code: "order_conflict" });
  });

  it("rejects a new revision that does not extend the locked current revision", async () => {
    const output = upsertOutput();
    const { sql } = fakeSql((query) => {
      if (query.text.includes("FROM omni_source_items")) {
        return [storedItem(output, "source_revision_locked_current")];
      }
      if (query.text.includes("FROM omni_source_sync_heads")) return [];
      return [];
    });

    await expect(applyPreparedCanonicalSourceUpsert(sql, {
      executionScope: executionScope(),
      order: defaultOrder,
      output,
    })).rejects.toMatchObject({ code: "revision_predecessor_mismatch" });
  });

  it("fails closed when a stored item has a divergent deterministic scope", async () => {
    const output = upsertOutput();
    const { sql } = fakeSql((query) => {
      if (query.text.includes("FROM omni_source_items")) {
        return [{
          ...storedItem(output, output.sourceRevision.sourceRevisionId),
          project_id: "project_unrelated",
        }];
      }
      if (query.text.includes("FROM omni_source_sync_heads")) return [];
      return [];
    });

    await expect(applyPreparedCanonicalSourceUpsert(sql, {
      executionScope: executionScope(),
      order: defaultOrder,
      output,
    })).rejects.toMatchObject({ code: "identity_conflict" });
  });

  it("atomically persists a fresh upsert, advances the ordered head, and appends a bounded event", async () => {
    const output = upsertOutput();
    const { sql, queries } = successfulMutationSql(output, null);

    await expect(applyPreparedCanonicalSourceUpsert(sql, {
      executionScope: executionScope(),
      order: defaultOrder,
      output,
    })).resolves.toMatchObject({
      status: "applied",
      operation: "upsert",
      sourceItemId: output.sourceItem.sourceItemId,
      sourceRevisionId: output.sourceRevision.sourceRevisionId,
    });

    const headWrite = queries.find((query) =>
      query.text.includes("INSERT INTO omni_source_sync_heads")
    );
    expect(headWrite?.text).toContain("authorization_generation");
    expect(headWrite?.text).toContain("rollout_generation");
    expect(headWrite?.text).toContain("phase_rank");
    expect(headWrite?.text).toContain("page_sequence");
    expect(headWrite?.text).toContain("ordinal");
    expect(headWrite?.text).not.toContain("source_updated_at");
    expect(headWrite?.text).not.toContain("adapter_observed_at");
    expect(eventMocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "source.revision.canonical_applied",
        payload: expect.objectContaining({
          operation: "upsert",
          mutationStatus: "applied",
          evidenceUnitCount: 0,
          ...defaultOrder,
        }),
      }),
      { sql },
    );
  });

  it("persists a metadata-only tombstone and advances a delete head", async () => {
    const upsert = upsertOutput();
    const output = deleteOutput(upsert);
    const priorOrder = { ...defaultOrder, rolloutGeneration: 2 } as const;
    const { sql, queries } = successfulMutationSql(
      output,
      storedItem(upsert, upsert.sourceRevision.sourceRevisionId),
      storedHead(upsert, priorOrder),
    );

    const result = await applyPreparedCanonicalSourceDelete(sql, {
      executionScope: executionScope(),
      order: defaultOrder,
      output,
    });
    expect(result).toMatchObject({
      status: "applied",
      operation: "delete",
      sourceItemId: upsert.sourceItem.sourceItemId,
      sourceRevisionId: null,
    });
    expect(result.sourceTombstoneId).toMatch(
      /^source_tombstone_[a-f0-9]{56}$/,
    );
    const tombstoneWrite = queries.find((query) =>
      query.text.includes("INSERT INTO omni_source_tombstones")
    );
    expect(tombstoneWrite?.text).toContain("provider_item_key_sha256");
    expect(tombstoneWrite?.text).toContain("last_known_source_revision_id");
    expect(tombstoneWrite?.text).not.toContain("content_sha256");
    expect(eventMocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "source.tombstone.canonical_applied",
        payload: expect.objectContaining({
          operation: "delete",
          deleteReason: "provider_deleted",
          evidenceUnitCount: 0,
        }),
      }),
      { sql },
    );
  });

  it("treats a newer upsert after a delete head as a restore of the same item", async () => {
    const original = upsertOutput();
    const restored = upsertOutput({
      previousSourceRevisionId: original.sourceRevision.sourceRevisionId,
      adapterEventSeed: "restore-event",
      contentSeed: "restored-content",
    });
    const deleted = deleteOutput(original);
    const priorOrder = { ...defaultOrder, pageSequence: 3 } as const;
    const { sql } = successfulMutationSql(
      restored,
      storedItem(original, original.sourceRevision.sourceRevisionId),
      storedHead(deleted, priorOrder, {
        source_tombstone_id: "source_tombstone_existing",
      }),
    );

    await expect(applyPreparedCanonicalSourceUpsert(sql, {
      executionScope: executionScope(),
      order: defaultOrder,
      output: restored,
    })).resolves.toMatchObject({
      status: "applied",
      operation: "upsert",
      sourceItemId: original.sourceItem.sourceItemId,
      sourceRevisionId: restored.sourceRevision.sourceRevisionId,
    });
  });

  it("accepts and compares a fully validated delete adapter receipt envelope", async () => {
    const output = deleteOutput(upsertOutput());
    const row = storedReceipt(output);
    const { sql } = fakeSql((query) =>
      query.text.includes("FROM omni_source_adapter_output_receipts")
        ? [row]
        : []
    );

    await expect(
      assertCanonicalAdapterOutputReceipt(sql, output),
    ).resolves.toBeUndefined();
    expect(storedAdapterEnvelopeMatches(row, output)).toBe(true);
  });
});

function upsertOutput(overrides: Readonly<{
  previousSourceRevisionId?: string | null;
  adapterEventSeed?: string;
  contentSeed?: string;
  sourceUpdatedAt?: string;
  capturedAt?: string;
  observedAt?: string;
}> = {}): SourceAdapterUpsertV1 {
  const sourceUpdatedAt = overrides.sourceUpdatedAt || SOURCE_UPDATED_AT;
  const capturedAt = overrides.capturedAt || CAPTURED_AT;
  const sourceItem = buildSourceItemV1({
    ...binding,
    sourceKind: "document",
    providerItemKeySha256: digest("provider-item-key"),
    metadataSha256: digest("source-metadata"),
    sourceCreatedAt: SOURCE_CREATED_AT,
    sourceUpdatedAt,
    capturedAt,
    extractorIdentity,
  });
  const sourceRevision = buildSourceRevisionV1({
    ...binding,
    sourceItemId: sourceItem.sourceItemId,
    previousSourceRevisionId: overrides.previousSourceRevisionId ?? null,
    sourceKind: sourceItem.sourceKind,
    providerItemKeySha256: sourceItem.providerItemKeySha256,
    providerRevisionKeySha256: digest(
      overrides.contentSeed || "provider-revision-key",
    ),
    contentSha256: digest(overrides.contentSeed || "source-content"),
    contentByteLength: 1_024,
    mediaType: "text/plain",
    metadataSha256: sourceItem.metadataSha256,
    sourceCreatedAt: SOURCE_CREATED_AT,
    sourceUpdatedAt,
    capturedAt,
    extractorIdentity,
  });
  return buildSourceAdapterUpsertV1({
    adapterId: "adapter_drive",
    adapterVersionId: "adapter_drive_v2",
    adapterConfigSha256: digest("adapter-config"),
    adapterEventKeySha256: digest(
      overrides.adapterEventSeed || "adapter-event-upsert",
    ),
    observedAt: overrides.observedAt || OBSERVED_AT,
    sourceItem,
    sourceRevision,
    evidenceUnits: [],
  });
}

function deleteOutput(
  upsert: SourceAdapterUpsertV1,
  adapterEventSeed = "adapter-event-delete",
): SourceAdapterDeleteV1 {
  const item = upsert.sourceItem;
  return buildSourceAdapterDeleteV1({
    adapterId: upsert.adapterId,
    adapterVersionId: upsert.adapterVersionId,
    adapterConfigSha256: upsert.adapterConfigSha256,
    adapterEventKeySha256: digest(adapterEventSeed),
    observedAt: "2026-01-05T03:06:05.000Z",
    tenantId: item.tenantId,
    ownerActorId: item.ownerActorId,
    workspaceId: item.workspaceId,
    projectId: item.projectId,
    missionId: item.missionId,
    connectionId: item.connectionId,
    visibility: item.visibility,
    sensitivity: item.sensitivity,
    permissionGrantIds: item.permissionGrantIds,
    allowedPurposeIds: item.allowedPurposeIds,
    retentionPolicyId: item.retentionPolicyId,
    retentionExpiresAt: item.retentionExpiresAt,
    sourceItemId: item.sourceItemId,
    sourceKind: item.sourceKind,
    providerItemKeySha256: item.providerItemKeySha256,
    lastKnownSourceRevisionId: upsert.sourceRevision.sourceRevisionId,
    deleteReason: "provider_deleted",
  });
}

function executionScope(
  contextGrantIds = [binding.connectionId],
  tenantId = binding.tenantId,
) {
  return createExecutionScope({
    tenantId,
    initiatingActorId: binding.ownerActorId,
    executingPrincipalType: "user",
    executingPrincipalId: binding.ownerActorId,
    workspaceId: binding.workspaceId,
    projectId: binding.projectId,
    missionId: binding.missionId,
    correlationId: "correlation_source_convergence",
    contextGrantIds,
    purpose: "source synchronization",
  });
}

function storedItem(
  output: SourceAdapterUpsertV1,
  currentRevisionId: string | null,
) {
  const item = output.sourceItem;
  return {
    id: item.sourceItemId,
    tenant_id: item.tenantId,
    owner_actor_id: item.ownerActorId,
    workspace_id: item.workspaceId,
    project_id: item.projectId,
    mission_id: item.missionId,
    connection_id: item.connectionId,
    visibility: item.visibility,
    sensitivity: item.sensitivity,
    permission_grant_ids: item.permissionGrantIds,
    allowed_purpose_ids: item.allowedPurposeIds,
    retention_policy_id: item.retentionPolicyId,
    retention_expires_at: item.retentionExpiresAt,
    permission_set_sha256: item.permissionSetSha256,
    purpose_set_sha256: item.purposeSetSha256,
    source_kind: item.sourceKind,
    provider_item_key_sha256: item.providerItemKeySha256,
    current_revision_id: currentRevisionId,
  };
}

function storedHead(
  output: SourceAdapterUpsertV1 | SourceAdapterDeleteV1,
  order: CanonicalSourceOrder,
  overrides: Record<string, unknown> = {},
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
  return {
    tenant_id: output.tenantId,
    source_item_id: sourceItemId,
    owner_actor_id: output.ownerActorId,
    connection_id: output.connectionId,
    source_kind: sourceKind,
    provider_item_key_sha256: providerItemKeySha256,
    authorization_generation: order.authorizationGeneration,
    rollout_generation: order.rolloutGeneration,
    phase_rank: order.phaseRank,
    page_sequence: order.pageSequence,
    ordinal: order.ordinal,
    operation: output.operation,
    source_revision_id: output.operation === "upsert"
      ? output.sourceRevision.sourceRevisionId
      : null,
    source_tombstone_id: null,
    adapter_output_id: output.adapterOutputId,
    adapter_output_sha256: output.adapterOutputSha256,
    absence_observed: false,
    ...overrides,
  };
}

function storedReceipt(
  output: SourceAdapterUpsertV1 | SourceAdapterDeleteV1,
) {
  return {
    schema_version: output.schemaVersion,
    contract_kind: output.contractKind,
    tenant_id: output.tenantId,
    connection_id: output.connectionId,
    adapter_output_id: output.adapterOutputId,
    adapter_output_sha256: output.adapterOutputSha256,
    adapter_operation: output.operation,
    adapter_id: output.adapterId,
    adapter_version_id: output.adapterVersionId,
    adapter_config_sha256: output.adapterConfigSha256,
    adapter_event_key_sha256: output.adapterEventKeySha256,
    adapter_observed_at: output.observedAt,
  };
}

function successfulMutationSql(
  output: SourceAdapterUpsertV1 | SourceAdapterDeleteV1,
  item: Record<string, unknown> | null,
  head: Record<string, unknown> | null = null,
) {
  const sourceItemId = output.operation === "upsert"
    ? output.sourceItem.sourceItemId
    : output.sourceItemId;
  return fakeSql((query) => {
    if (query.text.includes("FROM omni_source_items")) {
      return item ? [item] : [];
    }
    if (query.text.includes("FROM omni_source_sync_heads")) {
      return head ? [head] : [];
    }
    if (query.text.includes("FROM omni_source_adapter_output_receipts")) {
      return [storedReceipt(output)];
    }
    if (query.text.includes("INSERT INTO omni_source_revisions")) {
      return [{ id: output.operation === "upsert"
        ? output.sourceRevision.sourceRevisionId
        : "unused" }];
    }
    if (query.text.includes("INSERT INTO omni_source_tombstones")) {
      return [{ id: "inserted" }];
    }
    if (query.text.includes("INSERT INTO omni_source_sync_heads")) {
      return [{ source_item_id: sourceItemId }];
    }
    if (
      query.text.includes("INSERT INTO omni_source_items") ||
      query.text.includes("UPDATE omni_source_items")
    ) {
      return [{ id: sourceItemId }];
    }
    return [];
  });
}

function fakeSql(
  handler: (query: Query) => Record<string, unknown>[],
  transactionScoped = true,
) {
  const queries: Query[] = [];
  const sql = Object.assign(async (
    strings: TemplateStringsArray,
    ...params: unknown[]
  ) => {
    const query = {
      text: strings.join("?").replace(/\s+/g, " ").trim(),
      params,
    } satisfies Query;
    queries.push(query);
    return handler(query);
  }, { transactionScoped }) as unknown as SourceSqlClient;
  return { sql, queries };
}

function digest(seed: string) {
  return sourceContractSha256({ seed });
}
