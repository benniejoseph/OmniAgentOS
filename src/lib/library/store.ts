import { createHash } from "node:crypto";
import { captureActorReadOrder } from "@/lib/capture/actor-scope";
import { listCaptureAssets } from "@/lib/capture/assets";
import { listCaptureRecordingsForRequest } from "@/lib/capture/recordings";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import {
  parseWorkspaceLibraryItem,
  type WorkspaceLibraryItem,
  type WorkspaceLibraryKind,
  type WorkspaceLibraryScope,
} from "@/lib/library/contracts";
import { listMissionArtifacts, listMissions } from "@/lib/missions/store";
import { listProjectCollections, listProjects } from "@/lib/projects/store";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { redactSensitive } from "@/lib/security/context";

type SourceVisibility = WorkspaceLibraryScope["visibility"] | "agent_private";

export type WorkspaceLibraryQuery = Readonly<{
  tenantId: string;
  actorId: string;
  requestActorBinding?: CanonicalRequestActorBindingV1;
  query?: string;
  kinds?: readonly WorkspaceLibraryKind[];
  projectId?: string;
  limit?: number;
  offset?: number;
}>; 

export type WorkspaceLibraryResult = Readonly<{
  items: readonly WorkspaceLibraryItem[];
  total: number;
  totalIsLowerBound: boolean;
  nextOffset: number | null;
  countsByKind: Readonly<Partial<Record<WorkspaceLibraryKind, number>>>;
}>; 

type SqlRow = Record<string, unknown>;

export async function listWorkspaceLibrary(
  input: WorkspaceLibraryQuery,
): Promise<WorkspaceLibraryResult> {
  const query = normalizeQuery(input);
  const batch = hasDatabaseUrl()
    ? await listDatabaseLibraryCandidates(query)
    : await listLocalLibraryCandidates(query);
  const kinds = query.kinds.length ? new Set(query.kinds) : undefined;
  const searchTerms = tokenize(query.query);
  const filtered = batch.items
    .filter((item) => !kinds || kinds.has(item.kind))
    .filter((item) => !query.projectId || item.links.some(
      (link) => link.kind === "project" && link.id === query.projectId,
    ))
    .filter((item) => matchesSearch(item, searchTerms))
    .sort(compareLibraryItems);
  const countsByKind: Partial<Record<WorkspaceLibraryKind, number>> = {};
  for (const item of filtered) countsByKind[item.kind] = (countsByKind[item.kind] || 0) + 1;
  const page = filtered.slice(query.offset, query.offset + query.limit);
  const hasMore = filtered.length > query.offset + query.limit || batch.hasMore;
  const nextOffset = hasMore ? query.offset + page.length : null;
  return Object.freeze({
    items: Object.freeze(page),
    total: hasMore ? query.offset + page.length + 1 : query.offset + page.length,
    totalIsLowerBound: hasMore,
    nextOffset: page.length ? nextOffset : null,
    countsByKind: Object.freeze(countsByKind),
  });
}

async function listDatabaseLibraryCandidates(
  input: NormalizedWorkspaceLibraryQuery,
) {
  await ensureDatabaseSchema();
  const [canonicalActorId, exactActorId] = captureActorReadOrder(
    input.actorId,
    input.requestActorBinding,
    input.actorId,
  );
  const candidateLimit = Math.min(
    Math.max(input.offset + input.limit + 1, 100),
    10_101,
  );
  const searchPattern = `%${input.query}%`;
  const scopedSql = getSql();

  // Keep the complete read model on one request-scoped database reservation.
  // Hosted runtimes intentionally use a one-connection pool, so five separate
  // reservations would add avoidable pooler and scope round trips.
  return scopedSql.transaction(async (sql: typeof scopedSql) => {
    const resultRows = await sql`
      WITH capture_rows AS MATERIALIZED (
        SELECT asset.*, document.title AS knowledge_title,
          document.id AS knowledge_document_id_joined,
          document.source_revision_id,
          document.content_hash AS knowledge_content_sha256
        FROM omni_capture_assets asset
        LEFT JOIN omni_knowledge_documents document
          ON document.tenant_id = asset.tenant_id
          AND document.id = asset.knowledge_document_id
        WHERE asset.tenant_id = ${input.tenantId}
          AND asset.actor_id IN (${canonicalActorId}, ${exactActorId})
          AND COALESCE(asset.metadata->>'internalKind', '') = ''
          AND (
            ${input.query} = ''
            OR asset.filename ILIKE ${searchPattern}
            OR COALESCE(document.title, '') ILIKE ${searchPattern}
          )
        ORDER BY asset.updated_at DESC, asset.id ASC
        LIMIT ${candidateLimit}
      ), recording_rows AS MATERIALIZED (
        SELECT recording.*, LEFT(recording.transcript, 600) AS transcript_preview,
          document.id AS knowledge_document_id_joined,
          document.source_revision_id,
          document.content_hash AS knowledge_content_sha256,
          COALESCE(revision_count.version_count, 1)::integer
            AS transcript_version_count
        FROM omni_capture_recordings recording
        LEFT JOIN omni_knowledge_documents document
          ON document.tenant_id = recording.tenant_id
          AND document.id = recording.knowledge_document_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS version_count
          FROM omni_source_revisions revision
          WHERE revision.tenant_id = recording.tenant_id
            AND revision.source_item_id = document.source_item_id
        ) revision_count ON TRUE
        WHERE recording.tenant_id = ${input.tenantId}
          AND recording.actor_id IN (${canonicalActorId}, ${exactActorId})
          AND (
            ${input.query} = ''
            OR recording.title ILIKE ${searchPattern}
            OR recording.transcript ILIKE ${searchPattern}
          )
        ORDER BY recording.updated_at DESC, recording.id ASC
        LIMIT ${candidateLimit}
      ), project_rows AS MATERIALIZED (
        SELECT artifact.*, project.actor_id AS owner_actor_id,
          project.title AS project_title,
          mapping.workspace_id AS canonical_workspace_id,
          mapping.project_id AS canonical_project_id,
          mapping.work_item_id AS canonical_work_item_id
        FROM omni_project_artifacts artifact
        JOIN omni_projects project
          ON project.tenant_id = artifact.tenant_id
          AND project.id = artifact.project_id
        LEFT JOIN omni_work_compatibility_mappings mapping
          ON mapping.tenant_id = artifact.tenant_id
          AND mapping.source_kind = 'legacy_project_task'
          AND mapping.source_id = artifact.task_id
          AND mapping.state = 'active'
        WHERE artifact.tenant_id = ${input.tenantId}
          AND project.actor_id IN (${canonicalActorId}, ${exactActorId})
          AND (
            ${input.query} = ''
            OR artifact.title ILIKE ${searchPattern}
            OR artifact.content ILIKE ${searchPattern}
            OR project.title ILIKE ${searchPattern}
          )
        ORDER BY artifact.updated_at DESC, artifact.id ASC
        LIMIT ${candidateLimit}
      ), mission_rows AS MATERIALIZED (
        SELECT artifact.*, mission.title AS mission_title,
          COALESCE(task_mapping.workspace_id, mission_mapping.workspace_id)
            AS canonical_workspace_id,
          COALESCE(task_mapping.project_id, mission_mapping.project_id)
            AS canonical_project_id,
          task_mapping.work_item_id AS canonical_work_item_id
        FROM omni_mission_artifacts artifact
        JOIN omni_missions mission
          ON mission.tenant_id = artifact.tenant_id
          AND mission.actor_id = artifact.actor_id
          AND mission.id = artifact.mission_id
        LEFT JOIN omni_work_compatibility_mappings task_mapping
          ON task_mapping.tenant_id = artifact.tenant_id
          AND task_mapping.source_kind = 'legacy_mission_task'
          AND task_mapping.source_id = artifact.task_id
          AND task_mapping.state = 'active'
        LEFT JOIN omni_work_compatibility_mappings mission_mapping
          ON mission_mapping.tenant_id = artifact.tenant_id
          AND mission_mapping.source_kind = 'legacy_mission'
          AND mission_mapping.source_id = artifact.mission_id
          AND mission_mapping.state = 'active'
        WHERE artifact.tenant_id = ${input.tenantId}
          AND artifact.actor_id IN (${canonicalActorId}, ${exactActorId})
          AND (
            ${input.query} = ''
            OR artifact.title ILIKE ${searchPattern}
            OR mission.title ILIKE ${searchPattern}
            OR artifact.data::TEXT ILIKE ${searchPattern}
          )
        ORDER BY artifact.updated_at DESC, artifact.id ASC
        LIMIT ${candidateLimit}
      ), source_candidates AS MATERIALIZED (
        SELECT source_item.*
        FROM omni_source_items source_item
        WHERE source_item.tenant_id = ${input.tenantId}
          AND source_item.owner_actor_id IN (${canonicalActorId}, ${exactActorId})
          AND source_item.visibility <> 'agent_private'
          AND source_item.connection_id <> 'first_party.capture'
          AND (
            ${input.query} = ''
            OR to_tsvector(
              'simple',
              source_item.source_kind || ' ' || source_item.connection_id ||
              ' ' || source_item.id
            ) @@ plainto_tsquery('simple', ${input.query})
            OR EXISTS (
              SELECT 1
              FROM omni_knowledge_documents candidate_document
              WHERE candidate_document.tenant_id = source_item.tenant_id
                AND candidate_document.source_item_id = source_item.id
                AND candidate_document.source_revision_id =
                  source_item.current_revision_id
                AND to_tsvector('simple', candidate_document.title) @@
                  plainto_tsquery('simple', ${input.query})
            )
          )
          AND (
            source_item.retention_expires_at IS NULL
            OR source_item.retention_expires_at > CURRENT_TIMESTAMP
          )
        ORDER BY source_item.updated_at DESC, source_item.id ASC
        LIMIT ${candidateLimit}
      ), source_rows AS MATERIALIZED (
        SELECT source_item.*, revision.content_sha256,
          revision.content_byte_length, revision.media_type,
          revision.created_at AS revision_created_at,
          document.id AS knowledge_document_id_joined,
          document.title AS knowledge_title,
          COALESCE(revision_count.version_count, 1)::integer AS version_count
        FROM source_candidates source_item
        JOIN omni_source_revisions revision
          ON revision.tenant_id = source_item.tenant_id
          AND revision.source_item_id = source_item.id
          AND revision.id = source_item.current_revision_id
        LEFT JOIN omni_knowledge_documents document
          ON document.tenant_id = source_item.tenant_id
          AND document.source_item_id = source_item.id
          AND document.source_revision_id = revision.id
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS version_count
          FROM omni_source_revisions historical_revision
          WHERE historical_revision.tenant_id = source_item.tenant_id
            AND historical_revision.source_item_id = source_item.id
        ) revision_count ON TRUE
      )
      SELECT
        COALESCE((SELECT jsonb_agg(to_jsonb(item)) FROM capture_rows item), '[]'::jsonb)
          AS capture_rows,
        COALESCE((SELECT jsonb_agg(to_jsonb(item)) FROM recording_rows item), '[]'::jsonb)
          AS recording_rows,
        COALESCE((SELECT jsonb_agg(to_jsonb(item)) FROM project_rows item), '[]'::jsonb)
          AS project_rows,
        COALESCE((SELECT jsonb_agg(to_jsonb(item)) FROM mission_rows item), '[]'::jsonb)
          AS mission_rows,
        COALESCE((SELECT jsonb_agg(to_jsonb(item)) FROM source_rows item), '[]'::jsonb)
          AS source_rows
    `;
    const result = resultRows[0] || {};
    const captureRows = jsonRows(result.capture_rows);
    const recordingRows = jsonRows(result.recording_rows);
    const projectRows = jsonRows(result.project_rows);
    const missionRows = jsonRows(result.mission_rows);
    const sourceRows = jsonRows(result.source_rows);
    return {
      items: [
        ...captureRows.map((row) => captureAssetLibraryItem(row, exactActorId)),
        ...recordingRows.flatMap((row) => captureRecordingLibraryItems(row)),
        ...projectRows.map(projectArtifactLibraryItem),
        ...missionRows.map(missionArtifactLibraryItem),
        ...sourceRows.map(sourceItemLibraryItem),
      ],
      hasMore: [captureRows, recordingRows, projectRows, missionRows, sourceRows]
        .some((rows) => rows.length === candidateLimit),
    };
  }) as Promise<{ items: WorkspaceLibraryItem[]; hasMore: boolean }>;
}

async function listLocalLibraryCandidates(
  input: NormalizedWorkspaceLibraryQuery,
) {
  const owner = {
    tenantId: input.tenantId,
    actorId: input.actorId,
    requestActorBinding: input.requestActorBinding,
  };
  const assets = await listCaptureAssets(owner, 100);
  const recordings = await listCaptureRecordingsForRequest(owner, 100);
  const projects = await listProjects(100, owner);
  const collections = await listProjectCollections(
    projects.map((project) => project.id),
    { tenantId: input.tenantId },
  );
  const missions = await listMissions(100, owner);
  const missionArtifacts = [] as Array<{ missionTitle: string; artifact: Awaited<ReturnType<typeof listMissionArtifacts>>[number] }>;
  for (const mission of missions) {
    for (const artifact of await listMissionArtifacts(mission.id, owner, 100)) {
      missionArtifacts.push({ missionTitle: mission.title, artifact });
    }
  }
  const items = [
    ...assets.map((asset) => captureAssetLibraryItem({ ...asset, tenant_id: input.tenantId, actor_id: input.actorId }, input.actorId)),
    ...recordings.flatMap((recording) => captureRecordingLibraryItems({
      ...recording,
      tenant_id: input.tenantId,
      actor_id: input.actorId,
      language: "en-US",
      tags: [],
      byte_count: 0,
      transcript_preview: "",
      source: "capture",
      created_at: recording.startedAt,
      updated_at: recording.updatedAt,
    })),
    ...projects.flatMap((project) =>
      (collections.artifactsByProject.get(project.id) || []).map((artifact) =>
        projectArtifactLibraryItem({
          ...artifact,
          tenant_id: input.tenantId,
          owner_actor_id: input.actorId,
          project_title: project.title,
        }),
      ),
    ),
    ...missionArtifacts.map(({ missionTitle, artifact }) => missionArtifactLibraryItem({
      ...artifact,
      tenant_id: input.tenantId,
      actor_id: input.actorId,
      mission_title: missionTitle,
    })),
  ];
  return { items, hasMore: false };
}

export function captureAssetLibraryItem(
  row: SqlRow,
  exactActorId: string,
): WorkspaceLibraryItem {
  const id = text(row.id);
  const mediaType = mimeType(row.media_type ?? row.mediaType);
  const knowledgeDocumentId = optionalText(
    row.knowledge_document_id_joined ?? row.knowledgeDocumentId,
  );
  const sourceRevisionId = optionalText(row.source_revision_id);
  const ownerActorId = text(row.actor_id ?? row.actorId, exactActorId);
  const status = text(row.status, "stored");
  const filename = safeText(row.filename, 240, "Untitled file");
  return parseWorkspaceLibraryItem({
    schemaVersion: 1,
    id: `library:capture_asset:${id}`,
    tenantId: text(row.tenant_id ?? row.tenantId),
    kind: kindFromMediaType(mediaType),
    sourceAuthority: "capture_asset",
    sourceId: id,
    title: safeText(row.knowledge_title, 240, filename),
    summary: captureAssetSummary(row),
    sourceLabel: "Capture",
    status: status === "failed" ? "failed" : status === "unsupported" ? "unsupported" : status === "indexed" ? "ready" : "processing",
    tags: stringArray(row.tags),
    scope: privateScope(ownerActorId, null),
    currentVersion: {
      versionId: `version:capture_asset:${id}:${text(row.content_sha256 ?? row.contentSha256).slice(0, 64)}`,
      versionNumber: 1,
      contentSha256: sha256(row.content_sha256 ?? row.contentSha256, filename),
      byteCount: integer(row.byte_count ?? row.byteCount),
      mediaType,
      sourceRevisionId,
      createdAt: timestamp(row.created_at ?? row.createdAt),
    },
    versionCount: 1,
    citationRefs: citations([
      `capture-asset:${id}`,
      sourceRevisionId ? `source-revision:${sourceRevisionId}` : undefined,
      knowledgeDocumentId ? `knowledge-document:${knowledgeDocumentId}` : undefined,
    ]),
    links: links([
      sourceLink(id, "Captured file", "/app/capture"),
      knowledgeDocumentId ? knowledgeLink(knowledgeDocumentId) : undefined,
    ]),
    openHref: ownerActorId === exactActorId
      ? `/api/capture/assets/${encodeURIComponent(id)}?content=1&download=1`
      : "/app/capture",
    createdAt: timestamp(row.created_at ?? row.createdAt),
    updatedAt: timestamp(row.updated_at ?? row.updatedAt),
  });
}

export function captureRecordingLibraryItems(row: SqlRow): WorkspaceLibraryItem[] {
  const id = text(row.id);
  const tenantId = text(row.tenant_id ?? row.tenantId);
  const ownerActorId = text(row.actor_id ?? row.actorId);
  const createdAt = timestamp(row.created_at ?? row.createdAt ?? row.started_at ?? row.startedAt);
  const updatedAt = timestamp(row.updated_at ?? row.updatedAt);
  const knowledgeDocumentId = optionalText(row.knowledge_document_id_joined ?? row.knowledgeDocumentId);
  const sourceRevisionId = optionalText(row.source_revision_id);
  const byteCount = integer(row.byte_count ?? row.byteCount);
  const recordingHash = sha256(row.audio_sha256, `${id}:${byteCount}:${integer(row.segment_count ?? row.segmentCount)}`);
  const title = safeText(row.title, 240, "Untitled recording");
  const status = text(row.status, "processing");
  const shared = {
    tenantId,
    title,
    sourceLabel: "Capture recording",
    tags: stringArray(row.tags),
    scope: privateScope(ownerActorId, null),
    links: links([
      sourceLink(id, "Recording", "/app/capture"),
      knowledgeDocumentId ? knowledgeLink(knowledgeDocumentId) : undefined,
    ]),
    openHref: `/app/capture?recording=${encodeURIComponent(id)}`,
    createdAt,
    updatedAt,
  } as const;
  const items: WorkspaceLibraryItem[] = [parseWorkspaceLibraryItem({
    schemaVersion: 1,
    id: `library:capture_recording:${id}`,
    ...shared,
    kind: "recording",
    sourceAuthority: "capture_recording",
    sourceId: id,
    summary: `${integer(row.segment_count ?? row.segmentCount)} segment${integer(row.segment_count ?? row.segmentCount) === 1 ? "" : "s"} · ${durationLabel(integer(row.duration_ms ?? row.durationMs))}`,
    status: status === "failed" ? "failed" : status === "ready" ? "ready" : "processing",
    currentVersion: {
      versionId: `version:capture_recording:${id}:${recordingHash}`,
      versionNumber: 1,
      contentSha256: recordingHash,
      byteCount,
      mediaType: "audio/webm",
      sourceRevisionId: null,
      createdAt,
    },
    versionCount: 1,
    citationRefs: citations([`capture-recording:${id}`]),
  })];
  const transcript = safeText(row.transcript_preview ?? row.transcript, 600, "");
  if (transcript || knowledgeDocumentId || sourceRevisionId) {
    const transcriptHash = sha256(row.knowledge_content_sha256, transcript || id);
    const versionCount = Math.max(1, integer(row.transcript_version_count, 1));
    items.push(parseWorkspaceLibraryItem({
      schemaVersion: 1,
      id: `library:capture_transcript:${id}`,
      ...shared,
      kind: "transcript",
      sourceAuthority: "capture_transcript",
      sourceId: id,
      title: `${title} transcript`,
      summary: transcript,
      status: status === "failed" ? "failed" : sourceRevisionId || knowledgeDocumentId ? "ready" : "processing",
      currentVersion: {
        versionId: `version:capture_transcript:${id}:${sourceRevisionId || transcriptHash}`,
        versionNumber: versionCount,
        contentSha256: transcriptHash,
        byteCount: Buffer.byteLength(transcript, "utf8"),
        mediaType: "text/plain",
        sourceRevisionId,
        createdAt,
      },
      versionCount,
      citationRefs: citations([
        `capture-recording:${id}#transcript`,
        sourceRevisionId ? `source-revision:${sourceRevisionId}` : undefined,
        knowledgeDocumentId ? `knowledge-document:${knowledgeDocumentId}` : undefined,
      ]),
    }));
  }
  return items;
}

export function projectArtifactLibraryItem(row: SqlRow): WorkspaceLibraryItem {
  const id = text(row.id);
  const projectId = text(row.canonical_project_id ?? row.project_id ?? row.projectId);
  const legacyProjectId = text(row.project_id ?? row.projectId, projectId);
  const workItemId = optionalText(row.canonical_work_item_id ?? row.task_id ?? row.taskId);
  const workspaceId = optionalText(row.canonical_workspace_id);
  const content = safeText(row.content, 600, "");
  const contentSha256 = sha256(undefined, text(row.content));
  const status = text(row.status, "failed");
  return parseWorkspaceLibraryItem({
    schemaVersion: 1,
    id: `library:project_artifact:${id}`,
    tenantId: text(row.tenant_id ?? row.tenantId),
    kind: "generated_artifact",
    sourceAuthority: "project_artifact",
    sourceId: id,
    title: safeText(row.title, 240, "Generated project artifact"),
    summary: content,
    sourceLabel: safeText(row.project_title, 120, "Project output"),
    status: status === "verified" ? "ready" : "failed",
    tags: ["generated", "project-output"],
    scope: sharedScope({
      visibility: "project_shared",
      ownerActorId: text(row.owner_actor_id),
      workspaceId,
      projectId,
      workItemId,
    }),
    currentVersion: {
      versionId: `version:project_artifact:${id}:${contentSha256}`,
      versionNumber: 1,
      contentSha256,
      byteCount: Buffer.byteLength(text(row.content), "utf8"),
      mediaType: "text/markdown",
      sourceRevisionId: null,
      createdAt: timestamp(row.created_at ?? row.createdAt),
    },
    versionCount: 1,
    citationRefs: citations([
      `project-artifact:${id}`,
      ...stringArray(row.evidence_refs ?? row.evidenceRefs),
    ]),
    links: links([
      sourceLink(id, "Project artifact", `/app/projects?project=${encodeURIComponent(legacyProjectId)}&artifact=${encodeURIComponent(id)}`),
      projectLink(projectId, safeText(row.project_title, 120, "Project"), `/app/projects?project=${encodeURIComponent(legacyProjectId)}`),
      workItemId ? workItemLink(workItemId) : undefined,
      optionalText(row.memory_id ?? row.memoryId) ? knowledgeLink(text(row.memory_id ?? row.memoryId)) : undefined,
    ]),
    openHref: `/app/projects?project=${encodeURIComponent(legacyProjectId)}&artifact=${encodeURIComponent(id)}`,
    createdAt: timestamp(row.created_at ?? row.createdAt),
    updatedAt: timestamp(row.updated_at ?? row.updatedAt),
  });
}

export function missionArtifactLibraryItem(row: SqlRow): WorkspaceLibraryItem {
  const id = text(row.id);
  const missionId = text(row.mission_id ?? row.missionId);
  const projectId = optionalText(row.canonical_project_id);
  const workspaceId = optionalText(row.canonical_workspace_id);
  const workItemId = optionalText(row.canonical_work_item_id ?? row.task_id ?? row.taskId);
  const data = jsonObject(row.data);
  const serializedData = JSON.stringify(data);
  const contentSha256 = sha256(undefined, serializedData);
  const mediaType = mimeType(row.mime_type ?? row.mimeType, "application/json");
  return parseWorkspaceLibraryItem({
    schemaVersion: 1,
    id: `library:mission_artifact:${id}`,
    tenantId: text(row.tenant_id ?? row.tenantId),
    kind: kindFromMissionArtifact(row.kind, mediaType),
    sourceAuthority: "mission_artifact",
    sourceId: id,
    title: safeText(row.title, 240, "Generated mission artifact"),
    summary: artifactSummary(data),
    sourceLabel: safeText(row.mission_title, 120, "Mission output"),
    status: text(row.kind) === "error" ? "failed" : "ready",
    tags: ["generated", "mission-output"],
    scope: sharedScope({
      visibility: "mission_shared",
      ownerActorId: text(row.actor_id ?? row.actorId),
      workspaceId,
      projectId,
      missionId,
      workItemId,
    }),
    currentVersion: {
      versionId: `version:mission_artifact:${id}:${contentSha256}`,
      versionNumber: 1,
      contentSha256,
      byteCount: Buffer.byteLength(serializedData, "utf8"),
      mediaType,
      sourceRevisionId: null,
      createdAt: timestamp(row.created_at ?? row.createdAt),
    },
    versionCount: 1,
    citationRefs: citations([`mission-artifact:${id}`]),
    links: links([
      sourceLink(id, "Mission artifact", `/app/missions/${encodeURIComponent(missionId)}`),
      { kind: "mission", id: missionId, label: safeText(row.mission_title, 240, "Mission"), href: `/app/missions/${encodeURIComponent(missionId)}` },
      workspaceId ? { kind: "workspace", id: workspaceId, label: "Workspace", href: "/app" } : undefined,
      projectId ? projectLink(projectId, "Mission project", `/app/missions/${encodeURIComponent(missionId)}`) : undefined,
      workItemId ? workItemLink(workItemId) : undefined,
    ]),
    openHref: `/app/missions/${encodeURIComponent(missionId)}?artifact=${encodeURIComponent(id)}`,
    createdAt: timestamp(row.created_at ?? row.createdAt),
    updatedAt: timestamp(row.updated_at ?? row.updatedAt),
  });
}

export function sourceItemLibraryItem(row: SqlRow): WorkspaceLibraryItem {
  const id = text(row.id);
  const sourceRevisionId = text(row.current_revision_id);
  const sourceKind = text(row.source_kind);
  const kind = kindFromSourceKind(sourceKind);
  const connectionId = text(row.connection_id, "connected_source");
  const versionCount = Math.max(1, integer(row.version_count, 1));
  const knowledgeDocumentId = optionalText(row.knowledge_document_id_joined);
  const workspaceId = optionalText(row.workspace_id);
  const projectId = optionalText(row.project_id);
  const missionId = optionalText(row.mission_id);
  const title = safeText(
    row.knowledge_title,
    240,
    `${kindLabel(kind)} from ${sourceLabel(connectionId)}`,
  );
  return parseWorkspaceLibraryItem({
    schemaVersion: 1,
    id: `library:source_item:${id}`,
    tenantId: text(row.tenant_id),
    kind,
    sourceAuthority: "source_item",
    sourceId: id,
    title,
    summary: `${kindLabel(kind)} · ${versionCount} version${versionCount === 1 ? "" : "s"} · source-backed`,
    sourceLabel: sourceLabel(connectionId),
    status: "ready",
    tags: [sourceKind, "connected-source"],
    scope: sourceScope({
      visibility: text(row.visibility, "user_private") as SourceVisibility,
      ownerActorId: text(row.owner_actor_id),
      workspaceId,
      projectId,
      missionId,
    }),
    currentVersion: {
      versionId: `version:source_item:${id}:${sourceRevisionId}`,
      versionNumber: versionCount,
      contentSha256: sha256(row.content_sha256, id),
      byteCount: integer(row.content_byte_length),
      mediaType: mimeType(row.media_type, "application/octet-stream"),
      sourceRevisionId,
      createdAt: timestamp(row.revision_created_at ?? row.created_at),
    },
    versionCount,
    citationRefs: citations([
      `source-item:${id}`,
      `source-revision:${sourceRevisionId}`,
      knowledgeDocumentId ? `knowledge-document:${knowledgeDocumentId}` : undefined,
    ]),
    links: links([
      sourceLink(id, `${kindLabel(kind)} source`, "/app/capture"),
      knowledgeDocumentId ? knowledgeLink(knowledgeDocumentId) : undefined,
      workspaceId ? { kind: "workspace", id: workspaceId, label: "Workspace", href: "/app" } : undefined,
      projectId ? projectLink(projectId, "Project", `/app/projects?project=${encodeURIComponent(projectId)}`) : undefined,
      missionId ? { kind: "mission", id: missionId, label: "Mission", href: `/app/missions/${encodeURIComponent(missionId)}` } : undefined,
    ]),
    openHref: "/app/capture",
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

type NormalizedWorkspaceLibraryQuery = Readonly<{
  tenantId: string;
  actorId: string;
  requestActorBinding?: CanonicalRequestActorBindingV1;
  query: string;
  kinds: readonly WorkspaceLibraryKind[];
  projectId?: string;
  limit: number;
  offset: number;
}>;

function normalizeQuery(input: WorkspaceLibraryQuery): NormalizedWorkspaceLibraryQuery {
  const tenantId = boundedIdentity(input.tenantId, "tenant");
  const actorId = boundedIdentity(input.actorId, "actor");
  const query = safeText(input.query, 240, "");
  const kinds = [...new Set(input.kinds || [])].slice(0, 20);
  const projectId = input.projectId ? boundedIdentity(input.projectId, "project") : undefined;
  const limit = Math.min(Math.max(Math.trunc(input.limit || 60), 1), 100);
  const offset = Math.min(Math.max(Math.trunc(input.offset || 0), 0), 10_000);
  return Object.freeze({
    tenantId,
    actorId,
    ...(input.requestActorBinding ? { requestActorBinding: input.requestActorBinding } : {}),
    query,
    kinds,
    ...(projectId ? { projectId } : {}),
    limit,
    offset,
  });
}

function privateScope(ownerActorId: string, workspaceId: string | null): WorkspaceLibraryScope {
  return {
    visibility: "user_private",
    ownerActorId,
    workspaceId,
    projectId: null,
    missionId: null,
    workItemId: null,
    permissionBasis: "owner",
  };
}

function sharedScope(input: {
  visibility: "project_shared" | "mission_shared";
  ownerActorId: string;
  workspaceId?: string | null;
  projectId?: string | null;
  missionId?: string | null;
  workItemId?: string | null;
}): WorkspaceLibraryScope {
  return {
    visibility: input.visibility,
    ownerActorId: input.ownerActorId,
    workspaceId: input.workspaceId || null,
    projectId: input.projectId || null,
    missionId: input.missionId || null,
    workItemId: input.workItemId || null,
    permissionBasis: "owner",
  };
}

function sourceScope(input: {
  visibility: SourceVisibility;
  ownerActorId: string;
  workspaceId: string | null;
  projectId: string | null;
  missionId: string | null;
}): WorkspaceLibraryScope {
  const visibility = input.visibility === "agent_private"
    ? "user_private"
    : input.visibility;
  return {
    visibility,
    ownerActorId: input.ownerActorId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    missionId: input.missionId,
    workItemId: null,
    permissionBasis: "owner",
  };
}

function sourceLink(id: string, label: string, href: string) {
  return { kind: "source" as const, id, label, href };
}

function knowledgeLink(id: string) {
  return { kind: "knowledge_document" as const, id, label: "Indexed knowledge", href: "/app/memory" };
}

function projectLink(id: string, label: string, href: string) {
  return { kind: "project" as const, id, label, href };
}

function workItemLink(id: string) {
  return { kind: "work_item" as const, id, label: "Related work item", href: null };
}

function links<T>(items: Array<T | undefined>): T[] {
  return items.filter((item): item is T => Boolean(item));
}

function citations(items: Array<string | undefined>) {
  return [...new Set(items.filter((item): item is string => Boolean(item)).map((item) => safeText(item, 320, "")).filter(Boolean))].slice(0, 64);
}

function captureAssetSummary(row: SqlRow) {
  const extraction = text(row.extraction_status ?? row.extractionStatus, "pending").replaceAll("_", " ");
  return `${formatBytes(integer(row.byte_count ?? row.byteCount))} · ${extraction} extraction`;
}

function artifactSummary(data: Record<string, unknown>) {
  for (const key of ["summary", "report", "text", "content", "message"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return safeText(value, 600, "");
  }
  return Object.keys(data).length ? "Generated output with structured data" : "Generated mission output";
}

function kindFromMediaType(mediaType: string): WorkspaceLibraryKind {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.includes("spreadsheet") || mediaType.includes("excel") || mediaType === "text/csv") return "spreadsheet";
  if (mediaType.includes("presentation") || mediaType.includes("powerpoint")) return "presentation";
  if (mediaType.startsWith("text/") || mediaType === "application/pdf" || mediaType.includes("word")) return "document";
  return "file";
}

function kindFromMissionArtifact(kindValue: unknown, mediaType: string): WorkspaceLibraryKind {
  const kind = text(kindValue).toLowerCase();
  if (kind.includes("image")) return "image";
  if (kind.includes("transcript")) return "transcript";
  const mediaKind = kindFromMediaType(mediaType);
  return mediaKind === "file" ? "generated_artifact" : mediaKind;
}

function kindFromSourceKind(sourceKind: string): WorkspaceLibraryKind {
  if (sourceKind === "calendar_event") return "meeting";
  if (sourceKind === "capture") return "document";
  if ([
    "document", "spreadsheet", "presentation", "email", "message",
    "webpage", "image", "audio", "video", "record", "file",
  ].includes(sourceKind)) return sourceKind as WorkspaceLibraryKind;
  return "file";
}

function kindLabel(kind: WorkspaceLibraryKind) {
  return kind === "generated_artifact"
    ? "Generated artifact"
    : kind.charAt(0).toUpperCase() + kind.slice(1).replaceAll("_", " ");
}

function sourceLabel(connectionId: string) {
  if (connectionId.includes("google") && connectionId.includes("mail")) return "Google Mail";
  if (connectionId.includes("google") && connectionId.includes("calendar")) return "Google Calendar";
  if (connectionId.includes("google") && connectionId.includes("drive")) return "Google Drive";
  if (connectionId.includes("google")) return "Google";
  if (connectionId.includes("capture")) return "Capture";
  return safeText(connectionId.replace(/[._:-]+/g, " "), 120, "Connected source");
}

function matchesSearch(item: WorkspaceLibraryItem, terms: readonly string[]) {
  if (!terms.length) return true;
  const haystack = tokenize([
    item.title,
    item.summary,
    item.kind,
    item.sourceLabel,
    ...item.tags,
    ...item.citationRefs,
    ...item.links.flatMap((link) => [link.label, link.id]),
  ].join(" "));
  return terms.every((term) => haystack.some((word) => word.includes(term)));
}

function tokenize(value: string) {
  return value.toLocaleLowerCase().split(/[^\p{L}\p{N}._:@/+~-]+/u).filter(Boolean).slice(0, 80);
}

function compareLibraryItems(left: WorkspaceLibraryItem, right: WorkspaceLibraryItem) {
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
}

function boundedIdentity(value: unknown, label: string) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 320 || !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(normalized)) {
    throw new Error(`Workspace library ${label} id is invalid.`);
  }
  return normalized;
}

function safeText(value: unknown, max: number, fallback: string) {
  const normalized = String(redactSensitive(String(value ?? ""))).replace(/\s+/g, " ").trim().slice(0, max);
  return normalized || fallback;
}

function text(value: unknown, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function optionalText(value: unknown) {
  const normalized = text(value);
  return normalized || null;
}

function integer(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function timestamp(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value || 0));
  if (!Number.isFinite(date.getTime())) return new Date(0).toISOString();
  return date.toISOString();
}

function mimeType(value: unknown, fallback = "application/octet-stream") {
  const normalized = text(value).toLowerCase();
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(normalized)
    ? normalized.slice(0, 160)
    : fallback;
}

function sha256(value: unknown, fallback: string) {
  const normalized = text(value).toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized)
    ? normalized
    : createHash("sha256").update(fallback).digest("hex");
}

function stringArray(value: unknown) {
  const parsed = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? (() => { try { return JSON.parse(value) as unknown; } catch { return []; } })()
      : [];
  return Array.isArray(parsed)
    ? [...new Set(parsed.map((item) => safeText(item, 80, "")).filter(Boolean))].slice(0, 50)
    : [];
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try { return jsonObject(JSON.parse(value)); } catch { return {}; }
  }
  return {};
}

function jsonRows(value: unknown): SqlRow[] {
  if (Array.isArray(value)) return value.map(jsonObject);
  if (typeof value === "string") {
    try { return jsonRows(JSON.parse(value)); } catch { return []; }
  }
  return [];
}

function formatBytes(value: number) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function durationLabel(milliseconds: number) {
  if (milliseconds < 1_000) return "under a second";
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
