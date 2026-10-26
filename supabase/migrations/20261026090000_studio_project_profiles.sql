BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope','true',true);
SELECT set_config('omni.system_reason','ordered schema migration',true);
SELECT set_config('search_path','public, pg_catalog',true);
DO $predecessor$
BEGIN
 IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 261 OR NOT EXISTS(SELECT 1 FROM public.omni_schema_version WHERE version=261 AND checksum='4c7759ec2b4a57d0a85f9470292cdfa810e2b20c570b73c61b4ddcda3698c6e5') THEN
 RAISE EXCEPTION 'Studio project profile predecessor is invalid' USING ERRCODE='55000'; END IF;
END
$predecessor$;
-- Reuse the actor-private, bounded Studio record store. Existing tables, rows,
-- RLS, admission immutability and grants are unchanged. The new record kind
-- stores revisioned creative metadata; it carries no publishing authority.
ALTER TABLE public.omni_studio_records DROP CONSTRAINT omni_studio_records_kind_check;
ALTER TABLE public.omni_studio_records ADD CONSTRAINT omni_studio_records_kind_check
 CHECK(kind IN ('flow','quote','run','attempt','request','project_profile')) NOT VALID;
ALTER TABLE public.omni_studio_records VALIDATE CONSTRAINT omni_studio_records_kind_check;
-- Narrow current-authority reader: no general auth-table grant and no other
-- actor's project metadata. An exact alias resolves to a canonical Project.
CREATE FUNCTION public.omni_studio_projects_v1(candidate_tenant_id TEXT,candidate_actor_id TEXT,candidate_project_id TEXT)
RETURNS TABLE(project_id TEXT,source_id TEXT,workspace_id TEXT,title TEXT,lifecycle_status TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public
AS $catalog$
BEGIN
 IF candidate_tenant_id IS DISTINCT FROM NULLIF(current_setting('omni.tenant_id',TRUE),'')
   OR COALESCE(NULLIF(current_setting('omni.system_scope',TRUE),'')::BOOLEAN,FALSE)
   OR candidate_actor_id IS NULL
   OR NOT public.omni_actor_scope_v1_allows_canonical(candidate_tenant_id,candidate_actor_id)
 THEN RETURN; END IF;
 PERFORM 1 FROM public.omni_auth_users u JOIN public.omni_auth_memberships m ON m.user_id=u.id
   WHERE u.actor_id=candidate_actor_id AND u.status='active' AND m.tenant_id=candidate_tenant_id
     AND m.status='active' AND m.role IN ('operator','admin','system') FOR SHARE OF u,m;
 IF NOT FOUND THEN RETURN; END IF;
 RETURN QUERY SELECT p.project_id,p.source_id,p.workspace_id,p.title,p.lifecycle_status
   FROM public.omni_work_projects p
   JOIN public.omni_work_project_memberships pm ON pm.tenant_id=p.tenant_id AND pm.workspace_id=p.workspace_id AND pm.project_id=p.project_id
   JOIN public.omni_tenant_workspaces w ON w.tenant_id=p.tenant_id AND w.workspace_id=p.workspace_id
   JOIN public.omni_tenant_workspace_memberships wm ON wm.tenant_id=w.tenant_id AND wm.workspace_id=w.workspace_id
   WHERE p.tenant_id=candidate_tenant_id AND p.owner_actor_id=candidate_actor_id
     AND pm.subject_actor_id=candidate_actor_id AND pm.state='active' AND pm.access_level IN ('contributor','manager')
     AND w.state='active' AND wm.subject_kind='user' AND wm.subject_actor_id=candidate_actor_id
     AND wm.state='active' AND wm.access_level IN ('contributor','manager')
     AND (candidate_project_id IS NULL OR p.project_id=candidate_project_id OR p.source_id=candidate_project_id)
   ORDER BY p.updated_at DESC,p.project_id LIMIT 200 FOR SHARE OF p,pm,w,wm;
END
$catalog$;
DO $catalog_acl$
DECLARE fn REGPROCEDURE := 'public.omni_studio_projects_v1(TEXT,TEXT,TEXT)'::REGPROCEDURE; grant_row RECORD;
BEGIN
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',fn);
 FOR grant_row IN SELECT DISTINCT roles.rolname FROM pg_proc p
   CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) privilege
   JOIN pg_roles roles ON roles.oid=privilege.grantee WHERE p.oid=fn AND privilege.grantee<>p.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',fn,grant_row.rolname);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_runtime') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO omni_runtime',fn); END IF;
END
$catalog_acl$;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at) VALUES(262,'studio_project_profiles_v1','b8e1ee22c58a941ef450e5b1def4c8611e4c0fa3de096de3693a8a2c451be0a5',clock_timestamp());
COMMIT;
