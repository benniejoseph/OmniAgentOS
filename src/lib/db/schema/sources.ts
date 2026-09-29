import "server-only";

import type { SqlClient } from "@/lib/db/sql-types";

// TypeScript migration steps for connected sources: OAuth grants, sync health,
// source lineage and Drive sync checkpoints.

export async function ensureOAuthGrants(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_oauth_grants (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      account_email TEXT,
      connection_label TEXT NOT NULL DEFAULT 'Personal',
      connection_purpose TEXT NOT NULL DEFAULT 'personal',
      scopes TEXT[] NOT NULL DEFAULT '{}',
      sealed_tokens JSONB NOT NULL,
      expires_at TIMESTAMPTZ,
      sync_cursor TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE omni_oauth_grants ADD COLUMN IF NOT EXISTS account_email TEXT`;
  await sql`ALTER TABLE omni_oauth_grants ADD COLUMN IF NOT EXISTS connection_label TEXT NOT NULL DEFAULT 'Personal'`;
  await sql`ALTER TABLE omni_oauth_grants ADD COLUMN IF NOT EXISTS connection_purpose TEXT NOT NULL DEFAULT 'personal'`;
  await sql`ALTER TABLE omni_oauth_grants DROP CONSTRAINT IF EXISTS omni_oauth_grants_tenant_id_actor_id_provider_key`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS omni_oauth_grants_actor_provider_purpose_key ON omni_oauth_grants (tenant_id, actor_id, provider, connection_purpose)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS omni_oauth_grants_actor_provider_email_key ON omni_oauth_grants (tenant_id, actor_id, provider, account_email) WHERE account_email IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS omni_oauth_grants_tenant_actor_idx ON omni_oauth_grants (tenant_id, actor_id, updated_at DESC)`;
}

export async function ensureOAuthIncrementalSyncHealth(sql: SqlClient) {
  await ensureOAuthGrants(sql);
  await sql`ALTER TABLE omni_oauth_grants ADD COLUMN IF NOT EXISTS sync_status TEXT NOT NULL DEFAULT 'idle'`;
  await sql`ALTER TABLE omni_oauth_grants ADD COLUMN IF NOT EXISTS sync_error TEXT`;
  await sql`ALTER TABLE omni_oauth_grants ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ`;
  await sql`ALTER TABLE omni_oauth_grants ADD COLUMN IF NOT EXISTS synced_items INTEGER NOT NULL DEFAULT 0`;
  await sql`CREATE INDEX IF NOT EXISTS omni_oauth_grants_sync_health_idx ON omni_oauth_grants (tenant_id, actor_id, sync_status, last_synced_at DESC)`;
}

export async function ensureCanonicalSourceLineageShadow(sql: SqlClient) {
  await sql`
    CREATE OR REPLACE FUNCTION omni_source_contract_id_is_valid(value TEXT)
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    AS $function$
      SELECT value IS NOT NULL
        AND value = btrim(value)
        AND char_length(value) BETWEEN 1 AND 240
        AND value ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
    $function$
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_source_id_array_is_canonical(
      values_to_check TEXT[],
      maximum_entries INTEGER
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    AS $function$
      SELECT values_to_check IS NOT NULL
        AND maximum_entries > 0
        AND cardinality(values_to_check) BETWEEN 1 AND maximum_entries
        AND NOT EXISTS (
          SELECT 1
          FROM (
            SELECT
              value,
              lag(value) OVER (ORDER BY ordinal_position) AS previous_value
            FROM unnest(values_to_check)
              WITH ORDINALITY AS entry(value, ordinal_position)
          ) ordered_values
          WHERE NOT omni_source_contract_id_is_valid(value)
            OR (
              previous_value IS NOT NULL
              AND value COLLATE "C" <= previous_value COLLATE "C"
            )
        )
    $function$
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_jsonb_safe_integer(
      value_to_check JSONB,
      minimum_value BIGINT
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    AS $function$
      SELECT CASE
        WHEN jsonb_typeof(value_to_check) IS DISTINCT FROM 'number' THEN FALSE
        WHEN value_to_check #>> '{}' !~ '^(0|[1-9][0-9]*)$' THEN FALSE
        ELSE (value_to_check #>> '{}')::NUMERIC
          BETWEEN minimum_value AND 9007199254740991
      END
    $function$
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_jsonb_safe_integer_value(
      value_to_check JSONB
    )
    RETURNS NUMERIC
    LANGUAGE SQL
    IMMUTABLE
    AS $function$
      SELECT CASE
        WHEN omni_jsonb_safe_integer(value_to_check, 0)
          THEN (value_to_check #>> '{}')::NUMERIC
        ELSE NULL
      END
    $function$
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_evidence_locator_v1_is_allowlisted(
      locator_value JSONB
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    AS $function$
      SELECT CASE
        WHEN jsonb_typeof(locator_value) <> 'object' THEN FALSE
        WHEN locator_value ->> 'kind' = 'text_span' THEN
          locator_value ?& ARRAY[
            'kind', 'offsetUnit', 'startOffset', 'endOffsetExclusive',
            'containerLength', 'containerSha256'
          ]
          AND locator_value - ARRAY[
            'kind', 'offsetUnit', 'startOffset', 'endOffsetExclusive',
            'containerLength', 'containerSha256'
          ] = '{}'::JSONB
          AND locator_value ->> 'offsetUnit' IN (
            'unicode_code_point', 'utf16_code_unit', 'utf8_byte'
          )
          AND omni_jsonb_safe_integer(locator_value -> 'startOffset', 0)
          AND omni_jsonb_safe_integer(locator_value -> 'endOffsetExclusive', 1)
          AND omni_jsonb_safe_integer(locator_value -> 'containerLength', 1)
          AND omni_jsonb_safe_integer_value(
            locator_value -> 'endOffsetExclusive'
          ) > omni_jsonb_safe_integer_value(locator_value -> 'startOffset')
          AND omni_jsonb_safe_integer_value(
            locator_value -> 'endOffsetExclusive'
          ) <= omni_jsonb_safe_integer_value(locator_value -> 'containerLength')
          AND locator_value ->> 'containerSha256' ~ '^[0-9a-f]{64}$'
        WHEN locator_value ->> 'kind' = 'page' THEN
          locator_value ?& ARRAY['kind', 'pageNumber', 'pageCount']
          AND locator_value - ARRAY['kind', 'pageNumber', 'pageCount'] = '{}'::JSONB
          AND omni_jsonb_safe_integer(locator_value -> 'pageNumber', 1)
          AND (
            locator_value -> 'pageCount' = 'null'::JSONB
            OR (
              omni_jsonb_safe_integer(locator_value -> 'pageCount', 1)
              AND omni_jsonb_safe_integer_value(
                locator_value -> 'pageNumber'
              ) <= omni_jsonb_safe_integer_value(locator_value -> 'pageCount')
            )
          )
        WHEN locator_value ->> 'kind' = 'sheet_range' THEN
          locator_value ?& ARRAY[
            'kind', 'sheetKeySha256', 'startRow', 'endRowExclusive',
            'startColumn', 'endColumnExclusive', 'sheetRowCount',
            'sheetColumnCount'
          ]
          AND locator_value - ARRAY[
            'kind', 'sheetKeySha256', 'startRow', 'endRowExclusive',
            'startColumn', 'endColumnExclusive', 'sheetRowCount',
            'sheetColumnCount'
          ] = '{}'::JSONB
          AND locator_value ->> 'sheetKeySha256' ~ '^[0-9a-f]{64}$'
          AND omni_jsonb_safe_integer(locator_value -> 'startRow', 1)
          AND omni_jsonb_safe_integer(locator_value -> 'endRowExclusive', 1)
          AND omni_jsonb_safe_integer(locator_value -> 'startColumn', 1)
          AND omni_jsonb_safe_integer(locator_value -> 'endColumnExclusive', 1)
          AND omni_jsonb_safe_integer_value(
            locator_value -> 'endRowExclusive'
          ) > omni_jsonb_safe_integer_value(locator_value -> 'startRow')
          AND omni_jsonb_safe_integer_value(
            locator_value -> 'endColumnExclusive'
          ) > omni_jsonb_safe_integer_value(locator_value -> 'startColumn')
          AND (
            locator_value -> 'sheetRowCount' = 'null'::JSONB
            OR (
              omni_jsonb_safe_integer(locator_value -> 'sheetRowCount', 1)
              AND omni_jsonb_safe_integer_value(
                locator_value -> 'endRowExclusive'
              ) <= omni_jsonb_safe_integer_value(
                locator_value -> 'sheetRowCount'
              ) + 1
            )
          )
          AND (
            locator_value -> 'sheetColumnCount' = 'null'::JSONB
            OR (
              omni_jsonb_safe_integer(locator_value -> 'sheetColumnCount', 1)
              AND omni_jsonb_safe_integer_value(
                locator_value -> 'endColumnExclusive'
              ) <= omni_jsonb_safe_integer_value(
                locator_value -> 'sheetColumnCount'
              ) + 1
            )
          )
        WHEN locator_value ->> 'kind' = 'slide' THEN
          locator_value ?& ARRAY[
            'kind', 'slideNumber', 'slideCount', 'elementKeySha256'
          ]
          AND locator_value - ARRAY[
            'kind', 'slideNumber', 'slideCount', 'elementKeySha256'
          ] = '{}'::JSONB
          AND omni_jsonb_safe_integer(locator_value -> 'slideNumber', 1)
          AND (
            locator_value -> 'slideCount' = 'null'::JSONB
            OR (
              omni_jsonb_safe_integer(locator_value -> 'slideCount', 1)
              AND omni_jsonb_safe_integer_value(
                locator_value -> 'slideNumber'
              ) <= omni_jsonb_safe_integer_value(locator_value -> 'slideCount')
            )
          )
          AND (
            locator_value -> 'elementKeySha256' = 'null'::JSONB
            OR locator_value ->> 'elementKeySha256' ~ '^[0-9a-f]{64}$'
          )
        WHEN locator_value ->> 'kind' = 'email_section' THEN
          locator_value ?& ARRAY[
            'kind', 'section', 'sectionIndex', 'partKeySha256'
          ]
          AND locator_value - ARRAY[
            'kind', 'section', 'sectionIndex', 'partKeySha256'
          ] = '{}'::JSONB
          AND locator_value ->> 'section' IN (
            'headers', 'subject', 'body', 'attachment'
          )
          AND omni_jsonb_safe_integer(locator_value -> 'sectionIndex', 0)
          AND (
            locator_value -> 'partKeySha256' = 'null'::JSONB
            OR locator_value ->> 'partKeySha256' ~ '^[0-9a-f]{64}$'
          )
        WHEN locator_value ->> 'kind' = 'image_region' THEN
          locator_value ?& ARRAY[
            'kind', 'coordinateUnit', 'x', 'y', 'width', 'height',
            'imageWidth', 'imageHeight'
          ]
          AND locator_value - ARRAY[
            'kind', 'coordinateUnit', 'x', 'y', 'width', 'height',
            'imageWidth', 'imageHeight'
          ] = '{}'::JSONB
          AND locator_value ->> 'coordinateUnit' = 'pixel'
          AND omni_jsonb_safe_integer(locator_value -> 'x', 0)
          AND omni_jsonb_safe_integer(locator_value -> 'y', 0)
          AND omni_jsonb_safe_integer(locator_value -> 'width', 1)
          AND omni_jsonb_safe_integer(locator_value -> 'height', 1)
          AND omni_jsonb_safe_integer(locator_value -> 'imageWidth', 1)
          AND omni_jsonb_safe_integer(locator_value -> 'imageHeight', 1)
          AND omni_jsonb_safe_integer_value(locator_value -> 'x')
            + omni_jsonb_safe_integer_value(locator_value -> 'width')
            <= omni_jsonb_safe_integer_value(locator_value -> 'imageWidth')
          AND omni_jsonb_safe_integer_value(locator_value -> 'y')
            + omni_jsonb_safe_integer_value(locator_value -> 'height')
            <= omni_jsonb_safe_integer_value(locator_value -> 'imageHeight')
        WHEN locator_value ->> 'kind' = 'media_time_range' THEN
          locator_value ?& ARRAY[
            'kind', 'mediaKind', 'startMilliseconds',
            'endMillisecondsExclusive', 'durationMilliseconds'
          ]
          AND locator_value - ARRAY[
            'kind', 'mediaKind', 'startMilliseconds',
            'endMillisecondsExclusive', 'durationMilliseconds'
          ] = '{}'::JSONB
          AND locator_value ->> 'mediaKind' IN ('audio', 'video')
          AND omni_jsonb_safe_integer(
            locator_value -> 'startMilliseconds',
            0
          )
          AND omni_jsonb_safe_integer(
            locator_value -> 'endMillisecondsExclusive',
            1
          )
          AND omni_jsonb_safe_integer(
            locator_value -> 'durationMilliseconds',
            1
          )
          AND omni_jsonb_safe_integer_value(
            locator_value -> 'endMillisecondsExclusive'
          ) > omni_jsonb_safe_integer_value(
            locator_value -> 'startMilliseconds'
          )
          AND omni_jsonb_safe_integer_value(
            locator_value -> 'endMillisecondsExclusive'
          ) <= omni_jsonb_safe_integer_value(
            locator_value -> 'durationMilliseconds'
          )
        ELSE FALSE
      END
    $function$
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_source_adapter_output_receipts (
      schema_version INTEGER NOT NULL,
      contract_kind TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      adapter_output_id TEXT NOT NULL,
      adapter_output_sha256 TEXT NOT NULL,
      adapter_operation TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      adapter_version_id TEXT NOT NULL,
      adapter_config_sha256 TEXT NOT NULL,
      adapter_event_key_sha256 TEXT NOT NULL,
      adapter_observed_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_source_adapter_output_receipts_pkey
        PRIMARY KEY (tenant_id, adapter_output_id),
      CONSTRAINT omni_source_adapter_output_receipts_envelope_key
        UNIQUE (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256,
          connection_id,
          adapter_operation,
          adapter_id,
          adapter_version_id,
          adapter_config_sha256,
          adapter_event_key_sha256,
          adapter_observed_at
        ),
      CONSTRAINT omni_source_adapter_output_receipts_schema_check CHECK (
        schema_version = 1
        AND contract_kind = 'source_adapter_output'
        AND adapter_operation = 'upsert'
      ),
      CONSTRAINT omni_source_adapter_output_receipts_required_ids_check CHECK (
        omni_source_contract_id_is_valid(tenant_id)
        AND omni_source_contract_id_is_valid(connection_id)
        AND omni_source_contract_id_is_valid(adapter_output_id)
        AND omni_source_contract_id_is_valid(adapter_id)
        AND omni_source_contract_id_is_valid(adapter_version_id)
      ),
      CONSTRAINT omni_source_adapter_output_receipts_hashes_check CHECK (
        adapter_output_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_config_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_event_key_sha256 ~ '^[0-9a-f]{64}$'
      )
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_source_items (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      contract_kind TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      workspace_id TEXT,
      project_id TEXT,
      mission_id TEXT,
      connection_id TEXT NOT NULL,
      visibility TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      permission_grant_ids TEXT[] NOT NULL,
      allowed_purpose_ids TEXT[] NOT NULL,
      retention_policy_id TEXT NOT NULL,
      retention_expires_at TIMESTAMPTZ,
      permission_set_sha256 TEXT NOT NULL,
      purpose_set_sha256 TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      provider_item_key_sha256 TEXT NOT NULL,
      metadata_sha256 TEXT NOT NULL,
      source_created_at TIMESTAMPTZ,
      source_updated_at TIMESTAMPTZ,
      captured_at TIMESTAMPTZ NOT NULL,
      extractor_id TEXT NOT NULL,
      extractor_version_id TEXT NOT NULL,
      extractor_config_sha256 TEXT NOT NULL,
      model_version_id TEXT,
      source_item_sha256 TEXT NOT NULL,
      current_revision_id TEXT,
      adapter_output_id TEXT NOT NULL,
      adapter_output_sha256 TEXT NOT NULL,
      adapter_operation TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      adapter_version_id TEXT NOT NULL,
      adapter_config_sha256 TEXT NOT NULL,
      adapter_event_key_sha256 TEXT NOT NULL,
      adapter_observed_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_source_items_tenant_id_id_key
        UNIQUE (tenant_id, id),
      CONSTRAINT omni_source_items_tenant_scope_key
        UNIQUE (tenant_id, id, owner_actor_id, connection_id),
      CONSTRAINT omni_source_items_adapter_output_receipt_fkey
        FOREIGN KEY (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256,
          connection_id,
          adapter_operation,
          adapter_id,
          adapter_version_id,
          adapter_config_sha256,
          adapter_event_key_sha256,
          adapter_observed_at
        )
        REFERENCES omni_source_adapter_output_receipts (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256,
          connection_id,
          adapter_operation,
          adapter_id,
          adapter_version_id,
          adapter_config_sha256,
          adapter_event_key_sha256,
          adapter_observed_at
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_source_items_schema_check CHECK (
        schema_version = 1
        AND contract_kind = 'source_item'
        AND adapter_operation = 'upsert'
      ),
      CONSTRAINT omni_source_items_source_kind_check CHECK (
        source_kind IN (
          'document', 'spreadsheet', 'presentation', 'email',
          'calendar_event', 'message', 'webpage', 'image', 'audio',
          'video', 'record', 'file', 'capture'
        )
      ),
      CONSTRAINT omni_source_items_visibility_check CHECK (
        visibility IN (
          'agent_private', 'user_private', 'mission_shared',
          'project_shared', 'workspace_shared'
        )
      ),
      CONSTRAINT omni_source_items_sensitivity_check CHECK (
        sensitivity IN ('public', 'internal', 'confidential', 'restricted')
      ),
      CONSTRAINT omni_source_items_visibility_scope_check CHECK (
        (visibility <> 'workspace_shared' OR workspace_id IS NOT NULL)
        AND (visibility <> 'project_shared' OR project_id IS NOT NULL)
        AND (visibility <> 'mission_shared' OR mission_id IS NOT NULL)
      ),
      CONSTRAINT omni_source_items_required_ids_check CHECK (
        omni_source_contract_id_is_valid(id)
        AND omni_source_contract_id_is_valid(tenant_id)
        AND omni_source_contract_id_is_valid(owner_actor_id)
        AND omni_source_contract_id_is_valid(connection_id)
        AND omni_source_contract_id_is_valid(retention_policy_id)
        AND omni_source_contract_id_is_valid(extractor_id)
        AND omni_source_contract_id_is_valid(extractor_version_id)
        AND omni_source_contract_id_is_valid(adapter_output_id)
        AND omni_source_contract_id_is_valid(adapter_id)
        AND omni_source_contract_id_is_valid(adapter_version_id)
        AND (
          workspace_id IS NULL
          OR omni_source_contract_id_is_valid(workspace_id)
        )
        AND (
          project_id IS NULL
          OR omni_source_contract_id_is_valid(project_id)
        )
        AND (
          mission_id IS NULL
          OR omni_source_contract_id_is_valid(mission_id)
        )
        AND (
          model_version_id IS NULL
          OR omni_source_contract_id_is_valid(model_version_id)
        )
        AND (
          current_revision_id IS NULL
          OR omni_source_contract_id_is_valid(current_revision_id)
        )
      ),
      CONSTRAINT omni_source_items_grants_check CHECK (
        omni_source_id_array_is_canonical(permission_grant_ids, 128)
        AND omni_source_id_array_is_canonical(allowed_purpose_ids, 64)
      ),
      CONSTRAINT omni_source_items_hashes_check CHECK (
        permission_set_sha256 ~ '^[0-9a-f]{64}$'
        AND purpose_set_sha256 ~ '^[0-9a-f]{64}$'
        AND provider_item_key_sha256 ~ '^[0-9a-f]{64}$'
        AND metadata_sha256 ~ '^[0-9a-f]{64}$'
        AND extractor_config_sha256 ~ '^[0-9a-f]{64}$'
        AND source_item_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_output_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_config_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_event_key_sha256 ~ '^[0-9a-f]{64}$'
      ),
      CONSTRAINT omni_source_items_source_timestamps_check CHECK (
        source_created_at IS NULL
        OR source_updated_at IS NULL
        OR source_created_at <= source_updated_at
      )
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_source_revisions (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      contract_kind TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      source_item_id TEXT NOT NULL,
      previous_source_revision_id TEXT,
      owner_actor_id TEXT NOT NULL,
      workspace_id TEXT,
      project_id TEXT,
      mission_id TEXT,
      connection_id TEXT NOT NULL,
      visibility TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      permission_grant_ids TEXT[] NOT NULL,
      allowed_purpose_ids TEXT[] NOT NULL,
      retention_policy_id TEXT NOT NULL,
      retention_expires_at TIMESTAMPTZ,
      permission_set_sha256 TEXT NOT NULL,
      purpose_set_sha256 TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      provider_item_key_sha256 TEXT NOT NULL,
      provider_revision_key_sha256 TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      content_byte_length BIGINT NOT NULL,
      media_type TEXT NOT NULL,
      metadata_sha256 TEXT NOT NULL,
      source_created_at TIMESTAMPTZ,
      source_updated_at TIMESTAMPTZ,
      captured_at TIMESTAMPTZ NOT NULL,
      extractor_id TEXT NOT NULL,
      extractor_version_id TEXT NOT NULL,
      extractor_config_sha256 TEXT NOT NULL,
      model_version_id TEXT,
      source_revision_sha256 TEXT NOT NULL,
      adapter_output_id TEXT NOT NULL,
      adapter_output_sha256 TEXT NOT NULL,
      adapter_operation TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      adapter_version_id TEXT NOT NULL,
      adapter_config_sha256 TEXT NOT NULL,
      adapter_event_key_sha256 TEXT NOT NULL,
      adapter_observed_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_source_revisions_tenant_id_id_key
        UNIQUE (tenant_id, id),
      CONSTRAINT omni_source_revisions_tenant_item_key
        UNIQUE (tenant_id, id, source_item_id),
      CONSTRAINT omni_source_revisions_tenant_scope_key
        UNIQUE (
          tenant_id,
          id,
          source_item_id,
          owner_actor_id,
          connection_id
        ),
      CONSTRAINT omni_source_revisions_adapter_output_receipt_fkey
        FOREIGN KEY (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256,
          connection_id,
          adapter_operation,
          adapter_id,
          adapter_version_id,
          adapter_config_sha256,
          adapter_event_key_sha256,
          adapter_observed_at
        )
        REFERENCES omni_source_adapter_output_receipts (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256,
          connection_id,
          adapter_operation,
          adapter_id,
          adapter_version_id,
          adapter_config_sha256,
          adapter_event_key_sha256,
          adapter_observed_at
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_source_revisions_source_item_fkey
        FOREIGN KEY (tenant_id, source_item_id, owner_actor_id, connection_id)
        REFERENCES omni_source_items (
          tenant_id,
          id,
          owner_actor_id,
          connection_id
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_source_revisions_previous_revision_fkey
        FOREIGN KEY (tenant_id, previous_source_revision_id, source_item_id)
        REFERENCES omni_source_revisions (tenant_id, id, source_item_id)
        ON DELETE RESTRICT
        DEFERRABLE INITIALLY DEFERRED,
      CONSTRAINT omni_source_revisions_schema_check CHECK (
        schema_version = 1
        AND contract_kind = 'source_revision'
        AND adapter_operation = 'upsert'
      ),
      CONSTRAINT omni_source_revisions_source_kind_check CHECK (
        source_kind IN (
          'document', 'spreadsheet', 'presentation', 'email',
          'calendar_event', 'message', 'webpage', 'image', 'audio',
          'video', 'record', 'file', 'capture'
        )
      ),
      CONSTRAINT omni_source_revisions_visibility_check CHECK (
        visibility IN (
          'agent_private', 'user_private', 'mission_shared',
          'project_shared', 'workspace_shared'
        )
      ),
      CONSTRAINT omni_source_revisions_sensitivity_check CHECK (
        sensitivity IN ('public', 'internal', 'confidential', 'restricted')
      ),
      CONSTRAINT omni_source_revisions_visibility_scope_check CHECK (
        (visibility <> 'workspace_shared' OR workspace_id IS NOT NULL)
        AND (visibility <> 'project_shared' OR project_id IS NOT NULL)
        AND (visibility <> 'mission_shared' OR mission_id IS NOT NULL)
      ),
      CONSTRAINT omni_source_revisions_required_ids_check CHECK (
        omni_source_contract_id_is_valid(id)
        AND omni_source_contract_id_is_valid(tenant_id)
        AND omni_source_contract_id_is_valid(source_item_id)
        AND omni_source_contract_id_is_valid(owner_actor_id)
        AND omni_source_contract_id_is_valid(connection_id)
        AND omni_source_contract_id_is_valid(retention_policy_id)
        AND omni_source_contract_id_is_valid(extractor_id)
        AND omni_source_contract_id_is_valid(extractor_version_id)
        AND omni_source_contract_id_is_valid(adapter_output_id)
        AND omni_source_contract_id_is_valid(adapter_id)
        AND omni_source_contract_id_is_valid(adapter_version_id)
        AND (
          previous_source_revision_id IS NULL
          OR omni_source_contract_id_is_valid(previous_source_revision_id)
        )
        AND (
          workspace_id IS NULL
          OR omni_source_contract_id_is_valid(workspace_id)
        )
        AND (
          project_id IS NULL
          OR omni_source_contract_id_is_valid(project_id)
        )
        AND (
          mission_id IS NULL
          OR omni_source_contract_id_is_valid(mission_id)
        )
        AND (
          model_version_id IS NULL
          OR omni_source_contract_id_is_valid(model_version_id)
        )
      ),
      CONSTRAINT omni_source_revisions_grants_check CHECK (
        omni_source_id_array_is_canonical(permission_grant_ids, 128)
        AND omni_source_id_array_is_canonical(allowed_purpose_ids, 64)
      ),
      CONSTRAINT omni_source_revisions_hashes_check CHECK (
        permission_set_sha256 ~ '^[0-9a-f]{64}$'
        AND purpose_set_sha256 ~ '^[0-9a-f]{64}$'
        AND provider_item_key_sha256 ~ '^[0-9a-f]{64}$'
        AND provider_revision_key_sha256 ~ '^[0-9a-f]{64}$'
        AND content_sha256 ~ '^[0-9a-f]{64}$'
        AND metadata_sha256 ~ '^[0-9a-f]{64}$'
        AND extractor_config_sha256 ~ '^[0-9a-f]{64}$'
        AND source_revision_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_output_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_config_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_event_key_sha256 ~ '^[0-9a-f]{64}$'
      ),
      CONSTRAINT omni_source_revisions_content_length_check
        CHECK (content_byte_length BETWEEN 0 AND 9007199254740991),
      CONSTRAINT omni_source_revisions_previous_revision_check CHECK (
        previous_source_revision_id IS NULL
        OR previous_source_revision_id <> id
      ),
      CONSTRAINT omni_source_revisions_media_type_check CHECK (
        char_length(media_type) BETWEEN 3 AND 160
        AND media_type ~* '^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$'
      ),
      CONSTRAINT omni_source_revisions_source_timestamps_check CHECK (
        source_created_at IS NULL
        OR source_updated_at IS NULL
        OR source_created_at <= source_updated_at
      )
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_evidence_units (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      contract_kind TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      source_item_id TEXT NOT NULL,
      source_revision_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      workspace_id TEXT,
      project_id TEXT,
      mission_id TEXT,
      connection_id TEXT NOT NULL,
      visibility TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      permission_grant_ids TEXT[] NOT NULL,
      allowed_purpose_ids TEXT[] NOT NULL,
      retention_policy_id TEXT NOT NULL,
      retention_expires_at TIMESTAMPTZ,
      permission_set_sha256 TEXT NOT NULL,
      purpose_set_sha256 TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      provider_item_key_sha256 TEXT NOT NULL,
      evidence_content_sha256 TEXT NOT NULL,
      evidence_byte_length BIGINT NOT NULL,
      locator JSONB NOT NULL,
      locator_sha256 TEXT NOT NULL,
      source_created_at TIMESTAMPTZ,
      source_updated_at TIMESTAMPTZ,
      captured_at TIMESTAMPTZ NOT NULL,
      extracted_at TIMESTAMPTZ NOT NULL,
      extractor_id TEXT NOT NULL,
      extractor_version_id TEXT NOT NULL,
      extractor_config_sha256 TEXT NOT NULL,
      model_version_id TEXT,
      evidence_unit_sha256 TEXT NOT NULL,
      adapter_output_id TEXT NOT NULL,
      adapter_output_sha256 TEXT NOT NULL,
      adapter_operation TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      adapter_version_id TEXT NOT NULL,
      adapter_config_sha256 TEXT NOT NULL,
      adapter_event_key_sha256 TEXT NOT NULL,
      adapter_observed_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_evidence_units_tenant_id_id_key
        UNIQUE (tenant_id, id),
      CONSTRAINT omni_evidence_units_tenant_revision_key
        UNIQUE (tenant_id, id, source_revision_id),
      CONSTRAINT omni_evidence_units_adapter_output_receipt_fkey
        FOREIGN KEY (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256,
          connection_id,
          adapter_operation,
          adapter_id,
          adapter_version_id,
          adapter_config_sha256,
          adapter_event_key_sha256,
          adapter_observed_at
        )
        REFERENCES omni_source_adapter_output_receipts (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256,
          connection_id,
          adapter_operation,
          adapter_id,
          adapter_version_id,
          adapter_config_sha256,
          adapter_event_key_sha256,
          adapter_observed_at
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_evidence_units_revision_fkey
        FOREIGN KEY (
          tenant_id,
          source_revision_id,
          source_item_id,
          owner_actor_id,
          connection_id
        )
        REFERENCES omni_source_revisions (
          tenant_id,
          id,
          source_item_id,
          owner_actor_id,
          connection_id
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_evidence_units_schema_check CHECK (
        schema_version = 1
        AND contract_kind = 'evidence_unit'
        AND adapter_operation = 'upsert'
      ),
      CONSTRAINT omni_evidence_units_source_kind_check CHECK (
        source_kind IN (
          'document', 'spreadsheet', 'presentation', 'email',
          'calendar_event', 'message', 'webpage', 'image', 'audio',
          'video', 'record', 'file', 'capture'
        )
      ),
      CONSTRAINT omni_evidence_units_visibility_check CHECK (
        visibility IN (
          'agent_private', 'user_private', 'mission_shared',
          'project_shared', 'workspace_shared'
        )
      ),
      CONSTRAINT omni_evidence_units_sensitivity_check CHECK (
        sensitivity IN ('public', 'internal', 'confidential', 'restricted')
      ),
      CONSTRAINT omni_evidence_units_visibility_scope_check CHECK (
        (visibility <> 'workspace_shared' OR workspace_id IS NOT NULL)
        AND (visibility <> 'project_shared' OR project_id IS NOT NULL)
        AND (visibility <> 'mission_shared' OR mission_id IS NOT NULL)
      ),
      CONSTRAINT omni_evidence_units_required_ids_check CHECK (
        omni_source_contract_id_is_valid(id)
        AND omni_source_contract_id_is_valid(tenant_id)
        AND omni_source_contract_id_is_valid(source_item_id)
        AND omni_source_contract_id_is_valid(source_revision_id)
        AND omni_source_contract_id_is_valid(owner_actor_id)
        AND omni_source_contract_id_is_valid(connection_id)
        AND omni_source_contract_id_is_valid(retention_policy_id)
        AND omni_source_contract_id_is_valid(extractor_id)
        AND omni_source_contract_id_is_valid(extractor_version_id)
        AND omni_source_contract_id_is_valid(adapter_output_id)
        AND omni_source_contract_id_is_valid(adapter_id)
        AND omni_source_contract_id_is_valid(adapter_version_id)
        AND (
          workspace_id IS NULL
          OR omni_source_contract_id_is_valid(workspace_id)
        )
        AND (
          project_id IS NULL
          OR omni_source_contract_id_is_valid(project_id)
        )
        AND (
          mission_id IS NULL
          OR omni_source_contract_id_is_valid(mission_id)
        )
        AND (
          model_version_id IS NULL
          OR omni_source_contract_id_is_valid(model_version_id)
        )
      ),
      CONSTRAINT omni_evidence_units_grants_check CHECK (
        omni_source_id_array_is_canonical(permission_grant_ids, 128)
        AND omni_source_id_array_is_canonical(allowed_purpose_ids, 64)
      ),
      CONSTRAINT omni_evidence_units_hashes_check CHECK (
        permission_set_sha256 ~ '^[0-9a-f]{64}$'
        AND purpose_set_sha256 ~ '^[0-9a-f]{64}$'
        AND provider_item_key_sha256 ~ '^[0-9a-f]{64}$'
        AND evidence_content_sha256 ~ '^[0-9a-f]{64}$'
        AND locator_sha256 ~ '^[0-9a-f]{64}$'
        AND extractor_config_sha256 ~ '^[0-9a-f]{64}$'
        AND evidence_unit_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_output_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_config_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_event_key_sha256 ~ '^[0-9a-f]{64}$'
      ),
      CONSTRAINT omni_evidence_units_content_length_check
        CHECK (evidence_byte_length BETWEEN 0 AND 9007199254740991),
      CONSTRAINT omni_evidence_units_locator_check
        CHECK (omni_evidence_locator_v1_is_allowlisted(locator)),
      CONSTRAINT omni_evidence_units_source_timestamps_check CHECK (
        source_created_at IS NULL
        OR source_updated_at IS NULL
        OR source_created_at <= source_updated_at
      )
    )
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_source_items_current_revision_fkey'
          AND conrelid = 'omni_source_items'::regclass
      ) THEN
        ALTER TABLE omni_source_items
        ADD CONSTRAINT omni_source_items_current_revision_fkey
        FOREIGN KEY (tenant_id, current_revision_id, id)
        REFERENCES omni_source_revisions (tenant_id, id, source_item_id)
        ON DELETE RESTRICT
        DEFERRABLE INITIALLY DEFERRED;
      END IF;
    END
    $migration$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_source_revision_binding()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM omni_source_items source_item
        WHERE source_item.tenant_id = NEW.tenant_id
          AND source_item.id = NEW.source_item_id
          AND source_item.owner_actor_id = NEW.owner_actor_id
          AND source_item.workspace_id IS NOT DISTINCT FROM NEW.workspace_id
          AND source_item.project_id IS NOT DISTINCT FROM NEW.project_id
          AND source_item.mission_id IS NOT DISTINCT FROM NEW.mission_id
          AND source_item.connection_id = NEW.connection_id
          AND source_item.visibility = NEW.visibility
          AND source_item.sensitivity = NEW.sensitivity
          AND source_item.source_kind = NEW.source_kind
          AND source_item.provider_item_key_sha256 = NEW.provider_item_key_sha256
          AND source_item.source_created_at IS NOT DISTINCT FROM NEW.source_created_at
          AND source_item.source_updated_at IS NOT DISTINCT FROM NEW.source_updated_at
          AND source_item.captured_at = NEW.captured_at
          AND NEW.permission_grant_ids <@ source_item.permission_grant_ids
          AND NEW.allowed_purpose_ids <@ source_item.allowed_purpose_ids
          AND NEW.retention_policy_id = source_item.retention_policy_id
          AND (
            source_item.retention_expires_at IS NULL
            OR (
              NEW.retention_expires_at IS NOT NULL
              AND NEW.retention_expires_at <= source_item.retention_expires_at
            )
          )
      ) THEN
        RAISE EXCEPTION 'Source revision binding does not match its source item'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_evidence_unit_binding()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM omni_source_revisions source_revision
        WHERE source_revision.tenant_id = NEW.tenant_id
          AND source_revision.id = NEW.source_revision_id
          AND source_revision.source_item_id = NEW.source_item_id
          AND source_revision.owner_actor_id = NEW.owner_actor_id
          AND source_revision.workspace_id IS NOT DISTINCT FROM NEW.workspace_id
          AND source_revision.project_id IS NOT DISTINCT FROM NEW.project_id
          AND source_revision.mission_id IS NOT DISTINCT FROM NEW.mission_id
          AND source_revision.connection_id = NEW.connection_id
          AND source_revision.visibility = NEW.visibility
          AND source_revision.sensitivity = NEW.sensitivity
          AND source_revision.source_kind = NEW.source_kind
          AND source_revision.provider_item_key_sha256 = NEW.provider_item_key_sha256
          AND source_revision.source_created_at IS NOT DISTINCT FROM NEW.source_created_at
          AND source_revision.source_updated_at IS NOT DISTINCT FROM NEW.source_updated_at
          AND source_revision.captured_at = NEW.captured_at
          AND source_revision.adapter_output_id = NEW.adapter_output_id
          AND source_revision.adapter_output_sha256 = NEW.adapter_output_sha256
          AND source_revision.adapter_id = NEW.adapter_id
          AND source_revision.adapter_version_id = NEW.adapter_version_id
          AND source_revision.adapter_config_sha256 = NEW.adapter_config_sha256
          AND source_revision.adapter_event_key_sha256 = NEW.adapter_event_key_sha256
          AND source_revision.adapter_observed_at = NEW.adapter_observed_at
          AND NEW.permission_grant_ids <@ source_revision.permission_grant_ids
          AND NEW.allowed_purpose_ids <@ source_revision.allowed_purpose_ids
          AND NEW.retention_policy_id = source_revision.retention_policy_id
          AND (
            source_revision.retention_expires_at IS NULL
            OR (
              NEW.retention_expires_at IS NOT NULL
              AND NEW.retention_expires_at <= source_revision.retention_expires_at
            )
          )
      ) THEN
        RAISE EXCEPTION 'Evidence unit binding does not match its source revision'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_revisions_validate_binding'
          AND tgrelid = 'omni_source_revisions'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_revisions_validate_binding
        BEFORE INSERT ON omni_source_revisions
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_source_revision_binding();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_evidence_units_validate_binding'
          AND tgrelid = 'omni_evidence_units'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_evidence_units_validate_binding
        BEFORE INSERT ON omni_evidence_units
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_evidence_unit_binding();
      END IF;
    END
    $migration$
  `;

  await sql`
    ALTER TABLE omni_knowledge_documents
    ADD COLUMN IF NOT EXISTS source_item_id TEXT
  `;
  await sql`
    ALTER TABLE omni_knowledge_documents
    ADD COLUMN IF NOT EXISTS source_revision_id TEXT
  `;
  await sql`
    ALTER TABLE omni_knowledge_chunks
    ADD COLUMN IF NOT EXISTS source_revision_id TEXT
  `;
  await sql`
    ALTER TABLE omni_knowledge_chunks
    ADD COLUMN IF NOT EXISTS evidence_unit_id TEXT
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS omni_knowledge_documents_tenant_id_id_idx
    ON omni_knowledge_documents (tenant_id, id)
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS omni_knowledge_documents_tenant_revision_idx
    ON omni_knowledge_documents (tenant_id, id, source_revision_id)
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_knowledge_documents_lineage_pair_check'
          AND conrelid = 'omni_knowledge_documents'::regclass
      ) THEN
        ALTER TABLE omni_knowledge_documents
        ADD CONSTRAINT omni_knowledge_documents_lineage_pair_check
        CHECK (
          (source_item_id IS NULL AND source_revision_id IS NULL)
          OR (source_item_id IS NOT NULL AND source_revision_id IS NOT NULL)
        );
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_knowledge_documents_source_revision_fkey'
          AND conrelid = 'omni_knowledge_documents'::regclass
      ) THEN
        ALTER TABLE omni_knowledge_documents
        ADD CONSTRAINT omni_knowledge_documents_source_revision_fkey
        FOREIGN KEY (tenant_id, source_revision_id, source_item_id)
        REFERENCES omni_source_revisions (tenant_id, id, source_item_id)
        ON DELETE RESTRICT;
      END IF;
    END
    $migration$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_knowledge_chunks_lineage_pair_check'
          AND conrelid = 'omni_knowledge_chunks'::regclass
      ) THEN
        ALTER TABLE omni_knowledge_chunks
        ADD CONSTRAINT omni_knowledge_chunks_lineage_pair_check
        CHECK (
          (source_revision_id IS NULL AND evidence_unit_id IS NULL)
          OR (source_revision_id IS NOT NULL AND evidence_unit_id IS NOT NULL)
        );
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_knowledge_chunks_tenant_document_fkey'
          AND conrelid = 'omni_knowledge_chunks'::regclass
      ) THEN
        ALTER TABLE omni_knowledge_chunks
        ADD CONSTRAINT omni_knowledge_chunks_tenant_document_fkey
        FOREIGN KEY (tenant_id, document_id)
        REFERENCES omni_knowledge_documents (tenant_id, id)
        ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_knowledge_chunks_document_revision_fkey'
          AND conrelid = 'omni_knowledge_chunks'::regclass
      ) THEN
        ALTER TABLE omni_knowledge_chunks
        ADD CONSTRAINT omni_knowledge_chunks_document_revision_fkey
        FOREIGN KEY (tenant_id, document_id, source_revision_id)
        REFERENCES omni_knowledge_documents (tenant_id, id, source_revision_id)
        ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_knowledge_chunks_evidence_revision_fkey'
          AND conrelid = 'omni_knowledge_chunks'::regclass
      ) THEN
        ALTER TABLE omni_knowledge_chunks
        ADD CONSTRAINT omni_knowledge_chunks_evidence_revision_fkey
        FOREIGN KEY (tenant_id, evidence_unit_id, source_revision_id)
        REFERENCES omni_evidence_units (tenant_id, id, source_revision_id)
        ON DELETE RESTRICT;
      END IF;
    END
    $migration$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_immutable_source_lineage_change()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION '% rows are immutable; % is not permitted',
        TG_TABLE_NAME,
        TG_OP
        USING ERRCODE = '55000';
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_adapter_output_receipt_change()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION '% rows are immutable; % is not permitted',
        TG_TABLE_NAME,
        TG_OP
        USING ERRCODE = '55000';
    END
    $function$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_adapter_output_receipts_immutable'
          AND tgrelid = 'omni_source_adapter_output_receipts'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_adapter_output_receipts_immutable
        BEFORE UPDATE OR DELETE ON omni_source_adapter_output_receipts
        FOR EACH ROW
        EXECUTE FUNCTION omni_reject_adapter_output_receipt_change();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_adapter_output_receipts_no_truncate'
          AND tgrelid = 'omni_source_adapter_output_receipts'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_adapter_output_receipts_no_truncate
        BEFORE TRUNCATE ON omni_source_adapter_output_receipts
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_reject_adapter_output_receipt_change();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_revisions_immutable'
          AND tgrelid = 'omni_source_revisions'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_revisions_immutable
        BEFORE UPDATE OR DELETE ON omni_source_revisions
        FOR EACH ROW
        EXECUTE FUNCTION omni_reject_immutable_source_lineage_change();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_revisions_no_truncate'
          AND tgrelid = 'omni_source_revisions'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_revisions_no_truncate
        BEFORE TRUNCATE ON omni_source_revisions
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_reject_immutable_source_lineage_change();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_evidence_units_immutable'
          AND tgrelid = 'omni_evidence_units'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_evidence_units_immutable
        BEFORE UPDATE OR DELETE ON omni_evidence_units
        FOR EACH ROW
        EXECUTE FUNCTION omni_reject_immutable_source_lineage_change();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_evidence_units_no_truncate'
          AND tgrelid = 'omni_evidence_units'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_evidence_units_no_truncate
        BEFORE TRUNCATE ON omni_evidence_units
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_reject_immutable_source_lineage_change();
      END IF;
    END
    $migration$
  `;

  await sql`CREATE INDEX IF NOT EXISTS omni_source_items_tenant_actor_updated_idx ON omni_source_items (tenant_id, owner_actor_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_source_items_tenant_scope_idx ON omni_source_items (tenant_id, workspace_id, project_id, mission_id)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_source_items_tenant_provider_key_idx ON omni_source_items (tenant_id, connection_id, provider_item_key_sha256)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_source_items_tenant_current_revision_idx ON omni_source_items (tenant_id, current_revision_id) WHERE current_revision_id IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS omni_source_items_tenant_adapter_output_idx ON omni_source_items (tenant_id, adapter_output_id)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_source_items_retention_expiry_idx ON omni_source_items (retention_expires_at) WHERE retention_expires_at IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS omni_source_revisions_tenant_item_captured_idx ON omni_source_revisions (tenant_id, source_item_id, captured_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_source_revisions_tenant_content_hash_idx ON omni_source_revisions (tenant_id, content_sha256)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_source_revisions_tenant_provider_revision_idx ON omni_source_revisions (tenant_id, source_item_id, provider_revision_key_sha256)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_source_revisions_tenant_previous_idx ON omni_source_revisions (tenant_id, previous_source_revision_id) WHERE previous_source_revision_id IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS omni_source_revisions_tenant_adapter_output_idx ON omni_source_revisions (tenant_id, adapter_output_id)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_source_revisions_retention_expiry_idx ON omni_source_revisions (retention_expires_at) WHERE retention_expires_at IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS omni_evidence_units_tenant_revision_locator_idx ON omni_evidence_units (tenant_id, source_revision_id, locator_sha256)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_evidence_units_tenant_content_hash_idx ON omni_evidence_units (tenant_id, evidence_content_sha256)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_evidence_units_tenant_adapter_output_idx ON omni_evidence_units (tenant_id, adapter_output_id)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_evidence_units_permission_grants_idx ON omni_evidence_units USING GIN (permission_grant_ids)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_evidence_units_retention_expiry_idx ON omni_evidence_units (retention_expires_at) WHERE retention_expires_at IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_documents_tenant_source_revision_idx ON omni_knowledge_documents (tenant_id, source_revision_id) WHERE source_revision_id IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_chunks_tenant_source_revision_idx ON omni_knowledge_chunks (tenant_id, source_revision_id) WHERE source_revision_id IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_chunks_tenant_evidence_unit_idx ON omni_knowledge_chunks (tenant_id, evidence_unit_id) WHERE evidence_unit_id IS NOT NULL`;

  // New lineage tables inherit only the DML capabilities already granted on
  // the existing knowledge-document boundary. This keeps dedicated runtime,
  // maintenance, and backup roles working without hard-coding role names.
  await sql.query(`
    DO $migration$
    DECLARE
      grant_record RECORD;
      target_table TEXT;
    BEGIN
      FOREACH target_table IN ARRAY ARRAY[
        'omni_source_adapter_output_receipts',
        'omni_source_revisions',
        'omni_evidence_units'
      ] LOOP
        FOR grant_record IN
          SELECT DISTINCT grantee, privilege_type
          FROM information_schema.table_privileges
          WHERE table_schema = current_schema()
            AND table_name = 'omni_knowledge_documents'
            AND privilege_type IN ('SELECT', 'INSERT')
            AND grantee <> current_user
            AND grantee <> 'PUBLIC'
        LOOP
          EXECUTE format(
            'GRANT %s ON TABLE %I.%I TO %I',
            grant_record.privilege_type,
            current_schema(),
            target_table,
            grant_record.grantee
          );
        END LOOP;
      END LOOP;

      FOR grant_record IN
        SELECT DISTINCT grantee, privilege_type
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_knowledge_documents'
          AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE')
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'GRANT %s ON TABLE %I.omni_source_items TO %I',
          grant_record.privilege_type,
          current_schema(),
          grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `);
}

export async function ensureDriveSyncV2ShadowCheckpoints(sql: SqlClient) {
  await ensureOAuthGrants(sql);

  await sql`
    ALTER TABLE omni_oauth_grants
    ADD COLUMN IF NOT EXISTS authorization_generation BIGINT
  `;
  await sql`
    UPDATE omni_oauth_grants
    SET authorization_generation = 1
    WHERE authorization_generation IS NULL
       OR authorization_generation < 1
  `;
  await sql`
    ALTER TABLE omni_oauth_grants
    ALTER COLUMN authorization_generation SET DEFAULT 1
  `;
  await sql`
    ALTER TABLE omni_oauth_grants
    ALTER COLUMN authorization_generation SET NOT NULL
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_oauth_grants_authorization_generation_check'
          AND conrelid = 'omni_oauth_grants'::regclass
      ) THEN
        ALTER TABLE omni_oauth_grants
        ADD CONSTRAINT omni_oauth_grants_authorization_generation_check
        CHECK (authorization_generation >= 1);
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_oauth_grants_connection_scope_key'
          AND conrelid = 'omni_oauth_grants'::regclass
      ) THEN
        ALTER TABLE omni_oauth_grants
        ADD CONSTRAINT omni_oauth_grants_connection_scope_key
        UNIQUE (tenant_id, id, actor_id, provider);
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_oauth_grants_authorization_scope_key'
          AND conrelid = 'omni_oauth_grants'::regclass
      ) THEN
        ALTER TABLE omni_oauth_grants
        ADD CONSTRAINT omni_oauth_grants_authorization_scope_key
        UNIQUE (
          tenant_id,
          id,
          actor_id,
          provider,
          authorization_generation
        );
      END IF;
    END
    $migration$
  `;

  await sql`
    ALTER TABLE omni_source_adapter_output_receipts
    DROP CONSTRAINT IF EXISTS omni_source_adapter_output_receipts_schema_check
  `;
  await sql`
    ALTER TABLE omni_source_adapter_output_receipts
    ADD CONSTRAINT omni_source_adapter_output_receipts_schema_check CHECK (
      schema_version = 1
      AND contract_kind = 'source_adapter_output'
      AND adapter_operation IN ('upsert', 'delete')
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS
      omni_source_adapter_output_receipts_tenant_output_digest_idx
    ON omni_source_adapter_output_receipts (
      tenant_id,
      adapter_output_id,
      adapter_output_sha256
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_source_sync_page_checkpoints (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'google',
      source_id TEXT NOT NULL DEFAULT 'drive',
      engine_version TEXT NOT NULL,
      adapter_version_id TEXT NOT NULL,
      adapter_config_sha256 TEXT NOT NULL,
      authorization_generation BIGINT NOT NULL,
      rollout_generation BIGINT NOT NULL,
      phase TEXT NOT NULL,
      page_sequence BIGINT NOT NULL,
      request_cursor_sealed JSONB,
      request_cursor_sha256 TEXT,
      fence_cursor_sha256 TEXT,
      observed_at TIMESTAMPTZ,
      manifest_sha256 TEXT,
      item_count INTEGER,
      status TEXT NOT NULL DEFAULT 'open',
      lease_owner_id TEXT,
      lease_expires_at TIMESTAMPTZ,
      lease_generation BIGINT NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      failure_code TEXT,
      failure_sha256 TEXT,
      committed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_source_sync_page_checkpoints_scope_key
        UNIQUE (
          tenant_id,
          id,
          owner_actor_id,
          connection_id,
          provider,
          source_id,
          engine_version,
          authorization_generation,
          rollout_generation,
          page_sequence
        ),
      CONSTRAINT omni_source_sync_page_checkpoints_page_key
        UNIQUE (
          tenant_id,
          owner_actor_id,
          connection_id,
          provider,
          source_id,
          authorization_generation,
          rollout_generation,
          page_sequence
        ),
      CONSTRAINT omni_source_sync_page_checkpoints_oauth_scope_fkey
        FOREIGN KEY (
          tenant_id,
          connection_id,
          owner_actor_id,
          provider
        )
        REFERENCES omni_oauth_grants (
          tenant_id,
          id,
          actor_id,
          provider
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_source_sync_page_checkpoints_schema_check CHECK (
        schema_version = 1
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_source_check CHECK (
        provider = 'google'
        AND source_id = 'drive'
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_required_ids_check CHECK (
        omni_source_contract_id_is_valid(id)
        AND omni_source_contract_id_is_valid(tenant_id)
        AND omni_source_contract_id_is_valid(owner_actor_id)
        AND omni_source_contract_id_is_valid(connection_id)
        AND omni_source_contract_id_is_valid(provider)
        AND omni_source_contract_id_is_valid(source_id)
        AND omni_source_contract_id_is_valid(engine_version)
        AND omni_source_contract_id_is_valid(adapter_version_id)
        AND (
          lease_owner_id IS NULL
          OR omni_source_contract_id_is_valid(lease_owner_id)
        )
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_hashes_check CHECK (
        adapter_config_sha256 ~ '^[0-9a-f]{64}$'
        AND (
          request_cursor_sha256 IS NULL
          OR request_cursor_sha256 ~ '^[0-9a-f]{64}$'
        )
        AND (
          fence_cursor_sha256 IS NULL
          OR fence_cursor_sha256 ~ '^[0-9a-f]{64}$'
        )
        AND (
          manifest_sha256 IS NULL
          OR manifest_sha256 ~ '^[0-9a-f]{64}$'
        )
        AND (
          failure_sha256 IS NULL
          OR failure_sha256 ~ '^[0-9a-f]{64}$'
        )
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_cursor_pair_check CHECK (
        (
          request_cursor_sealed IS NULL
          AND request_cursor_sha256 IS NULL
          AND fence_cursor_sha256 IS NULL
        )
        OR (
          request_cursor_sealed IS NOT NULL
          AND (
            request_cursor_sha256 IS NOT NULL
            OR fence_cursor_sha256 IS NOT NULL
          )
        )
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_sealed_cursor_check CHECK (
        request_cursor_sealed IS NULL
        OR (
          jsonb_typeof(request_cursor_sealed) = 'object'
          AND request_cursor_sealed ?& ARRAY[
            'version', 'algorithm', 'iv', 'ciphertext', 'tag'
          ]
          AND request_cursor_sealed - ARRAY[
            'version', 'algorithm', 'iv', 'ciphertext', 'tag'
          ] = '{}'::JSONB
          AND jsonb_typeof(request_cursor_sealed -> 'version') = 'number'
          AND request_cursor_sealed ->> 'version' = '1'
          AND jsonb_typeof(request_cursor_sealed -> 'algorithm') = 'string'
          AND request_cursor_sealed ->> 'algorithm' = 'aes-256-gcm'
          AND jsonb_typeof(request_cursor_sealed -> 'iv') = 'string'
          AND request_cursor_sealed ->> 'iv' ~ '^[A-Za-z0-9_-]{16}$'
          AND jsonb_typeof(request_cursor_sealed -> 'tag') = 'string'
          AND request_cursor_sealed ->> 'tag' ~ '^[A-Za-z0-9_-]{22}$'
          AND jsonb_typeof(request_cursor_sealed -> 'ciphertext') = 'string'
          AND request_cursor_sealed ->> 'ciphertext' ~ '^[A-Za-z0-9_-]*$'
          AND char_length(request_cursor_sealed ->> 'ciphertext') <= 32768
        )
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_phase_check CHECK (
        phase IN ('backfill', 'changes')
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_status_check CHECK (
        status IN (
          'open', 'leased', 'observed', 'committed',
          'dead_letter', 'superseded'
        )
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_counts_check CHECK (
        authorization_generation >= 1
        AND rollout_generation >= 1
        AND page_sequence >= 0
        AND lease_generation >= 0
        AND attempts >= 0
        AND (
          item_count IS NULL
          OR item_count BETWEEN 0 AND 1000
        )
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_observation_check CHECK (
        (
          observed_at IS NULL
          AND manifest_sha256 IS NULL
          AND item_count IS NULL
        )
        OR (
          observed_at IS NOT NULL
          AND manifest_sha256 IS NOT NULL
          AND item_count IS NOT NULL
        )
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_lease_check CHECK (
        (
          status IN ('leased', 'observed')
          AND lease_owner_id IS NOT NULL
          AND lease_expires_at IS NOT NULL
        )
        OR (
          status NOT IN ('leased', 'observed')
          AND lease_owner_id IS NULL
          AND lease_expires_at IS NULL
        )
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_failure_check CHECK (
        (failure_code IS NULL) = (failure_sha256 IS NULL)
        AND (
          failure_code IS NULL
          OR (
            char_length(failure_code) BETWEEN 1 AND 120
            AND failure_code ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
          )
        )
        AND (
          status <> 'dead_letter'
          OR failure_code IS NOT NULL
        )
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_commit_check CHECK (
        (
          status = 'committed'
          AND committed_at IS NOT NULL
          AND observed_at IS NOT NULL
          AND manifest_sha256 IS NOT NULL
          AND item_count IS NOT NULL
          AND request_cursor_sealed IS NOT NULL
          AND fence_cursor_sha256 IS NOT NULL
        )
        OR (
          status <> 'committed'
          AND committed_at IS NULL
        )
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_timestamps_check CHECK (
        created_at <= updated_at
        AND (committed_at IS NULL OR committed_at <= updated_at)
      )
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_source_sync_page_items (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'google',
      source_id TEXT NOT NULL DEFAULT 'drive',
      engine_version TEXT NOT NULL,
      authorization_generation BIGINT NOT NULL,
      rollout_generation BIGINT NOT NULL,
      phase_rank SMALLINT NOT NULL,
      page_sequence BIGINT NOT NULL,
      ordinal INTEGER NOT NULL,
      operation TEXT NOT NULL,
      provider_item_key_sha256 TEXT NOT NULL,
      provider_revision_key_sha256 TEXT,
      adapter_event_key_sha256 TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      manifest_item_sha256 TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'shadow_observed',
      source_item_id TEXT,
      source_revision_id TEXT,
      adapter_output_id TEXT,
      adapter_output_sha256 TEXT,
      delete_reason_code TEXT,
      last_known_revision_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_sha256 TEXT,
      next_retry_at TIMESTAMPTZ,
      applied_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_source_sync_page_items_checkpoint_ordinal_key
        UNIQUE (tenant_id, checkpoint_id, ordinal),
      CONSTRAINT omni_source_sync_page_items_checkpoint_event_key
        UNIQUE (tenant_id, checkpoint_id, adapter_event_key_sha256),
      CONSTRAINT omni_source_sync_page_items_checkpoint_fkey
        FOREIGN KEY (
          tenant_id,
          checkpoint_id,
          owner_actor_id,
          connection_id,
          provider,
          source_id,
          engine_version,
          authorization_generation,
          rollout_generation,
          page_sequence
        )
        REFERENCES omni_source_sync_page_checkpoints (
          tenant_id,
          id,
          owner_actor_id,
          connection_id,
          provider,
          source_id,
          engine_version,
          authorization_generation,
          rollout_generation,
          page_sequence
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_source_sync_page_items_adapter_output_fkey
        FOREIGN KEY (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256
        )
        REFERENCES omni_source_adapter_output_receipts (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_source_sync_page_items_schema_check CHECK (
        schema_version = 1
      ),
      CONSTRAINT omni_source_sync_page_items_source_check CHECK (
        provider = 'google'
        AND source_id = 'drive'
      ),
      CONSTRAINT omni_source_sync_page_items_required_ids_check CHECK (
        omni_source_contract_id_is_valid(id)
        AND omni_source_contract_id_is_valid(tenant_id)
        AND omni_source_contract_id_is_valid(checkpoint_id)
        AND omni_source_contract_id_is_valid(owner_actor_id)
        AND omni_source_contract_id_is_valid(connection_id)
        AND omni_source_contract_id_is_valid(provider)
        AND omni_source_contract_id_is_valid(source_id)
        AND omni_source_contract_id_is_valid(engine_version)
        AND (
          source_item_id IS NULL
          OR omni_source_contract_id_is_valid(source_item_id)
        )
        AND (
          source_revision_id IS NULL
          OR omni_source_contract_id_is_valid(source_revision_id)
        )
        AND (
          adapter_output_id IS NULL
          OR omni_source_contract_id_is_valid(adapter_output_id)
        )
        AND (
          last_known_revision_id IS NULL
          OR omni_source_contract_id_is_valid(last_known_revision_id)
        )
      ),
      CONSTRAINT omni_source_sync_page_items_hashes_check CHECK (
        provider_item_key_sha256 ~ '^[0-9a-f]{64}$'
        AND (
          provider_revision_key_sha256 IS NULL
          OR provider_revision_key_sha256 ~ '^[0-9a-f]{64}$'
        )
        AND adapter_event_key_sha256 ~ '^[0-9a-f]{64}$'
        AND manifest_item_sha256 ~ '^[0-9a-f]{64}$'
        AND (
          adapter_output_sha256 IS NULL
          OR adapter_output_sha256 ~ '^[0-9a-f]{64}$'
        )
        AND (
          error_sha256 IS NULL
          OR error_sha256 ~ '^[0-9a-f]{64}$'
        )
      ),
      CONSTRAINT omni_source_sync_page_items_order_check CHECK (
        authorization_generation >= 1
        AND rollout_generation >= 1
        AND phase_rank IN (0, 1)
        AND page_sequence >= 0
        AND ordinal BETWEEN 0 AND 999
        AND attempts >= 0
      ),
      CONSTRAINT omni_source_sync_page_items_operation_check CHECK (
        operation IN ('upsert', 'delete')
      ),
      CONSTRAINT omni_source_sync_page_items_outcome_check CHECK (
        outcome IN (
          'shadow_observed', 'pending', 'applied', 'noop', 'dead_letter'
        )
      ),
      CONSTRAINT omni_source_sync_page_items_adapter_output_pair_check CHECK (
        (adapter_output_id IS NULL) = (adapter_output_sha256 IS NULL)
      ),
      CONSTRAINT omni_source_sync_page_items_delete_check CHECK (
        (
          operation = 'upsert'
          AND delete_reason_code IS NULL
          AND last_known_revision_id IS NULL
        )
        OR (
          operation = 'delete'
          AND (
            delete_reason_code IS NULL
            OR delete_reason_code IN (
              'provider_deleted', 'access_revoked',
              'connection_removed', 'source_missing'
            )
          )
        )
      ),
      CONSTRAINT omni_source_sync_page_items_error_check CHECK (
        (error_code IS NULL) = (error_sha256 IS NULL)
        AND (
          error_code IS NULL
          OR (
            char_length(error_code) BETWEEN 1 AND 120
            AND error_code ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
          )
        )
        AND (
          outcome = 'dead_letter'
          OR (
            error_code IS NULL
            AND next_retry_at IS NULL
          )
        )
        AND (
          outcome <> 'dead_letter'
          OR error_code IS NOT NULL
        )
      ),
      CONSTRAINT omni_source_sync_page_items_applied_check CHECK (
        (
          outcome = 'applied'
          AND applied_at IS NOT NULL
          AND source_item_id IS NOT NULL
          AND adapter_output_id IS NOT NULL
          AND (
            (operation = 'upsert' AND source_revision_id IS NOT NULL)
            OR (operation = 'delete' AND delete_reason_code IS NOT NULL)
          )
        )
        OR (
          outcome = 'noop'
          AND applied_at IS NOT NULL
          AND source_item_id IS NOT NULL
        )
        OR (
          outcome NOT IN ('applied', 'noop')
          AND applied_at IS NULL
        )
      ),
      CONSTRAINT omni_source_sync_page_items_timestamps_check CHECK (
        created_at <= updated_at
        AND (applied_at IS NULL OR applied_at <= updated_at)
      )
    )
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS
      omni_source_sync_page_checkpoints_one_nonterminal_idx
    ON omni_source_sync_page_checkpoints (
      tenant_id,
      owner_actor_id,
      connection_id,
      provider,
      source_id,
      authorization_generation,
      rollout_generation
    )
    WHERE status NOT IN ('committed', 'superseded')
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_sync_page_checkpoints_due_idx
    ON omni_source_sync_page_checkpoints (
      tenant_id,
      status,
      lease_expires_at,
      updated_at
    )
    WHERE status NOT IN ('committed', 'superseded')
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_sync_page_items_outcome_idx
    ON omni_source_sync_page_items (
      tenant_id,
      checkpoint_id,
      outcome,
      ordinal
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_sync_page_items_source_order_idx
    ON omni_source_sync_page_items (
      tenant_id,
      owner_actor_id,
      connection_id,
      source_item_id,
      authorization_generation DESC,
      rollout_generation DESC,
      phase_rank DESC,
      page_sequence DESC,
      ordinal DESC
    )
    WHERE source_item_id IS NOT NULL
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_source_sync_checkpoint_scope()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      PERFORM 1
      FROM omni_oauth_grants grant_record
      WHERE grant_record.tenant_id = NEW.tenant_id
        AND grant_record.id = NEW.connection_id
        AND grant_record.actor_id = NEW.owner_actor_id
        AND grant_record.provider = NEW.provider
        AND grant_record.status = 'active'
        AND grant_record.authorization_generation =
          NEW.authorization_generation
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Source sync checkpoint authorization is stale'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_protect_source_sync_checkpoint()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      stored_item_count BIGINT;
      unresolved_item_count BIGINT;
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION '% rows cannot be changed with %', TG_TABLE_NAME, TG_OP
          USING ERRCODE = '55000';
      END IF;

      IF OLD.status IN ('committed', 'superseded') THEN
        RAISE EXCEPTION '% terminal rows are immutable', TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.owner_actor_id IS DISTINCT FROM OLD.owner_actor_id
        OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
        OR NEW.provider IS DISTINCT FROM OLD.provider
        OR NEW.source_id IS DISTINCT FROM OLD.source_id
        OR NEW.engine_version IS DISTINCT FROM OLD.engine_version
        OR NEW.adapter_version_id IS DISTINCT FROM OLD.adapter_version_id
        OR NEW.adapter_config_sha256 IS DISTINCT FROM OLD.adapter_config_sha256
        OR NEW.authorization_generation IS DISTINCT FROM OLD.authorization_generation
        OR NEW.rollout_generation IS DISTINCT FROM OLD.rollout_generation
        OR NEW.phase IS DISTINCT FROM OLD.phase
        OR NEW.page_sequence IS DISTINCT FROM OLD.page_sequence
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
      THEN
        RAISE EXCEPTION '% identity is immutable', TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      IF (OLD.request_cursor_sealed IS NOT NULL AND
          NEW.request_cursor_sealed IS DISTINCT FROM OLD.request_cursor_sealed)
        OR (OLD.request_cursor_sha256 IS NOT NULL AND
          NEW.request_cursor_sha256 IS DISTINCT FROM OLD.request_cursor_sha256)
        OR (OLD.fence_cursor_sha256 IS NOT NULL AND
          NEW.fence_cursor_sha256 IS DISTINCT FROM OLD.fence_cursor_sha256)
        OR (
          OLD.manifest_sha256 IS NOT NULL
          AND (
            NEW.observed_at IS DISTINCT FROM OLD.observed_at
            OR NEW.manifest_sha256 IS DISTINCT FROM OLD.manifest_sha256
            OR NEW.item_count IS DISTINCT FROM OLD.item_count
          )
        )
      THEN
        RAISE EXCEPTION '% initialized cursor or manifest is immutable',
          TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      IF NEW.lease_generation < OLD.lease_generation
        OR NEW.attempts < OLD.attempts
      THEN
        RAISE EXCEPTION '% counters cannot move backwards', TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      IF OLD.status <> 'committed' AND NEW.status = 'committed' THEN
        SELECT
          COUNT(*),
          COUNT(*) FILTER (
            WHERE item.outcome IN ('pending', 'dead_letter')
          )
        INTO stored_item_count, unresolved_item_count
        FROM omni_source_sync_page_items item
        WHERE item.tenant_id = NEW.tenant_id
          AND item.checkpoint_id = NEW.id
          AND item.owner_actor_id = NEW.owner_actor_id
          AND item.connection_id = NEW.connection_id
          AND item.provider = NEW.provider
          AND item.source_id = NEW.source_id
          AND item.engine_version = NEW.engine_version
          AND item.authorization_generation = NEW.authorization_generation
          AND item.rollout_generation = NEW.rollout_generation
          AND item.page_sequence = NEW.page_sequence;

        IF NEW.item_count IS NULL
          OR stored_item_count <> NEW.item_count
          OR unresolved_item_count <> 0
        THEN
          RAISE EXCEPTION 'Source sync committed page manifest is incomplete'
            USING ERRCODE = '23514';
        END IF;
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_source_sync_page_item_binding()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      checkpoint_phase TEXT;
      checkpoint_status TEXT;
      expected_phase_rank SMALLINT;
    BEGIN
      SELECT checkpoint.phase, checkpoint.status
      INTO checkpoint_phase, checkpoint_status
      FROM omni_source_sync_page_checkpoints checkpoint
      WHERE checkpoint.tenant_id = NEW.tenant_id
        AND checkpoint.id = NEW.checkpoint_id
        AND checkpoint.owner_actor_id = NEW.owner_actor_id
        AND checkpoint.connection_id = NEW.connection_id
        AND checkpoint.provider = NEW.provider
        AND checkpoint.source_id = NEW.source_id
        AND checkpoint.engine_version = NEW.engine_version
        AND checkpoint.authorization_generation = NEW.authorization_generation
        AND checkpoint.rollout_generation = NEW.rollout_generation
        AND checkpoint.page_sequence = NEW.page_sequence
      FOR UPDATE;

      IF checkpoint_phase = 'backfill' THEN
        expected_phase_rank := 0;
      ELSIF checkpoint_phase = 'changes' THEN
        expected_phase_rank := 1;
      ELSE
        expected_phase_rank := -1;
      END IF;

      IF checkpoint_phase IS NULL
        OR NEW.phase_rank <> expected_phase_rank
      THEN
        RAISE EXCEPTION 'Source sync page item does not match its checkpoint'
          USING ERRCODE = '23514';
      END IF;

      IF TG_OP = 'INSERT' AND checkpoint_status <> 'leased' THEN
        RAISE EXCEPTION 'Source sync page items require an active page lease'
          USING ERRCODE = '55000';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_protect_source_sync_page_item()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION '% rows cannot be changed with %', TG_TABLE_NAME, TG_OP
          USING ERRCODE = '55000';
      END IF;

      IF OLD.outcome IN ('shadow_observed', 'applied', 'noop') THEN
        RAISE EXCEPTION '% terminal outcomes are immutable', TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.checkpoint_id IS DISTINCT FROM OLD.checkpoint_id
        OR NEW.owner_actor_id IS DISTINCT FROM OLD.owner_actor_id
        OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
        OR NEW.provider IS DISTINCT FROM OLD.provider
        OR NEW.source_id IS DISTINCT FROM OLD.source_id
        OR NEW.engine_version IS DISTINCT FROM OLD.engine_version
        OR NEW.authorization_generation IS DISTINCT FROM OLD.authorization_generation
        OR NEW.rollout_generation IS DISTINCT FROM OLD.rollout_generation
        OR NEW.phase_rank IS DISTINCT FROM OLD.phase_rank
        OR NEW.page_sequence IS DISTINCT FROM OLD.page_sequence
        OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
        OR NEW.operation IS DISTINCT FROM OLD.operation
        OR NEW.provider_item_key_sha256 IS DISTINCT FROM OLD.provider_item_key_sha256
        OR NEW.provider_revision_key_sha256 IS DISTINCT FROM OLD.provider_revision_key_sha256
        OR NEW.adapter_event_key_sha256 IS DISTINCT FROM OLD.adapter_event_key_sha256
        OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
        OR NEW.manifest_item_sha256 IS DISTINCT FROM OLD.manifest_item_sha256
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
      THEN
        RAISE EXCEPTION '% identity is immutable', TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      IF (OLD.source_item_id IS NOT NULL AND
          NEW.source_item_id IS DISTINCT FROM OLD.source_item_id)
        OR (OLD.source_revision_id IS NOT NULL AND
          NEW.source_revision_id IS DISTINCT FROM OLD.source_revision_id)
        OR (OLD.adapter_output_id IS NOT NULL AND
          NEW.adapter_output_id IS DISTINCT FROM OLD.adapter_output_id)
        OR (OLD.adapter_output_sha256 IS NOT NULL AND
          NEW.adapter_output_sha256 IS DISTINCT FROM OLD.adapter_output_sha256)
        OR (OLD.delete_reason_code IS NOT NULL AND
          NEW.delete_reason_code IS DISTINCT FROM OLD.delete_reason_code)
        OR (OLD.last_known_revision_id IS NOT NULL AND
          NEW.last_known_revision_id IS DISTINCT FROM OLD.last_known_revision_id)
      THEN
        RAISE EXCEPTION '% initialized outcome bindings are immutable',
          TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      IF NEW.attempts < OLD.attempts THEN
        RAISE EXCEPTION '% attempts cannot move backwards', TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_sync_page_checkpoints_validate_scope'
          AND tgrelid = 'omni_source_sync_page_checkpoints'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_sync_page_checkpoints_validate_scope
        BEFORE INSERT ON omni_source_sync_page_checkpoints
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_source_sync_checkpoint_scope();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_sync_page_checkpoints_protect'
          AND tgrelid = 'omni_source_sync_page_checkpoints'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_sync_page_checkpoints_protect
        BEFORE UPDATE OR DELETE ON omni_source_sync_page_checkpoints
        FOR EACH ROW
        EXECUTE FUNCTION omni_protect_source_sync_checkpoint();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_sync_page_checkpoints_no_truncate'
          AND tgrelid = 'omni_source_sync_page_checkpoints'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_sync_page_checkpoints_no_truncate
        BEFORE TRUNCATE ON omni_source_sync_page_checkpoints
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_protect_source_sync_checkpoint();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_sync_page_items_validate_binding'
          AND tgrelid = 'omni_source_sync_page_items'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_sync_page_items_validate_binding
        BEFORE INSERT OR UPDATE ON omni_source_sync_page_items
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_source_sync_page_item_binding();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_sync_page_items_protect'
          AND tgrelid = 'omni_source_sync_page_items'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_sync_page_items_protect
        BEFORE UPDATE OR DELETE ON omni_source_sync_page_items
        FOR EACH ROW
        EXECUTE FUNCTION omni_protect_source_sync_page_item();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_sync_page_items_no_truncate'
          AND tgrelid = 'omni_source_sync_page_items'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_sync_page_items_no_truncate
        BEFORE TRUNCATE ON omni_source_sync_page_items
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_protect_source_sync_page_item();
      END IF;
    END
    $migration$
  `;

  await sql.query(`
    DO $migration$
    DECLARE
      grant_record RECORD;
      grant_mapping RECORD;
    BEGIN
      FOR grant_mapping IN
        SELECT *
        FROM (VALUES
          ('omni_source_sync_page_checkpoints', 'omni_oauth_grants'),
          ('omni_source_sync_page_items', 'omni_source_items')
        ) AS mappings(target_table, source_table)
      LOOP
        FOR grant_record IN
          SELECT DISTINCT grantee, privilege_type
          FROM information_schema.table_privileges
          WHERE table_schema = current_schema()
            AND table_name = grant_mapping.source_table
            AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE')
            AND grantee <> current_user
            AND grantee <> 'PUBLIC'
        LOOP
          EXECUTE format(
            'GRANT %s ON TABLE %I.%I TO %I',
            grant_record.privilege_type,
            current_schema(),
            grant_mapping.target_table,
            grant_record.grantee
          );
        END LOOP;
      END LOOP;
    END
    $migration$
  `);
}

export async function ensureCanonicalSourceConvergenceFoundation(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_source_tombstones (
      id TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      contract_kind TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      workspace_id TEXT,
      project_id TEXT,
      mission_id TEXT,
      connection_id TEXT NOT NULL,
      visibility TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      permission_grant_ids TEXT[] NOT NULL,
      allowed_purpose_ids TEXT[] NOT NULL,
      retention_policy_id TEXT NOT NULL,
      retention_expires_at TIMESTAMPTZ,
      permission_set_sha256 TEXT NOT NULL,
      purpose_set_sha256 TEXT NOT NULL,
      source_item_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      provider_item_key_sha256 TEXT NOT NULL,
      last_known_source_revision_id TEXT,
      delete_reason TEXT NOT NULL,
      tombstone_sha256 TEXT NOT NULL,
      adapter_output_id TEXT NOT NULL,
      adapter_output_sha256 TEXT NOT NULL,
      adapter_operation TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      adapter_version_id TEXT NOT NULL,
      adapter_config_sha256 TEXT NOT NULL,
      adapter_event_key_sha256 TEXT NOT NULL,
      adapter_observed_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_source_tombstones_pkey
        PRIMARY KEY (tenant_id, id),
      CONSTRAINT omni_source_tombstones_tenant_item_key
        UNIQUE (tenant_id, id, source_item_id),
      CONSTRAINT omni_source_tombstones_adapter_output_key
        UNIQUE (tenant_id, adapter_output_id),
      CONSTRAINT omni_source_tombstones_source_item_fkey
        FOREIGN KEY (
          tenant_id,
          source_item_id,
          owner_actor_id,
          connection_id
        )
        REFERENCES omni_source_items (
          tenant_id,
          id,
          owner_actor_id,
          connection_id
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_source_tombstones_last_known_revision_fkey
        FOREIGN KEY (
          tenant_id,
          last_known_source_revision_id,
          source_item_id,
          owner_actor_id,
          connection_id
        )
        REFERENCES omni_source_revisions (
          tenant_id,
          id,
          source_item_id,
          owner_actor_id,
          connection_id
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_source_tombstones_adapter_output_receipt_fkey
        FOREIGN KEY (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256,
          connection_id,
          adapter_operation,
          adapter_id,
          adapter_version_id,
          adapter_config_sha256,
          adapter_event_key_sha256,
          adapter_observed_at
        )
        REFERENCES omni_source_adapter_output_receipts (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256,
          connection_id,
          adapter_operation,
          adapter_id,
          adapter_version_id,
          adapter_config_sha256,
          adapter_event_key_sha256,
          adapter_observed_at
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_source_tombstones_schema_check CHECK (
        schema_version = 1
        AND contract_kind = 'source_tombstone'
        AND adapter_operation = 'delete'
      ),
      CONSTRAINT omni_source_tombstones_source_kind_check CHECK (
        source_kind IN (
          'document', 'spreadsheet', 'presentation', 'email',
          'calendar_event', 'message', 'webpage', 'image', 'audio',
          'video', 'record', 'file', 'capture'
        )
      ),
      CONSTRAINT omni_source_tombstones_visibility_check CHECK (
        visibility IN (
          'agent_private', 'user_private', 'mission_shared',
          'project_shared', 'workspace_shared'
        )
      ),
      CONSTRAINT omni_source_tombstones_sensitivity_check CHECK (
        sensitivity IN ('public', 'internal', 'confidential', 'restricted')
      ),
      CONSTRAINT omni_source_tombstones_visibility_scope_check CHECK (
        (visibility <> 'workspace_shared' OR workspace_id IS NOT NULL)
        AND (visibility <> 'project_shared' OR project_id IS NOT NULL)
        AND (visibility <> 'mission_shared' OR mission_id IS NOT NULL)
      ),
      CONSTRAINT omni_source_tombstones_required_ids_check CHECK (
        omni_source_contract_id_is_valid(id)
        AND omni_source_contract_id_is_valid(tenant_id)
        AND omni_source_contract_id_is_valid(owner_actor_id)
        AND omni_source_contract_id_is_valid(connection_id)
        AND omni_source_contract_id_is_valid(source_item_id)
        AND omni_source_contract_id_is_valid(retention_policy_id)
        AND omni_source_contract_id_is_valid(adapter_output_id)
        AND omni_source_contract_id_is_valid(adapter_id)
        AND omni_source_contract_id_is_valid(adapter_version_id)
        AND (
          workspace_id IS NULL
          OR omni_source_contract_id_is_valid(workspace_id)
        )
        AND (
          project_id IS NULL
          OR omni_source_contract_id_is_valid(project_id)
        )
        AND (
          mission_id IS NULL
          OR omni_source_contract_id_is_valid(mission_id)
        )
        AND (
          last_known_source_revision_id IS NULL
          OR omni_source_contract_id_is_valid(last_known_source_revision_id)
        )
      ),
      CONSTRAINT omni_source_tombstones_grants_check CHECK (
        omni_source_id_array_is_canonical(permission_grant_ids, 128)
        AND omni_source_id_array_is_canonical(allowed_purpose_ids, 64)
      ),
      CONSTRAINT omni_source_tombstones_hashes_check CHECK (
        permission_set_sha256 ~ '^[0-9a-f]{64}$'
        AND purpose_set_sha256 ~ '^[0-9a-f]{64}$'
        AND provider_item_key_sha256 ~ '^[0-9a-f]{64}$'
        AND tombstone_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_output_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_config_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_event_key_sha256 ~ '^[0-9a-f]{64}$'
      ),
      CONSTRAINT omni_source_tombstones_delete_reason_check CHECK (
        delete_reason IN (
          'provider_deleted', 'access_revoked',
          'connection_removed', 'source_missing'
        )
      )
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_source_sync_heads (
      schema_version INTEGER NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      source_item_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      provider_item_key_sha256 TEXT NOT NULL,
      absence_observed BOOLEAN NOT NULL DEFAULT FALSE,
      authorization_generation BIGINT NOT NULL,
      rollout_generation BIGINT NOT NULL,
      phase_rank SMALLINT NOT NULL,
      page_sequence BIGINT NOT NULL,
      ordinal INTEGER NOT NULL,
      operation TEXT NOT NULL,
      source_revision_id TEXT,
      source_tombstone_id TEXT,
      adapter_output_id TEXT NOT NULL,
      adapter_output_sha256 TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_source_sync_heads_pkey
        PRIMARY KEY (tenant_id, source_item_id),
      CONSTRAINT omni_source_sync_heads_source_revision_fkey
        FOREIGN KEY (
          tenant_id,
          source_revision_id,
          source_item_id,
          owner_actor_id,
          connection_id
        )
        REFERENCES omni_source_revisions (
          tenant_id,
          id,
          source_item_id,
          owner_actor_id,
          connection_id
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_source_sync_heads_source_tombstone_fkey
        FOREIGN KEY (tenant_id, source_tombstone_id, source_item_id)
        REFERENCES omni_source_tombstones (tenant_id, id, source_item_id)
        ON DELETE RESTRICT,
      CONSTRAINT omni_source_sync_heads_adapter_output_fkey
        FOREIGN KEY (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256
        )
        REFERENCES omni_source_adapter_output_receipts (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_source_sync_heads_schema_check CHECK (
        schema_version = 1
      ),
      CONSTRAINT omni_source_sync_heads_required_ids_check CHECK (
        omni_source_contract_id_is_valid(tenant_id)
        AND omni_source_contract_id_is_valid(source_item_id)
        AND omni_source_contract_id_is_valid(owner_actor_id)
        AND omni_source_contract_id_is_valid(connection_id)
        AND omni_source_contract_id_is_valid(adapter_output_id)
        AND (
          source_revision_id IS NULL
          OR omni_source_contract_id_is_valid(source_revision_id)
        )
        AND (
          source_tombstone_id IS NULL
          OR omni_source_contract_id_is_valid(source_tombstone_id)
        )
      ),
      CONSTRAINT omni_source_sync_heads_source_kind_check CHECK (
        source_kind IN (
          'document', 'spreadsheet', 'presentation', 'email',
          'calendar_event', 'message', 'webpage', 'image', 'audio',
          'video', 'record', 'file', 'capture'
        )
      ),
      CONSTRAINT omni_source_sync_heads_hashes_check CHECK (
        provider_item_key_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_output_sha256 ~ '^[0-9a-f]{64}$'
      ),
      CONSTRAINT omni_source_sync_heads_order_check CHECK (
        authorization_generation BETWEEN 1 AND 9007199254740991
        AND rollout_generation BETWEEN 1 AND 9007199254740991
        AND phase_rank IN (0, 1)
        AND page_sequence BETWEEN 0 AND 9007199254740991
        AND ordinal BETWEEN 0 AND 999
      ),
      CONSTRAINT omni_source_sync_heads_target_check CHECK (
        (
          absence_observed
          AND operation = 'delete'
          AND source_revision_id IS NULL
          AND source_tombstone_id IS NULL
        )
        OR (
          NOT absence_observed
          AND (
            (
              operation = 'upsert'
              AND source_revision_id IS NOT NULL
              AND source_tombstone_id IS NULL
            )
            OR (
              operation = 'delete'
              AND source_revision_id IS NULL
              AND source_tombstone_id IS NOT NULL
            )
          )
        )
      ),
      CONSTRAINT omni_source_sync_heads_timestamps_check CHECK (
        created_at <= updated_at
      )
    )
  `;

  await sql`
    ALTER TABLE omni_source_sync_page_items
    ADD COLUMN IF NOT EXISTS source_tombstone_id TEXT
  `;
  await sql`
    ALTER TABLE omni_source_sync_page_items
    ADD COLUMN IF NOT EXISTS noop_reason_code TEXT
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_source_sync_page_items_source_item_fkey'
          AND conrelid = 'omni_source_sync_page_items'::regclass
      ) THEN
        ALTER TABLE omni_source_sync_page_items
        ADD CONSTRAINT omni_source_sync_page_items_source_item_fkey
        FOREIGN KEY (tenant_id, source_item_id)
        REFERENCES omni_source_items (tenant_id, id)
        ON DELETE RESTRICT;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_source_sync_page_items_source_revision_fkey'
          AND conrelid = 'omni_source_sync_page_items'::regclass
      ) THEN
        ALTER TABLE omni_source_sync_page_items
        ADD CONSTRAINT omni_source_sync_page_items_source_revision_fkey
        FOREIGN KEY (tenant_id, source_revision_id, source_item_id)
        REFERENCES omni_source_revisions (tenant_id, id, source_item_id)
        ON DELETE RESTRICT;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_source_sync_page_items_source_tombstone_fkey'
          AND conrelid = 'omni_source_sync_page_items'::regclass
      ) THEN
        ALTER TABLE omni_source_sync_page_items
        ADD CONSTRAINT omni_source_sync_page_items_source_tombstone_fkey
        FOREIGN KEY (tenant_id, source_tombstone_id, source_item_id)
        REFERENCES omni_source_tombstones (tenant_id, id, source_item_id)
        ON DELETE RESTRICT;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_source_sync_page_items_convergence_ids_check'
          AND conrelid = 'omni_source_sync_page_items'::regclass
      ) THEN
        ALTER TABLE omni_source_sync_page_items
        ADD CONSTRAINT omni_source_sync_page_items_convergence_ids_check
        CHECK (
          source_tombstone_id IS NULL
          OR omni_source_contract_id_is_valid(source_tombstone_id)
        );
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_source_sync_page_items_noop_reason_check'
          AND conrelid = 'omni_source_sync_page_items'::regclass
      ) THEN
        ALTER TABLE omni_source_sync_page_items
        ADD CONSTRAINT omni_source_sync_page_items_noop_reason_check
        CHECK (
          noop_reason_code IS NULL
          OR noop_reason_code IN ('stale', 'duplicate', 'not_found')
        );
      END IF;
    END
    $migration$
  `;

  await sql`
    ALTER TABLE omni_source_sync_page_items
    DROP CONSTRAINT IF EXISTS omni_source_sync_page_items_applied_check
  `;
  await sql`
    ALTER TABLE omni_source_sync_page_items
    ADD CONSTRAINT omni_source_sync_page_items_applied_check CHECK (
      (
        outcome = 'applied'
        AND applied_at IS NOT NULL
        AND source_item_id IS NOT NULL
        AND adapter_output_id IS NOT NULL
        AND noop_reason_code IS NULL
        AND (
          (
            operation = 'upsert'
            AND source_revision_id IS NOT NULL
            AND source_tombstone_id IS NULL
            AND delete_reason_code IS NULL
          )
          OR (
            operation = 'delete'
            AND source_revision_id IS NULL
            AND source_tombstone_id IS NOT NULL
            AND delete_reason_code IS NOT NULL
          )
        )
      )
      OR (
        outcome = 'noop'
        AND applied_at IS NOT NULL
        AND source_revision_id IS NULL
        AND source_tombstone_id IS NULL
        AND noop_reason_code IS NOT NULL
        AND (
          (
            noop_reason_code = 'stale'
            AND adapter_output_id IS NULL
          )
          OR (
            noop_reason_code = 'duplicate'
            AND adapter_output_id IS NOT NULL
            AND (
              operation = 'delete'
              OR source_item_id IS NOT NULL
            )
          )
          OR (
            noop_reason_code = 'not_found'
            AND adapter_output_id IS NOT NULL
            AND operation = 'delete'
            AND source_item_id IS NULL
          )
        )
      )
      OR (
        outcome NOT IN ('applied', 'noop')
        AND applied_at IS NULL
        AND source_tombstone_id IS NULL
        AND noop_reason_code IS NULL
      )
    )
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_source_sync_page_item_binding()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      checkpoint_phase TEXT;
      checkpoint_status TEXT;
      checkpoint_adapter_version_id TEXT;
      checkpoint_adapter_config_sha256 TEXT;
      expected_phase_rank SMALLINT;
    BEGIN
      SELECT
        checkpoint.phase,
        checkpoint.status,
        checkpoint.adapter_version_id,
        checkpoint.adapter_config_sha256
      INTO
        checkpoint_phase,
        checkpoint_status,
        checkpoint_adapter_version_id,
        checkpoint_adapter_config_sha256
      FROM omni_source_sync_page_checkpoints checkpoint
      WHERE checkpoint.tenant_id = NEW.tenant_id
        AND checkpoint.id = NEW.checkpoint_id
        AND checkpoint.owner_actor_id = NEW.owner_actor_id
        AND checkpoint.connection_id = NEW.connection_id
        AND checkpoint.provider = NEW.provider
        AND checkpoint.source_id = NEW.source_id
        AND checkpoint.engine_version = NEW.engine_version
        AND checkpoint.authorization_generation = NEW.authorization_generation
        AND checkpoint.rollout_generation = NEW.rollout_generation
        AND checkpoint.page_sequence = NEW.page_sequence
      FOR UPDATE;

      IF checkpoint_phase = 'backfill' THEN
        expected_phase_rank := 0;
      ELSIF checkpoint_phase = 'changes' THEN
        expected_phase_rank := 1;
      ELSE
        expected_phase_rank := -1;
      END IF;

      IF checkpoint_phase IS NULL
        OR NEW.phase_rank <> expected_phase_rank
      THEN
        RAISE EXCEPTION 'Source sync page item does not match its checkpoint'
          USING ERRCODE = '23514';
      END IF;

      IF TG_OP = 'INSERT' AND checkpoint_status <> 'leased' THEN
        RAISE EXCEPTION 'Source sync page items require an active page lease'
          USING ERRCODE = '55000';
      END IF;

      IF NEW.adapter_output_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM omni_source_adapter_output_receipts receipt
          WHERE receipt.tenant_id = NEW.tenant_id
            AND receipt.connection_id = NEW.connection_id
            AND receipt.adapter_output_id = NEW.adapter_output_id
            AND receipt.adapter_output_sha256 = NEW.adapter_output_sha256
            AND receipt.adapter_operation = NEW.operation
            AND receipt.adapter_version_id = checkpoint_adapter_version_id
            AND receipt.adapter_config_sha256 =
              checkpoint_adapter_config_sha256
            AND receipt.adapter_event_key_sha256 =
              NEW.adapter_event_key_sha256
            AND receipt.adapter_observed_at = NEW.observed_at
        )
      THEN
        RAISE EXCEPTION 'Source sync page receipt binding is incoherent'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.outcome = 'applied' AND NEW.operation = 'upsert' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM omni_source_revisions source_revision
          WHERE source_revision.tenant_id = NEW.tenant_id
            AND source_revision.id = NEW.source_revision_id
            AND source_revision.source_item_id = NEW.source_item_id
            AND source_revision.owner_actor_id = NEW.owner_actor_id
            AND source_revision.connection_id = NEW.connection_id
            AND source_revision.provider_item_key_sha256 =
              NEW.provider_item_key_sha256
            AND source_revision.provider_revision_key_sha256 IS NOT DISTINCT
              FROM NEW.provider_revision_key_sha256
            AND source_revision.adapter_output_id = NEW.adapter_output_id
            AND source_revision.adapter_output_sha256 =
              NEW.adapter_output_sha256
            AND source_revision.adapter_operation = 'upsert'
            AND source_revision.adapter_version_id =
              checkpoint_adapter_version_id
            AND source_revision.adapter_config_sha256 =
              checkpoint_adapter_config_sha256
            AND source_revision.adapter_event_key_sha256 =
              NEW.adapter_event_key_sha256
            AND source_revision.adapter_observed_at = NEW.observed_at
        ) THEN
          RAISE EXCEPTION 'Source sync applied revision binding is incoherent'
            USING ERRCODE = '23514';
        END IF;
      ELSIF NEW.outcome = 'applied' AND NEW.operation = 'delete' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM omni_source_tombstones tombstone
          WHERE tombstone.tenant_id = NEW.tenant_id
            AND tombstone.id = NEW.source_tombstone_id
            AND tombstone.source_item_id = NEW.source_item_id
            AND tombstone.owner_actor_id = NEW.owner_actor_id
            AND tombstone.connection_id = NEW.connection_id
            AND tombstone.provider_item_key_sha256 =
              NEW.provider_item_key_sha256
            AND tombstone.last_known_source_revision_id IS NOT DISTINCT FROM
              NEW.last_known_revision_id
            AND tombstone.delete_reason = NEW.delete_reason_code
            AND tombstone.adapter_output_id = NEW.adapter_output_id
            AND tombstone.adapter_output_sha256 = NEW.adapter_output_sha256
            AND tombstone.adapter_operation = 'delete'
            AND tombstone.adapter_version_id = checkpoint_adapter_version_id
            AND tombstone.adapter_config_sha256 =
              checkpoint_adapter_config_sha256
            AND tombstone.adapter_event_key_sha256 =
              NEW.adapter_event_key_sha256
            AND tombstone.adapter_observed_at = NEW.observed_at
        ) THEN
          RAISE EXCEPTION 'Source sync applied tombstone binding is incoherent'
            USING ERRCODE = '23514';
        END IF;
      END IF;

      IF NEW.outcome = 'applied' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM omni_source_sync_heads head
          WHERE head.tenant_id = NEW.tenant_id
            AND head.source_item_id = NEW.source_item_id
            AND head.owner_actor_id = NEW.owner_actor_id
            AND head.connection_id = NEW.connection_id
            AND head.provider_item_key_sha256 =
              NEW.provider_item_key_sha256
            AND head.authorization_generation = NEW.authorization_generation
            AND head.rollout_generation = NEW.rollout_generation
            AND head.phase_rank = NEW.phase_rank
            AND head.page_sequence = NEW.page_sequence
            AND head.ordinal = NEW.ordinal
            AND NOT head.absence_observed
            AND head.operation = NEW.operation
            AND head.source_revision_id IS NOT DISTINCT FROM
              NEW.source_revision_id
            AND head.source_tombstone_id IS NOT DISTINCT FROM
              NEW.source_tombstone_id
            AND head.adapter_output_id = NEW.adapter_output_id
            AND head.adapter_output_sha256 = NEW.adapter_output_sha256
        ) THEN
          RAISE EXCEPTION 'Source sync applied head order is incoherent'
            USING ERRCODE = '23514';
        END IF;
      ELSIF NEW.outcome = 'noop'
        AND NEW.noop_reason_code IN ('duplicate', 'not_found')
      THEN
        IF NOT EXISTS (
          SELECT 1
          FROM omni_source_sync_heads head
          WHERE head.tenant_id = NEW.tenant_id
            AND head.owner_actor_id = NEW.owner_actor_id
            AND head.connection_id = NEW.connection_id
            AND head.provider_item_key_sha256 =
              NEW.provider_item_key_sha256
            AND head.authorization_generation = NEW.authorization_generation
            AND head.rollout_generation = NEW.rollout_generation
            AND head.phase_rank = NEW.phase_rank
            AND head.page_sequence = NEW.page_sequence
            AND head.ordinal = NEW.ordinal
            AND head.operation = NEW.operation
            AND head.adapter_output_id = NEW.adapter_output_id
            AND head.adapter_output_sha256 = NEW.adapter_output_sha256
            AND (
              NEW.source_item_id IS NULL
              OR head.source_item_id = NEW.source_item_id
            )
            AND (
              NEW.source_item_id IS NOT NULL
              OR head.absence_observed
            )
            AND (
              NEW.noop_reason_code <> 'not_found'
              OR head.absence_observed
            )
        ) THEN
          RAISE EXCEPTION 'Source sync duplicate or absence head is incoherent'
            USING ERRCODE = '23514';
        END IF;
      ELSIF NEW.outcome = 'noop' AND NEW.noop_reason_code = 'stale' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM omni_source_sync_heads head
          WHERE head.tenant_id = NEW.tenant_id
            AND head.owner_actor_id = NEW.owner_actor_id
            AND head.connection_id = NEW.connection_id
            AND head.provider_item_key_sha256 =
              NEW.provider_item_key_sha256
            AND (
              NEW.source_item_id IS NULL
              OR head.source_item_id = NEW.source_item_id
            )
            AND (
              NEW.source_item_id IS NOT NULL
              OR head.absence_observed
            )
            AND ROW(
              head.authorization_generation,
              head.rollout_generation,
              head.phase_rank,
              head.page_sequence,
              head.ordinal
            ) > ROW(
              NEW.authorization_generation,
              NEW.rollout_generation,
              NEW.phase_rank,
              NEW.page_sequence,
              NEW.ordinal
            )
        ) THEN
          RAISE EXCEPTION 'Source sync stale head order is incoherent'
            USING ERRCODE = '23514';
        END IF;
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_protect_source_sync_page_item()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION '% rows cannot be changed with %', TG_TABLE_NAME, TG_OP
          USING ERRCODE = '55000';
      END IF;

      IF OLD.outcome IN ('shadow_observed', 'applied', 'noop') THEN
        RAISE EXCEPTION '% terminal outcomes are immutable', TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.checkpoint_id IS DISTINCT FROM OLD.checkpoint_id
        OR NEW.owner_actor_id IS DISTINCT FROM OLD.owner_actor_id
        OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
        OR NEW.provider IS DISTINCT FROM OLD.provider
        OR NEW.source_id IS DISTINCT FROM OLD.source_id
        OR NEW.engine_version IS DISTINCT FROM OLD.engine_version
        OR NEW.authorization_generation IS DISTINCT FROM OLD.authorization_generation
        OR NEW.rollout_generation IS DISTINCT FROM OLD.rollout_generation
        OR NEW.phase_rank IS DISTINCT FROM OLD.phase_rank
        OR NEW.page_sequence IS DISTINCT FROM OLD.page_sequence
        OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
        OR NEW.operation IS DISTINCT FROM OLD.operation
        OR NEW.provider_item_key_sha256 IS DISTINCT FROM OLD.provider_item_key_sha256
        OR NEW.provider_revision_key_sha256 IS DISTINCT FROM OLD.provider_revision_key_sha256
        OR NEW.adapter_event_key_sha256 IS DISTINCT FROM OLD.adapter_event_key_sha256
        OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
        OR NEW.manifest_item_sha256 IS DISTINCT FROM OLD.manifest_item_sha256
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
      THEN
        RAISE EXCEPTION '% identity is immutable', TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      IF (OLD.source_item_id IS NOT NULL AND
          NEW.source_item_id IS DISTINCT FROM OLD.source_item_id)
        OR (OLD.source_revision_id IS NOT NULL AND
          NEW.source_revision_id IS DISTINCT FROM OLD.source_revision_id)
        OR (OLD.source_tombstone_id IS NOT NULL AND
          NEW.source_tombstone_id IS DISTINCT FROM OLD.source_tombstone_id)
        OR (OLD.adapter_output_id IS NOT NULL AND
          NEW.adapter_output_id IS DISTINCT FROM OLD.adapter_output_id)
        OR (OLD.adapter_output_sha256 IS NOT NULL AND
          NEW.adapter_output_sha256 IS DISTINCT FROM OLD.adapter_output_sha256)
        OR (OLD.delete_reason_code IS NOT NULL AND
          NEW.delete_reason_code IS DISTINCT FROM OLD.delete_reason_code)
        OR (OLD.noop_reason_code IS NOT NULL AND
          NEW.noop_reason_code IS DISTINCT FROM OLD.noop_reason_code)
        OR (OLD.last_known_revision_id IS NOT NULL AND
          NEW.last_known_revision_id IS DISTINCT FROM OLD.last_known_revision_id)
      THEN
        RAISE EXCEPTION '% initialized outcome bindings are immutable',
          TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      IF NEW.attempts < OLD.attempts THEN
        RAISE EXCEPTION '% attempts cannot move backwards', TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_tombstones_tenant_item_created_idx
    ON omni_source_tombstones (tenant_id, source_item_id, created_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_tombstones_tenant_source_idx
    ON omni_source_tombstones (
      tenant_id,
      owner_actor_id,
      connection_id,
      provider_item_key_sha256,
      created_at DESC
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_tombstones_last_revision_idx
    ON omni_source_tombstones (tenant_id, last_known_source_revision_id)
    WHERE last_known_source_revision_id IS NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_tombstones_retention_expiry_idx
    ON omni_source_tombstones (retention_expires_at)
    WHERE retention_expires_at IS NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_tombstones_permission_grants_idx
    ON omni_source_tombstones USING GIN (permission_grant_ids)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_sync_heads_source_order_idx
    ON omni_source_sync_heads (
      tenant_id,
      owner_actor_id,
      connection_id,
      authorization_generation DESC,
      rollout_generation DESC,
      phase_rank DESC,
      page_sequence DESC,
      ordinal DESC
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_sync_heads_provider_item_idx
    ON omni_source_sync_heads (
      tenant_id,
      connection_id,
      provider_item_key_sha256
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_sync_heads_revision_idx
    ON omni_source_sync_heads (tenant_id, source_revision_id)
    WHERE source_revision_id IS NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_sync_heads_tombstone_idx
    ON omni_source_sync_heads (tenant_id, source_tombstone_id)
    WHERE source_tombstone_id IS NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_sync_page_items_tombstone_idx
    ON omni_source_sync_page_items (tenant_id, source_tombstone_id)
    WHERE source_tombstone_id IS NOT NULL
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_lock_source_item_identity()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtext(NEW.tenant_id),
        hashtext(NEW.id)
      );
      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_source_head_end_state()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      checked_tenant_id TEXT;
      checked_source_item_id TEXT;
      head_absence_observed BOOLEAN;
      source_item_exists BOOLEAN;
    BEGIN
      IF TG_TABLE_NAME = 'omni_source_items' THEN
        IF TG_OP = 'DELETE' THEN
          checked_tenant_id := OLD.tenant_id;
          checked_source_item_id := OLD.id;
        ELSE
          checked_tenant_id := NEW.tenant_id;
          checked_source_item_id := NEW.id;
        END IF;
      ELSE
        IF TG_OP = 'DELETE' THEN
          checked_tenant_id := OLD.tenant_id;
          checked_source_item_id := OLD.source_item_id;
        ELSE
          checked_tenant_id := NEW.tenant_id;
          checked_source_item_id := NEW.source_item_id;
        END IF;
      END IF;

      SELECT head.absence_observed
      INTO head_absence_observed
      FROM omni_source_sync_heads head
      WHERE head.tenant_id = checked_tenant_id
        AND head.source_item_id = checked_source_item_id;

      IF NOT FOUND THEN
        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        END IF;
        RETURN NEW;
      END IF;

      SELECT EXISTS (
        SELECT 1
        FROM omni_source_items source_item
        WHERE source_item.tenant_id = checked_tenant_id
          AND source_item.id = checked_source_item_id
      )
      INTO source_item_exists;

      IF head_absence_observed AND source_item_exists THEN
        RAISE EXCEPTION 'Source absence head cannot coexist with a source item'
          USING ERRCODE = '23514';
      END IF;
      IF NOT head_absence_observed AND NOT source_item_exists THEN
        RAISE EXCEPTION 'Source convergence head requires its source item'
          USING ERRCODE = '23514';
      END IF;

      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_source_tombstone_binding()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      PERFORM 1
      FROM omni_source_items source_item
      WHERE source_item.tenant_id = NEW.tenant_id
        AND source_item.id = NEW.source_item_id
        AND source_item.owner_actor_id = NEW.owner_actor_id
        AND source_item.workspace_id IS NOT DISTINCT FROM NEW.workspace_id
        AND source_item.project_id IS NOT DISTINCT FROM NEW.project_id
        AND source_item.mission_id IS NOT DISTINCT FROM NEW.mission_id
        AND source_item.connection_id = NEW.connection_id
        AND source_item.visibility = NEW.visibility
        AND source_item.sensitivity = NEW.sensitivity
        AND source_item.permission_grant_ids = NEW.permission_grant_ids
        AND source_item.allowed_purpose_ids = NEW.allowed_purpose_ids
        AND source_item.retention_policy_id = NEW.retention_policy_id
        AND source_item.retention_expires_at IS NOT DISTINCT FROM
          NEW.retention_expires_at
        AND source_item.permission_set_sha256 = NEW.permission_set_sha256
        AND source_item.purpose_set_sha256 = NEW.purpose_set_sha256
        AND source_item.source_kind = NEW.source_kind
        AND source_item.provider_item_key_sha256 =
          NEW.provider_item_key_sha256
        AND source_item.current_revision_id IS NOT DISTINCT FROM
          NEW.last_known_source_revision_id
      FOR KEY SHARE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Source tombstone binding does not match its source item'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.last_known_source_revision_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM omni_source_revisions source_revision
          WHERE source_revision.tenant_id = NEW.tenant_id
            AND source_revision.id = NEW.last_known_source_revision_id
            AND source_revision.source_item_id = NEW.source_item_id
            AND source_revision.owner_actor_id = NEW.owner_actor_id
            AND source_revision.workspace_id IS NOT DISTINCT FROM
              NEW.workspace_id
            AND source_revision.project_id IS NOT DISTINCT FROM
              NEW.project_id
            AND source_revision.mission_id IS NOT DISTINCT FROM
              NEW.mission_id
            AND source_revision.connection_id = NEW.connection_id
            AND source_revision.visibility = NEW.visibility
            AND source_revision.sensitivity = NEW.sensitivity
            AND source_revision.permission_grant_ids <@
              NEW.permission_grant_ids
            AND source_revision.allowed_purpose_ids <@
              NEW.allowed_purpose_ids
            AND source_revision.retention_policy_id =
              NEW.retention_policy_id
            AND (
              NEW.retention_expires_at IS NULL
              OR (
                source_revision.retention_expires_at IS NOT NULL
                AND source_revision.retention_expires_at <=
                  NEW.retention_expires_at
              )
            )
            AND source_revision.source_kind = NEW.source_kind
            AND source_revision.provider_item_key_sha256 =
              NEW.provider_item_key_sha256
        )
      THEN
        RAISE EXCEPTION 'Source tombstone last-known revision is incoherent'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_source_sync_head_binding()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtext(NEW.tenant_id),
        hashtext(NEW.source_item_id)
      );

      IF NEW.absence_observed THEN
        IF EXISTS (
          SELECT 1
          FROM omni_source_items source_item
          WHERE source_item.tenant_id = NEW.tenant_id
            AND source_item.id = NEW.source_item_id
        ) THEN
          RAISE EXCEPTION 'Source absence head conflicts with a source item'
            USING ERRCODE = '23514';
        END IF;
      ELSE
        PERFORM 1
        FROM omni_source_items source_item
        WHERE source_item.tenant_id = NEW.tenant_id
          AND source_item.id = NEW.source_item_id
          AND source_item.owner_actor_id = NEW.owner_actor_id
          AND source_item.connection_id = NEW.connection_id
          AND source_item.source_kind = NEW.source_kind
          AND source_item.provider_item_key_sha256 =
            NEW.provider_item_key_sha256
        FOR KEY SHARE;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Source sync head does not match its source item'
            USING ERRCODE = '23514';
        END IF;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM omni_source_adapter_output_receipts receipt
        WHERE receipt.tenant_id = NEW.tenant_id
          AND receipt.adapter_output_id = NEW.adapter_output_id
          AND receipt.adapter_output_sha256 = NEW.adapter_output_sha256
          AND receipt.connection_id = NEW.connection_id
          AND receipt.adapter_operation = NEW.operation
      ) THEN
        RAISE EXCEPTION 'Source sync head adapter receipt is incoherent'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.absence_observed THEN
        RETURN NEW;
      END IF;

      IF NEW.operation = 'upsert' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM omni_source_revisions source_revision
          WHERE source_revision.tenant_id = NEW.tenant_id
            AND source_revision.id = NEW.source_revision_id
            AND source_revision.source_item_id = NEW.source_item_id
            AND source_revision.owner_actor_id = NEW.owner_actor_id
            AND source_revision.connection_id = NEW.connection_id
            AND source_revision.source_kind = NEW.source_kind
            AND source_revision.provider_item_key_sha256 =
              NEW.provider_item_key_sha256
            AND source_revision.adapter_output_id = NEW.adapter_output_id
            AND source_revision.adapter_output_sha256 =
              NEW.adapter_output_sha256
            AND source_revision.adapter_operation = NEW.operation
            AND source_revision.id = (
              SELECT current_source_item.current_revision_id
              FROM omni_source_items current_source_item
              WHERE current_source_item.tenant_id = NEW.tenant_id
                AND current_source_item.id = NEW.source_item_id
            )
        ) THEN
          RAISE EXCEPTION 'Source sync head revision target is incoherent'
            USING ERRCODE = '23514';
        END IF;
      ELSIF NEW.operation = 'delete' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM omni_source_tombstones tombstone
          WHERE tombstone.tenant_id = NEW.tenant_id
            AND tombstone.id = NEW.source_tombstone_id
            AND tombstone.source_item_id = NEW.source_item_id
            AND tombstone.owner_actor_id = NEW.owner_actor_id
            AND tombstone.connection_id = NEW.connection_id
            AND tombstone.source_kind = NEW.source_kind
            AND tombstone.provider_item_key_sha256 =
              NEW.provider_item_key_sha256
            AND tombstone.adapter_output_id = NEW.adapter_output_id
            AND tombstone.adapter_output_sha256 =
              NEW.adapter_output_sha256
            AND tombstone.adapter_operation = NEW.operation
            AND tombstone.last_known_source_revision_id IS NOT DISTINCT FROM (
              SELECT current_source_item.current_revision_id
              FROM omni_source_items current_source_item
              WHERE current_source_item.tenant_id = NEW.tenant_id
                AND current_source_item.id = NEW.source_item_id
            )
        ) THEN
          RAISE EXCEPTION 'Source sync head tombstone target is incoherent'
            USING ERRCODE = '23514';
        END IF;
      ELSE
        RAISE EXCEPTION 'Source sync head operation is invalid'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_protect_source_sync_head()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION '% rows cannot be changed with %', TG_TABLE_NAME, TG_OP
          USING ERRCODE = '55000';
      END IF;

      IF NEW.schema_version IS DISTINCT FROM OLD.schema_version
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.source_item_id IS DISTINCT FROM OLD.source_item_id
        OR NEW.owner_actor_id IS DISTINCT FROM OLD.owner_actor_id
        OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
        OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
        OR NEW.provider_item_key_sha256 IS DISTINCT FROM
          OLD.provider_item_key_sha256
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
      THEN
        RAISE EXCEPTION '% identity is immutable', TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      IF ROW(
        NEW.authorization_generation,
        NEW.rollout_generation,
        NEW.phase_rank,
        NEW.page_sequence,
        NEW.ordinal
      ) < ROW(
        OLD.authorization_generation,
        OLD.rollout_generation,
        OLD.phase_rank,
        OLD.page_sequence,
        OLD.ordinal
      ) THEN
        RAISE EXCEPTION '% order cannot move backwards', TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      IF ROW(
        NEW.authorization_generation,
        NEW.rollout_generation,
        NEW.phase_rank,
        NEW.page_sequence,
        NEW.ordinal
      ) = ROW(
        OLD.authorization_generation,
        OLD.rollout_generation,
        OLD.phase_rank,
        OLD.page_sequence,
        OLD.ordinal
      )
        AND (
          NEW.absence_observed IS DISTINCT FROM OLD.absence_observed
          OR NEW.operation IS DISTINCT FROM OLD.operation
          OR NEW.source_revision_id IS DISTINCT FROM OLD.source_revision_id
          OR NEW.source_tombstone_id IS DISTINCT FROM OLD.source_tombstone_id
          OR NEW.adapter_output_id IS DISTINCT FROM OLD.adapter_output_id
          OR NEW.adapter_output_sha256 IS DISTINCT FROM
            OLD.adapter_output_sha256
        )
      THEN
        RAISE EXCEPTION '% equal order is bound to different data',
          TG_TABLE_NAME
          USING ERRCODE = '23514';
      END IF;

      IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION '% updated_at cannot move backwards', TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_items_lock_insert_identity'
          AND tgrelid = 'omni_source_items'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_items_lock_insert_identity
        BEFORE INSERT ON omni_source_items
        FOR EACH ROW
        EXECUTE FUNCTION omni_lock_source_item_identity();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_items_validate_head_end_state'
          AND tgrelid = 'omni_source_items'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE CONSTRAINT TRIGGER omni_source_items_validate_head_end_state
        AFTER INSERT OR UPDATE OR DELETE ON omni_source_items
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_source_head_end_state();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_tombstones_validate_binding'
          AND tgrelid = 'omni_source_tombstones'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_tombstones_validate_binding
        BEFORE INSERT ON omni_source_tombstones
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_source_tombstone_binding();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_tombstones_immutable'
          AND tgrelid = 'omni_source_tombstones'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_tombstones_immutable
        BEFORE UPDATE OR DELETE ON omni_source_tombstones
        FOR EACH ROW
        EXECUTE FUNCTION omni_reject_immutable_source_lineage_change();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_tombstones_no_truncate'
          AND tgrelid = 'omni_source_tombstones'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_tombstones_no_truncate
        BEFORE TRUNCATE ON omni_source_tombstones
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_reject_immutable_source_lineage_change();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_sync_heads_protect'
          AND tgrelid = 'omni_source_sync_heads'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_sync_heads_protect
        BEFORE UPDATE OR DELETE ON omni_source_sync_heads
        FOR EACH ROW
        EXECUTE FUNCTION omni_protect_source_sync_head();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_sync_heads_validate_end_state'
          AND tgrelid = 'omni_source_sync_heads'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE CONSTRAINT TRIGGER omni_source_sync_heads_validate_end_state
        AFTER INSERT OR UPDATE OR DELETE ON omni_source_sync_heads
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_source_head_end_state();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_sync_heads_validate_binding'
          AND tgrelid = 'omni_source_sync_heads'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_sync_heads_validate_binding
        BEFORE INSERT OR UPDATE ON omni_source_sync_heads
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_source_sync_head_binding();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_sync_heads_no_truncate'
          AND tgrelid = 'omni_source_sync_heads'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_sync_heads_no_truncate
        BEFORE TRUNCATE ON omni_source_sync_heads
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_protect_source_sync_head();
      END IF;
    END
    $migration$
  `;

  // Tombstones inherit append-only lineage permissions; the mutable head
  // projection inherits the source-item upsert capabilities. Role names stay
  // deployment-owned and are discovered from the existing grant boundary.
  await sql.query(`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT grantee, privilege_type
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_source_revisions'
          AND privilege_type IN ('SELECT', 'INSERT')
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'GRANT %s ON TABLE %I.omni_source_tombstones TO %I',
          grant_record.privilege_type,
          current_schema(),
          grant_record.grantee
        );
      END LOOP;

      FOR grant_record IN
        SELECT DISTINCT grantee, privilege_type
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_source_items'
          AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE')
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'GRANT %s ON TABLE %I.omni_source_sync_heads TO %I',
          grant_record.privilege_type,
          current_schema(),
          grant_record.grantee
        );
      END LOOP;

    END
    $migration$
  `);
}

export async function ensureDriveGeneration2RolloutBoundCheckpoints(sql: SqlClient) {
  // This release is the first writer of rollout-bound Drive checkpoints. Refuse
  // to infer a capability, adapter, or lifecycle revision for pre-existing work.
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
          'omni_source_sync_page_checkpoints_rollout_binding_check'
          AND conrelid = 'omni_source_sync_page_checkpoints'::regclass
      ) AND EXISTS (
        SELECT 1
        FROM omni_source_sync_page_checkpoints checkpoint
        WHERE checkpoint.rollout_generation > 1
      ) THEN
        RAISE EXCEPTION
          'Cannot bind pre-existing generation-2 source sync checkpoints'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;

  await sql`
    ALTER TABLE omni_source_sync_page_checkpoints
    ADD COLUMN IF NOT EXISTS rollout_capability_id TEXT
  `;
  await sql`
    ALTER TABLE omni_source_sync_page_checkpoints
    ADD COLUMN IF NOT EXISTS adapter_id TEXT
  `;
  await sql`
    ALTER TABLE omni_source_sync_page_checkpoints
    ADD COLUMN IF NOT EXISTS rollout_lifecycle_revision BIGINT
  `;

  // Generation 1 retains its original uniqueness semantics. Canonical
  // generations include capability and adapter identity so independently
  // governed streams cannot collide at the database boundary.
  await sql`
    ALTER TABLE omni_source_sync_page_checkpoints
    DROP CONSTRAINT IF EXISTS omni_source_sync_page_checkpoints_page_key
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS
      omni_source_sync_page_checkpoints_generation1_page_idx
    ON omni_source_sync_page_checkpoints (
      tenant_id,
      owner_actor_id,
      connection_id,
      provider,
      source_id,
      authorization_generation,
      rollout_generation,
      page_sequence
    )
    WHERE rollout_generation = 1
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS
      omni_source_sync_page_checkpoints_canonical_page_idx
    ON omni_source_sync_page_checkpoints (
      tenant_id,
      owner_actor_id,
      connection_id,
      provider,
      source_id,
      authorization_generation,
      rollout_generation,
      rollout_capability_id,
      adapter_id,
      page_sequence
    )
    WHERE rollout_generation > 1
  `;
  await sql`
    DROP INDEX IF EXISTS
      omni_source_sync_page_checkpoints_one_nonterminal_idx
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS
      omni_source_sync_page_checkpoints_generation1_one_nonterminal_idx
    ON omni_source_sync_page_checkpoints (
      tenant_id,
      owner_actor_id,
      connection_id,
      provider,
      source_id,
      authorization_generation,
      rollout_generation
    )
    WHERE rollout_generation = 1
      AND status NOT IN ('committed', 'superseded')
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS
      omni_source_sync_page_checkpoints_canonical_one_nonterminal_idx
    ON omni_source_sync_page_checkpoints (
      tenant_id,
      owner_actor_id,
      connection_id,
      provider,
      source_id,
      authorization_generation,
      rollout_generation,
      rollout_capability_id,
      adapter_id
    )
    WHERE rollout_generation > 1
      AND status NOT IN ('committed', 'superseded')
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
          'omni_source_sync_page_checkpoints_rollout_binding_check'
          AND conrelid = 'omni_source_sync_page_checkpoints'::regclass
      ) THEN
        ALTER TABLE omni_source_sync_page_checkpoints
        ADD CONSTRAINT
          omni_source_sync_page_checkpoints_rollout_binding_check
        CHECK (
          (
            rollout_generation = 1
            AND rollout_capability_id IS NULL
            AND adapter_id IS NULL
            AND rollout_lifecycle_revision IS NULL
          )
          OR (
            rollout_generation > 1
            AND rollout_capability_id IS NOT NULL
            AND adapter_id IS NOT NULL
            AND omni_source_contract_id_is_valid(rollout_capability_id)
            AND omni_source_contract_id_is_valid(adapter_id)
            AND (
              (
                status = 'open'
                AND rollout_lifecycle_revision IS NULL
              )
              OR (
                status <> 'open'
                AND rollout_lifecycle_revision IS NOT NULL
                AND rollout_lifecycle_revision BETWEEN 1 AND 9007199254740991
              )
            )
          )
        ) NOT VALID;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
          'omni_source_sync_page_checkpoints_rollout_fkey'
          AND conrelid = 'omni_source_sync_page_checkpoints'::regclass
      ) THEN
        ALTER TABLE omni_source_sync_page_checkpoints
        ADD CONSTRAINT omni_source_sync_page_checkpoints_rollout_fkey
        FOREIGN KEY (
          tenant_id,
          rollout_capability_id,
          rollout_generation
        )
        REFERENCES omni_tenant_capability_rollouts (
          tenant_id,
          capability_id,
          rollout_generation
        )
        ON DELETE RESTRICT
        NOT VALID;
      END IF;
    END
    $migration$
  `;
  await sql`
    ALTER TABLE omni_source_sync_page_checkpoints
    VALIDATE CONSTRAINT
      omni_source_sync_page_checkpoints_rollout_binding_check
  `;
  await sql`
    ALTER TABLE omni_source_sync_page_checkpoints
    VALIDATE CONSTRAINT omni_source_sync_page_checkpoints_rollout_fkey
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
          'omni_source_sync_page_items_rollout_outcome_check'
          AND conrelid = 'omni_source_sync_page_items'::regclass
      ) THEN
        ALTER TABLE omni_source_sync_page_items
        ADD CONSTRAINT omni_source_sync_page_items_rollout_outcome_check
        CHECK (
          (rollout_generation = 1 AND outcome = 'shadow_observed')
          OR (
            rollout_generation > 1
            AND outcome IN ('pending', 'applied', 'noop', 'dead_letter')
          )
        ) NOT VALID;
      END IF;
    END
    $migration$
  `;
  await sql`
    ALTER TABLE omni_source_sync_page_items
    VALIDATE CONSTRAINT omni_source_sync_page_items_rollout_outcome_check
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_source_sync_checkpoint_rollout()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      active_lifecycle_revision BIGINT;
      requires_lifecycle_match BOOLEAN;
      requires_rollout_validation BOOLEAN;
    BEGIN
      IF NEW.rollout_generation = 1 THEN
        RETURN NEW;
      END IF;

      IF TG_OP = 'INSERT' THEN
        requires_rollout_validation := TRUE;
      ELSE
        requires_rollout_validation :=
          NEW.status IN ('leased', 'committed')
          OR (
            OLD.status = 'open'
            AND NEW.status = 'dead_letter'
          );
      END IF;

      IF requires_rollout_validation THEN
        SELECT rollout.lifecycle_revision
        INTO active_lifecycle_revision
        FROM omni_tenant_capability_rollouts rollout
        WHERE rollout.tenant_id = NEW.tenant_id
          AND rollout.capability_id = NEW.rollout_capability_id
          AND rollout.rollout_generation = NEW.rollout_generation
          AND rollout.engine_version = NEW.engine_version
          AND rollout.contract_version_id = NEW.adapter_version_id
          AND rollout.configuration_sha256 = NEW.adapter_config_sha256
          AND rollout.mode IN ('canary', 'enabled')
          AND rollout.status = 'active'
        FOR SHARE;

        IF NOT FOUND THEN
          RAISE EXCEPTION
            'Source sync checkpoint rollout is not active or exact'
            USING ERRCODE = '23514';
        END IF;

        requires_lifecycle_match := NEW.status <> 'open';
        IF requires_lifecycle_match AND
          NEW.rollout_lifecycle_revision IS DISTINCT FROM
            active_lifecycle_revision
        THEN
          RAISE EXCEPTION
            'Source sync checkpoint rollout lifecycle is stale'
            USING ERRCODE = '23514';
        END IF;
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION
      omni_protect_source_sync_checkpoint_rollout_binding()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF NEW.rollout_capability_id IS DISTINCT FROM
          OLD.rollout_capability_id
        OR NEW.adapter_id IS DISTINCT FROM OLD.adapter_id
      THEN
        RAISE EXCEPTION 'Source sync checkpoint rollout binding is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NEW.rollout_lifecycle_revision IS DISTINCT FROM
          OLD.rollout_lifecycle_revision
      THEN
        IF OLD.rollout_lifecycle_revision IS NULL
          AND NEW.rollout_lifecycle_revision IS NOT NULL
        THEN
          IF NOT (
            OLD.status = 'open'
            AND (
              (
                NEW.status = 'leased'
                AND NEW.lease_generation = OLD.lease_generation + 1
              )
              OR (
                NEW.status = 'dead_letter'
                AND NEW.lease_generation = OLD.lease_generation
              )
            )
          ) THEN
            RAISE EXCEPTION
              'Source sync rollout lifecycle may bind only on claim or exhaustion'
              USING ERRCODE = '55000';
          END IF;
        ELSIF OLD.rollout_lifecycle_revision IS NOT NULL
          AND NEW.rollout_lifecycle_revision IS NULL
        THEN
          IF NOT (
            OLD.status IN ('leased', 'observed', 'dead_letter')
            AND NEW.status = 'open'
            AND NEW.lease_generation = OLD.lease_generation
          ) THEN
            RAISE EXCEPTION
              'Source sync rollout lifecycle may clear only on reopen'
              USING ERRCODE = '55000';
          END IF;
        ELSIF NOT (
          OLD.status IN ('leased', 'observed')
          AND NEW.status = 'leased'
          AND NEW.lease_generation = OLD.lease_generation + 1
        ) THEN
          RAISE EXCEPTION
            'Source sync rollout lifecycle may change only on a new lease'
            USING ERRCODE = '55000';
        END IF;
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION
      omni_validate_source_sync_page_item_adapter_id()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      checkpoint_adapter_id TEXT;
    BEGIN
      IF NEW.rollout_generation = 1 THEN
        RETURN NEW;
      END IF;

      SELECT checkpoint.adapter_id
      INTO checkpoint_adapter_id
      FROM omni_source_sync_page_checkpoints checkpoint
      WHERE checkpoint.tenant_id = NEW.tenant_id
        AND checkpoint.id = NEW.checkpoint_id
        AND checkpoint.owner_actor_id = NEW.owner_actor_id
        AND checkpoint.connection_id = NEW.connection_id
        AND checkpoint.provider = NEW.provider
        AND checkpoint.source_id = NEW.source_id
        AND checkpoint.engine_version = NEW.engine_version
        AND checkpoint.authorization_generation = NEW.authorization_generation
        AND checkpoint.rollout_generation = NEW.rollout_generation
        AND checkpoint.page_sequence = NEW.page_sequence
      FOR UPDATE;

      IF checkpoint_adapter_id IS NULL THEN
        RAISE EXCEPTION
          'Generation-2 source sync page item has no checkpoint adapter'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.adapter_output_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM omni_source_adapter_output_receipts receipt
        WHERE receipt.tenant_id = NEW.tenant_id
          AND receipt.adapter_output_id = NEW.adapter_output_id
          AND receipt.adapter_output_sha256 = NEW.adapter_output_sha256
          AND receipt.adapter_id = checkpoint_adapter_id
      ) THEN
        RAISE EXCEPTION
          'Source sync page receipt adapter does not match its checkpoint'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.source_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM omni_source_revisions source_revision
        WHERE source_revision.tenant_id = NEW.tenant_id
          AND source_revision.id = NEW.source_revision_id
          AND source_revision.source_item_id = NEW.source_item_id
          AND source_revision.adapter_id = checkpoint_adapter_id
      ) THEN
        RAISE EXCEPTION
          'Source sync page revision adapter does not match its checkpoint'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.source_tombstone_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM omni_source_tombstones tombstone
        WHERE tombstone.tenant_id = NEW.tenant_id
          AND tombstone.id = NEW.source_tombstone_id
          AND tombstone.source_item_id = NEW.source_item_id
          AND tombstone.adapter_id = checkpoint_adapter_id
      ) THEN
        RAISE EXCEPTION
          'Source sync page tombstone adapter does not match its checkpoint'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname =
          'omni_source_sync_page_checkpoints_validate_rollout'
          AND tgrelid = 'omni_source_sync_page_checkpoints'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER
          omni_source_sync_page_checkpoints_validate_rollout
        BEFORE INSERT OR UPDATE ON omni_source_sync_page_checkpoints
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_source_sync_checkpoint_rollout();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname =
          'omni_source_sync_page_checkpoints_protect_rollout_binding'
          AND tgrelid = 'omni_source_sync_page_checkpoints'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER
          omni_source_sync_page_checkpoints_protect_rollout_binding
        BEFORE UPDATE ON omni_source_sync_page_checkpoints
        FOR EACH ROW
        EXECUTE FUNCTION
          omni_protect_source_sync_checkpoint_rollout_binding();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_sync_page_items_validate_adapter_id'
          AND tgrelid = 'omni_source_sync_page_items'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_sync_page_items_validate_adapter_id
        BEFORE INSERT OR UPDATE ON omni_source_sync_page_items
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_source_sync_page_item_adapter_id();
      END IF;
    END
    $migration$
  `;
}
