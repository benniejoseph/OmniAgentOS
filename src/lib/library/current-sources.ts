import type { SqlClient } from "@/lib/db/sql-types";
import { GOOGLE_SOURCE_ADAPTERS } from "@/lib/connectors/google-source-adapters";
import {
  GOOGLE_GMAIL_FULL_SCOPE,
  GOOGLE_WORKSPACE_OAUTH_SCOPES,
  GOOGLE_WORKSPACE_WRITE_ACCESS,
  googleWorkspaceAuthorizationScopes,
  hasGoogleWorkspaceCapability,
} from "@/lib/connectors/google-workspace-capabilities";

type LibrarySqlTag = {
  (strings: TemplateStringsArray, ...params: unknown[]): ReturnType<SqlClient>;
};

const googleScopes = [...new Set([
  ...GOOGLE_WORKSPACE_OAUTH_SCOPES,
  ...GOOGLE_WORKSPACE_WRITE_ACCESS.flatMap(googleWorkspaceAuthorizationScopes),
  GOOGLE_GMAIL_FULL_SCOPE,
])];

/** Use the same capability map as sync; drive.file never implies broad read. */
export function libraryGoogleReadScopes(source: keyof typeof GOOGLE_SOURCE_ADAPTERS) {
  return googleScopes.filter((scope) => hasGoogleWorkspaceCapability(
    [scope], GOOGLE_SOURCE_ADAPTERS[source].capability,
  ));
}

function queryParts(strings: TemplateStringsArray, ...params: unknown[]) {
  return { strings, params };
}

/**
 * Prepend the same current-source projection to every Library read. Only the
 * trusted query text is composed; tenant, physical actor pair and scopes stay
 * bound parameters. NOT MATERIALIZED lets exact IDs and candidate predicates
 * reach the source indexes before hydration and pagination.
 *
 * A canonical delete deliberately retains the item's previous revision. Its
 * sync head, current grant and revision identity therefore decide visibility.
 * An access-token expiry is not a revoked grant and requires no credential read.
 */
export function withCurrentLibrarySources(
  sql: LibrarySqlTag,
  input: Readonly<{
    tenantId: string;
    canonicalActorId: string;
    exactActorId: string;
    enabled?: boolean;
  }>,
): LibrarySqlTag {
  const prefix = queryParts`
    WITH library_current_sources AS NOT MATERIALIZED (
      SELECT source_item.*
      FROM omni_source_items source_item
      JOIN omni_source_revisions revision
        ON revision.tenant_id = source_item.tenant_id
        AND revision.source_item_id = source_item.id
        AND revision.id = source_item.current_revision_id
        AND revision.owner_actor_id = source_item.owner_actor_id
        AND revision.connection_id = source_item.connection_id
        AND revision.source_kind = source_item.source_kind
        AND revision.provider_item_key_sha256 = source_item.provider_item_key_sha256
        AND revision.adapter_id = source_item.adapter_id
        AND revision.adapter_operation = 'upsert'
        AND revision.visibility = source_item.visibility
        AND revision.permission_set_sha256 = source_item.permission_set_sha256
        AND revision.purpose_set_sha256 = source_item.purpose_set_sha256
      LEFT JOIN omni_source_sync_heads head
        ON head.tenant_id = source_item.tenant_id
        AND head.source_item_id = source_item.id
      WHERE source_item.tenant_id = ${input.tenantId}
        AND source_item.owner_actor_id IN (${input.canonicalActorId}, ${input.exactActorId})
        AND ${input.enabled !== false}
        AND source_item.adapter_operation = 'upsert'
        AND source_item.visibility <> 'agent_private'
        AND source_item.connection_id <> 'first_party.capture'
        AND (source_item.retention_expires_at IS NULL
          OR source_item.retention_expires_at > CURRENT_TIMESTAMP)
        AND (revision.retention_expires_at IS NULL
          OR revision.retention_expires_at > CURRENT_TIMESTAMP)
        AND (
          head.source_item_id IS NULL
          OR (
            head.owner_actor_id = source_item.owner_actor_id
            AND head.connection_id = source_item.connection_id
            AND head.source_kind = source_item.source_kind
            AND head.provider_item_key_sha256 = source_item.provider_item_key_sha256
            AND head.operation = 'upsert'
            AND NOT head.absence_observed
            AND head.source_tombstone_id IS NULL
            AND head.source_revision_id = source_item.current_revision_id
            AND head.adapter_output_id = revision.adapter_output_id
            AND head.adapter_output_sha256 = revision.adapter_output_sha256
          )
        )
        AND (
          (
            (source_item.adapter_id, source_item.connection_id) IN (
              ('asael.knowledge_service', 'first_party.knowledge_service'),
              ('asael.ingest_api', 'first_party.ingest_api'),
              ('asael.portable_restore', 'first_party.portable_restore')
            )
            AND EXISTS (
              SELECT 1 FROM omni_knowledge_documents document
              WHERE document.tenant_id = source_item.tenant_id
                AND document.source_item_id = source_item.id
                AND document.source_revision_id = revision.id
            )
          )
          OR EXISTS (
            SELECT 1 FROM omni_oauth_grants grant_row
            WHERE grant_row.tenant_id = source_item.tenant_id
              AND grant_row.actor_id = source_item.owner_actor_id
              AND grant_row.id = source_item.connection_id
              AND grant_row.provider = 'google'
              AND grant_row.status = 'active'
              AND (
                EXISTS (
                  SELECT 1 FROM omni_knowledge_documents document
                  WHERE document.tenant_id = source_item.tenant_id
                    AND document.source_item_id = source_item.id
                    AND document.source_revision_id = revision.id
                )
                OR (
                  head.source_item_id IS NOT NULL
                  AND source_item.adapter_id = ${GOOGLE_SOURCE_ADAPTERS.drive.adapterId}
                  AND revision.media_type = 'application/x.asael-source-metadata'
                )
              )
              AND (
                (source_item.adapter_id = ${GOOGLE_SOURCE_ADAPTERS.mail.adapterId}
                  AND source_item.source_kind = ${GOOGLE_SOURCE_ADAPTERS.mail.sourceKind}
                  AND grant_row.scopes && ${libraryGoogleReadScopes("mail")}::text[])
                OR (source_item.adapter_id = ${GOOGLE_SOURCE_ADAPTERS.calendar.adapterId}
                  AND source_item.source_kind = ${GOOGLE_SOURCE_ADAPTERS.calendar.sourceKind}
                  AND grant_row.scopes && ${libraryGoogleReadScopes("calendar")}::text[])
                OR (source_item.adapter_id = ${GOOGLE_SOURCE_ADAPTERS.drive.adapterId}
                  AND source_item.source_kind = ${GOOGLE_SOURCE_ADAPTERS.drive.sourceKind}
                  AND grant_row.scopes && ${libraryGoogleReadScopes("drive")}::text[])
              )
              AND (
                head.authorization_generation = grant_row.authorization_generation
                OR (
                  head.source_item_id IS NULL
                  AND grant_row.authorization_generation = 1
                  AND EXISTS (
                    SELECT 1 FROM omni_knowledge_documents document
                    WHERE document.tenant_id = source_item.tenant_id
                      AND document.source_item_id = source_item.id
                      AND document.source_revision_id = revision.id
                  )
                )
              )
          )
        )
    )
  `;
  return (strings, ...params) => {
    // Callers provide a SELECT or an existing WITH clause. No retrieved text
    // or user value can become an SQL fragment through this internal helper.
    const suffix = strings[0].replace(/^(\s*)WITH\b/i, "$1,");
    const parts = [...prefix.strings];
    parts[parts.length - 1] += suffix;
    parts.push(...strings.slice(1));
    const template = Object.assign(parts, { raw: [...parts] });
    return sql(template, ...prefix.params, ...params);
  };
}
