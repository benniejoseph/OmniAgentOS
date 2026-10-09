BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);

DO $predecessor$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 247 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version = 247
      AND name = 'thread_turn_workflow_run_binding_v1'
      AND checksum = 'f4f1712090f74fbb0beab44c4014d4542ed15d6c651984f83f395e75c8507a4e'
  ) <> 1 THEN
    RAISE EXCEPTION 'Personal profile predecessor is invalid' USING ERRCODE = '55000';
  END IF;
END
$predecessor$;

-- About me is an explicitly enabled owner profile, separate from memory consent.
-- Store only its current value. Clearing a field removes its contents and source;
-- mutation receipts contain hashes and revisions, never a historical profile.
CREATE TABLE public.omni_personal_profiles (
  schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  tenant_id TEXT NOT NULL CHECK (char_length(tenant_id) BETWEEN 1 AND 240),
  actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 320),
  revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  profile JSONB NOT NULL CHECK (
    jsonb_typeof(profile) = 'object' AND pg_column_size(profile) <= 48000
    AND profile ?& ARRAY['name', 'role', 'workingContext', 'preferences', 'goals', 'interests']
    AND profile - ARRAY['name', 'role', 'workingContext', 'preferences', 'goals', 'interests'] = '{}'::JSONB
    AND jsonb_typeof(profile->'name') = 'string' AND char_length(profile->>'name') <= 120
    AND jsonb_typeof(profile->'role') = 'string' AND char_length(profile->>'role') <= 600
    AND jsonb_typeof(profile->'workingContext') = 'string' AND char_length(profile->>'workingContext') <= 2400
    AND jsonb_typeof(profile->'preferences') = 'string' AND char_length(profile->>'preferences') <= 2000
    AND jsonb_typeof(profile->'goals') = 'string' AND char_length(profile->>'goals') <= 1600
    AND jsonb_typeof(profile->'interests') = 'string' AND char_length(profile->>'interests') <= 1200
  ),
  field_sources JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (
    jsonb_typeof(field_sources) = 'object' AND pg_column_size(field_sources) <= 8192
    AND field_sources - ARRAY['name', 'role', 'workingContext', 'preferences', 'goals', 'interests'] = '{}'::JSONB
  ),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, actor_id),
  CHECK (created_at <= updated_at)
);

CREATE TABLE public.omni_personal_profile_mutations (
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  idempotency_sha256 TEXT NOT NULL CHECK (idempotency_sha256 ~ '^[a-f0-9]{64}$'),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  saved_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, actor_id, idempotency_sha256),
  UNIQUE (tenant_id, actor_id, revision),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES public.omni_personal_profiles (tenant_id, actor_id)
    ON UPDATE RESTRICT ON DELETE CASCADE
);

CREATE FUNCTION public.omni_personal_profile_revision_v1()
RETURNS TRIGGER LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 OR NEW.created_at IS DISTINCT FROM NEW.updated_at THEN
      RAISE EXCEPTION 'Initial personal profile revision is invalid' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
    OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.revision <> OLD.revision + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Personal profile revision or ownership changed unexpectedly' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER omni_personal_profiles_revision BEFORE INSERT OR UPDATE ON public.omni_personal_profiles
FOR EACH ROW EXECUTE FUNCTION public.omni_personal_profile_revision_v1();

ALTER TABLE public.omni_personal_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_personal_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.omni_personal_profile_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_personal_profile_mutations FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_tenant_isolation ON public.omni_personal_profiles AS PERMISSIVE FOR ALL TO PUBLIC
USING (public.omni_tenant_visible(tenant_id)) WITH CHECK (public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_personal_profiles_actor ON public.omni_personal_profiles AS RESTRICTIVE FOR ALL TO PUBLIC
USING ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()), tenant_id, actor_id))
WITH CHECK ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()), tenant_id, actor_id));
CREATE POLICY omni_tenant_isolation ON public.omni_personal_profile_mutations AS PERMISSIVE FOR ALL TO PUBLIC
USING (public.omni_tenant_visible(tenant_id)) WITH CHECK (public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_personal_profile_mutations_actor ON public.omni_personal_profile_mutations AS RESTRICTIVE FOR ALL TO PUBLIC
USING ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()), tenant_id, actor_id))
WITH CHECK ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()), tenant_id, actor_id));

REVOKE ALL ON public.omni_personal_profiles, public.omni_personal_profile_mutations FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_personal_profile_revision_v1() FROM PUBLIC;
DO $grants$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['omni_runtime', 'omni_maintenance'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON public.omni_personal_profiles, public.omni_personal_profile_mutations FROM %I', role_name);
      EXECUTE format('GRANT SELECT, INSERT ON public.omni_personal_profiles, public.omni_personal_profile_mutations TO %I', role_name);
      EXECUTE format('GRANT UPDATE (revision, enabled, profile, field_sources, updated_at) ON public.omni_personal_profiles TO %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON public.omni_personal_profiles, public.omni_personal_profile_mutations TO omni_backup;
  END IF;
END
$grants$;

INSERT INTO public.omni_schema_version(version, name, checksum, applied_at)
VALUES (248, 'personal_profiles_v1',
  '032b554dec2e7f1e7d811180e9e74aa5170ec1418b79136a3f152cf84ffa2cdd', clock_timestamp());
COMMIT;
