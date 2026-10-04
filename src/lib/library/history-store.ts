import { captureActorReadOrder } from "@/lib/capture/actor-scope";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseActorScope } from "@/lib/db/client";
import type { WorkspaceLibraryItem } from "./contracts";
import { withCurrentLibrarySources } from "./current-sources";
import {
  LIBRARY_HISTORY_CONTRACT, LibraryHistoryError, libraryHistoryEntrySchema,
  libraryHistoryItemIdSchema, libraryHistoryListQuerySchema, libraryHistoryListResponseSchema,
  libraryHistoryReadQuerySchema, libraryHistoryReadResponseSchema, libraryHistoryVersionIdSchema,
  type LibraryHistoryEntry, type LibraryHistoryListQuery, type LibraryHistoryReadQuery,
} from "./history-contracts";
import { getWorkspaceLibraryItem, type WorkspaceLibraryItemQuery } from "./store";

const missing = () => new LibraryHistoryError("library_history_unavailable", 404, "This Library source is no longer available.");
const changed = () => new LibraryHistoryError("library_history_changed", 409, "Library history changed. Reload its current version before continuing.");
const noVersion = () => new LibraryHistoryError("library_version_not_found", 404, "This exact Library version is not available in the current scope.");

export async function listWorkspaceLibraryVersions(input: WorkspaceLibraryItemQuery, query: LibraryHistoryListQuery = {}) {
  libraryHistoryItemIdSchema.parse(input.libraryItemId);
  const window = libraryHistoryListQuerySchema.parse(query);
  const actors = captureActorReadOrder(input.actorId, input.requestActorBinding);
  return runWithDatabaseActorScope(input.tenantId, actors, async () => {
    const current = await readableCurrent(input);
    if (window.currentVersionId && window.currentVersionId !== current.currentVersion.versionId) throw changed();
    const result = await readVersionWindow(input, current, { limit: window.limit, before: window.before });
    const versions = result.versions.slice(0, window.limit), hasMore = result.versions.length > window.limit;
    return libraryHistoryListResponseSchema.parse({
      ...envelope(current, result.basis), versions,
      coverage: { limit: window.limit, returned: versions.length, hasMore,
        nextBefore: hasMore ? versions.at(-1)!.versionId : null, total: null },
    });
  });
}

export async function getWorkspaceLibraryVersion(input: WorkspaceLibraryItemQuery & { versionId: string }, query: LibraryHistoryReadQuery = {}) {
  libraryHistoryItemIdSchema.parse(input.libraryItemId);
  libraryHistoryVersionIdSchema.parse(input.versionId);
  const pin = libraryHistoryReadQuerySchema.parse(query);
  const actors = captureActorReadOrder(input.actorId, input.requestActorBinding);
  return runWithDatabaseActorScope(input.tenantId, actors, async () => {
    const current = await readableCurrent(input);
    if (pin.currentVersionId && pin.currentVersionId !== current.currentVersion.versionId) throw changed();
    const result = await readVersionWindow(input, current, { limit: 1, exact: input.versionId });
    const version = result.versions[0];
    if (!version || version.versionId !== input.versionId) throw noVersion();
    return libraryHistoryReadResponseSchema.parse({ ...envelope(current, result.basis), version });
  });
}

async function readableCurrent(input: WorkspaceLibraryItemQuery) {
  const item = await getWorkspaceLibraryItem(input);
  const actors = captureActorReadOrder(input.actorId, input.requestActorBinding);
  if (!item || item.id !== input.libraryItemId || item.tenantId !== input.tenantId || !actors.includes(item.scope.ownerActorId)) throw missing();
  return item;
}

function envelope(item: WorkspaceLibraryItem, basis: "retained_compatible_revisions" | "current_known_version_only") {
  return { schemaVersion: 1, contract: LIBRARY_HISTORY_CONTRACT, libraryItemId: item.id, tenantId: item.tenantId,
    sourceAuthority: item.sourceAuthority, sourceId: item.sourceId, currentVersionId: item.currentVersion.versionId,
    coverageBasis: basis, authorityEffect: "none", commandAttachmentPolicy: "current_library_resolution_required" };
}

function revisionId(item: WorkspaceLibraryItem, versionId: string, cursor: boolean) {
  const prefix = `version:${item.sourceAuthority}:${item.sourceId}:`;
  if (!versionId.startsWith(prefix) || !versionId.slice(prefix.length)) throw cursor ? changed() : noVersion();
  return versionId.slice(prefix.length);
}

async function readVersionWindow(input: WorkspaceLibraryItemQuery, current: WorkspaceLibraryItem,
  query: { limit: number; before?: string; exact?: string }): Promise<{
    basis: "retained_compatible_revisions" | "current_known_version_only"; versions: LibraryHistoryEntry[];
  }> {
  const retained = hasDatabaseUrl() && current.currentVersion.sourceRevisionId !== null &&
    (current.sourceAuthority === "source_item" || current.sourceAuthority === "capture_transcript");
  if (!retained) {
    if (query.before && query.before !== current.currentVersion.versionId) throw changed();
    if (query.exact && query.exact !== current.currentVersion.versionId) throw noVersion();
    return { basis: "current_known_version_only", versions: query.before ? [] : [libraryHistoryEntrySchema.parse({
      versionId: current.currentVersion.versionId, sourceRevisionId: current.currentVersion.sourceRevisionId,
      sourceRevisionSha256: null, contentSha256: current.currentVersion.contentSha256, byteCount: current.currentVersion.byteCount,
      mediaType: current.currentVersion.mediaType, capturedAt: current.currentVersion.createdAt, ordinal: null, current: true,
      citationRefs: current.citationRefs, contentAvailability: "metadata_only", historicalAttachmentAuthority: "none",
    })] };
  }

  const before = query.before ? revisionId(current, query.before, true) : null;
  const exact = query.exact ? revisionId(current, query.exact, false) : null;
  await ensureDatabaseSchema();
  const [canonicalActorId, exactActorId] = captureActorReadOrder(input.actorId, input.requestActorBinding);
  // This second phase rechecks current visibility in the SAME statement that
  // selects historical metadata. A first-phase receipt never revives a revoked
  // grant, deleted source, expired revision or replaced physical owner.
  const rows = await withCurrentLibrarySources(getSql(), {
    tenantId: input.tenantId, canonicalActorId, exactActorId, enabled: current.sourceAuthority === "source_item",
  })`
    WITH history_current AS (
      SELECT item.* FROM library_current_sources item
      WHERE ${current.sourceAuthority === "source_item"}
        AND item.id = ${current.sourceId} AND item.owner_actor_id = ${current.scope.ownerActorId}
      UNION ALL
      SELECT item.* FROM omni_capture_recordings recording
      JOIN omni_knowledge_documents document ON document.tenant_id = recording.tenant_id
        AND document.id = recording.knowledge_document_id AND document.source = recording.source
      JOIN omni_source_items item ON item.tenant_id = document.tenant_id AND item.id = document.source_item_id
        AND item.current_revision_id = document.source_revision_id AND item.owner_actor_id = recording.actor_id
      JOIN omni_source_revisions head_revision ON head_revision.tenant_id = item.tenant_id
        AND head_revision.source_item_id = item.id AND head_revision.id = item.current_revision_id
      LEFT JOIN omni_source_sync_heads head ON head.tenant_id = item.tenant_id AND head.source_item_id = item.id
      WHERE ${current.sourceAuthority === "capture_transcript"}
        AND recording.tenant_id = ${input.tenantId} AND recording.id = ${current.sourceId}
        AND recording.actor_id = ${current.scope.ownerActorId}
        AND item.connection_id = 'first_party.capture' AND item.adapter_id = 'asael.capture'
        AND item.adapter_operation = 'upsert' AND item.visibility = 'user_private'
        AND (item.retention_expires_at IS NULL OR item.retention_expires_at > CURRENT_TIMESTAMP)
        AND (head.source_item_id IS NULL OR (head.operation = 'upsert' AND NOT head.absence_observed
          AND head.source_tombstone_id IS NULL AND head.source_revision_id = item.current_revision_id
          AND head.owner_actor_id = item.owner_actor_id AND head.connection_id = item.connection_id
          AND head.source_kind = item.source_kind AND head.provider_item_key_sha256 = item.provider_item_key_sha256
          AND head.adapter_output_id = head_revision.adapter_output_id AND head.adapter_output_sha256 = head_revision.adapter_output_sha256))
    ), history_compatible AS NOT MATERIALIZED (
      SELECT revision.id, revision.content_sha256, revision.content_byte_length, revision.media_type,
        revision.captured_at, revision.source_revision_sha256
      FROM history_current item JOIN omni_source_revisions revision
        ON revision.tenant_id = item.tenant_id AND revision.source_item_id = item.id
        AND revision.owner_actor_id = item.owner_actor_id AND revision.connection_id = item.connection_id
        AND revision.source_kind = item.source_kind AND revision.provider_item_key_sha256 = item.provider_item_key_sha256
        AND revision.adapter_id = item.adapter_id AND revision.adapter_operation = 'upsert'
        AND revision.visibility = item.visibility AND revision.sensitivity = item.sensitivity
        AND revision.workspace_id IS NOT DISTINCT FROM item.workspace_id
        AND revision.project_id IS NOT DISTINCT FROM item.project_id
        AND revision.mission_id IS NOT DISTINCT FROM item.mission_id
        AND revision.permission_set_sha256 = item.permission_set_sha256
        AND revision.permission_grant_ids = item.permission_grant_ids
        AND revision.purpose_set_sha256 = item.purpose_set_sha256
        AND revision.allowed_purpose_ids = item.allowed_purpose_ids
        AND revision.retention_policy_id = item.retention_policy_id
      WHERE (revision.retention_expires_at IS NULL OR revision.retention_expires_at > CURRENT_TIMESTAMP)
        AND revision.captured_at <= CURRENT_TIMESTAMP
    ), history_before AS (
      SELECT id, captured_at FROM history_compatible WHERE id = ${before ?? ""}
    ), history_page AS (
      SELECT revision.* FROM history_compatible revision
      WHERE (${exact}::text IS NULL OR revision.id = ${exact})
        AND (${before}::text IS NULL OR EXISTS (SELECT 1 FROM history_before anchor
          WHERE (revision.captured_at, revision.id COLLATE "C") < (anchor.captured_at, anchor.id COLLATE "C")))
      ORDER BY revision.captured_at DESC, revision.id COLLATE "C" DESC
      LIMIT ${query.exact ? 1 : query.limit + 1}
    )
    SELECT (SELECT COUNT(*) FROM history_current) AS current_count,
      (SELECT current_revision_id FROM history_current LIMIT 1) AS current_revision_id,
      (SELECT content_sha256 FROM history_compatible WHERE id = (SELECT current_revision_id FROM history_current LIMIT 1)) AS current_content_sha256,
      EXISTS (SELECT 1 FROM history_before) AS cursor_valid,
      (SELECT jsonb_agg(to_jsonb(page) ORDER BY page.captured_at DESC, page.id COLLATE "C" DESC) FROM history_page page) AS versions
  `;
  const row = rows[0];
  if (!row || Number(row.current_count) === 0 || row.current_content_sha256 == null) throw missing();
  if (Number(row.current_count) !== 1) throw new Error("Library source resolved to multiple current identities.");
  if (row.current_revision_id !== current.currentVersion.sourceRevisionId || row.current_content_sha256 !== current.currentVersion.contentSha256) throw changed();
  if (before && row.cursor_valid !== true) throw changed();
  const raw: unknown = row.versions ?? [];
  if (!Array.isArray(raw) || raw.length > (query.exact ? 1 : query.limit + 1)) throw new Error("Library history exceeded its bounded read.");
  const versions = raw.map((value: Record<string, unknown>) => libraryHistoryEntrySchema.parse({
    versionId: `version:${current.sourceAuthority}:${current.sourceId}:${String(value.id)}`,
    sourceRevisionId: value.id, sourceRevisionSha256: value.source_revision_sha256,
    contentSha256: value.content_sha256, byteCount: Number(value.content_byte_length), mediaType: value.media_type,
    capturedAt: new Date(String(value.captured_at)).toISOString(), ordinal: null,
    current: value.id === current.currentVersion.sourceRevisionId,
    citationRefs: [`source-revision:${String(value.id)}`], contentAvailability: "metadata_only", historicalAttachmentAuthority: "none",
  }));
  return { basis: "retained_compatible_revisions", versions };
}
