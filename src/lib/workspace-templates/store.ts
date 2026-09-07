import { createHash } from "node:crypto";

import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { parsePersistedExecutionScope, type ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256, idempotencyKeySha256 } from "@/lib/tools/effect-receipt";
import {
  buildWorkspaceTemplateVersion,
  parseWorkspaceTemplateVersion,
  WORKSPACE_TEMPLATE_EVENT_TYPES,
  workspaceTemplateDefinitionInputSchema,
  workspaceTemplateInstantiationSchema,
  type WorkspaceTemplateDefinitionInput,
  type WorkspaceTemplateInstantiation,
  type WorkspaceTemplateVersion,
} from "@/lib/workspace-templates/contracts";

type TemplateSql = ReturnType<typeof getSql>;
type SqlRow = Record<string, unknown>;

export type WorkspaceTemplateAuthority = Readonly<{
  tenantId: string;
  workspaceId: string;
  canonicalActorId: string;
  executionScope: ExecutionScope;
  idempotencyKey: string;
}>;

export type WorkspaceTemplateReadAuthority = Readonly<{
  tenantId: string;
  workspaceId: string;
  canonicalActorId: string;
}>;

export type WorkspaceTemplateView = WorkspaceTemplateVersion & Readonly<{
  active: boolean;
  activeVersion: number;
}>;

export class WorkspaceTemplateConflictError extends Error {
  readonly code = "workspace_template_conflict";

  constructor(message = "The workspace template changed. Refresh and try again.") {
    super(message);
    this.name = "WorkspaceTemplateConflictError";
  }
}

export class WorkspaceTemplateUnavailableError extends Error {
  readonly code = "workspace_template_unavailable";

  constructor(message = "Workspace templates require the canonical database authority.") {
    super(message);
    this.name = "WorkspaceTemplateUnavailableError";
  }
}

export async function listWorkspaceTemplates(
  authority: WorkspaceTemplateReadAuthority,
  options: { activeOnly?: boolean; limit?: number } = {},
): Promise<readonly WorkspaceTemplateView[]> {
  requireDatabase();
  await ensureDatabaseSchema();
  validateReadAuthority(authority);
  const limit = Math.min(Math.max(Math.trunc(options.limit || 100), 1), 200);
  const rows = options.activeOnly
    ? await getSql()`
        SELECT version.template_snapshot, channel.active_template_version
        FROM omni_workspace_template_channels channel
        JOIN omni_workspace_template_versions version
          ON version.tenant_id = channel.tenant_id
         AND version.workspace_id = channel.workspace_id
         AND version.template_id = channel.template_id
         AND version.template_version = channel.active_template_version
        WHERE channel.tenant_id = ${authority.tenantId}
          AND channel.workspace_id = ${authority.workspaceId}
        ORDER BY version.name, version.template_id
        LIMIT ${limit}
      `
    : await getSql()`
        SELECT version.template_snapshot, channel.active_template_version
        FROM omni_workspace_template_versions version
        JOIN omni_workspace_template_channels channel
          ON channel.tenant_id = version.tenant_id
         AND channel.workspace_id = version.workspace_id
         AND channel.template_id = version.template_id
        WHERE version.tenant_id = ${authority.tenantId}
          AND version.workspace_id = ${authority.workspaceId}
        ORDER BY version.name, version.template_id, version.template_version DESC
        LIMIT ${limit}
      `;
  return Object.freeze(rows.map(templateViewFromRow));
}

export async function getWorkspaceTemplateVersion(input: {
  authority: WorkspaceTemplateReadAuthority;
  templateId: string;
  templateVersionId?: string;
}): Promise<WorkspaceTemplateView | undefined> {
  requireDatabase();
  await ensureDatabaseSchema();
  validateReadAuthority(input.authority);
  const rows = input.templateVersionId
    ? await getSql()`
        SELECT version.template_snapshot, channel.active_template_version
        FROM omni_workspace_template_versions version
        JOIN omni_workspace_template_channels channel
          ON channel.tenant_id = version.tenant_id
         AND channel.workspace_id = version.workspace_id
         AND channel.template_id = version.template_id
        WHERE version.tenant_id = ${input.authority.tenantId}
          AND version.workspace_id = ${input.authority.workspaceId}
          AND version.template_id = ${input.templateId}
          AND version.template_version_id = ${input.templateVersionId}
        LIMIT 1
      `
    : await getSql()`
        SELECT version.template_snapshot, channel.active_template_version
        FROM omni_workspace_template_channels channel
        JOIN omni_workspace_template_versions version
          ON version.tenant_id = channel.tenant_id
         AND version.workspace_id = channel.workspace_id
         AND version.template_id = channel.template_id
         AND version.template_version = channel.active_template_version
        WHERE channel.tenant_id = ${input.authority.tenantId}
          AND channel.workspace_id = ${input.authority.workspaceId}
          AND channel.template_id = ${input.templateId}
        LIMIT 1
      `;
  return rows[0] ? templateViewFromRow(rows[0]) : undefined;
}

export async function publishWorkspaceTemplate(input: {
  authority: WorkspaceTemplateAuthority;
  definition: WorkspaceTemplateDefinitionInput;
}): Promise<WorkspaceTemplateView> {
  requireDatabase();
  await ensureDatabaseSchema();
  const authority = validateMutationAuthority(input.authority, "workspace.template.publish");
  const definition = workspaceTemplateDefinitionInputSchema.parse(input.definition);
  const idempotencySha256 = idempotencyKeySha256({
    tenantId: authority.tenantId,
    idempotencyKey: authority.idempotencyKey,
  });
  const requestSha256 = canonicalJsonSha256({
    workspaceId: authority.workspaceId,
    canonicalActorId: authority.canonicalActorId,
    definition,
  });
  const templateId = definition.templateId || deterministicId(
    "workspace-template",
    canonicalJsonSha256({
      tenantId: authority.tenantId,
      workspaceId: authority.workspaceId,
      canonicalActorId: authority.canonicalActorId,
      idempotencySha256,
    }),
  );

  return getSql().transaction(async (sql: TemplateSql) => {
    const replayRows = await sql`
      SELECT version.template_snapshot, channel.active_template_version,
             version.publish_request_sha256
      FROM omni_workspace_template_versions version
      JOIN omni_workspace_template_channels channel
        ON channel.tenant_id = version.tenant_id
       AND channel.workspace_id = version.workspace_id
       AND channel.template_id = version.template_id
      WHERE version.tenant_id = ${authority.tenantId}
        AND version.workspace_id = ${authority.workspaceId}
        AND version.owner_actor_id = ${authority.canonicalActorId}
        AND version.publish_idempotency_sha256 = ${idempotencySha256}
      LIMIT 1
    `;
    if (replayRows[0]) {
      if (String(replayRows[0].publish_request_sha256) !== requestSha256) {
        throw new WorkspaceTemplateConflictError(
          "Idempotency-Key is already bound to a different template publication.",
        );
      }
      return templateViewFromRow(replayRows[0]);
    }

    const channelRows = await sql`
      SELECT * FROM omni_workspace_template_channels
      WHERE tenant_id = ${authority.tenantId}
        AND workspace_id = ${authority.workspaceId}
        AND template_id = ${templateId}
      FOR UPDATE
    `;
    const channel = channelRows[0];
    if (definition.templateId && !channel) {
      throw new WorkspaceTemplateConflictError("The template to revise was not found.");
    }
    if (channel && String(channel.owner_actor_id) !== authority.canonicalActorId) {
      throw new WorkspaceTemplateConflictError("Only the template owner can publish its next version.");
    }
    const version = channel ? positiveInteger(channel.active_template_version) + 1 : 1;
    const clockRows = await sql`SELECT clock_timestamp() AS published_at`;
    const publishedAt = timestamp(clockRows[0]?.published_at);
    const template = buildWorkspaceTemplateVersion({
      tenantId: authority.tenantId,
      workspaceId: authority.workspaceId,
      templateId,
      version,
      ownerActorId: authority.canonicalActorId,
      definition,
      publishedAt,
    });
    await sql`
      INSERT INTO omni_workspace_template_versions (
        tenant_id, workspace_id, template_id, template_version,
        template_version_id, owner_actor_id, name, description,
        template_sha256, template_snapshot, publish_idempotency_sha256,
        publish_request_sha256, published_by_actor_id, published_at
      ) VALUES (
        ${template.tenantId}, ${template.workspaceId}, ${template.templateId},
        ${template.version}, ${template.templateVersionId},
        ${template.ownerActorId}, ${template.name}, ${template.description},
        ${template.templateSha256}, ${template}::JSONB,
        ${idempotencySha256}, ${requestSha256},
        ${template.publishedByActorId}, ${template.publishedAt}
      )
    `;
    if (channel) {
      await sql`
        UPDATE omni_workspace_template_channels
        SET active_template_version = ${template.version},
            active_template_version_id = ${template.templateVersionId},
            lifecycle_revision = lifecycle_revision + 1,
            updated_by_actor_id = ${authority.canonicalActorId},
            updated_at = GREATEST(
              ${template.publishedAt}::TIMESTAMPTZ,
              updated_at + INTERVAL '1 microsecond'
            )
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND template_id = ${template.templateId}
          AND active_template_version = ${template.version - 1}
      `;
    } else {
      await sql`
        INSERT INTO omni_workspace_template_channels (
          tenant_id, workspace_id, template_id, owner_actor_id,
          active_template_version, active_template_version_id,
          lifecycle_revision, updated_by_actor_id, created_at, updated_at
        ) VALUES (
          ${template.tenantId}, ${template.workspaceId}, ${template.templateId},
          ${template.ownerActorId}, ${template.version},
          ${template.templateVersionId}, 1, ${authority.canonicalActorId},
          ${template.publishedAt}, ${template.publishedAt}
        )
      `;
    }
    await appendScopedDomainEvent({
      id: `workspace-template-published:${template.templateSha256}`,
      streamId: template.templateId,
      type: WORKSPACE_TEMPLATE_EVENT_TYPES.published,
      executionScope: authority.executionScope,
      payload: {
        schemaVersion: 1,
        workspaceId: template.workspaceId,
        templateId: template.templateId,
        templateVersionId: template.templateVersionId,
        version: template.version,
        templateSha256: template.templateSha256,
        previousTemplateVersionId: template.previousTemplateVersionId,
      },
    }, { sql });
    return Object.freeze({ ...template, active: true, activeVersion: template.version });
  }) as Promise<WorkspaceTemplateView>;
}

export async function findWorkspaceTemplateInstantiation(input: {
  authority: WorkspaceTemplateReadAuthority;
  idempotencyKey: string;
}): Promise<WorkspaceTemplateInstantiation | undefined> {
  requireDatabase();
  await ensureDatabaseSchema();
  validateReadAuthority(input.authority);
  const idempotencySha256 = idempotencyKeySha256({
    tenantId: input.authority.tenantId,
    idempotencyKey: input.idempotencyKey,
  });
  const rows = await getSql()`
    SELECT * FROM omni_workspace_template_instantiations
    WHERE tenant_id = ${input.authority.tenantId}
      AND workspace_id = ${input.authority.workspaceId}
      AND instantiated_by_actor_id = ${input.authority.canonicalActorId}
      AND instantiate_idempotency_sha256 = ${idempotencySha256}
    LIMIT 1
  `;
  return rows[0] ? instantiationFromRow(rows[0]) : undefined;
}

export async function recordWorkspaceTemplateInstantiation(input: {
  authority: WorkspaceTemplateAuthority;
  template: WorkspaceTemplateVersion;
  projectSnapshot: Readonly<Record<string, unknown>>;
}): Promise<WorkspaceTemplateInstantiation> {
  requireDatabase();
  await ensureDatabaseSchema();
  const authority = validateMutationAuthority(
    input.authority,
    "workspace.template.instantiate",
  );
  if (
    input.template.tenantId !== authority.tenantId ||
    input.template.workspaceId !== authority.workspaceId
  ) {
    throw new WorkspaceTemplateConflictError("Template scope does not match the requested workspace.");
  }
  const projectId = String(input.projectSnapshot.projectId || "").trim();
  if (!projectId) throw new WorkspaceTemplateConflictError("Project snapshot is incomplete.");
  const idempotencySha256 = idempotencyKeySha256({
    tenantId: authority.tenantId,
    idempotencyKey: authority.idempotencyKey,
  });
  const requestSha256 = canonicalJsonSha256({
    workspaceId: authority.workspaceId,
    canonicalActorId: authority.canonicalActorId,
    templateVersionId: input.template.templateVersionId,
    templateSha256: input.template.templateSha256,
    projectSnapshot: input.projectSnapshot,
  });
  const projectSnapshotSha256 = canonicalJsonSha256(input.projectSnapshot);
  const instantiationId = deterministicId(
    "workspace-template-instantiation",
    canonicalJsonSha256({
      tenantId: authority.tenantId,
      workspaceId: authority.workspaceId,
      canonicalActorId: authority.canonicalActorId,
      idempotencySha256,
    }),
  );

  return getSql().transaction(async (sql: TemplateSql) => {
    const replayRows = await sql`
      SELECT * FROM omni_workspace_template_instantiations
      WHERE tenant_id = ${authority.tenantId}
        AND workspace_id = ${authority.workspaceId}
        AND instantiated_by_actor_id = ${authority.canonicalActorId}
        AND instantiate_idempotency_sha256 = ${idempotencySha256}
      LIMIT 1
    `;
    if (replayRows[0]) {
      if (String(replayRows[0].instantiate_request_sha256) !== requestSha256) {
        throw new WorkspaceTemplateConflictError(
          "Idempotency-Key is already bound to a different template instantiation.",
        );
      }
      return instantiationFromRow(replayRows[0]);
    }
    const clockRows = await sql`SELECT clock_timestamp() AS instantiated_at`;
    const instantiatedAt = timestamp(clockRows[0]?.instantiated_at);
    const record = workspaceTemplateInstantiationSchema.parse({
      schemaVersion: 1,
      tenantId: authority.tenantId,
      workspaceId: authority.workspaceId,
      instantiationId,
      templateId: input.template.templateId,
      templateVersionId: input.template.templateVersionId,
      templateVersion: input.template.version,
      templateSha256: input.template.templateSha256,
      projectId,
      projectSnapshotSha256,
      instantiatedByActorId: authority.canonicalActorId,
      instantiatedAt,
    });
    await sql`
      INSERT INTO omni_workspace_template_instantiations (
        tenant_id, workspace_id, instantiation_id, template_id,
        template_version, template_version_id, template_sha256, project_id,
        project_snapshot_sha256, template_snapshot, project_snapshot,
        instantiate_idempotency_sha256, instantiate_request_sha256,
        owner_actor_id, instantiated_by_actor_id, instantiated_at
      ) VALUES (
        ${record.tenantId}, ${record.workspaceId}, ${record.instantiationId},
        ${record.templateId}, ${record.templateVersion},
        ${record.templateVersionId}, ${record.templateSha256},
        ${record.projectId}, ${record.projectSnapshotSha256},
        ${input.template}::JSONB, ${input.projectSnapshot}::JSONB,
        ${idempotencySha256}, ${requestSha256},
        ${record.instantiatedByActorId}, ${record.instantiatedByActorId},
        ${record.instantiatedAt}
      )
    `;
    await appendScopedDomainEvent({
      id: `workspace-template-instantiated:${record.instantiationId}`,
      streamId: record.templateId,
      type: WORKSPACE_TEMPLATE_EVENT_TYPES.instantiated,
      executionScope: authority.executionScope,
      payload: {
        schemaVersion: 1,
        workspaceId: record.workspaceId,
        instantiationId: record.instantiationId,
        templateId: record.templateId,
        templateVersionId: record.templateVersionId,
        templateSha256: record.templateSha256,
        projectId: record.projectId,
        projectSnapshotSha256: record.projectSnapshotSha256,
      },
    }, { sql });
    return Object.freeze(record);
  }) as Promise<WorkspaceTemplateInstantiation>;
}

function templateViewFromRow(row: SqlRow): WorkspaceTemplateView {
  const template = parseWorkspaceTemplateVersion(jsonValue(row.template_snapshot));
  if (!template) throw new WorkspaceTemplateConflictError("Stored template version is invalid.");
  const activeVersion = positiveInteger(row.active_template_version);
  return Object.freeze({
    ...template,
    active: template.version === activeVersion,
    activeVersion,
  });
}

function instantiationFromRow(row: SqlRow): WorkspaceTemplateInstantiation {
  return Object.freeze(workspaceTemplateInstantiationSchema.parse({
    schemaVersion: 1,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    instantiationId: row.instantiation_id,
    templateId: row.template_id,
    templateVersionId: row.template_version_id,
    templateVersion: Number(row.template_version),
    templateSha256: row.template_sha256,
    projectId: row.project_id,
    projectSnapshotSha256: row.project_snapshot_sha256,
    instantiatedByActorId: row.instantiated_by_actor_id,
    instantiatedAt: timestamp(row.instantiated_at),
  }));
}

function validateReadAuthority(authority: WorkspaceTemplateReadAuthority) {
  if (
    !authority.tenantId.trim() || !authority.workspaceId.startsWith("workspace:") ||
    !/^actor:[0-9a-f-]{36}$/.test(authority.canonicalActorId)
  ) {
    throw new WorkspaceTemplateConflictError("Workspace template authority is invalid.");
  }
  return authority;
}

function validateMutationAuthority(
  authority: WorkspaceTemplateAuthority,
  purpose: string,
) {
  validateReadAuthority(authority);
  const executionScope = parsePersistedExecutionScope(authority.executionScope);
  if (
    !executionScope || executionScope.tenantId !== authority.tenantId ||
    executionScope.initiatingActorId !== authority.canonicalActorId ||
    executionScope.workspaceId !== authority.workspaceId ||
    executionScope.projectId !== null || executionScope.missionId !== null ||
    executionScope.purpose !== purpose
  ) {
    throw new WorkspaceTemplateConflictError("Workspace template mutation scope is invalid.");
  }
  const idempotencyKey = authority.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 512) {
    throw new WorkspaceTemplateConflictError("Workspace template Idempotency-Key is invalid.");
  }
  return { ...authority, executionScope, idempotencyKey };
}

function deterministicId(prefix: string, digest: string) {
  const hex = createHash("sha256").update(`${prefix}:${digest}`, "utf8").digest("hex");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return `${prefix}:${uuid}`;
}

function jsonValue(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function positiveInteger(value: unknown) {
  const integer = Number(value);
  if (!Number.isSafeInteger(integer) || integer < 1) {
    throw new WorkspaceTemplateConflictError("Stored template revision is invalid.");
  }
  return integer;
}

function timestamp(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new WorkspaceTemplateConflictError("Stored template timestamp is invalid.");
  }
  return date.toISOString();
}

function requireDatabase() {
  if (!hasDatabaseUrl()) throw new WorkspaceTemplateUnavailableError();
}
