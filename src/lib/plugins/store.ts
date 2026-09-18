import { createHash } from "node:crypto";

import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  buildPluginInstallation,
  buildPluginPreview,
  parsePluginInstallation,
  parsePluginManifest,
  parsePluginPreview,
  PLUGIN_EVENT_TYPES,
  pluginManifestSha256,
  type PluginInstallation,
  type PluginInstallationState,
  type PluginManifest,
  type PluginPreview,
} from "@/lib/plugins/contracts";
import { parsePersistedExecutionScope, type ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256, idempotencyKeySha256 } from "@/lib/tools/effect-receipt";
import { syncPluginSkillTemplatesWithSql } from "@/lib/skills/store";

type PluginSql = ReturnType<typeof getSql>;
type SqlRow = Record<string, unknown>;

export type PluginReadAuthority = Readonly<{
  tenantId: string;
  actorId: string;
}>;

export type PluginMutationAuthority = PluginReadAuthority & Readonly<{
  executionScope: ExecutionScope;
  idempotencyKey: string;
}>;

export type PluginInstallationRecord = Readonly<{
  installation: PluginInstallation;
  manifest: PluginManifest;
}>;

export class PluginUnavailableError extends Error {
  readonly code = "plugin_storage_unavailable";

  constructor(message = "Plugins require the canonical database authority.") {
    super(message);
    this.name = "PluginUnavailableError";
  }
}

export class PluginConflictError extends Error {
  readonly code = "plugin_conflict";

  constructor(message = "The plugin changed. Refresh and try again.") {
    super(message);
    this.name = "PluginConflictError";
  }
}

export class PluginPreviewExpiredError extends Error {
  readonly code = "plugin_preview_expired";

  constructor(message = "The exact plugin preview expired. Create a new preview and try again.") {
    super(message);
    this.name = "PluginPreviewExpiredError";
  }
}

export class PluginNotFoundError extends Error {
  readonly code = "plugin_not_found";

  constructor(message = "The plugin installation was not found.") {
    super(message);
    this.name = "PluginNotFoundError";
  }
}

export function pluginStorageAvailable() {
  return hasDatabaseUrl();
}

export async function listPluginInstallations(
  authority: PluginReadAuthority,
): Promise<readonly PluginInstallationRecord[]> {
  requireDatabase();
  const exact = validateReadAuthority(authority);
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT installation_snapshot, manifest_snapshot
    FROM omni_plugin_installations
    WHERE tenant_id = ${exact.tenantId}
      AND owner_actor_id = ${exact.actorId}
    ORDER BY updated_at DESC, plugin_id ASC
  `;
  return Object.freeze(rows.map(pluginInstallationRecordFromRow));
}

export async function createPluginInstallPreview(input: {
  authority: PluginMutationAuthority;
  manifest: PluginManifest;
}): Promise<Readonly<{ preview: PluginPreview; manifest: PluginManifest }>> {
  requireDatabase();
  await ensureDatabaseSchema();
  const authority = validateMutationAuthority(input.authority, "plugin.preview");
  const manifest = parsePluginManifest(input.manifest);
  const idempotencySha256 = idempotencyKeySha256({
    tenantId: authority.tenantId,
    idempotencyKey: authority.idempotencyKey,
  });
  const requestSha256 = canonicalJsonSha256({ manifest });
  const previewId = deterministicId("plugin-preview", {
    tenantId: authority.tenantId,
    actorId: authority.actorId,
    idempotencySha256,
  });

  return getSql().transaction(async (sql: PluginSql) => {
    await lockMutation(sql, authority, `preview:${idempotencySha256}`);
    const existingRows = await sql`
      SELECT preview_snapshot, manifest_snapshot, request_sha256
      FROM omni_plugin_install_previews
      WHERE tenant_id = ${authority.tenantId}
        AND owner_actor_id = ${authority.actorId}
        AND idempotency_key_sha256 = ${idempotencySha256}
      LIMIT 1
    `;
    if (existingRows[0]) {
      if (String(existingRows[0].request_sha256) !== requestSha256) {
        throw new PluginConflictError(
          "Idempotency-Key is already bound to a different plugin preview.",
        );
      }
      return pluginPreviewRecordFromRow(existingRows[0]);
    }

    const clockRows = await sql`SELECT clock_timestamp() AS created_at`;
    const preview = buildPluginPreview({
      previewId,
      manifest,
      createdAt: timestamp(clockRows[0]?.created_at),
    });
    await sql`
      INSERT INTO omni_plugin_install_previews (
        id, tenant_id, owner_actor_id, plugin_id, plugin_version,
        manifest_sha256, manifest_snapshot, preview_snapshot,
        preview_sha256, idempotency_key_sha256, request_sha256,
        expires_at, created_at
      ) VALUES (
        ${preview.previewId}, ${authority.tenantId}, ${authority.actorId},
        ${preview.pluginId}, ${preview.pluginVersion}, ${preview.manifestSha256},
        ${manifest}::JSONB, ${preview}::JSONB, ${preview.previewSha256},
        ${idempotencySha256}, ${requestSha256}, ${preview.expiresAt},
        ${preview.createdAt}
      )
    `;
    await appendScopedDomainEvent({
      id: `plugin-previewed:${preview.previewId}`,
      streamId: `plugin:${preview.pluginId}`,
      type: PLUGIN_EVENT_TYPES.previewed,
      executionScope: authority.executionScope,
      payload: {
        schemaVersion: 1,
        pluginId: preview.pluginId,
        pluginVersion: preview.pluginVersion,
        previewId: preview.previewId,
        manifestSha256: preview.manifestSha256,
        previewSha256: preview.previewSha256,
        expiresAt: preview.expiresAt,
      },
    }, { sql });
    return Object.freeze({ preview, manifest });
  }) as Promise<Readonly<{ preview: PluginPreview; manifest: PluginManifest }>>;
}

export async function installPlugin(input: {
  authority: PluginMutationAuthority;
  previewId: string;
  manifestSha256: string;
}): Promise<PluginInstallationRecord> {
  requireDatabase();
  await ensureDatabaseSchema();
  const authority = validateMutationAuthority(input.authority, "plugin.install");
  const previewId = requiredString(input.previewId, "preview ID", 200);
  const manifestSha256 = exactSha256(input.manifestSha256, "manifest");
  const request = { previewId, manifestSha256 };

  return getSql().transaction(async (sql: PluginSql) => {
    const replay = await findMutationReplay(sql, authority, "install", request);
    if (replay) return replay;

    const previewRows = await sql`
      SELECT preview_snapshot, manifest_snapshot, manifest_sha256, expires_at,
             clock_timestamp() AS checked_at
      FROM omni_plugin_install_previews
      WHERE id = ${previewId}
        AND tenant_id = ${authority.tenantId}
        AND owner_actor_id = ${authority.actorId}
      LIMIT 1
    `;
    if (!previewRows[0]) throw new PluginNotFoundError("The exact plugin preview was not found.");
    const previewRecord = pluginPreviewRecordFromRow(previewRows[0]);
    if (
      previewRecord.preview.manifestSha256 !== manifestSha256 ||
      String(previewRows[0].manifest_sha256) !== manifestSha256 ||
      pluginManifestSha256(previewRecord.manifest) !== manifestSha256
    ) {
      throw new PluginConflictError("The plugin manifest does not match the exact preview digest.");
    }
    if (
      new Date(previewRecord.preview.expiresAt).getTime() <=
      new Date(timestamp(previewRows[0].checked_at)).getTime()
    ) {
      throw new PluginPreviewExpiredError();
    }

    await lockMutation(sql, authority, `install:${previewRecord.manifest.pluginId}`);
    const replayAfterLock = await findMutationReplay(sql, authority, "install", request);
    if (replayAfterLock) return replayAfterLock;
    const existingRows = await sql`
      SELECT installation_snapshot, manifest_snapshot, source_preview_id
      FROM omni_plugin_installations
      WHERE tenant_id = ${authority.tenantId}
        AND owner_actor_id = ${authority.actorId}
        AND plugin_id = ${previewRecord.manifest.pluginId}
      FOR UPDATE
    `;
    const existing = existingRows[0] ? pluginInstallationRecordFromRow(existingRows[0]) : undefined;
    if (existing && existing.installation.state !== "uninstalled") {
      throw new PluginConflictError("This plugin is already installed.");
    }
    if (
      existing &&
      String(existingRows[0].source_preview_id) === previewRecord.preview.previewId
    ) {
      throw new PluginConflictError(
        "Reinstalling a plugin requires a fresh exact preview.",
      );
    }
    const clockRows = await sql`SELECT clock_timestamp() AS occurred_at`;
    const occurredAt = timestamp(clockRows[0]?.occurred_at);
    const installation = buildPluginInstallation({
      installationId: existing?.installation.installationId || pluginInstallationIdForActor({
        tenantId: authority.tenantId,
        actorId: authority.actorId,
        pluginId: previewRecord.manifest.pluginId,
      }),
      manifest: previewRecord.manifest,
      state: "enabled",
      revision: existing ? existing.installation.revision + 1 : 1,
      installedAt: existing?.installation.installedAt || occurredAt,
      updatedAt: occurredAt,
    });
    if (existing) {
      await sql`
        UPDATE omni_plugin_installations
        SET plugin_version = ${installation.pluginVersion},
            manifest_sha256 = ${installation.manifestSha256},
            manifest_snapshot = ${previewRecord.manifest}::JSONB,
            installation_snapshot = ${installation}::JSONB,
            installation_sha256 = ${installation.installationSha256},
            state = ${installation.state},
            lifecycle_revision = ${installation.revision},
            source_preview_id = ${previewRecord.preview.previewId},
            source_preview_sha256 = ${previewRecord.preview.previewSha256},
            updated_by_actor_id = ${authority.actorId},
            updated_at = ${installation.updatedAt}
        WHERE tenant_id = ${authority.tenantId}
          AND owner_actor_id = ${authority.actorId}
          AND id = ${installation.installationId}
          AND lifecycle_revision = ${existing.installation.revision}
      `;
    } else {
      await sql`
        INSERT INTO omni_plugin_installations (
          id, tenant_id, owner_actor_id, plugin_id, plugin_version,
          manifest_sha256, manifest_snapshot, installation_snapshot,
          installation_sha256, state, lifecycle_revision, source_preview_id,
          source_preview_sha256, installed_by_actor_id, updated_by_actor_id,
          installed_at, updated_at
        ) VALUES (
          ${installation.installationId}, ${authority.tenantId}, ${authority.actorId},
          ${installation.pluginId}, ${installation.pluginVersion},
          ${installation.manifestSha256}, ${previewRecord.manifest}::JSONB,
          ${installation}::JSONB, ${installation.installationSha256},
          ${installation.state}, ${installation.revision},
          ${previewRecord.preview.previewId}, ${previewRecord.preview.previewSha256},
          ${authority.actorId}, ${authority.actorId}, ${installation.installedAt},
          ${installation.updatedAt}
        )
      `;
    }
    await syncPluginSkillTemplatesWithSql({
      tenantId: authority.tenantId,
      actorId: authority.actorId,
      installationId: installation.installationId,
      manifest: previewRecord.manifest,
      installationState: installation.state,
      occurredAt: installation.updatedAt,
      sql,
    });
    const record = Object.freeze({ installation, manifest: previewRecord.manifest });
    await recordMutation(sql, authority, "install", request, record);
    await appendLifecycleEvent(sql, authority, PLUGIN_EVENT_TYPES.installed, record);
    return record;
  }) as Promise<PluginInstallationRecord>;
}

export async function transitionPluginInstallation(input: {
  authority: PluginMutationAuthority;
  installationId: string;
  action: "enable" | "disable" | "uninstall";
  expectedRevision: number;
}): Promise<PluginInstallationRecord> {
  requireDatabase();
  await ensureDatabaseSchema();
  const authority = validateMutationAuthority(input.authority, `plugin.${input.action}`);
  const installationId = requiredString(input.installationId, "installation ID", 200);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new PluginConflictError("Plugin expected revision is invalid.");
  }
  const request = {
    installationId,
    action: input.action,
    expectedRevision: input.expectedRevision,
  };
  return getSql().transaction(async (sql: PluginSql) => {
    const replay = await findMutationReplay(sql, authority, input.action, request);
    if (replay) return replay;
    await lockMutation(sql, authority, `lifecycle:${installationId}`);
    const replayAfterLock = await findMutationReplay(sql, authority, input.action, request);
    if (replayAfterLock) return replayAfterLock;
    const rows = await sql`
      SELECT installation_snapshot, manifest_snapshot
      FROM omni_plugin_installations
      WHERE id = ${installationId}
        AND tenant_id = ${authority.tenantId}
        AND owner_actor_id = ${authority.actorId}
      FOR UPDATE
    `;
    if (!rows[0]) throw new PluginNotFoundError();
    const current = pluginInstallationRecordFromRow(rows[0]);
    if (current.installation.revision !== input.expectedRevision) {
      throw new PluginConflictError("The plugin revision changed. Refresh and try again.");
    }
    const state = transitionState(current.installation.state, input.action);
    const clockRows = await sql`SELECT clock_timestamp() AS occurred_at`;
    const installation = buildPluginInstallation({
      installationId: current.installation.installationId,
      manifest: current.manifest,
      state,
      revision: current.installation.revision + 1,
      installedAt: current.installation.installedAt,
      updatedAt: timestamp(clockRows[0]?.occurred_at),
    });
    const updated = await sql`
      UPDATE omni_plugin_installations
      SET installation_snapshot = ${installation}::JSONB,
          installation_sha256 = ${installation.installationSha256},
          state = ${installation.state},
          lifecycle_revision = ${installation.revision},
          updated_by_actor_id = ${authority.actorId},
          updated_at = ${installation.updatedAt}
      WHERE tenant_id = ${authority.tenantId}
        AND owner_actor_id = ${authority.actorId}
        AND id = ${installation.installationId}
        AND lifecycle_revision = ${current.installation.revision}
      RETURNING id
    `;
    if (!updated[0]) throw new PluginConflictError();
    await syncPluginSkillTemplatesWithSql({
      tenantId: authority.tenantId,
      actorId: authority.actorId,
      installationId: installation.installationId,
      manifest: current.manifest,
      installationState: installation.state,
      occurredAt: installation.updatedAt,
      sql,
    });
    const record = Object.freeze({ installation, manifest: current.manifest });
    await recordMutation(sql, authority, input.action, request, record);
    const eventType = input.action === "enable"
      ? PLUGIN_EVENT_TYPES.enabled
      : input.action === "disable"
        ? PLUGIN_EVENT_TYPES.disabled
        : PLUGIN_EVENT_TYPES.uninstalled;
    await appendLifecycleEvent(sql, authority, eventType, record);
    return record;
  }) as Promise<PluginInstallationRecord>;
}

async function findMutationReplay(
  sql: PluginSql,
  authority: PluginMutationAuthority,
  operation: string,
  request: unknown,
) {
  const idempotencySha256 = idempotencyKeySha256({
    tenantId: authority.tenantId,
    idempotencyKey: authority.idempotencyKey,
  });
  const rows = await sql`
    SELECT request_sha256, installation_snapshot, manifest_snapshot
    FROM omni_plugin_mutation_receipts
    WHERE tenant_id = ${authority.tenantId}
      AND owner_actor_id = ${authority.actorId}
      AND operation = ${operation}
      AND idempotency_key_sha256 = ${idempotencySha256}
    LIMIT 1
  `;
  if (!rows[0]) return undefined;
  if (String(rows[0].request_sha256) !== canonicalJsonSha256(request)) {
    throw new PluginConflictError(
      "Idempotency-Key is already bound to a different plugin mutation.",
    );
  }
  return pluginInstallationRecordFromRow(rows[0]);
}

async function recordMutation(
  sql: PluginSql,
  authority: PluginMutationAuthority,
  operation: "install" | "enable" | "disable" | "uninstall",
  request: unknown,
  record: PluginInstallationRecord,
) {
  const idempotencySha256 = idempotencyKeySha256({
    tenantId: authority.tenantId,
    idempotencyKey: authority.idempotencyKey,
  });
  const requestSha256 = canonicalJsonSha256(request);
  const receiptId = deterministicId("plugin-mutation", {
    tenantId: authority.tenantId,
    actorId: authority.actorId,
    operation,
    idempotencySha256,
  });
  await sql`
    INSERT INTO omni_plugin_mutation_receipts (
      id, tenant_id, owner_actor_id, installation_id, operation,
      idempotency_key_sha256, request_sha256, result_sha256,
      installation_snapshot, manifest_snapshot, occurred_at
    ) VALUES (
      ${receiptId}, ${authority.tenantId}, ${authority.actorId},
      ${record.installation.installationId}, ${operation}, ${idempotencySha256},
      ${requestSha256}, ${record.installation.installationSha256},
      ${record.installation}::JSONB, ${record.manifest}::JSONB,
      ${record.installation.updatedAt}
    )
  `;
}

async function appendLifecycleEvent(
  sql: PluginSql,
  authority: PluginMutationAuthority,
  type: string,
  record: PluginInstallationRecord,
) {
  await appendScopedDomainEvent({
    id: `plugin-lifecycle:${type}:${record.installation.installationId}:v${record.installation.revision}`,
    streamId: `plugin:${record.installation.pluginId}`,
    type,
    executionScope: authority.executionScope,
    payload: {
      schemaVersion: 1,
      installationId: record.installation.installationId,
      pluginId: record.installation.pluginId,
      pluginVersion: record.installation.pluginVersion,
      manifestSha256: record.installation.manifestSha256,
      state: record.installation.state,
      revision: record.installation.revision,
      installationSha256: record.installation.installationSha256,
    },
  }, { sql });
}

function transitionState(
  current: PluginInstallationState,
  action: "enable" | "disable" | "uninstall",
): PluginInstallationState {
  if (action === "enable" && current === "disabled") return "enabled";
  if (action === "disable" && current === "enabled") return "disabled";
  if (action === "uninstall" && current !== "uninstalled") return "uninstalled";
  throw new PluginConflictError(`Cannot ${action} a plugin while it is ${current}.`);
}

function pluginInstallationRecordFromRow(row: SqlRow): PluginInstallationRecord {
  const installation = parsePluginInstallation(jsonValue(row.installation_snapshot));
  const manifestValue = jsonValue(row.manifest_snapshot);
  const manifestResult = (() => {
    try {
      return parsePluginManifest(manifestValue);
    } catch {
      return undefined;
    }
  })();
  if (!installation || !manifestResult || installation.manifestSha256 !== pluginManifestSha256(manifestResult)) {
    throw new PluginConflictError("Stored plugin installation is invalid.");
  }
  return Object.freeze({ installation, manifest: manifestResult });
}

function pluginPreviewRecordFromRow(row: SqlRow) {
  const preview = parsePluginPreview(jsonValue(row.preview_snapshot));
  const manifestValue = jsonValue(row.manifest_snapshot);
  const manifest = (() => {
    try {
      return parsePluginManifest(manifestValue);
    } catch {
      return undefined;
    }
  })();
  if (!preview || !manifest || preview.manifestSha256 !== pluginManifestSha256(manifest)) {
    throw new PluginConflictError("Stored plugin preview is invalid.");
  }
  return Object.freeze({ preview, manifest });
}

function validateReadAuthority(authority: PluginReadAuthority) {
  const tenantId = requiredExactString(authority.tenantId, "tenant", 120);
  const actorId = requiredExactString(authority.actorId, "actor", 200);
  return Object.freeze({ tenantId, actorId });
}

function validateMutationAuthority(authority: PluginMutationAuthority, purpose: string) {
  const exact = validateReadAuthority(authority);
  const executionScope = parsePersistedExecutionScope(authority.executionScope);
  if (
    !executionScope ||
    executionScope.tenantId !== exact.tenantId ||
    executionScope.initiatingActorId !== exact.actorId ||
    executionScope.workspaceId !== null ||
    executionScope.projectId !== null ||
    executionScope.missionId !== null ||
    executionScope.purpose !== purpose
  ) {
    throw new PluginConflictError("Plugin mutation scope is invalid.");
  }
  const idempotencyKey = requiredString(authority.idempotencyKey, "Idempotency-Key", 512);
  return Object.freeze({ ...exact, executionScope, idempotencyKey });
}

async function lockMutation(sql: PluginSql, authority: PluginReadAuthority, identity: string) {
  await sql`
    SELECT pg_advisory_xact_lock(hashtextextended(
      ${`${authority.tenantId}:${authority.actorId}:${identity}`}, 0
    ))
  `;
}

function deterministicId(prefix: string, value: unknown) {
  const digest = createHash("sha256")
    .update(`${prefix}:${canonicalJsonSha256(value)}`, "utf8")
    .digest("hex");
  return `${prefix}:${digest.slice(0, 40)}`;
}

export function pluginInstallationIdForActor(input: PluginReadAuthority & { pluginId: string }) {
  const authority = validateReadAuthority(input);
  const pluginId = requiredExactString(input.pluginId, "ID", 120);
  return deterministicId("plugin-installation", {
    tenantId: authority.tenantId,
    actorId: authority.actorId,
    pluginId,
  });
}

function exactSha256(value: string, label: string) {
  const normalized = value.trim();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new PluginConflictError(`Plugin ${label} digest is invalid.`);
  }
  return normalized;
}

function requiredString(value: string, label: string, max: number) {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new PluginConflictError(`Plugin ${label} is invalid.`);
  }
  return normalized;
}

function requiredExactString(value: string, label: string, max: number) {
  if (value !== value.trim() || !value || value.length > max) {
    throw new PluginConflictError(`Plugin ${label} is invalid.`);
  }
  return value;
}

function timestamp(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new PluginConflictError("Plugin timestamp is invalid.");
  return date.toISOString();
}

function jsonValue(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function requireDatabase() {
  if (!hasDatabaseUrl()) throw new PluginUnavailableError();
}
