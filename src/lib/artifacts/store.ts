import { createHash } from "node:crypto";

import {
  GENERATED_ARTIFACT_CONTRACT_VERSION,
  GENERATED_ARTIFACT_SCHEMA_VERSION,
  assertGeneratedArtifactSha256,
  generatedArtifactIdSchema,
  generatedArtifactKindSchema,
  generatedArtifactRenderStatusSchema,
  generatedArtifactSpecSha256,
  generatedArtifactVersionIdSchema,
  normalizeGeneratedArtifactRefs,
  parseGeneratedArtifactSpec,
  parseGoogleArtifactResourceRef,
  type GeneratedArtifactKind,
  type GeneratedArtifactMutationContext,
  type GeneratedArtifactRecord,
  type GeneratedArtifactRenderStatus,
  type GeneratedArtifactSpec,
  type GeneratedArtifactVersionRecord,
  type GoogleArtifactResourceRef,
} from "@/lib/artifacts/contracts";
import {
  GENERATED_ARTIFACT_EVENT_TYPES,
  generatedArtifactEventPayload,
  generatedArtifactMutationEventId,
  type GeneratedArtifactEventType,
} from "@/lib/artifacts/events";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  assertExecutionScopeTenant,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { stageAssetObject } from "@/lib/storage/object-plane";
import {
  canonicalJsonSha256,
  idempotencyKeySha256,
} from "@/lib/tools/effect-receipt";

type ArtifactSql = ReturnType<typeof getSql>;
type SqlRow = Record<string, unknown>;

export const GENERATED_ARTIFACT_PURPOSES = Object.freeze({
  create: "artifact.create",
  revise: "artifact.revise",
  render: "artifact.render",
  read: "artifact.read",
  preview: "artifact.preview",
  download: "artifact.download",
  export: "artifact.export",
} as const);

export class GeneratedArtifactError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "database_required"
      | "invalid_contract"
      | "idempotency_conflict"
      | "artifact_not_found"
      | "version_not_found"
      | "version_conflict"
      | "invalid_transition",
  ) {
    super(message);
    this.name = "GeneratedArtifactError";
  }
}

type StoreOptions = Readonly<{ sql?: ArtifactSql }>;

export async function createGeneratedArtifactVersion(input: {
  tenantId: string;
  ownerActorId: string;
  title: string;
  kind: GeneratedArtifactKind;
  spec: GeneratedArtifactSpec;
  mediaType: string;
  mutation: GeneratedArtifactMutationContext;
  artifactId?: string;
  expectedCurrentVersion?: number;
  lineageRefs?: readonly string[];
  evidenceRefs?: readonly string[];
  projectId?: string | null;
  missionId?: string | null;
  workItemId?: string | null;
}, options: StoreOptions = {}): Promise<GeneratedArtifactVersionRecord> {
  const normalized = normalizeCreateInput(input);
  return withArtifactSql(normalized.tenantId, normalized.ownerActorId, options, (sql) =>
    sql.transaction(async (tx: ArtifactSql) => {
      await lockMutation(tx, normalized.tenantId, normalized.ownerActorId, normalized.idempotencyKeySha256);
      const replay = await replayMutation(tx, {
        tenantId: normalized.tenantId,
        ownerActorId: normalized.ownerActorId,
        operation: "queue",
        idempotencyKeySha256: normalized.idempotencyKeySha256,
        requestSha256: normalized.requestSha256,
      });
      if (replay) return replay;

      const artifactId = normalized.artifactId || deterministicArtifactId({
        tenantId: normalized.tenantId,
        ownerActorId: normalized.ownerActorId,
        idempotencyKeySha256: normalized.idempotencyKeySha256,
      });
      const headRows = await tx`
        SELECT * FROM omni_generated_artifacts
        WHERE id = ${artifactId} AND tenant_id = ${normalized.tenantId}
          AND owner_actor_id = ${normalized.ownerActorId}
        FOR UPDATE
      `;
      const head = headRows[0] ? generatedArtifactFromRow(headRows[0]) : undefined;
      if (head && head.kind !== normalized.kind) {
        throw new GeneratedArtifactError(
          "An artifact cannot change kind between versions.",
          "version_conflict",
        );
      }
      if (head && normalized.expectedCurrentVersion === undefined) {
        throw new GeneratedArtifactError(
          "Revising an artifact requires its exact current version.",
          "version_conflict",
        );
      }
      if (!head && normalized.expectedCurrentVersion !== undefined) {
        throw new GeneratedArtifactError(
          "The artifact version to revise was not found.",
          "artifact_not_found",
        );
      }
      if (head && head.currentVersion !== normalized.expectedCurrentVersion) {
        throw new GeneratedArtifactError(
          "The artifact changed. Refresh and try again.",
          "version_conflict",
        );
      }

      const version = head ? head.currentVersion + 1 : 1;
      const versionId = `${artifactId}:v${version}`;
      const clockRows = await tx`SELECT clock_timestamp() AS now`;
      const now = timestamp(clockRows[0]?.now);
      const versionRecord: GeneratedArtifactVersionRecord = Object.freeze({
        schemaVersion: GENERATED_ARTIFACT_SCHEMA_VERSION,
        contractVersion: GENERATED_ARTIFACT_CONTRACT_VERSION,
        id: versionId,
        artifactId,
        tenantId: normalized.tenantId,
        ownerActorId: normalized.ownerActorId,
        version,
        kind: normalized.kind,
        title: normalized.title,
        renderStatus: "queued",
        spec: normalized.spec,
        specSha256: normalized.specSha256,
        mediaType: normalized.mediaType,
        contentSha256: null,
        byteCount: null,
        lineageRefs: normalized.lineageRefs,
        evidenceRefs: normalized.evidenceRefs,
        projectId: normalized.projectId,
        missionId: normalized.missionId,
        workItemId: normalized.workItemId,
        googleResourceRef: null,
        failureCode: null,
        executionScope: normalized.executionScope,
        queuedAt: now,
        renderingStartedAt: null,
        readyAt: null,
        failedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      if (head) {
        const updated = await tx`
          UPDATE omni_generated_artifacts
          SET title = ${versionRecord.title}, current_version = ${version},
              current_version_id = ${versionId}, project_id = ${versionRecord.projectId},
              mission_id = ${versionRecord.missionId}, work_item_id = ${versionRecord.workItemId},
              updated_at = ${now}
          WHERE id = ${artifactId} AND tenant_id = ${normalized.tenantId}
            AND owner_actor_id = ${normalized.ownerActorId}
            AND current_version = ${head.currentVersion}
          RETURNING id
        `;
        if (!updated[0]) {
          throw new GeneratedArtifactError(
            "The artifact changed. Refresh and try again.",
            "version_conflict",
          );
        }
      } else {
        await tx`
          INSERT INTO omni_generated_artifacts (
            id, tenant_id, owner_actor_id, kind, title, current_version,
            current_version_id, project_id, mission_id, work_item_id,
            created_at, updated_at
          ) VALUES (
            ${artifactId}, ${normalized.tenantId}, ${normalized.ownerActorId},
            ${normalized.kind}, ${normalized.title}, 1, ${versionId},
            ${normalized.projectId}, ${normalized.missionId}, ${normalized.workItemId},
            ${now}, ${now}
          )
        `;
      }

      await tx`
        INSERT INTO omni_generated_artifact_versions (
          id, artifact_id, tenant_id, owner_actor_id, artifact_version,
          kind, title, render_status, spec_snapshot, spec_sha256, media_type,
          content_sha256, byte_count, content_bytes, lineage_refs, evidence_refs,
          project_id, mission_id, work_item_id, google_resource_ref, failure_code,
          creation_idempotency_key_sha256, creation_request_sha256,
          execution_scope, queued_at, rendering_started_at, ready_at, failed_at,
          created_at, updated_at
        ) VALUES (
          ${versionId}, ${artifactId}, ${normalized.tenantId},
          ${normalized.ownerActorId}, ${version}, ${normalized.kind},
          ${normalized.title}, 'queued', ${normalized.spec}::jsonb,
          ${normalized.specSha256}, ${normalized.mediaType}, NULL, NULL, NULL,
          ${normalized.lineageRefs}, ${normalized.evidenceRefs},
          ${normalized.projectId}, ${normalized.missionId}, ${normalized.workItemId},
          NULL, NULL, ${normalized.idempotencyKeySha256},
          ${normalized.requestSha256}, ${normalized.executionScope}::jsonb,
          ${now}, NULL, NULL, NULL, ${now}, ${now}
        )
      `;
      await appendArtifactMutation(tx, {
        operation: "queue",
        type: GENERATED_ARTIFACT_EVENT_TYPES.queued,
        version: versionRecord,
        mutation: normalized,
        requestSha256: normalized.requestSha256,
      });
      return versionRecord;
    }) as Promise<GeneratedArtifactVersionRecord>
  );
}

export async function startGeneratedArtifactRender(input: {
  tenantId: string;
  ownerActorId: string;
  artifactId: string;
  artifactVersion: number;
  mutation: GeneratedArtifactMutationContext;
}, options: StoreOptions = {}) {
  const authority = normalizeLifecycleAuthority(input, "start");
  const requestSha256 = canonicalJsonSha256({
    operation: "start",
    artifactId: authority.artifactId,
    artifactVersion: authority.artifactVersion,
  });
  return mutateLifecycle(authority, {
    operation: "start",
    type: GENERATED_ARTIFACT_EVENT_TYPES.rendering,
    requestSha256,
    targetStatus: "rendering",
  }, options);
}

export async function completeGeneratedArtifactRender(input: {
  tenantId: string;
  ownerActorId: string;
  artifactId: string;
  artifactVersion: number;
  bytes: Uint8Array;
  googleResourceRef?: GoogleArtifactResourceRef | null;
  mutation: GeneratedArtifactMutationContext;
}, options: StoreOptions = {}) {
  const authority = normalizeLifecycleAuthority(input, "ready");
  const bytes = normalizeBytes(input.bytes);
  const contentSha256 = createHash("sha256").update(bytes).digest("hex");
  const googleResourceRef = parseGoogleArtifactResourceRef(
    input.googleResourceRef,
  );
  const requestSha256 = canonicalJsonSha256({
    operation: "ready",
    artifactId: authority.artifactId,
    artifactVersion: authority.artifactVersion,
    contentSha256,
    byteCount: bytes.byteLength,
    googleResourceRef,
  });
  return mutateLifecycle(authority, {
    operation: "ready",
    type: GENERATED_ARTIFACT_EVENT_TYPES.ready,
    requestSha256,
    targetStatus: "ready",
    bytes,
    contentSha256,
    googleResourceRef,
  }, options);
}

export async function failGeneratedArtifactRender(input: {
  tenantId: string;
  ownerActorId: string;
  artifactId: string;
  artifactVersion: number;
  failureCode: string;
  mutation: GeneratedArtifactMutationContext;
}, options: StoreOptions = {}) {
  const authority = normalizeLifecycleAuthority(input, "fail");
  const failureCode = normalizedFailureCode(input.failureCode);
  const requestSha256 = canonicalJsonSha256({
    operation: "fail",
    artifactId: authority.artifactId,
    artifactVersion: authority.artifactVersion,
    failureCode,
  });
  return mutateLifecycle(authority, {
    operation: "fail",
    type: GENERATED_ARTIFACT_EVENT_TYPES.failed,
    requestSha256,
    targetStatus: "failed",
    failureCode,
  }, options);
}

export async function getGeneratedArtifact(
  input: { tenantId: string; ownerActorId: string; artifactId: string },
  options: StoreOptions = {},
) {
  const tenantId = requiredText(input.tenantId, 160, "tenant id");
  const ownerActorId = requiredText(input.ownerActorId, 320, "owner actor id");
  const artifactId = parseArtifactId(input.artifactId);
  return withArtifactSql(tenantId, ownerActorId, options, async (sql) => {
    const rows = await sql`
      SELECT * FROM omni_generated_artifacts
      WHERE id = ${artifactId} AND tenant_id = ${tenantId}
        AND owner_actor_id = ${ownerActorId}
      LIMIT 1
    `;
    return rows[0] ? generatedArtifactFromRow(rows[0]) : undefined;
  });
}

export async function getGeneratedArtifactVersion(
  input: {
    tenantId: string;
    ownerActorId: string;
    artifactId: string;
    artifactVersion: number;
  },
  options: StoreOptions = {},
) {
  const tenantId = requiredText(input.tenantId, 160, "tenant id");
  const ownerActorId = requiredText(input.ownerActorId, 320, "owner actor id");
  const artifactId = parseArtifactId(input.artifactId);
  const artifactVersion = positiveInteger(input.artifactVersion, "artifact version");
  return withArtifactSql(tenantId, ownerActorId, options, (sql) =>
    readVersion(sql, tenantId, ownerActorId, artifactId, artifactVersion)
  );
}

export async function readGeneratedArtifactContent(
  input: {
    tenantId: string;
    ownerActorId: string;
    artifactId: string;
    artifactVersion: number;
  },
  options: StoreOptions = {},
) {
  const tenantId = requiredText(input.tenantId, 160, "tenant id");
  const ownerActorId = requiredText(input.ownerActorId, 320, "owner actor id");
  const artifactId = parseArtifactId(input.artifactId);
  const artifactVersion = positiveInteger(input.artifactVersion, "artifact version");
  return withArtifactSql(tenantId, ownerActorId, options, async (sql) => {
    const rows = await sql`
      SELECT * FROM omni_generated_artifact_versions
      WHERE artifact_id = ${artifactId} AND artifact_version = ${artifactVersion}
        AND tenant_id = ${tenantId} AND owner_actor_id = ${ownerActorId}
        AND render_status = 'ready'
      LIMIT 1
    `;
    if (!rows[0]) {
      throw new GeneratedArtifactError(
        "A ready artifact version was not found.",
        "version_not_found",
      );
    }
    const version = generatedArtifactVersionFromRow(rows[0]);
    const stored = rows[0].content_bytes;
    if (stored === null || stored === undefined) {
      throw new GeneratedArtifactError(
        "Stored artifact content is unavailable.",
        "invalid_contract",
      );
    }
    const bytes = new Uint8Array(Buffer.from(stored as Uint8Array));
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");
    if (
      bytes.byteLength !== version.byteCount ||
      contentSha256 !== version.contentSha256
    ) {
      throw new GeneratedArtifactError(
        "Stored artifact content integrity check failed.",
        "invalid_contract",
      );
    }
    return Object.freeze({ version, bytes });
  });
}

export async function listGeneratedArtifacts(
  input: {
    tenantId: string;
    ownerActorId: string;
    kind?: GeneratedArtifactKind;
    limit?: number;
  },
  options: StoreOptions = {},
) {
  const tenantId = requiredText(input.tenantId, 160, "tenant id");
  const ownerActorId = requiredText(input.ownerActorId, 320, "owner actor id");
  const kind = input.kind === undefined
    ? undefined
    : generatedArtifactKindSchema.parse(input.kind);
  const limit = Math.min(Math.max(Math.trunc(input.limit || 50), 1), 100);
  return withArtifactSql(tenantId, ownerActorId, options, async (sql) => {
    const rows = kind
      ? await sql`
          SELECT * FROM omni_generated_artifacts
          WHERE tenant_id = ${tenantId} AND owner_actor_id = ${ownerActorId}
            AND kind = ${kind}
          ORDER BY updated_at DESC, id ASC
          LIMIT ${limit}
        `
      : await sql`
          SELECT * FROM omni_generated_artifacts
          WHERE tenant_id = ${tenantId} AND owner_actor_id = ${ownerActorId}
          ORDER BY updated_at DESC, id ASC
          LIMIT ${limit}
        `;
    return Object.freeze(rows.map(generatedArtifactFromRow));
  });
}

type LifecycleAuthority = ReturnType<typeof normalizeLifecycleAuthority>;
type LifecycleOperation = "start" | "ready" | "fail";

async function mutateLifecycle(
  authority: LifecycleAuthority,
  transition: Readonly<{
    operation: LifecycleOperation;
    type: GeneratedArtifactEventType;
    requestSha256: string;
    targetStatus: Exclude<GeneratedArtifactRenderStatus, "queued">;
    bytes?: Uint8Array;
    contentSha256?: string;
    googleResourceRef?: GoogleArtifactResourceRef | null;
    failureCode?: string;
  }>,
  options: StoreOptions,
) {
  return withArtifactSql(authority.tenantId, authority.ownerActorId, options, (sql) =>
    sql.transaction(async (tx: ArtifactSql) => {
      await lockMutation(tx, authority.tenantId, authority.ownerActorId, authority.idempotencyKeySha256);
      const replay = await replayMutation(tx, {
        tenantId: authority.tenantId,
        ownerActorId: authority.ownerActorId,
        operation: transition.operation,
        idempotencyKeySha256: authority.idempotencyKeySha256,
        requestSha256: transition.requestSha256,
      });
      if (replay) return replay;

      const rows = await tx`
        SELECT * FROM omni_generated_artifact_versions
        WHERE artifact_id = ${authority.artifactId}
          AND artifact_version = ${authority.artifactVersion}
          AND tenant_id = ${authority.tenantId}
          AND owner_actor_id = ${authority.ownerActorId}
        FOR UPDATE
      `;
      if (!rows[0]) {
        throw new GeneratedArtifactError(
          "The artifact version was not found.",
          "version_not_found",
        );
      }
      const current = generatedArtifactVersionFromRow(rows[0]);
      assertLifecycleScopeMatches(authority.executionScope, current);
      assertTransition(current.renderStatus, transition.targetStatus);
      const clockRows = await tx`SELECT clock_timestamp() AS now`;
      const now = timestamp(clockRows[0]?.now);
      const updatedRows = transition.targetStatus === "rendering"
        ? await tx`
            UPDATE omni_generated_artifact_versions
            SET render_status = 'rendering', rendering_started_at = ${now},
                updated_at = ${now}
            WHERE id = ${current.id} AND tenant_id = ${authority.tenantId}
              AND owner_actor_id = ${authority.ownerActorId}
              AND render_status = 'queued'
            RETURNING *
          `
        : transition.targetStatus === "ready"
          ? await tx`
              UPDATE omni_generated_artifact_versions
              SET render_status = 'ready', content_sha256 = ${transition.contentSha256},
                  byte_count = ${transition.bytes!.byteLength},
                  content_bytes = ${Buffer.from(transition.bytes!)},
                  google_resource_ref = ${transition.googleResourceRef || null}::jsonb,
                  ready_at = ${now}, updated_at = ${now}
              WHERE id = ${current.id} AND tenant_id = ${authority.tenantId}
                AND owner_actor_id = ${authority.ownerActorId}
                AND render_status = 'rendering'
              RETURNING *
            `
          : await tx`
              UPDATE omni_generated_artifact_versions
              SET render_status = 'failed', failure_code = ${transition.failureCode},
                  failed_at = ${now}, updated_at = ${now}
              WHERE id = ${current.id} AND tenant_id = ${authority.tenantId}
                AND owner_actor_id = ${authority.ownerActorId}
                AND render_status IN ('queued', 'rendering')
              RETURNING *
            `;
      if (!updatedRows[0]) {
        throw new GeneratedArtifactError(
          "The artifact render lifecycle changed. Refresh and try again.",
          "invalid_transition",
        );
      }
      const updated = generatedArtifactVersionFromRow(updatedRows[0]);
      if (updated.renderStatus === "ready") {
        await stageAssetObject({
          tenantId: updated.tenantId,
          ownerActorId: updated.ownerActorId,
          sourceKind: "generated_artifact",
          sourceId: updated.artifactId,
          objectVersion: updated.version,
          contentSha256: updated.contentSha256!,
          byteCount: updated.byteCount!,
          mediaType: updated.mediaType,
          extractionState: "completed",
          executionScope: authority.executionScope,
          projectId: updated.projectId,
          missionId: updated.missionId,
          permissionGrantIds: ["first_party.generated_artifacts"],
          allowedPurposeIds: [
            GENERATED_ARTIFACT_PURPOSES.download,
            GENERATED_ARTIFACT_PURPOSES.export,
            GENERATED_ARTIFACT_PURPOSES.preview,
          ],
          retentionPolicyId: "retention.generated_artifact.owner_controlled",
        }, { sql: tx });
      }
      await appendArtifactMutation(tx, {
        operation: transition.operation,
        type: transition.type,
        version: updated,
        mutation: authority,
        requestSha256: transition.requestSha256,
      });
      return updated;
    }) as Promise<GeneratedArtifactVersionRecord>
  );
}

async function appendArtifactMutation(
  sql: ArtifactSql,
  input: {
    operation: "queue" | LifecycleOperation;
    type: GeneratedArtifactEventType;
    version: GeneratedArtifactVersionRecord;
    mutation: {
      executionScope: ExecutionScope;
      idempotencyKeySha256: string;
    };
    requestSha256: string;
  },
) {
  const payload = generatedArtifactEventPayload({
    version: input.version,
    idempotencyKeySha256: input.mutation.idempotencyKeySha256,
    requestSha256: input.requestSha256,
  });
  const eventId = generatedArtifactMutationEventId({
    tenantId: input.version.tenantId,
    ownerActorId: input.version.ownerActorId,
    artifactVersionId: input.version.id,
    type: input.type,
    idempotencyKeySha256: input.mutation.idempotencyKeySha256,
  });
  await appendScopedDomainEvent({
    id: eventId,
    streamId: `generated-artifact:${input.version.artifactId}`,
    type: input.type,
    executionScope: input.mutation.executionScope,
    payload,
  }, { sql });
  const mutationId = `generated_artifact_mutation_${canonicalJsonSha256({
    tenantId: input.version.tenantId,
    ownerActorId: input.version.ownerActorId,
    operation: input.operation,
    idempotencyKeySha256: input.mutation.idempotencyKeySha256,
  }).slice(0, 48)}`;
  await sql`
    INSERT INTO omni_generated_artifact_mutations (
      id, tenant_id, owner_actor_id, artifact_id, artifact_version_id,
      operation, idempotency_key_sha256, request_sha256, result_status,
      event_id, execution_scope, created_at
    ) VALUES (
      ${mutationId}, ${input.version.tenantId}, ${input.version.ownerActorId},
      ${input.version.artifactId}, ${input.version.id}, ${input.operation},
      ${input.mutation.idempotencyKeySha256}, ${input.requestSha256},
      ${input.version.renderStatus}, ${eventId},
      ${input.mutation.executionScope}::jsonb, ${input.version.updatedAt}
    )
  `;
}

async function replayMutation(
  sql: ArtifactSql,
  input: {
    tenantId: string;
    ownerActorId: string;
    operation: "queue" | LifecycleOperation;
    idempotencyKeySha256: string;
    requestSha256: string;
  },
) {
  const rows = await sql`
    SELECT artifact_id, artifact_version_id, request_sha256
    FROM omni_generated_artifact_mutations
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.ownerActorId}
      AND operation = ${input.operation}
      AND idempotency_key_sha256 = ${input.idempotencyKeySha256}
    LIMIT 1
  `;
  if (!rows[0]) return undefined;
  if (String(rows[0].request_sha256) !== input.requestSha256) {
    throw new GeneratedArtifactError(
      "Idempotency-Key is already bound to a different artifact mutation.",
      "idempotency_conflict",
    );
  }
  const versionId = generatedArtifactVersionIdSchema.parse(
    rows[0].artifact_version_id,
  );
  const versionRows = await sql`
    SELECT * FROM omni_generated_artifact_versions
    WHERE id = ${versionId} AND tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.ownerActorId}
    LIMIT 1
  `;
  if (!versionRows[0]) {
    throw new GeneratedArtifactError(
      "The idempotent artifact result is unavailable.",
      "version_not_found",
    );
  }
  return generatedArtifactVersionFromRow(versionRows[0]);
}

async function readVersion(
  sql: ArtifactSql,
  tenantId: string,
  ownerActorId: string,
  artifactId: string,
  artifactVersion: number,
) {
  const rows = await sql`
    SELECT * FROM omni_generated_artifact_versions
    WHERE artifact_id = ${artifactId} AND artifact_version = ${artifactVersion}
      AND tenant_id = ${tenantId} AND owner_actor_id = ${ownerActorId}
    LIMIT 1
  `;
  return rows[0] ? generatedArtifactVersionFromRow(rows[0]) : undefined;
}

async function lockMutation(
  sql: ArtifactSql,
  tenantId: string,
  ownerActorId: string,
  idempotencySha256: string,
) {
  await sql`
    SELECT pg_advisory_xact_lock(hashtextextended(
      ${`${tenantId}:${ownerActorId}:${idempotencySha256}`}, 0
    ))
  `;
}

async function withArtifactSql<T>(
  tenantId: string,
  ownerActorId: string,
  options: StoreOptions,
  operation: (sql: ArtifactSql) => Promise<T>,
) {
  if (options.sql) return operation(options.sql);
  if (!hasDatabaseUrl()) {
    throw new GeneratedArtifactError(
      "Generated artifacts require the canonical database authority.",
      "database_required",
    );
  }
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(
    tenantId,
    [ownerActorId],
    () => operation(getSql()),
  );
}

function normalizeCreateInput(input: Parameters<typeof createGeneratedArtifactVersion>[0]) {
  const tenantId = requiredText(input.tenantId, 160, "tenant id");
  const ownerActorId = requiredText(input.ownerActorId, 320, "owner actor id");
  const executionScope = validateMutationContext(
    input.mutation,
    tenantId,
    ownerActorId,
    input.artifactId ? GENERATED_ARTIFACT_PURPOSES.revise : GENERATED_ARTIFACT_PURPOSES.create,
  );
  const artifactId = input.artifactId === undefined
    ? undefined
    : parseArtifactId(input.artifactId);
  const expectedCurrentVersion = input.expectedCurrentVersion === undefined
    ? undefined
    : positiveInteger(input.expectedCurrentVersion, "expected artifact version");
  const kind = generatedArtifactKindSchema.parse(input.kind);
  const title = requiredText(input.title, 240, "artifact title");
  const spec = parseGeneratedArtifactSpec(input.spec);
  const specSha256 = generatedArtifactSpecSha256(spec);
  const mediaType = normalizeMediaType(input.mediaType);
  const projectId = scopedOptionalId(
    input.projectId,
    executionScope.projectId,
    "project id",
  );
  const missionId = scopedOptionalId(
    input.missionId,
    executionScope.missionId,
    "mission id",
  );
  const workItemId = optionalId(input.workItemId, "work item id");
  const lineageRefs = normalizeGeneratedArtifactRefs(input.lineageRefs, "lineageRefs");
  const evidenceRefs = normalizeGeneratedArtifactRefs(input.evidenceRefs, "evidenceRefs");
  const idempotencyKeySha256Value = idempotencyKeySha256({
    tenantId,
    idempotencyKey: `${ownerActorId}\u0000${input.mutation.idempotencyKey.trim()}`,
  });
  const requestSha256 = canonicalJsonSha256({
    artifactId: artifactId || null,
    expectedCurrentVersion: expectedCurrentVersion || null,
    kind,
    title,
    specSha256,
    mediaType,
    lineageRefs,
    evidenceRefs,
    projectId,
    missionId,
    workItemId,
  });
  return {
    tenantId,
    ownerActorId,
    artifactId,
    expectedCurrentVersion,
    kind,
    title,
    spec,
    specSha256,
    mediaType,
    lineageRefs,
    evidenceRefs,
    projectId,
    missionId,
    workItemId,
    executionScope,
    idempotencyKeySha256: idempotencyKeySha256Value,
    requestSha256,
  } as const;
}

function normalizeLifecycleAuthority(
  input: {
    tenantId: string;
    ownerActorId: string;
    artifactId: string;
    artifactVersion: number;
    mutation: GeneratedArtifactMutationContext;
  },
  operation: LifecycleOperation,
) {
  const tenantId = requiredText(input.tenantId, 160, "tenant id");
  const ownerActorId = requiredText(input.ownerActorId, 320, "owner actor id");
  const executionScope = validateMutationContext(
    input.mutation,
    tenantId,
    ownerActorId,
    GENERATED_ARTIFACT_PURPOSES.render,
  );
  return {
    tenantId,
    ownerActorId,
    artifactId: parseArtifactId(input.artifactId),
    artifactVersion: positiveInteger(input.artifactVersion, "artifact version"),
    executionScope,
    idempotencyKeySha256: idempotencyKeySha256({
      tenantId,
      idempotencyKey: `${ownerActorId}\u0000${operation}\u0000${input.mutation.idempotencyKey.trim()}`,
    }),
  } as const;
}

function validateMutationContext(
  mutation: GeneratedArtifactMutationContext,
  tenantId: string,
  ownerActorId: string,
  expectedPurpose: string,
) {
  const scope = parsePersistedExecutionScope(mutation.executionScope);
  if (!scope) {
    throw new GeneratedArtifactError(
      "Artifact mutation requires an execution scope.",
      "invalid_contract",
    );
  }
  assertExecutionScopeTenant(scope, tenantId);
  if (
    scope.initiatingActorId !== ownerActorId ||
    !scope.executingPrincipalId ||
    scope.purpose !== expectedPurpose
  ) {
    throw new GeneratedArtifactError(
      "Artifact mutation scope is invalid.",
      "invalid_contract",
    );
  }
  const idempotencyKey = mutation.idempotencyKey.trim();
  if (
    !idempotencyKey ||
    idempotencyKey.length > 200 ||
    !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)
  ) {
    throw new GeneratedArtifactError(
      "Artifact Idempotency-Key is invalid.",
      "invalid_contract",
    );
  }
  return scope;
}

function assertLifecycleScopeMatches(
  scope: ExecutionScope,
  version: GeneratedArtifactVersionRecord,
) {
  if (
    scope.projectId !== version.projectId ||
    scope.missionId !== version.missionId
  ) {
    throw new GeneratedArtifactError(
      "Artifact render scope does not match the artifact version.",
      "invalid_contract",
    );
  }
}

function assertTransition(
  current: GeneratedArtifactRenderStatus,
  target: Exclude<GeneratedArtifactRenderStatus, "queued">,
) {
  const allowed =
    (current === "queued" && (target === "rendering" || target === "failed")) ||
    (current === "rendering" && (target === "ready" || target === "failed"));
  if (!allowed) {
    throw new GeneratedArtifactError(
      `Artifact render cannot transition from ${current} to ${target}.`,
      "invalid_transition",
    );
  }
}

function deterministicArtifactId(input: Record<string, string>) {
  return `generated_artifact_${canonicalJsonSha256(input).slice(0, 48)}`;
}

function generatedArtifactFromRow(row: SqlRow): GeneratedArtifactRecord {
  const artifactId = parseArtifactId(row.id);
  const currentVersion = positiveInteger(row.current_version, "current artifact version");
  const currentVersionId = generatedArtifactVersionIdSchema.parse(row.current_version_id);
  if (currentVersionId !== `${artifactId}:v${currentVersion}`) {
    throw new GeneratedArtifactError(
      "Stored artifact head is invalid.",
      "invalid_contract",
    );
  }
  return Object.freeze({
    id: artifactId,
    tenantId: requiredText(row.tenant_id, 160, "stored tenant id"),
    ownerActorId: requiredText(row.owner_actor_id, 320, "stored owner actor id"),
    kind: generatedArtifactKindSchema.parse(row.kind),
    title: requiredText(row.title, 240, "stored artifact title"),
    currentVersion,
    currentVersionId,
    projectId: nullableId(row.project_id),
    missionId: nullableId(row.mission_id),
    workItemId: nullableId(row.work_item_id),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function generatedArtifactVersionFromRow(
  row: SqlRow,
): GeneratedArtifactVersionRecord {
  const artifactId = parseArtifactId(row.artifact_id);
  const version = positiveInteger(row.artifact_version, "stored artifact version");
  const id = generatedArtifactVersionIdSchema.parse(row.id);
  if (id !== `${artifactId}:v${version}`) {
    throw new GeneratedArtifactError(
      "Stored artifact version identity is invalid.",
      "invalid_contract",
    );
  }
  const spec = parseGeneratedArtifactSpec(jsonValue(row.spec_snapshot));
  const specSha256 = assertGeneratedArtifactSha256(
    row.spec_sha256,
    "Stored artifact spec digest",
  );
  if (generatedArtifactSpecSha256(spec) !== specSha256) {
    throw new GeneratedArtifactError(
      "Stored artifact spec integrity check failed.",
      "invalid_contract",
    );
  }
  const executionScope = parsePersistedExecutionScope(jsonValue(row.execution_scope));
  if (!executionScope) {
    throw new GeneratedArtifactError(
      "Stored artifact execution scope is invalid.",
      "invalid_contract",
    );
  }
  const tenantId = requiredText(row.tenant_id, 160, "stored tenant id");
  const ownerActorId = requiredText(row.owner_actor_id, 320, "stored owner actor id");
  assertExecutionScopeTenant(executionScope, tenantId);
  if (executionScope.initiatingActorId !== ownerActorId) {
    throw new GeneratedArtifactError(
      "Stored artifact owner scope is invalid.",
      "invalid_contract",
    );
  }
  const renderStatus = generatedArtifactRenderStatusSchema.parse(row.render_status);
  const contentSha256 = row.content_sha256 === null || row.content_sha256 === undefined
    ? null
    : assertGeneratedArtifactSha256(row.content_sha256, "Stored artifact content digest");
  const byteCount = row.byte_count === null || row.byte_count === undefined
    ? null
    : positiveInteger(row.byte_count, "stored artifact byte count");
  if ((renderStatus === "ready") !== (contentSha256 !== null && byteCount !== null)) {
    throw new GeneratedArtifactError(
      "Stored artifact output lifecycle is invalid.",
      "invalid_contract",
    );
  }
  const failureCode = row.failure_code === null || row.failure_code === undefined
    ? null
    : normalizedFailureCode(String(row.failure_code));
  if ((renderStatus === "failed") !== (failureCode !== null)) {
    throw new GeneratedArtifactError(
      "Stored artifact failure lifecycle is invalid.",
      "invalid_contract",
    );
  }
  return Object.freeze({
    schemaVersion: GENERATED_ARTIFACT_SCHEMA_VERSION,
    contractVersion: GENERATED_ARTIFACT_CONTRACT_VERSION,
    id,
    artifactId,
    tenantId,
    ownerActorId,
    version,
    kind: generatedArtifactKindSchema.parse(row.kind),
    title: requiredText(row.title, 240, "stored artifact title"),
    renderStatus,
    spec,
    specSha256,
    mediaType: normalizeMediaType(String(row.media_type)),
    contentSha256,
    byteCount,
    lineageRefs: normalizeGeneratedArtifactRefs(stringArray(row.lineage_refs), "lineageRefs"),
    evidenceRefs: normalizeGeneratedArtifactRefs(stringArray(row.evidence_refs), "evidenceRefs"),
    projectId: nullableId(row.project_id),
    missionId: nullableId(row.mission_id),
    workItemId: nullableId(row.work_item_id),
    googleResourceRef: parseGoogleArtifactResourceRef(jsonValue(row.google_resource_ref)),
    failureCode,
    executionScope,
    queuedAt: timestamp(row.queued_at),
    renderingStartedAt: nullableTimestamp(row.rendering_started_at),
    readyAt: nullableTimestamp(row.ready_at),
    failedAt: nullableTimestamp(row.failed_at),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function scopedOptionalId(
  requested: string | null | undefined,
  scoped: string | null,
  label: string,
) {
  const normalized = requested === undefined ? scoped : optionalId(requested, label);
  if (scoped !== null && normalized !== scoped) {
    throw new GeneratedArtifactError(
      `Artifact ${label} does not match its execution scope.`,
      "invalid_contract",
    );
  }
  return normalized;
}

function parseArtifactId(value: unknown) {
  try {
    return generatedArtifactIdSchema.parse(value);
  } catch {
    throw new GeneratedArtifactError(
      "Generated artifact id is invalid.",
      "invalid_contract",
    );
  }
}

function normalizeBytes(value: Uint8Array) {
  if (!(value instanceof Uint8Array) || value.byteLength < 1) {
    throw new GeneratedArtifactError(
      "Rendered artifact bytes are required.",
      "invalid_contract",
    );
  }
  return new Uint8Array(value);
}

function normalizeMediaType(value: string) {
  const mediaType = requiredText(value, 200, "media type").toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)) {
    throw new GeneratedArtifactError(
      "Generated artifact media type is invalid.",
      "invalid_contract",
    );
  }
  return mediaType;
}

function normalizedFailureCode(value: string) {
  const code = value.trim().toLowerCase();
  if (!/^[a-z0-9_]{1,80}$/.test(code)) {
    throw new GeneratedArtifactError(
      "Artifact failure code is invalid.",
      "invalid_contract",
    );
  }
  return code;
}

function requiredText(value: unknown, max: number, label: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || Array.from(normalized).length > max) {
    throw new GeneratedArtifactError(
      `Generated artifact ${label} is invalid.`,
      "invalid_contract",
    );
  }
  return normalized;
}

function optionalId(value: unknown, label: string) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = requiredText(value, 240, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(normalized)) {
    throw new GeneratedArtifactError(
      `Generated artifact ${label} is invalid.`,
      "invalid_contract",
    );
  }
  return normalized;
}

function nullableId(value: unknown) {
  return optionalId(value, "stored reference id");
}

function positiveInteger(value: unknown, label: string) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new GeneratedArtifactError(
      `Generated artifact ${label} is invalid.`,
      "invalid_contract",
    );
  }
  return normalized;
}

function timestamp(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new GeneratedArtifactError(
      "Generated artifact timestamp is invalid.",
      "invalid_contract",
    );
  }
  return date.toISOString();
}

function nullableTimestamp(value: unknown) {
  return value === null || value === undefined ? null : timestamp(value);
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) {
    throw new GeneratedArtifactError(
      "Generated artifact reference set is invalid.",
      "invalid_contract",
    );
  }
  return value.map(String);
}

function jsonValue(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new GeneratedArtifactError(
      "Stored generated artifact JSON is invalid.",
      "invalid_contract",
    );
  }
}
