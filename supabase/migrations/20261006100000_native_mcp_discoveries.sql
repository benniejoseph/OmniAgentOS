BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout','600000',true);
SELECT set_config('omni.system_scope','true',true);
SELECT set_config('omni.system_reason','ordered schema migration',true);
SELECT set_config('search_path','public,pg_catalog',true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 242 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version=242 AND name='native_openapi_imports_v1'
      AND checksum='69c0b615c0d7f966954c4c664d7dd1cd3110027ffd918381af6d11db9d92b495'
  )<>1 THEN RAISE EXCEPTION 'Native MCP discovery predecessor is invalid' USING ERRCODE='55000'; END IF;
END
$migration$;

CREATE FUNCTION public.omni_native_mcp_discovery_intent_valid_v1(i JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT COALESCE(jsonb_typeof(i)='object' AND pg_column_size(i)<=16384
    AND i->'request'->>'contract'='asael-connector-lifecycle-action:1'
    AND i->'request'->>'kind'='mcp' AND i->'request'->>'action'='discover' AND i->'request'->'preview'='null'::JSONB
    AND jsonb_typeof(i->'scope'->'tenantId')='string' AND i->'scope'->>'tenantId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
    AND jsonb_typeof(i->'scope'->'ownerActorId')='string' AND length(i->'scope'->>'ownerActorId') BETWEEN 1 AND 320
    AND i->'scope'->>'ownerActorId'=btrim(i->'scope'->>'ownerActorId')
    AND jsonb_typeof(i->'scope'->'canonicalActorId')='string' AND i->'scope'->>'canonicalActorId' ~ '^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    AND jsonb_typeof(i->'request'->'connectorId')='string' AND i->'request'->>'connectorId' ~ '^[A-Za-z0-9][A-Za-z0-9._:@+~-]{0,199}$'
    AND public.omni_native_connector_intent_valid_v1(
      i||jsonb_build_object('request',((i->'request')-'preview')||jsonb_build_object('contract','asael-connector-action:1','action','review_contracts')),
      jsonb_build_object('contract','asael-connector-acceptance:1','id','connector-acceptance:'||repeat('0',64),'scope',i->'scope',
        'keySha256',i->'keySha256','requestSha256',repeat('0',64),'kind','mcp','connectorId',i->'request'->'connectorId','action','review_contracts',
        'reviewSha256',i->'request'->'review'->'reviewSha256','acceptedAt','2026-10-06T00:00:00.000Z','acceptanceSha256',repeat('0',64))),FALSE)
$function$;

CREATE FUNCTION public.omni_native_mcp_discovery_attempt_valid_v1(a JSONB,i JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT COALESCE(jsonb_typeof(a)='object' AND pg_column_size(a)<=8192
    AND a ?& ARRAY['contract','id','scope','keySha256','intentSha256','kind','connectorId','reviewSha256','startedAt','expiresAt','attemptSha256']
    AND a-ARRAY['contract','id','scope','keySha256','intentSha256','kind','connectorId','reviewSha256','startedAt','expiresAt','attemptSha256']='{}'::JSONB
    AND a->>'contract'='asael-mcp-discovery-attempt:1' AND a->>'id' ~ '^mcp-discovery-attempt:[a-f0-9]{64}$'
    AND a->'scope'=i->'scope' AND a->'keySha256'=i->'keySha256' AND a->>'kind'='mcp'
    AND a->'connectorId'=i->'request'->'connectorId' AND a->'reviewSha256'=i->'request'->'review'->'reviewSha256'
    AND jsonb_typeof(a->'startedAt')='string' AND jsonb_typeof(a->'expiresAt')='string'
    AND (a->>'expiresAt')::TIMESTAMPTZ-(a->>'startedAt')::TIMESTAMPTZ=INTERVAL '45 seconds'
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['intentSha256','attemptSha256']) f
      WHERE jsonb_typeof(a->f) IS DISTINCT FROM 'string' OR a->>f !~ '^[a-f0-9]{64}$'),FALSE)
$function$;

CREATE FUNCTION public.omni_native_mcp_discovery_settlement_valid_v1(s JSONB,i JSONB,a JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT COALESCE(jsonb_typeof(s)='object' AND pg_column_size(s)<=16384
    AND s ?& ARRAY['contract','attemptId','attemptSha256','settledAt','result','settlementSha256']
    AND s-ARRAY['contract','attemptId','attemptSha256','settledAt','result','settlementSha256']='{}'::JSONB
    AND s->>'contract'='asael-mcp-discovery-settlement:1' AND s->'attemptId'=a->'id' AND s->'attemptSha256'=a->'attemptSha256'
    AND jsonb_typeof(s->'settlementSha256')='string' AND s->>'settlementSha256' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(s->'settledAt')='string' AND (s->>'settledAt')::TIMESTAMPTZ>=(a->>'startedAt')::TIMESTAMPTZ
    AND jsonb_typeof(s->'result')='object' AND s->'result'->>'kind'='mcp' AND s->'result'->'connectorId'=i->'request'->'connectorId'
    AND CASE WHEN s->'result'->>'status'='failed' THEN
      s->'result' ?& ARRAY['status','kind','connectorId','failureCode']
      AND (s->'result')-ARRAY['status','kind','connectorId','failureCode']='{}'::JSONB
      AND s->'result'->>'failureCode' IN ('discovery_failed','catalog_unreviewable','target_changed','deadline_exceeded')
      AND (s->'result'->>'failureCode'<>'deadline_exceeded' OR (s->>'settledAt')::TIMESTAMPTZ>=(a->>'expiresAt')::TIMESTAMPTZ)
    WHEN s->'result'->>'status'='complete' THEN
      s->'result' ?& ARRAY['status','kind','connectorId','connectorStatus','contractCount','pendingCount','credentialVersion','review']
      AND (s->'result')-ARRAY['status','kind','connectorId','connectorStatus','contractCount','pendingCount','credentialVersion','review']='{}'::JSONB
      AND s->'result'->>'connectorStatus'='disabled' AND (s->>'settledAt')::TIMESTAMPTZ<(a->>'expiresAt')::TIMESTAMPTZ
      AND s->'result'->'credentialVersion'=i->'request'->'review'->'credentialVersion'
      AND s->'result'->'review'->'credentialVersion'=s->'result'->'credentialVersion'
      AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['contractCount','pendingCount']) f
        WHERE jsonb_typeof(s->'result'->f) IS DISTINCT FROM 'number' OR s->'result'->>f !~ '^(0|[1-9][0-9]{0,2})$'
          OR (s->'result'->>f)::NUMERIC>200)
      AND (s->'result'->>'pendingCount')::NUMERIC<=(s->'result'->>'contractCount')::NUMERIC
      AND ((s->'result'->'contractCount'='0'::JSONB)=(s->'result'->'review'->>'contractsSha256'='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'))
      AND public.omni_native_mcp_discovery_intent_valid_v1(i||jsonb_build_object('request',i->'request'||jsonb_build_object('review',s->'result'->'review')))
    ELSE FALSE END,FALSE)
$function$;

CREATE FUNCTION public.omni_native_mcp_discovery_closure_valid_v1(c JSONB,i JSONB,a JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT COALESCE(jsonb_typeof(c)='object' AND pg_column_size(c)<=8192
    AND c ?& ARRAY['contract','scope','keySha256','intentSha256','attemptId','attemptSha256','closedAt','closureSha256']
    AND c-ARRAY['contract','scope','keySha256','intentSha256','attemptId','attemptSha256','closedAt','closureSha256']='{}'::JSONB
    AND c->>'contract'='asael-mcp-discovery-closure:1' AND c->'scope'=i->'scope' AND c->'keySha256'=i->'keySha256'
    AND jsonb_typeof(c->'closedAt')='string'
    AND (a IS NULL AND c->'attemptId'='null'::JSONB AND c->'attemptSha256'='null'::JSONB OR
      a IS NOT NULL AND c->'attemptId'=a->'id' AND c->'attemptSha256'=a->'attemptSha256'
      AND c->'intentSha256'=a->'intentSha256' AND (c->>'closedAt')::TIMESTAMPTZ>=(a->>'startedAt')::TIMESTAMPTZ)
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['intentSha256','closureSha256']) f
      WHERE jsonb_typeof(c->f) IS DISTINCT FROM 'string' OR c->>f !~ '^[a-f0-9]{64}$'),FALSE)
$function$;

-- Recovery belongs to the initiating owner and survives connector Trash. An
-- expired pending attempt keeps its target reservation until explicit close.
CREATE TABLE public.omni_native_mcp_discoveries(
  id TEXT PRIMARY KEY CHECK(id ~ '^mcp-discovery-attempt:[a-f0-9]{64}$'),
  tenant_id TEXT NOT NULL REFERENCES public.omni_auth_tenants(id) CHECK(tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  owner_actor_id TEXT NOT NULL CHECK(length(owner_actor_id) BETWEEN 1 AND 320 AND owner_actor_id=btrim(owner_actor_id)),
  canonical_actor_id TEXT NOT NULL CHECK(canonical_actor_id ~ '^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  idempotency_key_sha256 TEXT NOT NULL CHECK(idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  connector_id TEXT NOT NULL CHECK(connector_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@+~-]{0,199}$'),
  intent JSONB NOT NULL, attempt JSONB, attempt_expires_at TIMESTAMPTZ,
  publication_token TEXT CHECK(publication_token ~ '^[a-f0-9]{64}$'),
  credential_binding_sha256 TEXT CHECK(credential_binding_sha256 ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL CHECK(state IN ('pending','settled','closed')), settlement JSONB, closure JSONB,
  UNIQUE(tenant_id,owner_actor_id,idempotency_key_sha256),
  CHECK(public.omni_native_mcp_discovery_intent_valid_v1(intent)),
  CHECK(COALESCE(intent->'scope'=jsonb_build_object('tenantId',tenant_id,'ownerActorId',owner_actor_id,'canonicalActorId',canonical_actor_id)
    AND intent->>'keySha256'=idempotency_key_sha256 AND intent->'request'->>'connectorId'=connector_id,FALSE)),
  CHECK(attempt IS NULL AND state='closed' AND attempt_expires_at IS NULL AND credential_binding_sha256 IS NULL OR
    attempt IS NOT NULL AND attempt_expires_at IS NOT NULL AND credential_binding_sha256 IS NOT NULL
    AND public.omni_native_mcp_discovery_attempt_valid_v1(attempt,intent) AND attempt->>'id'=id
    AND (attempt->>'expiresAt')::TIMESTAMPTZ=attempt_expires_at),
  CHECK((state='pending')=(publication_token IS NOT NULL)),
  CHECK((state='settled')=(settlement IS NOT NULL)),
  CHECK(settlement IS NULL OR public.omni_native_mcp_discovery_settlement_valid_v1(settlement,intent,attempt)),
  CHECK((state='closed')=(closure IS NOT NULL)),
  CHECK(closure IS NULL OR public.omni_native_mcp_discovery_closure_valid_v1(closure,intent,attempt))
);
CREATE UNIQUE INDEX omni_native_mcp_discovery_pending ON public.omni_native_mcp_discoveries(tenant_id,connector_id) WHERE state='pending';

CREATE FUNCTION public.omni_protect_native_mcp_discovery_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
DECLARE parent RECORD; actual_count BIGINT; actual_pending BIGINT;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Discovery evidence is immutable' USING ERRCODE='55000'; END IF;
  IF COALESCE(public.omni_system_scope_enabled(),FALSE) OR
    NOT public.omni_native_connector_actor_v1(NEW.tenant_id,NEW.owner_actor_id,NEW.canonical_actor_id,NEW.state<>'closed')
  THEN RAISE EXCEPTION 'Exact current owner discovery authority is required' USING ERRCODE='42501'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state='closed' THEN
      IF NEW.attempt IS NOT NULL OR NEW.attempt_expires_at IS NOT NULL OR NEW.publication_token IS NOT NULL OR NEW.credential_binding_sha256 IS NOT NULL
        OR (NEW.closure->>'closedAt')::TIMESTAMPTZ>clock_timestamp()
      THEN RAISE EXCEPTION 'Absent discovery close cannot invent an attempt' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END IF;
    IF NEW.state<>'pending' OR NEW.attempt IS NULL OR NEW.publication_token IS NULL OR NEW.credential_binding_sha256 IS NULL THEN
      RAISE EXCEPTION 'Discovery must reserve its attempt before settlement' USING ERRCODE='23514'; END IF;
    SELECT status,transport,auth_type,credential_version INTO parent FROM public.omni_mcp_connectors
      WHERE id=NEW.connector_id AND tenant_id=NEW.tenant_id FOR UPDATE;
    IF NOT FOUND OR parent.status<>'disabled' OR parent.transport<>'streamable_http'
      OR parent.auth_type NOT IN ('none','bearer_env','bearer_vault')
      OR COALESCE(parent.credential_version,0) IS DISTINCT FROM (NEW.intent->'request'->'review'->>'credentialVersion')::INTEGER
      OR NEW.attempt_expires_at<=clock_timestamp() OR (NEW.attempt->>'startedAt')::TIMESTAMPTZ>clock_timestamp()
    THEN RAISE EXCEPTION 'Discovery requires the fresh disabled credential generation' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['state','publication_token','settlement','closure']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','publication_token','settlement','closure']) OR OLD.state<>'pending'
    OR NEW.state NOT IN ('settled','closed') OR NEW.publication_token IS NOT NULL THEN
    RAISE EXCEPTION 'Discovery identity and terminal evidence are immutable' USING ERRCODE='55000'; END IF;
  IF NEW.state='closed' THEN
    IF (NEW.closure->>'closedAt')::TIMESTAMPTZ>clock_timestamp() THEN
      RAISE EXCEPTION 'Discovery closure cannot claim a future instant' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.settlement->>'settledAt')::TIMESTAMPTZ>clock_timestamp() THEN
    RAISE EXCEPTION 'Discovery settlement cannot claim a future instant' USING ERRCODE='23514'; END IF;
  IF NEW.settlement->'result'->>'status'='complete' THEN
    SELECT status,credential_version,tool_count INTO parent FROM public.omni_mcp_connectors
      WHERE id=NEW.connector_id AND tenant_id=NEW.tenant_id FOR UPDATE;
    IF NOT FOUND OR parent.status<>'disabled'
      OR COALESCE(parent.credential_version,0) IS DISTINCT FROM (NEW.intent->'request'->'review'->>'credentialVersion')::INTEGER
      OR NEW.attempt_expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'Discovery publication lost its disabled credential generation or deadline' USING ERRCODE='23514'; END IF;
    PERFORM 1 FROM public.omni_mcp_tools WHERE tenant_id=NEW.tenant_id AND connector_id=NEW.connector_id FOR SHARE;
    SELECT count(*),count(*) FILTER(WHERE status='pending_review') INTO actual_count,actual_pending
      FROM public.omni_mcp_tools WHERE tenant_id=NEW.tenant_id AND connector_id=NEW.connector_id;
    IF actual_count>200 OR actual_count IS DISTINCT FROM (NEW.settlement->'result'->>'contractCount')::BIGINT
      OR actual_pending IS DISTINCT FROM (NEW.settlement->'result'->>'pendingCount')::BIGINT OR parent.tool_count IS DISTINCT FROM actual_count
      OR NEW.attempt_expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'Discovery settlement must name the complete current catalog' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER omni_native_mcp_discovery_guard BEFORE INSERT OR UPDATE OR DELETE ON public.omni_native_mcp_discoveries
FOR EACH ROW EXECUTE FUNCTION public.omni_protect_native_mcp_discovery_v1();
CREATE TRIGGER omni_native_mcp_discovery_no_truncate BEFORE TRUNCATE ON public.omni_native_mcp_discoveries
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_native_mcp_discovery_v1();
ALTER TABLE public.omni_native_mcp_discoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_native_mcp_discoveries FORCE ROW LEVEL SECURITY;
CREATE POLICY omni_tenant_isolation ON public.omni_native_mcp_discoveries AS PERMISSIVE FOR ALL
USING(public.omni_tenant_visible(tenant_id)) WITH CHECK(public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_native_mcp_discovery_actor ON public.omni_native_mcp_discoveries AS RESTRICTIVE FOR ALL
USING((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id))
WITH CHECK((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id));
CREATE POLICY omni_native_mcp_discovery_owner ON public.omni_native_mcp_discoveries AS RESTRICTIVE FOR ALL
USING(public.omni_native_connector_actor_v1(tenant_id,owner_actor_id,canonical_actor_id,FALSE))
WITH CHECK(public.omni_native_connector_actor_v1(tenant_id,owner_actor_id,canonical_actor_id,FALSE));
REVOKE ALL ON public.omni_native_mcp_discoveries FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_native_mcp_discovery_intent_valid_v1(JSONB),public.omni_native_mcp_discovery_attempt_valid_v1(JSONB,JSONB),
  public.omni_native_mcp_discovery_settlement_valid_v1(JSONB,JSONB,JSONB),public.omni_native_mcp_discovery_closure_valid_v1(JSONB,JSONB,JSONB),
  public.omni_protect_native_mcp_discovery_v1() FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_runtime') THEN
    GRANT SELECT,INSERT ON public.omni_native_mcp_discoveries TO omni_runtime;
    GRANT UPDATE(state,publication_token,settlement,closure) ON public.omni_native_mcp_discoveries TO omni_runtime;
    GRANT EXECUTE ON FUNCTION public.omni_native_mcp_discovery_intent_valid_v1(JSONB),public.omni_native_mcp_discovery_attempt_valid_v1(JSONB,JSONB),
      public.omni_native_mcp_discovery_settlement_valid_v1(JSONB,JSONB,JSONB),public.omni_native_mcp_discovery_closure_valid_v1(JSONB,JSONB,JSONB) TO omni_runtime;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_backup') THEN GRANT SELECT ON public.omni_native_mcp_discoveries TO omni_backup; END IF;
END
$grants$;
-- Digest of this reviewed SQL migration file is recorded below.
INSERT INTO public.omni_schema_version (version,name,checksum,applied_at)
VALUES (
  243,
  'native_mcp_discoveries_v1',
  '64bd3b002d304b5fdc5483bb81286cdbeb22e49532cf2b83fd4dae228d76030c',
  clock_timestamp()
);
COMMIT;
