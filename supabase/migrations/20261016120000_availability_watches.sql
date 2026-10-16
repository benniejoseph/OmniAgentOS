BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 258 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version = 258 AND name = 'local_asael_navigation_v1'
      AND checksum = 'b260eca85260f4c22e8d205f1665029ee5c02bf407e53ecac600d85b2f05c3db'
  ) <> 1 THEN RAISE EXCEPTION 'Availability watch predecessor is invalid' USING ERRCODE = '55000'; END IF;
END
$migration$;

CREATE TABLE public.omni_availability_watches (
  tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL CHECK (actor_id ~ '^actor:[a-f0-9-]{36}$'),
  id TEXT NOT NULL CHECK (id ~ '^watch_[a-f0-9]{48}$'),
  revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991), generation BIGINT NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL CHECK (state IN ('active','degraded','fulfilled','expired','stopped','exhausted')),
  config_sha256 TEXT NOT NULL CHECK (config_sha256 ~ '^[a-f0-9]{64}$'),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND pg_column_size(snapshot) <= 262144),
  pending_check_id TEXT, next_check_at TIMESTAMPTZ, notification_due_at TIMESTAMPTZ, expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id,actor_id,id), UNIQUE(id),
  CHECK (created_at <= updated_at AND expires_at > created_at),
  CHECK (pending_check_id IS NULL OR pending_check_id ~ '^availability-check:[a-f0-9]{64}$'),
  CHECK (state IN ('active','degraded') OR (pending_check_id IS NULL AND next_check_at IS NULL)),
  CHECK (notification_due_at IS NULL OR state = 'fulfilled')
);
CREATE INDEX omni_availability_watches_due ON public.omni_availability_watches (next_check_at,notification_due_at,id) WHERE state IN ('active','degraded','fulfilled');
CREATE INDEX omni_availability_watches_owner ON public.omni_availability_watches (tenant_id,actor_id,created_at DESC,id);
CREATE INDEX omni_availability_watches_config ON public.omni_availability_watches (tenant_id,actor_id,config_sha256) WHERE state IN ('active','degraded','fulfilled');

CREATE TABLE public.omni_availability_watch_checks (
  tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL, watch_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (id ~ '^availability-check:[a-f0-9]{64}$'), generation BIGINT NOT NULL CHECK (generation > 0),
  scheduled_for TIMESTAMPTZ NOT NULL, state TEXT NOT NULL CHECK (state IN ('queued','running','completed','failed','canceled')),
  job_id TEXT NOT NULL, snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND pg_column_size(snapshot) <= 131072),
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id,actor_id,watch_id,id), UNIQUE(id), UNIQUE(tenant_id,actor_id,watch_id,generation,scheduled_for),
  FOREIGN KEY (tenant_id,actor_id,watch_id) REFERENCES public.omni_availability_watches(tenant_id,actor_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK (created_at <= updated_at)
);
CREATE INDEX omni_availability_checks_recent ON public.omni_availability_watch_checks (tenant_id,actor_id,watch_id,scheduled_for DESC);
CREATE TABLE public.omni_availability_watch_mutations (
  tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL, watch_id TEXT NOT NULL,
  idempotency_sha256 TEXT NOT NULL CHECK (idempotency_sha256 ~ '^[a-f0-9]{64}$'), request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND pg_column_size(snapshot) <= 262144), created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id,actor_id,idempotency_sha256),
  FOREIGN KEY (tenant_id,actor_id,watch_id) REFERENCES public.omni_availability_watches(tenant_id,actor_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE FUNCTION public.omni_protect_availability_watch_v1() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public,pg_catalog AS $function$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Watch history cannot be removed' USING ERRCODE = '23514'; END IF;
  IF NOT COALESCE(NEW.snapshot->'schemaVersion' = '1'::jsonb AND NEW.snapshot->>'id' = NEW.id
    AND NEW.snapshot->'revision' = to_jsonb(NEW.revision) AND NEW.snapshot->'generation' = to_jsonb(NEW.generation)
    AND NEW.snapshot->>'state' = NEW.state AND (NEW.snapshot->>'nextCheckAt')::timestamptz IS NOT DISTINCT FROM NEW.next_check_at
    AND (NEW.snapshot->'config'->>'expiresAt')::timestamptz = NEW.expires_at
    AND (NEW.snapshot->>'createdAt')::timestamptz = NEW.created_at AND (NEW.snapshot->>'updatedAt')::timestamptz = NEW.updated_at
    AND (NEW.snapshot->>'checksUsed')::int BETWEEN 0 AND (NEW.snapshot->'config'->>'maxChecks')::int
    AND (NEW.snapshot->'config'->>'maxChecks')::int BETWEEN 1 AND 50000
    AND (NEW.snapshot->'config'->>'intervalMinutes')::int BETWEEN 1 AND 60
    AND NEW.snapshot->'config'->'source'->>'provider' = 'district'
    AND NEW.snapshot->'config'->'target'->>'timezone' = 'Asia/Kolkata'
    AND NEW.snapshot->'config'->'notification' = '{"destination":"owner_in_app","push":true,"quietOnNoChange":true}'::jsonb
    AND (NEW.state <> 'fulfilled' OR (NEW.snapshot->>'openingId' ~ '^availability-opening:[a-f0-9]{64}$' AND jsonb_array_length(NEW.snapshot->'matches') > 0)),FALSE)
  THEN RAISE EXCEPTION 'Watch projection binding is invalid' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.config_sha256 IS DISTINCT FROM OLD.config_sha256
    OR NEW.snapshot->'config' IS DISTINCT FROM OLD.snapshot->'config' OR NEW.revision <> OLD.revision + 1
    OR NEW.generation NOT BETWEEN OLD.generation AND OLD.generation + 1 OR NEW.updated_at < OLD.updated_at
    OR (NEW.snapshot->>'checksUsed')::int < (OLD.snapshot->>'checksUsed')::int
    OR OLD.state = 'stopped' OR (OLD.state IN ('expired','exhausted') AND NEW.state <> 'stopped')
    OR (OLD.state = 'fulfilled' AND NEW.state NOT IN ('fulfilled','stopped'))
    OR (OLD.snapshot->>'openingId' IS NOT NULL AND NEW.snapshot->>'openingId' IS DISTINCT FROM OLD.snapshot->>'openingId'))
  THEN RAISE EXCEPTION 'Watch transition is invalid' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER omni_availability_watch_protect BEFORE INSERT OR UPDATE OR DELETE ON public.omni_availability_watches FOR EACH ROW EXECUTE FUNCTION public.omni_protect_availability_watch_v1();
CREATE TRIGGER omni_availability_watch_no_truncate BEFORE TRUNCATE ON public.omni_availability_watches FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_availability_watch_v1();

CREATE FUNCTION public.omni_protect_availability_watch_check_v1() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public,pg_catalog AS $function$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Watch check history cannot be removed' USING ERRCODE = '23514'; END IF;
  IF NOT COALESCE(NEW.snapshot->>'id' = NEW.id AND NEW.snapshot->'generation' = to_jsonb(NEW.generation) AND NEW.snapshot->>'state' = NEW.state
    AND (NEW.snapshot->>'scheduledFor')::timestamptz = NEW.scheduled_for
    AND (NEW.state <> 'completed' OR (NEW.snapshot->>'toolExecutionId' IS NOT NULL AND jsonb_typeof(NEW.snapshot->'observation') = 'object')),FALSE)
  THEN RAISE EXCEPTION 'Watch check binding is invalid' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' AND (OLD.state IN ('completed','failed','canceled') OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
    OR NEW.watch_id IS DISTINCT FROM OLD.watch_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.generation IS DISTINCT FROM OLD.generation
    OR NEW.scheduled_for IS DISTINCT FROM OLD.scheduled_for OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.created_at IS DISTINCT FROM OLD.created_at)
  THEN RAISE EXCEPTION 'Terminal watch checks are immutable' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER omni_availability_check_protect BEFORE INSERT OR UPDATE OR DELETE ON public.omni_availability_watch_checks FOR EACH ROW EXECUTE FUNCTION public.omni_protect_availability_watch_check_v1();
CREATE TRIGGER omni_availability_check_no_truncate BEFORE TRUNCATE ON public.omni_availability_watch_checks FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_availability_watch_check_v1();
CREATE FUNCTION public.omni_protect_availability_watch_mutation_v1() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public,pg_catalog AS $function$
BEGIN RAISE EXCEPTION 'Watch mutation receipts are immutable' USING ERRCODE = '23514'; END
$function$;
CREATE TRIGGER omni_availability_mutation_protect BEFORE UPDATE OR DELETE ON public.omni_availability_watch_mutations FOR EACH ROW EXECUTE FUNCTION public.omni_protect_availability_watch_mutation_v1();
CREATE TRIGGER omni_availability_mutation_no_truncate BEFORE TRUNCATE ON public.omni_availability_watch_mutations FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_availability_watch_mutation_v1();

ALTER TABLE public.omni_notification_dispositions DROP CONSTRAINT omni_notification_dispositions_source_kind_check;
ALTER TABLE public.omni_notification_dispositions ADD CONSTRAINT omni_notification_dispositions_source_kind_check CHECK (source_kind IN (
  'tool_approval','meeting','customer_risk','agent_run','today_reminder','delegated_task','scheduled_routine','security_incident','responsibility_change','research_workflow','availability_watch'));

DO $security$
DECLARE table_name TEXT; role_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['omni_availability_watches','omni_availability_watch_checks','omni_availability_watch_mutations'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY omni_tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC USING (public.omni_tenant_visible(tenant_id)) WITH CHECK (public.omni_tenant_visible(tenant_id))',table_name);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO PUBLIC USING ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,actor_id)) WITH CHECK ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,actor_id))',table_name || '_actor',table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',table_name);
    FOR role_name IN SELECT DISTINCT role.rolname FROM pg_class relation CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl,acldefault('r',relation.relowner))) acl
      JOIN pg_roles role ON role.oid = acl.grantee WHERE relation.oid = ('public.' || table_name)::regclass AND acl.grantee <> relation.relowner LOOP
      EXECUTE format('REVOKE ALL ON public.%I FROM %I',table_name,role_name);
    END LOOP;
    FOREACH role_name IN ARRAY ARRAY['omni_runtime','omni_maintenance'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('GRANT SELECT,INSERT%s ON public.%I TO %I',CASE WHEN table_name = 'omni_availability_watch_mutations' THEN '' ELSE ',UPDATE' END,table_name,role_name);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN EXECUTE format('GRANT SELECT ON public.%I TO omni_backup',table_name); END IF;
  END LOOP;
END
$security$;
REVOKE ALL ON FUNCTION public.omni_protect_availability_watch_v1(),public.omni_protect_availability_watch_check_v1(),public.omni_protect_availability_watch_mutation_v1() FROM PUBLIC;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES (259,'availability_watches_v1','268ba162a1199e274cefc0abd9058622dcf91df5399de76ee31cdf6ff204332f',clock_timestamp());
COMMIT;
