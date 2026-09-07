BEGIN;

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 128
      AND name = 'canonical_work_model_v1'
      AND checksum = '04e10243d48983a00192987e1a2cb0f4b7dc00a1609a13d172495e911c85c59c'
  ) <> 1 THEN
    RAISE EXCEPTION 'Canonical work projection repair predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE OR REPLACE FUNCTION omni_protect_canonical_work_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Canonical work records cannot be deleted or truncated'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'omni_work_item_status_history' THEN
    RAISE EXCEPTION 'Canonical WorkItem status history is append-only'
      USING ERRCODE = '55000';
  ELSIF TG_TABLE_NAME = 'omni_work_projects' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
      OR NEW.project_id IS DISTINCT FROM OLD.project_id
      OR NEW.owner_actor_id IS DISTINCT FROM OLD.owner_actor_id
      OR NEW.source_authority IS DISTINCT FROM OLD.source_authority
      OR NEW.source_id IS DISTINCT FROM OLD.source_id
      OR NEW.source_owner_actor_id IS DISTINCT FROM OLD.source_owner_actor_id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.lifecycle_revision IS DISTINCT FROM OLD.lifecycle_revision + 1
      OR NEW.updated_at <= OLD.updated_at
    THEN
      RAISE EXCEPTION 'Canonical Project update is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'omni_work_items' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
      OR NEW.project_id IS DISTINCT FROM OLD.project_id
      OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id
      OR NEW.source_authority IS DISTINCT FROM OLD.source_authority
      OR NEW.source_id IS DISTINCT FROM OLD.source_id
      OR NEW.source_owner_actor_id IS DISTINCT FROM OLD.source_owner_actor_id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.status_revision IS DISTINCT FROM OLD.status_revision + 1
      OR NEW.updated_at <= OLD.updated_at
    THEN
      RAISE EXCEPTION 'Canonical WorkItem update is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'omni_work_compatibility_mappings' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.mapping_id IS DISTINCT FROM OLD.mapping_id
      OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
      OR NEW.source_id IS DISTINCT FROM OLD.source_id
      OR NEW.source_owner_actor_id IS DISTINCT FROM OLD.source_owner_actor_id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.mapping_revision IS DISTINCT FROM OLD.mapping_revision + 1
      OR NEW.updated_at <= OLD.updated_at
    THEN
      RAISE EXCEPTION 'Canonical compatibility mapping update is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'omni_work_project_memberships' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
      OR NEW.project_id IS DISTINCT FROM OLD.project_id
      OR NEW.subject_actor_id IS DISTINCT FROM OLD.subject_actor_id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.membership_revision IS DISTINCT FROM OLD.membership_revision + 1
      OR NEW.updated_at <= OLD.updated_at
      OR NOT (OLD.state = 'active' AND NEW.state = 'revoked')
    THEN
      RAISE EXCEPTION 'Canonical Project membership update is invalid'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION omni_canonical_json_text_repair_v1(value JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $function$
DECLARE
  encoded TEXT;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{' || COALESCE(string_agg(
        to_json(key)::TEXT || ':' || omni_canonical_json_text_repair_v1(entry),
        ',' ORDER BY key
      ), '') || '}'
      INTO encoded
      FROM jsonb_each(value) AS object_entry(key, entry);
      RETURN encoded;
    WHEN 'array' THEN
      SELECT '[' || COALESCE(string_agg(
        omni_canonical_json_text_repair_v1(entry),
        ',' ORDER BY ordinal
      ), '') || ']'
      INTO encoded
      FROM jsonb_array_elements(value) WITH ORDINALITY
        AS array_entry(entry, ordinal);
      RETURN encoded;
    ELSE
      RETURN value::TEXT;
  END CASE;
END
$function$;

ALTER TABLE omni_work_items DISABLE TRIGGER omni_work_items_protect;

WITH incomplete AS (
  SELECT item.*,
    jsonb_build_object(
      'schemaVersion', item.schema_version,
      'tenantId', item.tenant_id,
      'workspaceId', item.workspace_id,
      'projectId', item.project_id,
      'workItemId', item.work_item_id,
      'parentWorkItemId', item.parent_work_item_id,
      'kind', item.kind,
      'title', item.title,
      'detail', item.detail,
      'priority', item.priority,
      'canonicalStatus', item.canonical_status,
      'sourceStatus', item.source_status,
      'statusRevision', item.status_revision,
      'sourceAuthority', item.source_authority,
      'dependencyWorkItemIds', item.dependency_work_item_ids,
      'ownerActorIds', item.owner_actor_ids,
      'assignedAgents', COALESCE(valid_agents.value, '[]'::JSONB),
      'schedule', jsonb_build_object(
        'startsAt', CASE
          WHEN pg_input_is_valid(item.schedule ->> 'startsAt', 'timestamptz')
            THEN to_char(
              (item.schedule ->> 'startsAt')::TIMESTAMPTZ AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            )
          ELSE NULL
        END,
        'dueAt', CASE
          WHEN pg_input_is_valid(item.schedule ->> 'dueAt', 'timestamptz')
            THEN to_char(
              (item.schedule ->> 'dueAt')::TIMESTAMPTZ AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            )
          ELSE NULL
        END,
        'timeZone', item.schedule -> 'timeZone'
      ),
      'recurrence', item.recurrence,
      'risks', item.risks,
      'decisions', item.decisions,
      'artifacts', item.artifacts,
      'createdAt', to_char(
        item.created_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'updatedAt', to_char(
        item.updated_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'terminalAt', CASE WHEN item.terminal_at IS NULL THEN NULL ELSE to_char(
        item.terminal_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) END
    ) AS repaired_projection
  FROM omni_work_items item
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(agent ORDER BY agent ->> 'agentId') AS value
    FROM jsonb_array_elements(item.assigned_agents) agent
    WHERE jsonb_typeof(agent) = 'object'
      AND NULLIF(btrim(agent ->> 'agentId'), '') IS NOT NULL
      AND agent ->> 'agentId' ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
      AND length(agent ->> 'agentId') <= 240
      AND (
        (agent -> 'principalId' = 'null'::JSONB
          AND agent -> 'principalGeneration' = 'null'::JSONB)
        OR
        (agent ->> 'principalId' ~ '^agent:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
          AND pg_input_is_valid(
            agent ->> 'principalGeneration', 'integer'
          )
          AND (agent ->> 'principalGeneration')::INTEGER >= 1)
      )
  ) valid_agents ON TRUE
  WHERE NOT item.projection ?& ARRAY[
    'schemaVersion', 'tenantId', 'workspaceId', 'projectId', 'workItemId',
    'parentWorkItemId', 'kind', 'title', 'detail', 'priority',
    'canonicalStatus', 'sourceStatus', 'statusRevision', 'sourceAuthority',
    'dependencyWorkItemIds', 'ownerActorIds', 'assignedAgents', 'schedule',
    'recurrence', 'risks', 'decisions', 'artifacts', 'createdAt', 'updatedAt',
    'terminalAt'
  ]
), repaired AS (
  UPDATE omni_work_items item
  SET projection = incomplete.repaired_projection,
      projection_sha256 = encode(sha256(convert_to(
        omni_canonical_json_text_repair_v1(incomplete.repaired_projection),
        'UTF8'
      )), 'hex')
  FROM incomplete
  WHERE item.tenant_id = incomplete.tenant_id
    AND item.source_authority = incomplete.source_authority
    AND item.source_id = incomplete.source_id
  RETURNING item.tenant_id, item.source_authority, item.source_id
)
SELECT count(*) FROM repaired;

ALTER TABLE omni_work_items ENABLE TRIGGER omni_work_items_protect;

DO $migration$
DECLARE
  required_keys CONSTANT TEXT[] := ARRAY[
    'schemaVersion', 'tenantId', 'workspaceId', 'projectId', 'workItemId',
    'parentWorkItemId', 'kind', 'title', 'detail', 'priority',
    'canonicalStatus', 'sourceStatus', 'statusRevision', 'sourceAuthority',
    'dependencyWorkItemIds', 'ownerActorIds', 'assignedAgents', 'schedule',
    'recurrence', 'risks', 'decisions', 'artifacts', 'createdAt', 'updatedAt',
    'terminalAt'
  ];
BEGIN
  IF EXISTS (
    SELECT 1 FROM omni_work_items item
    WHERE NOT item.projection ?& required_keys
      OR item.projection ->> 'tenantId' <> item.tenant_id
      OR item.projection ->> 'workspaceId' <> item.workspace_id
      OR item.projection ->> 'projectId' <> item.project_id
      OR item.projection ->> 'workItemId' <> item.work_item_id
      OR item.projection ->> 'kind' <> item.kind
      OR item.projection ->> 'canonicalStatus' <> item.canonical_status
      OR item.projection ->> 'sourceStatus' <> item.source_status
      OR (item.projection ->> 'statusRevision')::INTEGER <> item.status_revision
      OR item.projection ->> 'sourceAuthority' <> item.source_authority
      OR item.projection_sha256 <> encode(sha256(convert_to(
        omni_canonical_json_text_repair_v1(item.projection), 'UTF8'
      )), 'hex')
  ) THEN
    RAISE EXCEPTION 'Canonical work projection repair is incomplete'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

DROP FUNCTION omni_canonical_json_text_repair_v1(JSONB);

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  129,
  'canonical_work_projection_repair_v1',
  '2caff999167ba65438fbef957b194e64b9556c203028995fbb316ed7ba310bfc',
  clock_timestamp()
);

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 129
      AND name = 'canonical_work_projection_repair_v1'
      AND checksum = '2caff999167ba65438fbef957b194e64b9556c203028995fbb316ed7ba310bfc'
  ) <> 1 THEN
    RAISE EXCEPTION 'Canonical work projection repair integrity check failed'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

COMMIT;
