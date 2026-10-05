BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout','600000',true);
SELECT set_config('omni.system_scope','true',true);
SELECT set_config('omni.system_reason','ordered schema migration',true);
SELECT set_config('search_path','public,pg_catalog',true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 243 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version=243 AND name='native_mcp_discoveries_v1'
      AND checksum='64bd3b002d304b5fdc5483bb81286cdbeb22e49532cf2b83fd4dae228d76030c'
  )<>1 THEN RAISE EXCEPTION 'Native GitHub upgrade predecessor is invalid' USING ERRCODE='55000'; END IF;
END
$migration$;

-- The existing discovery ledger accepts only action=discover, and its
-- settlement cannot attest an endpoint/policy transition. Keep it byte-frozen.
CREATE FUNCTION public.omni_native_github_upgrade_intent_valid_v1(i JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT COALESCE(jsonb_typeof(i)='object' AND pg_column_size(i)<=16384
    AND i->'request'->>'contract'='asael-connector-lifecycle-action:1'
    AND i->'request'->>'kind'='mcp' AND i->'request'->>'action'='upgrade_github'
    AND i->'request'->'preview'='null'::JSONB
    AND public.omni_native_mcp_discovery_intent_valid_v1(
      i||jsonb_build_object('request',i->'request'||jsonb_build_object('action','discover'))),FALSE)
$function$;

CREATE FUNCTION public.omni_native_github_upgrade_attempt_valid_v1(a JSONB,i JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT COALESCE(jsonb_typeof(a)='object' AND pg_column_size(a)<=8192
    AND a ?& ARRAY['contract','id','scope','keySha256','intentSha256','connectorId','reviewSha256',
      'targetEndpoint','startedAt','expiresAt','attemptSha256']
    AND a-ARRAY['contract','id','scope','keySha256','intentSha256','connectorId','reviewSha256',
      'targetEndpoint','startedAt','expiresAt','attemptSha256']='{}'::JSONB
    AND a->>'contract'='asael-github-upgrade-attempt:1'
    AND a->>'id' ~ '^github-upgrade-attempt:[a-f0-9]{64}$'
    AND a->'scope'=i->'scope' AND a->'keySha256'=i->'keySha256'
    AND a->'connectorId'=i->'request'->'connectorId'
    AND a->'reviewSha256'=i->'request'->'review'->'reviewSha256'
    AND a->>'targetEndpoint'='https://api.githubcopilot.com/mcp/x/all'
    AND jsonb_typeof(a->'startedAt')='string' AND jsonb_typeof(a->'expiresAt')='string'
    AND (a->>'expiresAt')::TIMESTAMPTZ-(a->>'startedAt')::TIMESTAMPTZ=INTERVAL '45 seconds'
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['intentSha256','attemptSha256']) f
      WHERE jsonb_typeof(a->f) IS DISTINCT FROM 'string' OR a->>f !~ '^[a-f0-9]{64}$'),FALSE)
$function$;

CREATE FUNCTION public.omni_native_github_upgrade_settlement_valid_v1(s JSONB,i JSONB,a JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT COALESCE(jsonb_typeof(s)='object' AND pg_column_size(s)<=16384
    AND s ?& ARRAY['contract','attemptId','attemptSha256','settledAt','result','settlementSha256']
    AND s-ARRAY['contract','attemptId','attemptSha256','settledAt','result','settlementSha256']='{}'::JSONB
    AND s->>'contract'='asael-github-upgrade-settlement:1'
    AND s->'attemptId'=a->'id' AND s->'attemptSha256'=a->'attemptSha256'
    AND jsonb_typeof(s->'settlementSha256')='string'
    AND s->>'settlementSha256' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(s->'settledAt')='string'
    AND (s->>'settledAt')::TIMESTAMPTZ>=(a->>'startedAt')::TIMESTAMPTZ
    AND jsonb_typeof(s->'result')='object'
    AND s->'result'->>'kind'='mcp'
    AND s->'result'->'connectorId'=i->'request'->'connectorId'
    AND CASE WHEN s->'result'->>'status'='failed' THEN
      s->'result' ?& ARRAY['status','kind','connectorId','failureCode']
      AND (s->'result')-ARRAY['status','kind','connectorId','failureCode']='{}'::JSONB
      AND s->'result'->>'failureCode' IN
        ('discovery_failed','catalog_unreviewable','target_changed','deadline_exceeded')
      AND (s->'result'->>'failureCode'<>'deadline_exceeded'
        OR (s->>'settledAt')::TIMESTAMPTZ>=(a->>'expiresAt')::TIMESTAMPTZ)
    WHEN s->'result'->>'status'='complete' THEN
      s->'result' ?& ARRAY['status','kind','connectorId','connectorStatus','endpoint',
        'defaultRiskLevel','approvalRequired','contractCount','pendingCount',
        'credentialVersion','review']
      AND (s->'result')-ARRAY['status','kind','connectorId','connectorStatus','endpoint',
        'defaultRiskLevel','approvalRequired','contractCount','pendingCount',
        'credentialVersion','review']='{}'::JSONB
      AND s->'result'->>'connectorStatus'='disabled'
      AND s->'result'->>'endpoint'='https://api.githubcopilot.com/mcp/x/all'
      AND s->'result'->'defaultRiskLevel'='2'::JSONB
      AND s->'result'->'approvalRequired'='false'::JSONB
      AND (s->>'settledAt')::TIMESTAMPTZ<(a->>'expiresAt')::TIMESTAMPTZ
      AND s->'result'->'credentialVersion'=i->'request'->'review'->'credentialVersion'
      AND s->'result'->'review'->'credentialVersion'=s->'result'->'credentialVersion'
      AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['contractCount','pendingCount']) f
        WHERE jsonb_typeof(s->'result'->f) IS DISTINCT FROM 'number'
          OR s->'result'->>f !~ '^[1-9][0-9]{0,2}$'
          OR (s->'result'->>f)::NUMERIC>200)
      AND s->'result'->'pendingCount'=s->'result'->'contractCount'
      AND public.omni_native_github_upgrade_intent_valid_v1(
        i||jsonb_build_object('request',
          i->'request'||jsonb_build_object('review',s->'result'->'review')))
    ELSE FALSE END,FALSE)
$function$;

CREATE FUNCTION public.omni_native_github_upgrade_closure_valid_v1(c JSONB,i JSONB,a JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT COALESCE(jsonb_typeof(c)='object' AND pg_column_size(c)<=8192
    AND c ?& ARRAY['contract','scope','keySha256','intentSha256','attemptId',
      'attemptSha256','closedAt','closureSha256']
    AND c-ARRAY['contract','scope','keySha256','intentSha256','attemptId',
      'attemptSha256','closedAt','closureSha256']='{}'::JSONB
    AND c->>'contract'='asael-github-upgrade-closure:1'
    AND c->'scope'=i->'scope' AND c->'keySha256'=i->'keySha256'
    AND jsonb_typeof(c->'closedAt')='string'
    AND (a IS NULL AND c->'attemptId'='null'::JSONB
      AND c->'attemptSha256'='null'::JSONB OR
      a IS NOT NULL AND c->'attemptId'=a->'id'
      AND c->'attemptSha256'=a->'attemptSha256'
      AND c->'intentSha256'=a->'intentSha256'
      AND (c->>'closedAt')::TIMESTAMPTZ>=(a->>'startedAt')::TIMESTAMPTZ)
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['intentSha256','closureSha256']) f
      WHERE jsonb_typeof(c->f) IS DISTINCT FROM 'string'
        OR c->>f !~ '^[a-f0-9]{64}$'),FALSE)
$function$;

-- Rows survive connector Trash. An absent-key closure is an immutable
-- tombstone, so a delayed possible POST cannot create an effect.
CREATE TABLE public.omni_native_github_upgrades(
  id TEXT PRIMARY KEY CHECK(id ~ '^github-upgrade-attempt:[a-f0-9]{64}$'),
  tenant_id TEXT NOT NULL REFERENCES public.omni_auth_tenants(id)
    CHECK(tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  owner_actor_id TEXT NOT NULL
    CHECK(length(owner_actor_id) BETWEEN 1 AND 320 AND owner_actor_id=btrim(owner_actor_id)),
  canonical_actor_id TEXT NOT NULL
    CHECK(canonical_actor_id ~ '^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  idempotency_key_sha256 TEXT NOT NULL CHECK(idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  connector_id TEXT NOT NULL CHECK(connector_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@+~-]{0,199}$'),
  intent JSONB NOT NULL, attempt JSONB, attempt_expires_at TIMESTAMPTZ,
  publication_token TEXT CHECK(publication_token ~ '^[a-f0-9]{64}$'),
  credential_binding_sha256 TEXT CHECK(credential_binding_sha256 ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL CHECK(state IN ('pending','settled','closed')),
  settlement JSONB, closure JSONB,
  UNIQUE(tenant_id,owner_actor_id,idempotency_key_sha256),
  CHECK(public.omni_native_github_upgrade_intent_valid_v1(intent)),
  CHECK(COALESCE(intent->'scope'=jsonb_build_object('tenantId',tenant_id,
    'ownerActorId',owner_actor_id,'canonicalActorId',canonical_actor_id)
    AND intent->>'keySha256'=idempotency_key_sha256
    AND intent->'request'->>'connectorId'=connector_id,FALSE)),
  CHECK(attempt IS NULL AND state='closed' AND attempt_expires_at IS NULL
    AND credential_binding_sha256 IS NULL OR
    attempt IS NOT NULL AND attempt_expires_at IS NOT NULL
    AND credential_binding_sha256 IS NOT NULL
    AND public.omni_native_github_upgrade_attempt_valid_v1(attempt,intent)
    AND attempt->>'id'=id AND (attempt->>'expiresAt')::TIMESTAMPTZ=attempt_expires_at),
  CHECK((state='pending')=(publication_token IS NOT NULL)),
  CHECK((state='settled')=(settlement IS NOT NULL)),
  CHECK(settlement IS NULL OR
    public.omni_native_github_upgrade_settlement_valid_v1(settlement,intent,attempt)),
  CHECK((state='closed')=(closure IS NOT NULL)),
  CHECK(closure IS NULL OR public.omni_native_github_upgrade_closure_valid_v1(closure,intent,attempt))
);
-- A deadline makes provider publication impossible; it does not erase an
-- uncertain dispatch. Exact owner recovery or close is required before a
-- different idempotency key can reserve this connector.
CREATE UNIQUE INDEX omni_native_github_upgrade_pending ON public.omni_native_github_upgrades(
  tenant_id,connector_id) WHERE state='pending';

-- Both ledgers have forced owner RLS. A manager's ordinary SELECT cannot see
-- another owner's pending row, so the shared target lock also needs one
-- boolean-only cross-owner check. Refuse migration under an owner unable to
-- bypass forced RLS; row_security=off makes later privilege drift fail closed.
DO $definer$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user
    AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Native provider single-flight requires a BYPASSRLS migration owner'
      USING ERRCODE='42501';
  END IF;
END
$definer$;
CREATE FUNCTION public.omni_native_provider_pending_v1(
  requested_tenant TEXT,requested_owner TEXT,requested_canonical TEXT,requested_connector TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $function$
BEGIN
  IF requested_connector IS NULL OR requested_connector !~ '^[A-Za-z0-9][A-Za-z0-9._:@+~-]{0,199}$'
    OR NOT COALESCE(public.omni_native_connector_actor_v1(
      requested_tenant,requested_owner,requested_canonical,TRUE),FALSE)
  THEN RAISE EXCEPTION 'Exact current connector manager authority is required'
    USING ERRCODE='42501'; END IF;
  RETURN EXISTS(SELECT 1 FROM public.omni_native_mcp_discoveries
      WHERE tenant_id=requested_tenant AND connector_id=requested_connector AND state='pending')
    OR EXISTS(SELECT 1 FROM public.omni_native_github_upgrades
      WHERE tenant_id=requested_tenant AND connector_id=requested_connector AND state='pending');
END
$function$;
CREATE FUNCTION public.omni_native_provider_singleflight_v1() RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=off AS $function$
BEGIN
  IF NEW.state<>'pending' THEN RETURN NEW; END IF;
  IF NOT COALESCE(public.omni_native_connector_actor_v1(NEW.tenant_id,
    NEW.owner_actor_id,NEW.canonical_actor_id,TRUE),FALSE) THEN
    RAISE EXCEPTION 'Exact current connector manager authority is required'
      USING ERRCODE='42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'native-mcp-discovery-target:'||NEW.tenant_id||':'||NEW.connector_id,0));
  IF public.omni_native_provider_pending_v1(NEW.tenant_id,NEW.owner_actor_id,
    NEW.canonical_actor_id,NEW.connector_id) THEN
    RAISE EXCEPTION 'Another native provider attempt must settle or close first'
      USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END
$function$;
-- Alphabetic trigger order puts this target lock before each ledger's own
-- guard can lock the connector parent row.
CREATE TRIGGER omni_native_00_provider_singleflight BEFORE INSERT
  ON public.omni_native_mcp_discoveries FOR EACH ROW
  EXECUTE FUNCTION public.omni_native_provider_singleflight_v1();
CREATE TRIGGER omni_native_00_provider_singleflight BEFORE INSERT
  ON public.omni_native_github_upgrades FOR EACH ROW
  EXECUTE FUNCTION public.omni_native_provider_singleflight_v1();

CREATE FUNCTION public.omni_protect_native_github_upgrade_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
DECLARE parent RECORD; actual_count BIGINT; actual_pending BIGINT;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'GitHub upgrade evidence is immutable' USING ERRCODE='55000';
  END IF;
  IF COALESCE(public.omni_system_scope_enabled(),FALSE) OR
    NOT public.omni_native_connector_actor_v1(NEW.tenant_id,NEW.owner_actor_id,
      NEW.canonical_actor_id,NEW.state<>'closed')
  THEN RAISE EXCEPTION 'Exact current owner GitHub upgrade authority is required' USING ERRCODE='42501';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state='closed' THEN
      IF NEW.attempt IS NOT NULL OR NEW.attempt_expires_at IS NOT NULL
        OR NEW.publication_token IS NOT NULL OR NEW.credential_binding_sha256 IS NOT NULL
        OR (NEW.closure->>'closedAt')::TIMESTAMPTZ>clock_timestamp()
      THEN RAISE EXCEPTION 'Absent GitHub upgrade close cannot invent an attempt' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END IF;
    IF NEW.state<>'pending' OR NEW.attempt IS NULL OR NEW.publication_token IS NULL
      OR NEW.credential_binding_sha256 IS NULL THEN
      RAISE EXCEPTION 'GitHub upgrade must reserve an attempt before settlement' USING ERRCODE='23514';
    END IF;
    SELECT endpoint,transport,auth_type,credential_version INTO parent
      FROM public.omni_mcp_connectors WHERE id=NEW.connector_id
      AND tenant_id=NEW.tenant_id FOR UPDATE;
    IF NOT FOUND OR parent.endpoint NOT IN
      ('https://api.githubcopilot.com/mcp','https://api.githubcopilot.com/mcp/')
      OR parent.transport<>'streamable_http'
      OR parent.auth_type NOT IN ('none','bearer_env','bearer_vault')
      OR COALESCE(parent.credential_version,0) IS DISTINCT FROM
        (NEW.intent->'request'->'review'->>'credentialVersion')::INTEGER
      OR NEW.attempt_expires_at<=clock_timestamp()
      OR (NEW.attempt->>'startedAt')::TIMESTAMPTZ>clock_timestamp()
    THEN RAISE EXCEPTION 'GitHub upgrade requires a fresh legacy credential generation' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['state','publication_token','settlement','closure']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','publication_token','settlement','closure'])
    OR OLD.state<>'pending' OR NEW.state NOT IN ('settled','closed')
    OR NEW.publication_token IS NOT NULL THEN
    RAISE EXCEPTION 'GitHub upgrade identity and terminal evidence are immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.state='closed' THEN
    IF (NEW.closure->>'closedAt')::TIMESTAMPTZ>clock_timestamp() THEN
      RAISE EXCEPTION 'GitHub upgrade closure cannot claim a future instant' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.settlement->>'settledAt')::TIMESTAMPTZ>clock_timestamp() THEN
    RAISE EXCEPTION 'GitHub upgrade settlement cannot claim a future instant' USING ERRCODE='23514';
  END IF;
  IF NEW.settlement->'result'->>'status'='complete' THEN
    SELECT endpoint,status,default_risk_level,approval_required,credential_version,tool_count
      INTO parent FROM public.omni_mcp_connectors
      WHERE id=NEW.connector_id AND tenant_id=NEW.tenant_id FOR UPDATE;
    IF NOT FOUND OR parent.endpoint<>'https://api.githubcopilot.com/mcp/x/all'
      OR parent.status<>'disabled' OR parent.default_risk_level<>2
      OR parent.approval_required OR COALESCE(parent.credential_version,0) IS DISTINCT FROM
        (NEW.intent->'request'->'review'->>'credentialVersion')::INTEGER
      OR NEW.attempt_expires_at<=clock_timestamp()
    THEN RAISE EXCEPTION 'GitHub upgrade lost its disabled policy or deadline' USING ERRCODE='23514'; END IF;
    PERFORM 1 FROM public.omni_mcp_tools WHERE tenant_id=NEW.tenant_id
      AND connector_id=NEW.connector_id FOR SHARE;
    SELECT count(*),count(*) FILTER(WHERE status='pending_review')
      INTO actual_count,actual_pending FROM public.omni_mcp_tools
      WHERE tenant_id=NEW.tenant_id AND connector_id=NEW.connector_id;
    IF actual_count<1 OR actual_count>200
      OR actual_count IS DISTINCT FROM (NEW.settlement->'result'->>'contractCount')::BIGINT
      OR actual_pending IS DISTINCT FROM actual_count OR parent.tool_count IS DISTINCT FROM actual_count
      OR NEW.attempt_expires_at<=clock_timestamp()
    THEN RAISE EXCEPTION 'GitHub upgrade settlement must name the complete pending catalog' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER omni_native_github_upgrade_guard BEFORE INSERT OR UPDATE OR DELETE
  ON public.omni_native_github_upgrades FOR EACH ROW
  EXECUTE FUNCTION public.omni_protect_native_github_upgrade_v1();
CREATE TRIGGER omni_native_github_upgrade_no_truncate BEFORE TRUNCATE
  ON public.omni_native_github_upgrades FOR EACH STATEMENT
  EXECUTE FUNCTION public.omni_protect_native_github_upgrade_v1();
ALTER TABLE public.omni_native_github_upgrades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_native_github_upgrades FORCE ROW LEVEL SECURITY;
CREATE POLICY omni_tenant_isolation ON public.omni_native_github_upgrades AS PERMISSIVE FOR ALL
USING(public.omni_tenant_visible(tenant_id)) WITH CHECK(public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_native_github_upgrade_actor ON public.omni_native_github_upgrades AS RESTRICTIVE FOR ALL
USING((SELECT public.omni_system_scope_enabled()) OR
  public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id))
WITH CHECK((SELECT public.omni_system_scope_enabled()) OR
  public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id));
CREATE POLICY omni_native_github_upgrade_owner ON public.omni_native_github_upgrades AS RESTRICTIVE FOR ALL
USING(public.omni_native_connector_actor_v1(tenant_id,owner_actor_id,canonical_actor_id,FALSE))
WITH CHECK(public.omni_native_connector_actor_v1(tenant_id,owner_actor_id,canonical_actor_id,FALSE));
REVOKE ALL ON public.omni_native_github_upgrades FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_native_github_upgrade_intent_valid_v1(JSONB),
  public.omni_native_github_upgrade_attempt_valid_v1(JSONB,JSONB),
  public.omni_native_github_upgrade_settlement_valid_v1(JSONB,JSONB,JSONB),
  public.omni_native_github_upgrade_closure_valid_v1(JSONB,JSONB,JSONB),
  public.omni_protect_native_github_upgrade_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_native_provider_pending_v1(TEXT,TEXT,TEXT,TEXT),
  public.omni_native_provider_singleflight_v1() FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_runtime') THEN
    GRANT SELECT,INSERT ON public.omni_native_github_upgrades TO omni_runtime;
    GRANT UPDATE(state,publication_token,settlement,closure)
      ON public.omni_native_github_upgrades TO omni_runtime;
    GRANT EXECUTE ON FUNCTION public.omni_native_github_upgrade_intent_valid_v1(JSONB),
      public.omni_native_github_upgrade_attempt_valid_v1(JSONB,JSONB),
      public.omni_native_github_upgrade_settlement_valid_v1(JSONB,JSONB,JSONB),
      public.omni_native_github_upgrade_closure_valid_v1(JSONB,JSONB,JSONB)
      TO omni_runtime;
    GRANT EXECUTE ON FUNCTION public.omni_native_provider_pending_v1(TEXT,TEXT,TEXT,TEXT)
      TO omni_runtime;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_backup') THEN
    GRANT SELECT ON public.omni_native_github_upgrades TO omni_backup;
  END IF;
END
$grants$;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES(244,'native_github_upgrades_v1',
  '710fb954e502ad8c3620b992893cac50093854e47092f6ffd0c16859fc706926',
  clock_timestamp());
COMMIT;
