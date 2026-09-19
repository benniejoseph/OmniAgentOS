import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionScope } from "@/lib/security/execution-scope";

const mocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(),
  ensureDatabaseSchema: vi.fn(),
  enqueueOperationJob: vi.fn(),
  getSql: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({
  del: vi.fn(),
  get: vi.fn(),
  put: vi.fn(),
}));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  ensureDatabaseSchema: mocks.ensureDatabaseSchema,
  getSql: mocks.getSql,
}));
vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.appendScopedDomainEvent,
}));
vi.mock("@/lib/operations/job-queue", () => ({
  enqueueOperationJob: mocks.enqueueOperationJob,
}));

import {
  AssetObjectError,
  commitAssetObjectJob,
  deleteAssetObjectJob,
  issueAssetObjectDelivery,
  readReadyAssetObject,
  redeemAssetObjectDelivery,
  retireAssetObjectsForSource,
  stageAssetObject,
  updateAssetObjectExtractionState,
  type PrivateAssetBlobAdapter,
} from "@/lib/storage/object-plane";

const tenantId = "tenant-a";
const actorId = "owner@example.test";
const sourceId = "capture_asset_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const bytes = new Uint8Array(Buffer.from("private asset bytes"));
const contentSha256 = createHash("sha256").update(bytes).digest("hex");
const scope = createExecutionScope({
  tenantId,
  initiatingActorId: actorId,
  executingPrincipalType: "user",
  executingPrincipalId: actorId,
  correlationId: "capture-request-a",
  capabilityGrantIds: ["first_party.capture"],
  purpose: "capture.asset.ingest",
});
const deleteScope = createExecutionScope({
  tenantId,
  initiatingActorId: actorId,
  executingPrincipalType: "user",
  executingPrincipalId: actorId,
  correlationId: "capture-delete-request-a",
  capabilityGrantIds: ["first_party.capture"],
  purpose: "capture.asset.delete",
});

type ObjectRow = Record<string, unknown>;

function createObjectHarness(options: {
  sourceKind?: "capture_asset" | "generated_artifact";
  sourceId?: string;
  objectVersion?: number;
  bytes?: Uint8Array;
  mediaType?: string;
  executionScope?: typeof scope;
  permissionGrantIds?: string[];
  allowedPurposeIds?: string[];
  retentionPolicyId?: string;
  extractionState?: "pending" | "completed";
  projectId?: string | null;
} = {}) {
  const harnessSourceKind = options.sourceKind || "capture_asset";
  const harnessSourceId = options.sourceId || sourceId;
  const harnessObjectVersion = options.objectVersion || 1;
  const harnessBytes = options.bytes || bytes;
  const harnessContentSha256 = createHash("sha256")
    .update(harnessBytes)
    .digest("hex");
  const harnessScope = options.executionScope || scope;
  const objectId = `asset_object_${sha256(JSON.stringify({
    schemaVersion: 1,
    tenantId,
    ownerActorId: actorId,
    sourceKind: harnessSourceKind,
    sourceId: harnessSourceId,
    objectVersion: harnessObjectVersion,
    contentSha256: harnessContentSha256,
  })).slice(0, 48)}`;
  const locator = [
    "v1",
    sha256(tenantId).slice(0, 32),
    sha256(actorId).slice(0, 32),
    harnessSourceKind,
    sha256(harnessSourceId).slice(0, 48),
    `v${harnessObjectVersion}`,
    `${harnessContentSha256}.bin`,
  ].join("/");
  let row: ObjectRow = {
    id: objectId,
    tenant_id: tenantId,
    owner_actor_id: actorId,
    workspace_id: null,
    project_id: options.projectId || null,
    mission_id: null,
    source_kind: harnessSourceKind,
    source_id: harnessSourceId,
    object_version: harnessObjectVersion,
    storage_provider: "vercel_blob_private",
    storage_locator: locator,
    storage_etag: null,
    status: "pending",
    content_sha256: harnessContentSha256,
    byte_count: harnessBytes.byteLength,
    media_type: options.mediaType || "application/pdf",
    visibility: "user_private",
    sensitivity: "confidential",
    permission_grant_ids: options.permissionGrantIds || ["first_party.capture"],
    allowed_purpose_ids: options.allowedPurposeIds || [
      "capture.asset.download",
      "capture.asset.extract",
    ],
    retention_policy_id: options.retentionPolicyId || "retention.capture.owner-controlled",
    retention_expires_at: null,
    extraction_state: options.extractionState || "pending",
    upload_job_id: null,
    failure_count: 0,
    failure_code: null,
    execution_scope: harnessScope,
    ready_at: null,
    deleted_at: null,
    scrubbed_at: null,
    created_at: "2026-09-06T10:00:00.000Z",
    updated_at: "2026-09-06T10:00:00.000Z",
  };
  let extractionMutation = 0;
  const sql = Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join(" ").replace(/\s+/g, " ");
      if (query.includes("INSERT INTO omni_asset_objects")) return [row];
      if (query.includes("SET upload_job_id")) {
        row = { ...row, upload_job_id: "job-commit-a" };
        return [row];
      }
      if (query.includes("SET extraction_state")) {
        const extractionState = String(values[0]);
        if (row.extraction_state === extractionState) return [];
        extractionMutation += 1;
        row = {
          ...row,
          extraction_state: extractionState,
          updated_at: `2026-09-06T10:00:0${extractionMutation}.000Z`,
        };
        return [row];
      }
      if (
        query.includes("SELECT content AS bytes") ||
        query.includes("SELECT content_bytes AS bytes")
      ) return [{ bytes: harnessBytes }];
      if (query.includes("SET status = 'ready'")) {
        row = {
          ...row,
          status: "ready",
          storage_etag: "etag-a",
          ready_at: "2026-09-06T10:01:00.000Z",
        };
        return [row];
      }
      if (query.includes("SET status = 'deleted'")) {
        row = {
          ...row,
          status: "deleted",
          deleted_at: "2026-09-06T10:02:00.000Z",
        };
        return [row];
      }
      if (query.includes("SET scrubbed_at")) {
        row = {
          ...row,
          storage_etag: null,
          scrubbed_at: "2026-09-06T10:03:00.000Z",
        };
        return [row];
      }
      if (
        query.includes("object_version") &&
        query.includes("status = 'ready'")
      ) {
        return row.status === "ready" ? [row] : [];
      }
      if (query.includes("SELECT 1 FROM omni_capture_assets")) return [{}];
      if (query.includes("SELECT 1 FROM omni_generated_artifact_versions")) {
        return [{}];
      }
      if (query.includes("SELECT * FROM omni_asset_objects")) return [row];
      throw new Error(`Unexpected object-plane query: ${query}`);
    }),
    {
      transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(sql)),
    },
  );
  return {
    objectId,
    locator,
    sql,
    bytes: harnessBytes,
    contentSha256: harnessContentSha256,
    getRow: () => row,
  };
}

beforeEach(() => {
  vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", "a".repeat(64));
  mocks.appendScopedDomainEvent.mockReset().mockResolvedValue({});
  mocks.ensureDatabaseSchema.mockReset().mockResolvedValue(undefined);
  mocks.enqueueOperationJob.mockReset().mockImplementation(async (input) => ({
    id: input.type === "asset.object.delete" ? "job-delete-a" : "job-commit-a",
    tenantId: input.tenantId,
    type: input.type,
    status: "queued",
    payload: input.payload,
    dedupeKey: input.dedupeKey,
    priority: input.priority,
    attempt: 0,
    maxAttempts: input.maxAttempts,
    runAt: "2026-09-06T10:00:00.000Z",
    createdAt: "2026-09-06T10:00:00.000Z",
    updatedAt: "2026-09-06T10:00:00.000Z",
  }));
});

describe("tenant-scoped private asset object plane", () => {
  it("stages, verifies, and atomically promotes immutable bytes", async () => {
    const harness = createObjectHarness();
    mocks.getSql.mockReturnValue(harness.sql);
    const staged = await stageAssetObject({
      tenantId,
      ownerActorId: actorId,
      sourceKind: "capture_asset",
      sourceId,
      contentSha256,
      byteCount: bytes.byteLength,
      mediaType: "application/pdf",
      extractionState: "pending",
      executionScope: scope,
      permissionGrantIds: ["first_party.capture"],
      allowedPurposeIds: ["capture.asset.extract", "capture.asset.download"],
      retentionPolicyId: "retention.capture.owner-controlled",
    }, { sql: harness.sql as never });
    const commitJob = mocks.enqueueOperationJob.mock.results[0]?.value
      ? await mocks.enqueueOperationJob.mock.results[0].value
      : undefined;
    const stored = new Map<string, Uint8Array>();
    const adapter: PrivateAssetBlobAdapter = {
      read: vi.fn(async (locator) => stored.has(locator)
        ? { bytes: stored.get(locator)!, etag: "etag-a" }
        : null),
      put: vi.fn(async (locator, body) => {
        stored.set(locator, new Uint8Array(body));
      }),
      delete: vi.fn(async (locator) => {
        stored.delete(locator);
      }),
    };

    const ready = await commitAssetObjectJob(commitJob, { adapter });

    expect(staged).toMatchObject({
      id: harness.objectId,
      tenantId,
      ownerActorId: actorId,
      storageLocator: harness.locator,
      status: "pending",
      uploadJobId: "job-commit-a",
    });
    expect(ready).toMatchObject({ status: "ready", storageEtag: "etag-a" });
    expect(adapter.put).toHaveBeenCalledOnce();
    expect(harness.sql.transaction).toHaveBeenCalledOnce();
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "asset_object.ready" }),
      { sql: harness.sql },
    );
  });

  it("keeps generated artifact versions private and reads their exact canonical source", async () => {
    const artifactId = `generated_artifact_${"b".repeat(48)}`;
    const artifactBytes = new Uint8Array(Buffer.from("generated presentation bytes"));
    const artifactScope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "system",
      executingPrincipalId: "artifact-renderer",
      projectId: "project:proposal-a",
      correlationId: "artifact-render-a",
      capabilityGrantIds: ["first_party.generated_artifacts"],
      purpose: "artifact.render",
    });
    const harness = createObjectHarness({
      sourceKind: "generated_artifact",
      sourceId: artifactId,
      objectVersion: 3,
      bytes: artifactBytes,
      mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      executionScope: artifactScope,
      permissionGrantIds: ["first_party.generated_artifacts"],
      allowedPurposeIds: ["artifact.download", "artifact.preview"],
      retentionPolicyId: "retention.generated_artifact.owner_controlled",
      extractionState: "completed",
      projectId: "project:proposal-a",
    });
    mocks.getSql.mockReturnValue(harness.sql);
    await stageAssetObject({
      tenantId,
      ownerActorId: actorId,
      sourceKind: "generated_artifact",
      sourceId: artifactId,
      objectVersion: 3,
      contentSha256: harness.contentSha256,
      byteCount: artifactBytes.byteLength,
      mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      extractionState: "completed",
      executionScope: artifactScope,
      projectId: "project:proposal-a",
      allowedPurposeIds: ["artifact.download", "artifact.preview"],
      retentionPolicyId: "retention.generated_artifact.owner_controlled",
    }, { sql: harness.sql as never });
    const commitJob = await mocks.enqueueOperationJob.mock.results[0].value;
    const stored = new Map<string, Uint8Array>();
    const adapter: PrivateAssetBlobAdapter = {
      read: vi.fn(async (locator) => stored.has(locator)
        ? { bytes: stored.get(locator)!, etag: "etag-generated-a" }
        : null),
      put: vi.fn(async (locator, body) => {
        stored.set(locator, new Uint8Array(body));
      }),
      delete: vi.fn(async (locator) => {
        stored.delete(locator);
      }),
    };

    await commitAssetObjectJob(commitJob, { adapter });
    await expect(readReadyAssetObject({
      tenantId,
      ownerActorId: actorId,
      sourceKind: "generated_artifact",
      sourceId: artifactId,
      objectVersion: 3,
      purpose: "artifact.preview",
      adapter,
    })).resolves.toMatchObject({ bytes: artifactBytes });
    expect(harness.locator).toContain("/generated_artifact/");
    expect(harness.sql.mock.calls.some(([strings]) =>
      (strings as TemplateStringsArray).join(" ")
        .includes("FROM omni_generated_artifact_versions")
    )).toBe(true);
  });

  it("binds delivery to owner and purpose, then revokes it before scrubbing", async () => {
    const harness = createObjectHarness();
    mocks.getSql.mockReturnValue(harness.sql);
    await stageAssetObject({
      tenantId,
      ownerActorId: actorId,
      sourceKind: "capture_asset",
      sourceId,
      contentSha256,
      byteCount: bytes.byteLength,
      mediaType: "application/pdf",
      extractionState: "pending",
      executionScope: scope,
      allowedPurposeIds: ["capture.asset.download", "capture.asset.extract"],
      retentionPolicyId: "retention.capture.owner-controlled",
    }, { sql: harness.sql as never });
    const commitJob = await mocks.enqueueOperationJob.mock.results[0].value;
    let stored = true;
    const adapter: PrivateAssetBlobAdapter = {
      read: vi.fn(async () => stored ? { bytes, etag: "etag-a" } : null),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => {
        stored = false;
      }),
    };
    await commitAssetObjectJob(commitJob, { adapter });
    await expect(readReadyAssetObject({
      tenantId,
      ownerActorId: actorId,
      sourceKind: "capture_asset",
      sourceId,
      purpose: "capture.asset.download",
      adapter,
    })).resolves.toMatchObject({ bytes });
    const delivery = await issueAssetObjectDelivery({
      tenantId,
      actorId,
      sourceKind: "capture_asset",
      sourceId,
      purpose: "capture.asset.download",
    });
    await expect(redeemAssetObjectDelivery({
      token: delivery.token,
      tenantId,
      actorId: "sibling@example.test",
      purpose: "capture.asset.download",
      adapter,
    })).rejects.toMatchObject({ code: "delivery_token_invalid" });
    await expect(redeemAssetObjectDelivery({
      token: delivery.token,
      tenantId,
      actorId,
      purpose: "capture.asset.download",
      adapter,
    })).resolves.toMatchObject({ bytes });

    await retireAssetObjectsForSource({
      tenantId,
      ownerActorId: actorId,
      sourceKind: "capture_asset",
      sourceId,
      executionScope: deleteScope,
    }, { sql: harness.sql as never });
    await expect(redeemAssetObjectDelivery({
      token: delivery.token,
      tenantId,
      actorId,
      purpose: "capture.asset.download",
      adapter,
    })).rejects.toBeInstanceOf(AssetObjectError);
    const deleteJob = await mocks.enqueueOperationJob.mock.results[1].value;
    expect(deleteJob.payload.executionScope).toEqual(deleteScope);
    expect(deleteJob.payload.executionScope).not.toEqual(scope);
    const deleted = await deleteAssetObjectJob(deleteJob, { adapter });
    expect(deleted).toMatchObject({ status: "deleted", scrubbedAt: expect.any(String) });
    expect(adapter.delete).toHaveBeenCalledWith(harness.locator);
  });

  it("gives repeated extraction states distinct event identities across processing runs", async () => {
    const harness = createObjectHarness();
    mocks.getSql.mockReturnValue(harness.sql);
    const reindexScope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "user",
      executingPrincipalId: actorId,
      correlationId: "capture-reindex-request-a",
      causationId: "capture-reindex-request-a",
      capabilityGrantIds: ["first_party.capture"],
      purpose: "capture.asset.index",
    });
    const workerScope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "system",
      executingPrincipalId: "background-worker",
      correlationId: "capture-reindex-request-a",
      causationId: "capture-reindex-job-a",
      capabilityGrantIds: ["first_party.capture"],
      purpose: "capture.asset.ingest",
    });

    await updateAssetObjectExtractionState({
      tenantId,
      ownerActorId: actorId,
      sourceKind: "capture_asset",
      sourceId,
      extractionState: "completed",
      executionScope: scope,
    }, { sql: harness.sql as never });
    await updateAssetObjectExtractionState({
      tenantId,
      ownerActorId: actorId,
      sourceKind: "capture_asset",
      sourceId,
      extractionState: "pending",
      executionScope: reindexScope,
    }, { sql: harness.sql as never });
    await updateAssetObjectExtractionState({
      tenantId,
      ownerActorId: actorId,
      sourceKind: "capture_asset",
      sourceId,
      extractionState: "completed",
      executionScope: workerScope,
    }, { sql: harness.sql as never });
    await updateAssetObjectExtractionState({
      tenantId,
      ownerActorId: actorId,
      sourceKind: "capture_asset",
      sourceId,
      extractionState: "completed",
      executionScope: workerScope,
    }, { sql: harness.sql as never });

    const extractionEvents = mocks.appendScopedDomainEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "asset_object.extraction_changed");
    expect(extractionEvents).toHaveLength(3);
    expect(extractionEvents[0].id).not.toBe(extractionEvents[2].id);
    expect(new Set(extractionEvents.map((event) => event.id)).size).toBe(3);
    expect(extractionEvents[0].id).toContain(":1:completed:");
    expect(extractionEvents[2].id).toContain(":1:completed:");
  });
});

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
