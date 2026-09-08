BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 147
      AND name = 'loop_v2_context_text_engine_v1'
      AND checksum =
        'abe02d5cde5e23661f1407af38a6cb7db6f9491b46e48c7313341d7b8a069760'
  ) <> 1 THEN
    RAISE EXCEPTION 'Personal-context consent predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE OR REPLACE FUNCTION omni_personal_context_consent_row_is_valid(
  candidate_schema_version SMALLINT,
  candidate_tenant_id TEXT,
  candidate_actor_id TEXT,
  candidate_consent_generation BIGINT,
  candidate_contract_id TEXT,
  candidate_notice_contract_id TEXT,
  candidate_notice_contract_version SMALLINT,
  candidate_notice_sha256 TEXT,
  candidate_state TEXT,
  candidate_lifecycle_revision BIGINT,
  candidate_activated_by_actor_id TEXT,
  candidate_revoked_by_actor_id TEXT,
  candidate_created_at TIMESTAMPTZ,
  candidate_activated_at TIMESTAMPTZ,
  candidate_revoked_at TIMESTAMPTZ,
  candidate_updated_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
  SELECT COALESCE(
    candidate_schema_version = 1
    AND public.omni_source_contract_id_is_valid(candidate_tenant_id)
    AND candidate_actor_id ~
      '^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND candidate_consent_generation BETWEEN 1 AND 9007199254740991
    AND candidate_contract_id = 'personal-context-consent:1'
    AND candidate_notice_contract_id = 'notice:personal-context-automatic'
    AND candidate_notice_contract_version = 1
    AND candidate_notice_sha256 =
      '443267b19d744dc16298e950b4c5c0f8543124a526488fa018668193e61f1e75'
    AND candidate_activated_by_actor_id = candidate_actor_id
    AND candidate_created_at = candidate_activated_at
    AND candidate_activated_at <= candidate_updated_at
    AND (
      (
        candidate_state = 'active'
        AND candidate_lifecycle_revision = 1
        AND candidate_revoked_by_actor_id IS NULL
        AND candidate_revoked_at IS NULL
      )
      OR (
        candidate_state = 'revoked'
        AND candidate_lifecycle_revision = 2
        AND candidate_revoked_by_actor_id = candidate_actor_id
        AND candidate_revoked_at IS NOT NULL
        AND candidate_activated_at <= candidate_revoked_at
        AND candidate_revoked_at = candidate_updated_at
      )
    ),
    FALSE
  )
$function$;

CREATE TABLE IF NOT EXISTS omni_personal_context_consents (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  consent_generation BIGINT NOT NULL,
  contract_id TEXT NOT NULL DEFAULT 'personal-context-consent:1',
  notice_contract_id TEXT NOT NULL DEFAULT 'notice:personal-context-automatic',
  notice_contract_version SMALLINT NOT NULL DEFAULT 1,
  notice_sha256 TEXT NOT NULL DEFAULT
    '443267b19d744dc16298e950b4c5c0f8543124a526488fa018668193e61f1e75',
  state TEXT NOT NULL,
  lifecycle_revision BIGINT NOT NULL,
  activated_by_actor_id TEXT NOT NULL,
  revoked_by_actor_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT omni_personal_context_consents_pkey
    PRIMARY KEY (tenant_id, actor_id, consent_generation),
  CONSTRAINT omni_personal_context_consents_row_check CHECK (
    omni_personal_context_consent_row_is_valid(
      schema_version, tenant_id, actor_id, consent_generation, contract_id,
      notice_contract_id, notice_contract_version, notice_sha256, state,
      lifecycle_revision, activated_by_actor_id, revoked_by_actor_id,
      created_at, activated_at, revoked_at, updated_at
    )
  ),
  CONSTRAINT omni_personal_context_consents_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES omni_auth_tenants (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_personal_context_consents_actor_fkey
    FOREIGN KEY (actor_id) REFERENCES omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_personal_context_consents_activated_actor_fkey
    FOREIGN KEY (activated_by_actor_id) REFERENCES omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_personal_context_consents_revoked_actor_fkey
    FOREIGN KEY (revoked_by_actor_id) REFERENCES omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS omni_personal_context_consents_active_idx
ON omni_personal_context_consents (tenant_id, actor_id)
WHERE state = 'active';

CREATE OR REPLACE FUNCTION omni_validate_personal_context_consent_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  expected_generation BIGINT;
  transition_at TIMESTAMPTZ;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext(NEW.tenant_id),
    hashtext(NEW.actor_id || chr(31) || 'personal-context-consent:1')
  );
  SELECT COALESCE(MAX(consent_generation), 0) + 1
  INTO expected_generation
  FROM public.omni_personal_context_consents
  WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id;

  IF NEW.consent_generation IS DISTINCT FROM expected_generation
    OR NEW.state IS DISTINCT FROM 'active'
    OR NEW.lifecycle_revision IS DISTINCT FROM 1
    OR NEW.activated_by_actor_id IS DISTINCT FROM NEW.actor_id
    OR NEW.revoked_by_actor_id IS NOT NULL
    OR NEW.revoked_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'Personal-context consent activation is invalid'
      USING ERRCODE = '23514';
  END IF;

  transition_at := statement_timestamp();
  NEW.created_at := transition_at;
  NEW.activated_at := transition_at;
  NEW.updated_at := transition_at;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION omni_protect_personal_context_consent()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  transition_at TIMESTAMPTZ;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Personal-context consent history is immutable'
      USING ERRCODE = '55000';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtext(OLD.tenant_id),
    hashtext(OLD.actor_id || chr(31) || 'personal-context-consent:1')
  );
  IF OLD.state IS DISTINCT FROM 'active'
    OR NEW.state IS DISTINCT FROM 'revoked'
    OR NEW.lifecycle_revision IS DISTINCT FROM 2
    OR NEW.revoked_by_actor_id IS DISTINCT FROM OLD.actor_id
    OR ROW(
      NEW.schema_version, NEW.tenant_id, NEW.actor_id,
      NEW.consent_generation, NEW.contract_id, NEW.notice_contract_id,
      NEW.notice_contract_version, NEW.notice_sha256,
      NEW.activated_by_actor_id, NEW.created_at, NEW.activated_at
    ) IS DISTINCT FROM ROW(
      OLD.schema_version, OLD.tenant_id, OLD.actor_id,
      OLD.consent_generation, OLD.contract_id, OLD.notice_contract_id,
      OLD.notice_contract_version, OLD.notice_sha256,
      OLD.activated_by_actor_id, OLD.created_at, OLD.activated_at
    )
  THEN
    RAISE EXCEPTION 'Personal-context consent transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  transition_at := GREATEST(
    statement_timestamp(),
    OLD.updated_at + INTERVAL '1 microsecond'
  );
  NEW.revoked_at := transition_at;
  NEW.updated_at := transition_at;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS omni_personal_context_consent_validate_insert
  ON omni_personal_context_consents;
CREATE TRIGGER omni_personal_context_consent_validate_insert
BEFORE INSERT ON omni_personal_context_consents
FOR EACH ROW EXECUTE FUNCTION omni_validate_personal_context_consent_insert();

DROP TRIGGER IF EXISTS omni_personal_context_consent_protect
  ON omni_personal_context_consents;
CREATE TRIGGER omni_personal_context_consent_protect
BEFORE UPDATE OR DELETE ON omni_personal_context_consents
FOR EACH ROW EXECUTE FUNCTION omni_protect_personal_context_consent();

DROP TRIGGER IF EXISTS omni_personal_context_consent_no_truncate
  ON omni_personal_context_consents;
CREATE TRIGGER omni_personal_context_consent_no_truncate
BEFORE TRUNCATE ON omni_personal_context_consents
FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_personal_context_consent();

ALTER TABLE omni_personal_context_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_personal_context_consents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS omni_personal_context_consents_actor_scope
  ON omni_personal_context_consents;
CREATE POLICY omni_personal_context_consents_actor_scope
ON omni_personal_context_consents AS PERMISSIVE FOR ALL TO PUBLIC
USING (
  omni_system_scope_enabled()
  OR omni_actor_scope_v1_allows_canonical(tenant_id, actor_id)
)
WITH CHECK (
  omni_system_scope_enabled()
  OR omni_actor_scope_v1_allows_canonical(tenant_id, actor_id)
);

REVOKE ALL ON TABLE omni_personal_context_consents FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_personal_context_consent_row_is_valid(
  SMALLINT, TEXT, TEXT, BIGINT, TEXT, TEXT, SMALLINT, TEXT, TEXT,
  BIGINT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_validate_personal_context_consent_insert()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_protect_personal_context_consent() FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    EXECUTE
      'REVOKE ALL ON TABLE omni_personal_context_consents FROM omni_runtime';
    GRANT SELECT, INSERT ON omni_personal_context_consents TO omni_runtime;
    GRANT UPDATE (
      state, lifecycle_revision, revoked_by_actor_id, revoked_at, updated_at
    ) ON omni_personal_context_consents TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    EXECUTE
      'REVOKE ALL ON TABLE omni_personal_context_consents FROM omni_maintenance';
    GRANT SELECT, INSERT ON omni_personal_context_consents TO omni_maintenance;
    GRANT UPDATE (
      state, lifecycle_revision, revoked_by_actor_id, revoked_at, updated_at
    ) ON omni_personal_context_consents TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    EXECUTE
      'REVOKE ALL ON TABLE omni_personal_context_consents FROM omni_backup';
    GRANT SELECT ON omni_personal_context_consents TO omni_backup;
  END IF;
END
$grants$;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'omni_personal_context_consents'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid = 'omni_personal_context_consents'::regclass
      AND polname = 'omni_personal_context_consents_actor_scope'
      AND polpermissive
  ) <> 1 OR EXISTS (
    SELECT 1 FROM information_schema.table_privileges
    WHERE table_schema = current_schema()
      AND table_name = 'omni_personal_context_consents'
      AND grantee IN ('omni_runtime', 'omni_maintenance')
      AND privilege_type IN ('DELETE', 'TRUNCATE')
  ) THEN
    RAISE EXCEPTION 'Personal-context consent boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  148,
  'personal_context_consent_v1',
  'e41c0aa8ef3d49aa2b29da415d2ca37d4d1eeef3d36fe338cb1fffa2a6a48e0d',
  clock_timestamp()
);

COMMIT;
