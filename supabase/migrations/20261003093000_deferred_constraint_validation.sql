BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);

DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version
  FROM public.omni_schema_version
  WHERE version IS NOT NULL;

  IF latest_version IS DISTINCT FROM 213 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 213
      AND name = 'source_validator_restore_qualification_v1'
      AND checksum = '0540f57f5a92f5dd02b2d3289537a3bd26104f2c945f4280464bf06c084c3a65'
  ) <> 1 THEN
    RAISE EXCEPTION 'Deferred constraint validation predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- Validate only the 43 CHECKs v208 added and the refresh-pair CHECK v209
-- added. The eight renamed v208 CHECKs and later NOT VALID CHECKs are outside
-- this migration. Check the entire target catalog before taking validation
-- locks; never repair, delete or otherwise rewrite a row to make it pass.
DO $validation$
DECLARE
  expected RECORD;
  already_validated BOOLEAN;
  pending_checks TEXT[] := '{}';
  validation_statement TEXT;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('omni_mobile_push_deliveries',
        'omni_mobile_push_deliveries_attempt_check',
        'CHECK (((attempt >= 0) AND (attempt <= 20)))'),
      ('omni_mobile_push_deliveries',
        'omni_mobile_push_deliveries_cause_id_check',
        'CHECK (((char_length(cause_id) >= 1) AND (char_length(cause_id) <= 240)))'),
      ('omni_mobile_push_deliveries',
        'omni_mobile_push_deliveries_check',
        'CHECK ((attempt <= max_attempts))'),
      ('omni_mobile_push_deliveries',
        'omni_mobile_push_deliveries_deep_link_check',
        'CHECK ((((char_length(deep_link) >= 2) AND (char_length(deep_link) <= 1000)) AND ("left"(deep_link, 1) = ''/''::text)))'),
      ('omni_mobile_push_deliveries',
        'omni_mobile_push_deliveries_id_check',
        'CHECK (((char_length(id) >= 16) AND (char_length(id) <= 200)))'),
      ('omni_mobile_push_deliveries',
        'omni_mobile_push_deliveries_max_attempts_check',
        'CHECK (((max_attempts >= 1) AND (max_attempts <= 20)))'),
      ('omni_mobile_push_deliveries',
        'omni_mobile_push_deliveries_notification_id_check',
        'CHECK (((notification_id IS NULL) OR ((char_length(notification_id) >= 1) AND (char_length(notification_id) <= 240))))'),
      ('omni_mobile_push_deliveries',
        'omni_mobile_push_deliveries_owner_actor_id_check',
        'CHECK (((char_length(owner_actor_id) >= 1) AND (char_length(owner_actor_id) <= 500)))'),
      ('omni_mobile_push_deliveries',
        'omni_mobile_push_deliveries_parent_id_check',
        'CHECK (((parent_id IS NULL) OR ((char_length(parent_id) >= 1) AND (char_length(parent_id) <= 240))))'),
      ('omni_mobile_push_deliveries',
        'omni_mobile_push_deliveries_provider_message_id_sha256_check',
        'CHECK (((provider_message_id_sha256 IS NULL) OR (provider_message_id_sha256 ~ ''^[a-f0-9]{64}$''::text)))'),
      ('omni_mobile_push_registrations',
        'omni_mobile_push_registrations_credential_version_check',
        'CHECK (((credential_version >= 1) AND (credential_version <= 32767)))'),
      ('omni_mobile_push_registrations',
        'omni_mobile_push_registrations_device_id_check',
        'CHECK (((char_length(device_id) >= 8) AND (char_length(device_id) <= 200)))'),
      ('omni_mobile_push_registrations',
        'omni_mobile_push_registrations_id_check',
        'CHECK (((char_length(id) >= 16) AND (char_length(id) <= 200)))'),
      ('omni_mobile_push_registrations',
        'omni_mobile_push_registrations_lifecycle_revision_check',
        'CHECK (((lifecycle_revision >= 1) AND (lifecycle_revision <= ''9007199254740991''::bigint)))'),
      ('omni_mobile_push_registrations',
        'omni_mobile_push_registrations_owner_actor_id_check',
        'CHECK (((char_length(owner_actor_id) >= 1) AND (char_length(owner_actor_id) <= 500)))'),
      ('omni_model_assignments',
        'omni_model_assignments_revision_check',
        'CHECK ((assignment_revision > 0))'),
      ('omni_salesforce_connections',
        'omni_salesforce_connections_check2',
        'CHECK (((last_successful_sync_at IS NULL) OR (last_successful_sync_at >= created_at)))'),
      ('omni_salesforce_connections',
        'omni_salesforce_connections_check3',
        'CHECK (((last_webhook_at IS NULL) OR (last_webhook_at >= created_at)))'),
      ('omni_salesforce_connections',
        'omni_salesforce_connections_instance_origin_check',
        'CHECK ((instance_origin ~ ''^https://[A-Za-z0-9.-]+\.(salesforce\.com|salesforce\.mil|cloudforce\.com)$''::text))'),
      ('omni_salesforce_connections',
        'omni_salesforce_connections_object_scope_check',
        'CHECK ((object_scope <@ ARRAY[''Account''::text, ''Contact''::text, ''Opportunity''::text, ''Case''::text, ''Task''::text, ''Event''::text, ''Asset''::text, ''Contract''::text]))'),
      ('omni_salesforce_connections',
        'omni_salesforce_connections_object_scope_check1',
        'CHECK ((object_scope @> ARRAY[''Account''::text, ''Contact''::text, ''Opportunity''::text, ''Case''::text, ''Task''::text, ''Event''::text, ''Asset''::text, ''Contract''::text]))'),
      ('omni_salesforce_connections',
        'omni_salesforce_connections_sync_cursor_check1',
        'CHECK ((jsonb_typeof((sync_cursor -> ''objects''::text)) = ''object''::text))'),
      ('omni_salesforce_connections',
        'omni_salesforce_connections_sync_error_check',
        'CHECK (((sync_error IS NULL) OR ((jsonb_typeof(sync_error) = ''object''::text) AND (sync_error ? ''code''::text) AND (sync_error ? ''message''::text) AND (sync_error ? ''action''::text) AND (sync_error ? ''occurredAt''::text))))'),
      ('omni_salesforce_connections',
        'omni_salesforce_connections_sync_lease_owner_id_check',
        'CHECK (((sync_lease_owner_id IS NULL) OR ((char_length(sync_lease_owner_id) >= 1) AND (char_length(sync_lease_owner_id) <= 240))))'),
      ('omni_salesforce_reconciliation_findings',
        'omni_salesforce_reconciliation_finding_remote_revision_id_check',
        'CHECK (((remote_revision_id IS NULL) OR (remote_revision_id ~ ''^salesforce-revision:[a-f0-9]{64}$''::text)))'),
      ('omni_salesforce_reconciliation_findings',
        'omni_salesforce_reconciliation_findings_local_revision_id_check',
        'CHECK (((local_revision_id IS NULL) OR (local_revision_id ~ ''^salesforce-revision:[a-f0-9]{64}$''::text)))'),
      ('omni_salesforce_reconciliation_findings',
        'omni_salesforce_reconciliation_findings_object_type_check',
        'CHECK ((object_type = ANY (ARRAY[''Account''::text, ''Contact''::text, ''Opportunity''::text, ''Case''::text, ''Task''::text, ''Event''::text, ''Asset''::text, ''Contract''::text])))'),
      ('omni_salesforce_record_heads',
        'omni_salesforce_record_heads_account_external_id_check',
        'CHECK (((account_external_id IS NULL) OR (account_external_id ~ ''^[A-Za-z0-9]{15,18}$''::text)))'),
      ('omni_salesforce_record_heads',
        'omni_salesforce_record_heads_check1',
        'CHECK (((record_snapshot ->> ''revisionId''::text) = current_revision_id))'),
      ('omni_salesforce_record_heads',
        'omni_salesforce_record_heads_check3',
        'CHECK (((projected_at IS NULL) OR (projected_at <= updated_at)))'),
      ('omni_salesforce_record_heads',
        'omni_salesforce_record_heads_organization_id_sha256_check',
        'CHECK ((organization_id_sha256 ~ ''^[a-f0-9]{64}$''::text))'),
      ('omni_salesforce_record_heads',
        'omni_salesforce_record_heads_projection_error_code_check',
        'CHECK (((projection_error_code IS NULL) OR (projection_error_code = ANY (ARRAY[''account_missing''::text, ''account_conflict''::text, ''permission_denied''::text, ''invalid_record''::text, ''internal_error''::text]))))'),
      ('omni_salesforce_record_revisions',
        'omni_salesforce_record_revisions_account_external_id_check',
        'CHECK (((account_external_id IS NULL) OR (account_external_id ~ ''^[A-Za-z0-9]{15,18}$''::text)))'),
      ('omni_salesforce_record_revisions',
        'omni_salesforce_record_revisions_check1',
        'CHECK (((record_snapshot ->> ''revisionId''::text) = revision_id))'),
      ('omni_salesforce_record_revisions',
        'omni_salesforce_record_revisions_check2',
        'CHECK (((record_snapshot ->> ''objectType''::text) = object_type))'),
      ('omni_salesforce_record_revisions',
        'omni_salesforce_record_revisions_check3',
        'CHECK (((record_snapshot ->> ''externalId''::text) = external_id))'),
      ('omni_salesforce_record_revisions',
        'omni_salesforce_record_revisions_check4',
        'CHECK ((received_at >= observed_at))'),
      ('omni_salesforce_record_revisions',
        'omni_salesforce_record_revisions_fields_sha256_check',
        'CHECK ((fields_sha256 ~ ''^[a-f0-9]{64}$''::text))'),
      ('omni_salesforce_record_revisions',
        'omni_salesforce_record_revisions_organization_id_sha256_check',
        'CHECK ((organization_id_sha256 ~ ''^[a-f0-9]{64}$''::text))'),
      ('omni_salesforce_record_revisions',
        'omni_salesforce_record_revisions_replay_id_sha256_check',
        'CHECK (((replay_id_sha256 IS NULL) OR (replay_id_sha256 ~ ''^[a-f0-9]{64}$''::text)))'),
      ('omni_salesforce_webhook_events',
        'omni_salesforce_webhook_events_external_id_check',
        'CHECK ((external_id ~ ''^[A-Za-z0-9]{15,18}$''::text))'),
      ('omni_salesforce_webhook_events',
        'omni_salesforce_webhook_events_object_type_check',
        'CHECK ((object_type = ANY (ARRAY[''Account''::text, ''Contact''::text, ''Opportunity''::text, ''Case''::text, ''Task''::text, ''Event''::text, ''Asset''::text, ''Contract''::text])))'),
      ('omni_salesforce_webhook_events',
        'omni_salesforce_webhook_events_organization_id_sha256_check',
        'CHECK ((organization_id_sha256 ~ ''^[a-f0-9]{64}$''::text))'),
      ('omni_mobile_sessions',
        'omni_mobile_sessions_refresh_rotation_check',
        'CHECK ((((refresh_rotated_at IS NULL) = (refresh_rotation_key IS NULL)) AND ((refresh_rotation_key IS NULL) OR (refresh_rotation_key ~ ''^[A-Za-z0-9_-]{43}$''::text))))')
    ) AS targets(table_name, constraint_name, definition)
  LOOP
    SELECT check_constraint.convalidated INTO already_validated
    FROM pg_constraint check_constraint
    JOIN pg_class relation ON relation.oid = check_constraint.conrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = expected.table_name
      AND relation.relkind = 'r'
      AND check_constraint.conname = expected.constraint_name
      AND check_constraint.contype = 'c'
      AND check_constraint.conislocal
      AND check_constraint.coninhcount = 0
      AND NOT check_constraint.connoinherit
      AND pg_get_constraintdef(check_constraint.oid) = expected.definition ||
        CASE WHEN check_constraint.convalidated THEN '' ELSE ' NOT VALID' END;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Validation target %.% is missing or differs from its recorded definition',
        expected.table_name, expected.constraint_name USING ERRCODE = '55000';
    END IF;
    IF NOT already_validated THEN
      pending_checks := array_append(pending_checks, format(
        'ALTER TABLE public.%I VALIDATE CONSTRAINT %I',
        expected.table_name, expected.constraint_name
      ));
    END IF;
  END LOOP;

  -- PostgreSQL checks all existing rows, fails with 23514 on a violation,
  -- and uses SHARE UPDATE EXCLUSIVE rather than ACCESS EXCLUSIVE. This
  -- transaction rolls every validation back if any target cannot validate.
  FOREACH validation_statement IN ARRAY pending_checks LOOP
    EXECUTE validation_statement;
  END LOOP;
END
$validation$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  214,
  'deferred_constraint_validation_v1',
  'c5aa4b4689b0c80e509f86e3c44512ea70c6ccf6f3d4ae57a369d432469fd9b4',
  clock_timestamp()
);

COMMIT;
