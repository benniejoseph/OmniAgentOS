BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope','true',true);
SELECT set_config('omni.system_reason','ordered schema migration',true);
SELECT set_config('search_path','public, pg_catalog',true);
DO $predecessor$
BEGIN
 IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 260 OR NOT EXISTS(SELECT 1 FROM public.omni_schema_version WHERE version=260 AND checksum='8640153049e2aca9b86ecc853087290db8a4fe0c238860b83a7c12294e756c0c') THEN
 RAISE EXCEPTION 'Creative studio predecessor is invalid' USING ERRCODE='55000'; END IF;
END
$predecessor$;
CREATE TABLE public.omni_studio_records (
 tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL CHECK(actor_id ~ '^actor:[a-f0-9-]{36}$'),
 kind TEXT NOT NULL CHECK(kind IN ('flow','quote','run','attempt','request')),
 id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 180), parent_id TEXT,
 state TEXT NOT NULL, body JSONB NOT NULL CHECK(jsonb_typeof(body)='object' AND pg_column_size(body)<=33554432),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,actor_id,kind,id)
);
CREATE INDEX omni_studio_records_listing_idx ON public.omni_studio_records(tenant_id,actor_id,kind,parent_id,created_at DESC,id DESC);
CREATE TABLE public.omni_studio_run_events (
 seq BIGSERIAL PRIMARY KEY, tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL CHECK(actor_id ~ '^actor:[a-f0-9-]{36}$'),
 run_id TEXT NOT NULL, type TEXT NOT NULL CHECK(length(type)<=100), message TEXT NOT NULL CHECK(length(message)<=1000),
 node_id TEXT, status TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX omni_studio_run_events_cursor_idx ON public.omni_studio_run_events(tenant_id,actor_id,run_id,seq);
-- Cost-only tenant ledger: no prompts, actor IDs, run IDs, provider handles or media.
-- Every accepted run holds its maximum for a rolling 24 hours, including uncertainty.
CREATE TABLE public.omni_studio_budget_reservations (
  tenant_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL CHECK (reservation_id ~ '^[a-f0-9]{64}$'),
  maximum_microusd BIGINT NOT NULL CHECK (maximum_microusd BETWEEN 0 AND 1000000000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, reservation_id)
);
CREATE INDEX omni_studio_budget_window_idx
  ON public.omni_studio_budget_reservations(tenant_id, created_at DESC);
ALTER TABLE public.omni_studio_budget_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_studio_budget_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY omni_tenant_isolation ON public.omni_studio_budget_reservations
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (public.omni_tenant_visible(tenant_id))
  WITH CHECK (public.omni_tenant_visible(tenant_id));
REVOKE ALL ON public.omni_studio_budget_reservations FROM PUBLIC;
DO $budget_grants$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['omni_runtime','omni_maintenance'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('GRANT SELECT,INSERT ON public.omni_studio_budget_reservations TO %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='omni_backup') THEN
    GRANT SELECT ON public.omni_studio_budget_reservations TO omni_backup;
  END IF;
END
$budget_grants$;
CREATE FUNCTION public.omni_protect_studio_record_v1() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.tenant_id,NEW.actor_id,NEW.kind,NEW.id,NEW.parent_id,NEW.created_at) IS DISTINCT FROM (OLD.tenant_id,OLD.actor_id,OLD.kind,OLD.id,OLD.parent_id,OLD.created_at) THEN RAISE EXCEPTION 'Studio record identity is immutable'; END IF;
  IF OLD.kind IN ('quote','request') AND NEW.body IS DISTINCT FROM OLD.body THEN RAISE EXCEPTION 'Studio admission records are immutable'; END IF;
  IF OLD.kind='run' AND (NEW.body#>'{value,graph}',NEW.body#>'{value,scope}',NEW.body#>'{value,flowRevision}',NEW.body#>'{value,requestedBy}',NEW.body->'assetPins',NEW.body->'dependencies',NEW.body->'executionScope',NEW.body->'requestHash',NEW.body->'routes',NEW.body->'capabilityPins',NEW.body->'reusable',NEW.body->'workspaceId',NEW.body->'projectId',NEW.body->'legacyActorId',NEW.body#>'{value,maxCostUsd}',NEW.body#>'{value,maxGenerations}',NEW.body#>'{value,estimate}') IS DISTINCT FROM (OLD.body#>'{value,graph}',OLD.body#>'{value,scope}',OLD.body#>'{value,flowRevision}',OLD.body#>'{value,requestedBy}',OLD.body->'assetPins',OLD.body->'dependencies',OLD.body->'executionScope',OLD.body->'requestHash',OLD.body->'routes',OLD.body->'capabilityPins',OLD.body->'reusable',OLD.body->'workspaceId',OLD.body->'projectId',OLD.body->'legacyActorId',OLD.body#>'{value,maxCostUsd}',OLD.body#>'{value,maxGenerations}',OLD.body#>'{value,estimate}') THEN RAISE EXCEPTION 'Studio run input snapshot is immutable'; END IF;
  IF OLD.kind='attempt' AND (NEW.body->'submissionKey',NEW.body->'runId',NEW.body->'nodeId',NEW.body->'providerPrompt') IS DISTINCT FROM (OLD.body->'submissionKey',OLD.body->'runId',OLD.body->'nodeId',OLD.body->'providerPrompt') THEN RAISE EXCEPTION 'Studio provider attempt identity is immutable'; END IF;
 END IF;
 RETURN NEW;
END
$fn$;
CREATE TRIGGER omni_protect_studio_record_v1 BEFORE UPDATE ON public.omni_studio_records FOR EACH ROW EXECUTE FUNCTION public.omni_protect_studio_record_v1();
DO $security$
DECLARE table_name TEXT; role_name TEXT;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['omni_studio_records','omni_studio_run_events'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY omni_tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC USING (public.omni_tenant_visible(tenant_id)) WITH CHECK (public.omni_tenant_visible(tenant_id))',table_name);
  EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO PUBLIC USING ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,actor_id)) WITH CHECK ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,actor_id))',table_name||'_actor',table_name);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',table_name);
  FOREACH role_name IN ARRAY ARRAY['omni_runtime','omni_maintenance'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
    EXECUTE format('GRANT SELECT,INSERT%s ON public.%I TO %I',CASE WHEN table_name='omni_studio_records' THEN ',UPDATE' ELSE '' END,table_name,role_name);
   END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_backup') THEN EXECUTE format('GRANT SELECT ON public.%I TO omni_backup',table_name); END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_runtime') THEN GRANT USAGE,SELECT ON SEQUENCE public.omni_studio_run_events_seq_seq TO omni_runtime; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_maintenance') THEN GRANT USAGE,SELECT ON SEQUENCE public.omni_studio_run_events_seq_seq TO omni_maintenance; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_backup') THEN GRANT SELECT ON SEQUENCE public.omni_studio_run_events_seq_seq TO omni_backup; END IF;
END
$security$;
REVOKE ALL ON FUNCTION public.omni_protect_studio_record_v1() FROM PUBLIC;
-- Closed read/lock boundaries. Runtime receives no SELECT on auth tables and no
-- UPDATE on workspace authority merely to acquire a PostgreSQL FOR SHARE lock.
CREATE FUNCTION public.omni_studio_authority_v1(
  candidate_tenant_id TEXT, candidate_actor_id TEXT,
  candidate_workspace_id TEXT, candidate_project_id TEXT
) RETURNS TABLE(workspace_id TEXT, legacy_actor_id TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public
AS $authority$
DECLARE selected_workspace TEXT; selected_email TEXT; selected_project TEXT;
BEGIN
  IF candidate_tenant_id IS DISTINCT FROM NULLIF(current_setting('omni.tenant_id',TRUE),'')
    OR COALESCE(NULLIF(current_setting('omni.system_scope',TRUE),'')::BOOLEAN,FALSE)
    OR candidate_actor_id IS NULL
    OR NOT public.omni_actor_scope_v1_allows_canonical(candidate_tenant_id,candidate_actor_id)
  THEN RETURN; END IF;
  SELECT u.email INTO selected_email
    FROM public.omni_auth_users u
    JOIN public.omni_auth_memberships m ON m.user_id=u.id
    WHERE u.actor_id=candidate_actor_id AND u.status='active'
      AND m.tenant_id=candidate_tenant_id AND m.status='active'
      AND m.role IN ('operator','admin','system')
    FOR SHARE OF u,m;
  IF selected_email IS NULL THEN RETURN; END IF;
  SELECT w.workspace_id INTO selected_workspace
    FROM public.omni_tenant_workspaces w
    JOIN public.omni_tenant_workspace_memberships wm
      ON wm.tenant_id=w.tenant_id AND wm.workspace_id=w.workspace_id
    WHERE w.tenant_id=candidate_tenant_id AND w.state='active'
      AND wm.subject_kind='user' AND wm.subject_actor_id=candidate_actor_id
      AND wm.state='active' AND wm.access_level IN ('contributor','manager')
      AND (candidate_workspace_id IS NULL OR w.workspace_id=candidate_workspace_id)
    ORDER BY CASE WHEN w.created_by_actor_id=candidate_actor_id THEN 0 ELSE 1 END,w.workspace_id
    LIMIT 1 FOR SHARE OF w,wm;
  IF selected_workspace IS NULL THEN RETURN; END IF;
  IF candidate_project_id IS NOT NULL THEN
    SELECT p.project_id INTO selected_project FROM public.omni_work_projects p
      WHERE p.tenant_id=candidate_tenant_id AND p.workspace_id=selected_workspace
        AND p.owner_actor_id=candidate_actor_id
        AND (p.project_id=candidate_project_id OR p.source_id=candidate_project_id)
      LIMIT 1 FOR SHARE OF p;
    IF selected_project IS NULL THEN RETURN; END IF;
  END IF;
  RETURN QUERY SELECT selected_workspace,selected_email;
END
$authority$;

-- Returns aggregate cents only; exposes no other actor's ledger or Studio content.
CREATE FUNCTION public.omni_studio_budget_totals_v1(
  candidate_tenant_id TEXT, candidate_actor_id TEXT, candidate_since TIMESTAMPTZ
) RETURNS TABLE(other_cost NUMERIC,reserved_cost NUMERIC)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
AS $totals$
BEGIN
  IF candidate_tenant_id IS DISTINCT FROM NULLIF(current_setting('omni.tenant_id',TRUE),'')
    OR COALESCE(NULLIF(current_setting('omni.system_scope',TRUE),'')::BOOLEAN,FALSE)
    OR candidate_actor_id IS NULL
    OR NOT public.omni_actor_scope_v1_allows_canonical(candidate_tenant_id,candidate_actor_id)
  THEN RAISE EXCEPTION 'Studio budget owner is unavailable' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT
    (SELECT COALESCE(SUM(u.estimated_cost_microusd),0)::NUMERIC FROM public.omni_ai_usage u
      WHERE u.tenant_id=candidate_tenant_id AND u.recorded_at>=candidate_since
        AND u.source_stream_id NOT LIKE 'studio:%'),
    (SELECT COALESCE(SUM(r.maximum_microusd),0)::NUMERIC FROM public.omni_studio_budget_reservations r
      WHERE r.tenant_id=candidate_tenant_id AND r.created_at>=candidate_since);
END
$totals$;

-- Default privileges may have granted named roles access at CREATE time. Normalize
-- every inherited grantee, not just PUBLIC, before granting the single caller role.
DO $studio_acl$
DECLARE fn REGPROCEDURE; grant_row RECORD;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.omni_studio_authority_v1(TEXT,TEXT,TEXT,TEXT)'::REGPROCEDURE,
    'public.omni_studio_budget_totals_v1(TEXT,TEXT,TIMESTAMPTZ)'::REGPROCEDURE
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',fn);
    FOR grant_row IN
      SELECT DISTINCT roles.rolname FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) privilege
      JOIN pg_roles roles ON roles.oid=privilege.grantee
      WHERE p.oid=fn AND privilege.grantee<>p.proowner
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',fn,grant_row.rolname);
    END LOOP;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_runtime') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO omni_runtime',fn);
    END IF;
  END LOOP;
END
$studio_acl$;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at) VALUES(261,'creative_studio_v1','4c7759ec2b4a57d0a85f9470292cdfa810e2b20c570b73c61b4ddcda3698c6e5',clock_timestamp());
COMMIT;
