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

  IF latest_version IS DISTINCT FROM 214 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 214
      AND name = 'deferred_constraint_validation_v1'
      AND checksum = 'c5aa4b4689b0c80e509f86e3c44512ea70c6ccf6f3d4ae57a369d432469fd9b4'
  ) <> 1 THEN
    RAISE EXCEPTION 'Companion preferences predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- These preferences change presentation/navigation only. They grant no agent,
-- tool, voice, notification, provider, or conversation-creation authority.
CREATE TABLE public.omni_companion_preferences (
  schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  tenant_id TEXT NOT NULL CHECK (char_length(tenant_id) BETWEEN 1 AND 240),
  actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 320),
  revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  intensity TEXT NOT NULL CHECK (intensity IN ('quiet', 'balanced', 'expressive')),
  visible BOOLEAN NOT NULL,
  motion TEXT NOT NULL CHECK (motion IN ('full', 'reduced', 'off')),
  default_destination TEXT NOT NULL CHECK (default_destination IN ('assistant', 'today', 'activity', 'work')),
  -- Retain a deleted/inaccessible choice until the owner changes or resets it.
  -- No FK or cascade may silently change its saved revision; reads recheck access.
  preferred_thread_id TEXT CHECK (preferred_thread_id IS NULL OR preferred_thread_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, actor_id),
  CHECK (created_at <= updated_at)
);

CREATE TABLE public.omni_companion_preference_mutations (
  schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  id TEXT NOT NULL UNIQUE CHECK (id ~ '^companion:[a-f0-9]{64}$'),
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  idempotency_sha256 TEXT NOT NULL CHECK (idempotency_sha256 ~ '^[a-f0-9]{64}$'),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  expected_revision BIGINT NOT NULL CHECK (expected_revision BETWEEN 0 AND 9007199254740990),
  revision BIGINT NOT NULL CHECK (revision = expected_revision + 1),
  preferences JSONB NOT NULL,
  saved_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, actor_id, idempotency_sha256),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES public.omni_companion_preferences (tenant_id, actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (
    jsonb_typeof(preferences) = 'object'
    AND pg_column_size(preferences) <= 4096
    AND preferences ?& ARRAY['intensity', 'visible', 'motion', 'defaultDestination', 'preferredThreadId']
    AND preferences - ARRAY['intensity', 'visible', 'motion', 'defaultDestination', 'preferredThreadId'] = '{}'::JSONB
    AND jsonb_typeof(preferences -> 'intensity') = 'string'
    AND preferences ->> 'intensity' IN ('quiet', 'balanced', 'expressive')
    AND jsonb_typeof(preferences -> 'visible') = 'boolean'
    AND jsonb_typeof(preferences -> 'motion') = 'string'
    AND preferences ->> 'motion' IN ('full', 'reduced', 'off')
    AND jsonb_typeof(preferences -> 'defaultDestination') = 'string'
    AND preferences ->> 'defaultDestination' IN ('assistant', 'today', 'activity', 'work')
    AND (
      preferences -> 'preferredThreadId' = 'null'::JSONB
      OR (
        jsonb_typeof(preferences -> 'preferredThreadId') = 'string'
        AND preferences ->> 'preferredThreadId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      )
    )
  )
);

CREATE FUNCTION public.omni_protect_companion_preferences_v1()
RETURNS TRIGGER LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Companion preference records cannot be physically removed'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 OR NEW.created_at IS DISTINCT FROM NEW.updated_at THEN
      RAISE EXCEPTION 'Initial Companion preference revision is invalid'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
      OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.revision <> OLD.revision + 1
      OR NEW.updated_at < OLD.updated_at
    THEN
      RAISE EXCEPTION 'Companion preference revision or ownership changed unexpectedly'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER omni_companion_preferences_revision
BEFORE INSERT OR UPDATE OR DELETE ON public.omni_companion_preferences
FOR EACH ROW EXECUTE FUNCTION public.omni_protect_companion_preferences_v1();
CREATE TRIGGER omni_companion_preferences_no_truncate
BEFORE TRUNCATE ON public.omni_companion_preferences
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_companion_preferences_v1();

CREATE FUNCTION public.omni_protect_companion_preference_mutations_v1()
RETURNS TRIGGER LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Companion preference receipts are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.omni_companion_preferences preference
    WHERE preference.tenant_id = NEW.tenant_id AND preference.actor_id = NEW.actor_id
      AND preference.revision = NEW.revision AND preference.updated_at = NEW.saved_at
      AND jsonb_build_object(
        'intensity', preference.intensity, 'visible', preference.visible, 'motion', preference.motion,
        'defaultDestination', preference.default_destination, 'preferredThreadId', preference.preferred_thread_id
      ) = NEW.preferences
  ) THEN
    RAISE EXCEPTION 'Companion receipt does not match the saved preference revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER omni_companion_preference_mutations_immutable
BEFORE INSERT OR UPDATE OR DELETE ON public.omni_companion_preference_mutations
FOR EACH ROW EXECUTE FUNCTION public.omni_protect_companion_preference_mutations_v1();
CREATE TRIGGER omni_companion_preference_mutations_no_truncate
BEFORE TRUNCATE ON public.omni_companion_preference_mutations
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_companion_preference_mutations_v1();

ALTER TABLE public.omni_companion_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_companion_preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE public.omni_companion_preference_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_companion_preference_mutations FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_tenant_isolation
ON public.omni_companion_preferences AS PERMISSIVE FOR ALL TO PUBLIC
USING (public.omni_tenant_visible(tenant_id))
WITH CHECK (public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_companion_preferences_actor
ON public.omni_companion_preferences AS RESTRICTIVE FOR ALL TO PUBLIC
USING (
  (SELECT public.omni_system_scope_enabled())
  OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()), tenant_id, actor_id)
)
WITH CHECK (
  (SELECT public.omni_system_scope_enabled())
  OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()), tenant_id, actor_id)
);
CREATE POLICY omni_tenant_isolation
ON public.omni_companion_preference_mutations AS PERMISSIVE FOR ALL TO PUBLIC
USING (public.omni_tenant_visible(tenant_id))
WITH CHECK (public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_companion_preference_mutations_actor
ON public.omni_companion_preference_mutations AS RESTRICTIVE FOR ALL TO PUBLIC
USING (
  (SELECT public.omni_system_scope_enabled())
  OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()), tenant_id, actor_id)
)
WITH CHECK (
  (SELECT public.omni_system_scope_enabled())
  OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()), tenant_id, actor_id)
);

REVOKE ALL ON public.omni_companion_preferences FROM PUBLIC;
REVOKE ALL ON public.omni_companion_preference_mutations FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_protect_companion_preferences_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_protect_companion_preference_mutations_v1() FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    REVOKE ALL ON TABLE public.omni_companion_preferences FROM omni_runtime;
    REVOKE ALL ON TABLE public.omni_companion_preference_mutations FROM omni_runtime;
    GRANT SELECT, INSERT ON public.omni_companion_preferences, public.omni_companion_preference_mutations TO omni_runtime;
    GRANT UPDATE (revision, intensity, visible, motion, default_destination, preferred_thread_id, updated_at)
      ON public.omni_companion_preferences TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    REVOKE ALL ON TABLE public.omni_companion_preferences FROM omni_maintenance;
    REVOKE ALL ON TABLE public.omni_companion_preference_mutations FROM omni_maintenance;
    GRANT SELECT, INSERT ON public.omni_companion_preferences, public.omni_companion_preference_mutations TO omni_maintenance;
    GRANT UPDATE (revision, intensity, visible, motion, default_destination, preferred_thread_id, updated_at)
      ON public.omni_companion_preferences TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON public.omni_companion_preferences, public.omni_companion_preference_mutations TO omni_backup;
  END IF;
END
$grants$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  215,
  'companion_preferences_v1',
  'e24b96868f0833a36f887f8fa57885d9a35fb002e25495f4fdafd1424b82d373',
  clock_timestamp()
);

COMMIT;
