BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 259 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version = 259 AND name = 'availability_watches_v1'
      AND checksum = '268ba162a1199e274cefc0abd9058622dcf91df5399de76ee31cdf6ff204332f'
  ) <> 1 THEN RAISE EXCEPTION 'Browser push requires exact schema259'; END IF;
END
$migration$;
-- Private browser transports share the existing owner Inbox. Endpoints/keys
-- are sealed; dispatch and receipts revalidate the exact live web session.
CREATE TABLE public.omni_web_push_registrations (
  id TEXT PRIMARY KEY CHECK (id ~ '^web_registration_[a-f0-9]{48}$'),
  tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL CHECK (actor_id ~ '^actor:[a-f0-9-]{36}$'),
  user_id TEXT NOT NULL, session_id TEXT NOT NULL,
  endpoint_sha256 TEXT NOT NULL CHECK (endpoint_sha256 ~ '^[a-f0-9]{64}$'),
  subscription JSONB NOT NULL CHECK (jsonb_typeof(subscription) = 'object'),
  state TEXT NOT NULL CHECK (state IN ('active','revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id,actor_id,endpoint_sha256), UNIQUE (tenant_id,actor_id,id)
);
CREATE INDEX omni_web_push_registrations_owner ON public.omni_web_push_registrations(tenant_id,actor_id) WHERE state = 'active';
CREATE TABLE public.omni_web_push_deliveries (
  id TEXT PRIMARY KEY CHECK (id ~ '^web_delivery_[a-f0-9]{48}$'),
  tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL CHECK (actor_id ~ '^actor:[a-f0-9-]{36}$'),
  registration_id TEXT NOT NULL, session_id TEXT NOT NULL,
  notification_id TEXT, occurrence_key TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('watch','test')),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','accepted','failed')),
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 4),
  due_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL,
  lease_id TEXT, lease_expires_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ, received_at TIMESTAMPTZ, opened_at TIMESTAMPTZ, failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id,actor_id,registration_id) REFERENCES public.omni_web_push_registrations(tenant_id,actor_id,id),
  UNIQUE (tenant_id,actor_id,registration_id,occurrence_key),
  CHECK ((kind = 'watch' AND notification_id IS NOT NULL) OR (kind = 'test' AND notification_id IS NULL))
);
CREATE INDEX omni_web_push_deliveries_due ON public.omni_web_push_deliveries(due_at) WHERE state IN ('queued','running');
DO $security$
DECLARE table_name TEXT; role_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['omni_web_push_registrations','omni_web_push_deliveries'] LOOP
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
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN EXECUTE format('GRANT SELECT,INSERT,UPDATE ON public.%I TO %I',table_name,role_name); END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN EXECUTE format('GRANT SELECT ON public.%I TO omni_backup',table_name); END IF;
  END LOOP;
END
$security$;
-- v259 admitted watch sources but omitted their direct-delivery reason.
ALTER TABLE public.omni_notification_dispositions DROP CONSTRAINT omni_notification_dispositions_reason_check;
ALTER TABLE public.omni_notification_dispositions ADD CONSTRAINT omni_notification_dispositions_reason_check CHECK (reason IN (
  'approval_required','security_alert','actionable_failure','meeting_imminent','critical_delivery','quiet_hours','cooldown_active',
  'digest_nonurgent','digest_during_cooldown','routine_success','failure_not_actionable','meeting_not_imminent','not_worthy',
  'material_change','research_ready','availability_opened'));
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES (260,'watch_alert_delivery_v1','8640153049e2aca9b86ecc853087290db8a4fe0c238860b83a7c12294e756c0c',clock_timestamp());
COMMIT;
