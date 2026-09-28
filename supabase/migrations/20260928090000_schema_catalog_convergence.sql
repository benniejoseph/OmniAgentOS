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

  IF latest_version IS DISTINCT FROM 207 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 207
      AND name = 'memory_forget_lineage_closure_v1'
      AND checksum = '980dfe0af300eac5072cf0bf6b5f80b6a4e5335f444f0046732e7291f3f26c36'
  ) <> 1 THEN
    RAISE EXCEPTION 'Schema catalog convergence predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- A database migrated before every version ran from its SQL file can differ
-- from what the files build in three ways, and this migration brings it to
-- the files' catalog:
--
-- 1. 38 tables whose only policy should be an actor policy also have a
--    permissive omni_tenant_isolation policy. Permissive policies combine with
--    OR, so every actor of a tenant could read and change the others' rows.
-- 2. 8 tables lack 43 of their CHECK constraints and have 8 others under
--    different names. The missing ones are added NOT VALID, so they bind new
--    and changed rows at once without scanning the table under its lock; a
--    later release validates them.
-- 3. omni_system_scope_enabled() admits only the schema owner, so the
--    BYPASSRLS maintenance role cannot raise system scope.
--
-- Each step changes only what differs, so on a database the files built this
-- migration takes no table lock.

DO $policies$
DECLARE
  actor_expression CONSTANT TEXT :=
    '(omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))';
  actor_scope_expression CONSTANT TEXT :=
    '(omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id) OR omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id))';
  consent_expression CONSTANT TEXT :=
    '(omni_system_scope_enabled() OR omni_actor_scope_v1_allows_canonical(tenant_id, actor_id))';
  expected RECORD;
BEGIN
  FOR expected IN
    SELECT table_name, table_name || '_actor' AS policy_name, actor_expression AS expression
    FROM unnest(ARRAY[
      'omni_ap2_credential_claims',
      'omni_ap2_credential_grants',
      'omni_ap2_mandate_authorizations',
      'omni_ap2_mandate_reviews',
      'omni_ap2_payment_receipts',
      'omni_ap2_payment_transactions',
      'omni_ap2_reconciliation_jobs',
      'omni_ap2_reconciliation_observations',
      'omni_ap2_signing_credentials',
      'omni_communication_intents',
      'omni_conversation_links',
      'omni_delivery_receipts',
      'omni_inbound_communications',
      'omni_message_drafts',
      'omni_mobile_push_deliveries',
      'omni_mobile_push_registrations',
      'omni_person_contact_policies'
    ]::TEXT[]) AS table_name
    UNION ALL
    SELECT table_name, table_name || '_actor_scope', actor_scope_expression
    FROM unnest(ARRAY[
      'omni_app_builder_checkpoints',
      'omni_app_builder_deliveries',
      'omni_app_builder_deployments',
      'omni_app_builder_events',
      'omni_app_builder_releases',
      'omni_app_builder_repository_bindings',
      'omni_app_builder_sessions',
      'omni_app_builder_verifications',
      'omni_market_backtest_events',
      'omni_market_backtests',
      'omni_market_event_replay_events',
      'omni_market_event_replays',
      'omni_market_macro_event_events',
      'omni_market_macro_event_schedule_events',
      'omni_market_macro_event_schedules',
      'omni_market_macro_events',
      'omni_market_macro_observation_events',
      'omni_market_macro_observations',
      'omni_market_price_snapshot_events',
      'omni_market_price_snapshots'
    ]::TEXT[]) AS table_name
    UNION ALL
    SELECT
      'omni_personal_context_consents'::TEXT,
      'omni_personal_context_consents_actor_scope'::TEXT,
      consent_expression
    ORDER BY 1
  LOOP
    -- DROP POLICY IF EXISTS would lock the table even when the policy is
    -- absent.
    IF EXISTS (
      SELECT 1
      FROM pg_policy policy
      JOIN pg_class relation ON relation.oid = policy.polrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = expected.table_name
        AND policy.polname = 'omni_tenant_isolation'
    ) THEN
      EXECUTE format('DROP POLICY omni_tenant_isolation ON public.%I', expected.table_name);
    END IF;

    -- The actor policy must be the table's only policy, exactly as the files
    -- create it, and row security must be forced.
    IF NOT EXISTS (
      SELECT 1
      FROM pg_policy policy
      JOIN pg_class relation ON relation.oid = policy.polrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = expected.table_name
        AND relation.relrowsecurity
        AND relation.relforcerowsecurity
        AND policy.polname = expected.policy_name
        AND policy.polpermissive
        AND policy.polcmd = '*'
        AND policy.polroles = ARRAY[0]::OID[]
        AND pg_get_expr(policy.polqual, policy.polrelid) = expected.expression
        AND pg_get_expr(policy.polwithcheck, policy.polrelid) = expected.expression
    ) OR (
      SELECT count(*)
      FROM pg_policy policy
      JOIN pg_class relation ON relation.oid = policy.polrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = expected.table_name
    ) <> 1 THEN
      RAISE EXCEPTION 'The policies of % are not its actor policy alone', expected.table_name
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$policies$;

DO $constraints$
DECLARE
  planned_rename RECORD;
  expected RECORD;
BEGIN
  -- Renamed in this order, so that each name is free before a constraint
  -- takes it.
  FOR planned_rename IN
    SELECT table_name, old_name, new_name
    FROM (VALUES
      (1, 'omni_mobile_push_deliveries',
        'omni_mobile_push_deliveries_check4',
        'omni_mobile_push_deliveries_check5'),
      (2, 'omni_mobile_push_deliveries',
        'omni_mobile_push_deliveries_check3',
        'omni_mobile_push_deliveries_check4'),
      (3, 'omni_mobile_push_deliveries',
        'omni_mobile_push_deliveries_check2',
        'omni_mobile_push_deliveries_check3'),
      (4, 'omni_mobile_push_deliveries',
        'omni_mobile_push_deliveries_check1',
        'omni_mobile_push_deliveries_check2'),
      (5, 'omni_mobile_push_deliveries',
        'omni_mobile_push_deliveries_check',
        'omni_mobile_push_deliveries_check1'),
      (6, 'omni_mobile_push_registrations',
        'omni_mobile_push_registrations_check1',
        'omni_mobile_push_registrations_check'),
      (7, 'omni_salesforce_connections',
        'omni_salesforce_connections_object_scope_check',
        'omni_salesforce_connections_object_scope_check2'),
      (8, 'omni_salesforce_record_heads',
        'omni_salesforce_record_heads_check1',
        'omni_salesforce_record_heads_check2')
    ) AS renames(step, table_name, old_name, new_name)
    ORDER BY step
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_constraint check_constraint
      JOIN pg_class relation ON relation.oid = check_constraint.conrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = planned_rename.table_name
        AND check_constraint.conname = planned_rename.old_name
    ) AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint check_constraint
      JOIN pg_class relation ON relation.oid = check_constraint.conrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = planned_rename.table_name
        AND check_constraint.conname = planned_rename.new_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',
        planned_rename.table_name,
        planned_rename.old_name,
        planned_rename.new_name
      );
    END IF;
  END LOOP;

  -- The files wrote this CHECK with BETWEEN, which Postgres keeps as an AND
  -- inside an AND. Its printed definition parses back to one flat AND and
  -- prints differently, so it is added as the files wrote it.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint check_constraint
    JOIN pg_class relation ON relation.oid = check_constraint.conrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'omni_mobile_push_deliveries'
      AND check_constraint.conname = 'omni_mobile_push_deliveries_deep_link_check'
  ) THEN
    ALTER TABLE public.omni_mobile_push_deliveries
      ADD CONSTRAINT omni_mobile_push_deliveries_deep_link_check
      CHECK (char_length(deep_link) BETWEEN 2 AND 1000 AND left(deep_link, 1) = '/')
      NOT VALID;
  END IF;

  -- Every constraint the files create on these tables that the old runner
  -- left out or named differently, with its definition as pg_get_constraintdef
  -- prints it.
  FOR expected IN
    SELECT table_name, constraint_name, definition
    FROM (VALUES
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
        'omni_mobile_push_deliveries_check1',
        'CHECK (((lease_owner IS NULL) = (lease_expires_at IS NULL)))'),
      ('omni_mobile_push_deliveries',
        'omni_mobile_push_deliveries_check2',
        'CHECK (((status = ''running''::text) = (lease_owner IS NOT NULL)))'),
      ('omni_mobile_push_deliveries',
        'omni_mobile_push_deliveries_check3',
        'CHECK (((delivered_at IS NULL) OR (status = ANY (ARRAY[''delivered''::text, ''acknowledged''::text]))))'),
      ('omni_mobile_push_deliveries',
        'omni_mobile_push_deliveries_check4',
        'CHECK (((acknowledged_at IS NOT NULL) = (status = ''acknowledged''::text)))'),
      ('omni_mobile_push_deliveries',
        'omni_mobile_push_deliveries_check5',
        'CHECK (((cause_kind = ''work_item''::text) OR (parent_id IS NULL)))'),
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
        'omni_mobile_push_registrations_check',
        'CHECK (((state = ''revoked''::text) = (revoked_at IS NOT NULL)))'),
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
        'omni_salesforce_connections_object_scope_check2',
        'CHECK ((cardinality(object_scope) = 8))'),
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
        'omni_salesforce_record_heads_check2',
        'CHECK (((projection_status = ''error''::text) = (projection_error_code IS NOT NULL)))'),
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
        'CHECK ((organization_id_sha256 ~ ''^[a-f0-9]{64}$''::text))')
    ) AS expected_constraints(table_name, constraint_name, definition)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint check_constraint
      JOIN pg_class relation ON relation.oid = check_constraint.conrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = expected.table_name
        AND check_constraint.conname = expected.constraint_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I %s NOT VALID',
        expected.table_name,
        expected.constraint_name,
        expected.definition
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint check_constraint
      JOIN pg_class relation ON relation.oid = check_constraint.conrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = expected.table_name
        AND check_constraint.conname = expected.constraint_name
        AND pg_get_constraintdef(check_constraint.oid) = expected.definition ||
          CASE WHEN check_constraint.convalidated THEN '' ELSE ' NOT VALID' END
    ) THEN
      RAISE EXCEPTION 'Constraint % of % is not the expected one',
        expected.constraint_name,
        expected.table_name
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  -- The old runner's name for omni_mobile_push_registrations_check.
  IF EXISTS (
    SELECT 1
    FROM pg_constraint check_constraint
    JOIN pg_class relation ON relation.oid = check_constraint.conrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'omni_mobile_push_registrations'
      AND check_constraint.conname = 'omni_mobile_push_registrations_check1'
  ) THEN
    RAISE EXCEPTION 'omni_mobile_push_registrations still has a constraint the files do not create'
      USING ERRCODE = '55000';
  END IF;
END
$constraints$;

-- The definition from maintenance_system_scope_v1. Replacing a function keeps
-- its owner and grants.
CREATE OR REPLACE FUNCTION public.omni_system_scope_enabled()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
  SELECT
    COALESCE(current_setting('omni.system_scope', TRUE), '') = 'true'
    AND NULLIF(current_setting('omni.system_reason', TRUE), '') IS NOT NULL
    AND (
      current_user = (
        SELECT pg_get_userbyid(relowner)
        FROM pg_class
        WHERE oid = 'omni_schema_version'::regclass
      )
      OR EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = current_user
          AND rolbypassrls
          AND NOT rolsuper
      )
    )
$function$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  208,
  'schema_catalog_convergence_v1',
  '514f00004c8726a2c762f6069728b20d4816a92731c72c125bf39cbca9a0371f',
  clock_timestamp()
);

COMMIT;
