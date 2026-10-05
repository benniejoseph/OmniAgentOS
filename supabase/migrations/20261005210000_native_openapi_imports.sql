BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout','600000',true);
SELECT set_config('omni.system_scope','true',true);
SELECT set_config('omni.system_reason','ordered schema migration',true);
SELECT set_config('search_path','public,pg_catalog',true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 241 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version=241 AND name='native_mcp_registrations_v1'
      AND checksum='9d673841107a1136a18e3801e78a7bceb69b9dbfbfd0f00a4745746102a09645'
  )<>1 THEN RAISE EXCEPTION 'Native OpenAPI import predecessor is invalid' USING ERRCODE='55000'; END IF;
END
$migration$;

CREATE FUNCTION public.omni_native_connector_intent_valid_v6(i JSONB,a JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT CASE WHEN i->'request'->>'action'<>'import_openapi' THEN public.omni_native_connector_intent_valid_v5(i,a)
    ELSE COALESCE(i->'request'->>'action'='import_openapi' AND i->'request'->>'contract'='asael-connector-prepared-action:1'
      AND i->'request'->>'kind'='openapi' AND a->>'kind'='openapi' AND a->>'action'='import_openapi'
      AND i->'request'->'review'='null'::JSONB AND i->'request'->>'connectorId' ~ '^native-openapi-[a-f0-9]{64}$'
      AND jsonb_typeof(i->'request'->'preparationId')='string' AND i->'request'->>'preparationId' ~ '^connector-preparation:[a-f0-9]{64}$'
      AND jsonb_typeof(i->'request'->'preparationSha256')='string' AND i->'request'->>'preparationSha256' ~ '^[a-f0-9]{64}$'
      AND a->'reviewSha256'=i->'request'->'preparationSha256'
      AND public.omni_native_connector_intent_valid_v1(
        i||jsonb_build_object('request',((i->'request')-ARRAY['preparationId','preparationSha256'])||jsonb_build_object(
          'contract','asael-connector-action:1','action','review_contracts','review',jsonb_build_object('kind','openapi',
            'connectorId',i->'request'->'connectorId','connectorSha256',repeat('0',64),'contractsSha256',repeat('0',64),
            'configurationSha256',repeat('0',64),'reviewFingerprint',NULL,'credentialVersion',0,'reviewSha256',i->'request'->'preparationSha256'))),
        a||jsonb_build_object('action','review_contracts')),FALSE)
    END
$function$;
CREATE FUNCTION public.omni_native_connector_settlement_valid_v6(s JSONB,a JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT CASE WHEN a->>'action'<>'import_openapi' THEN public.omni_native_connector_settlement_valid_v5(s,a)
    ELSE s IS NULL OR COALESCE(s->'result'->>'operation'='import_openapi' AND s->'result'->>'kind'='openapi' AND a->>'kind'='openapi'
      AND s->'result'->'credentialVersion'='0'::JSONB AND jsonb_typeof(s->'result'->'contractCount')='number'
      AND s->'result'->>'contractCount' ~ '^[1-9][0-9]{0,2}$' AND (s->'result'->>'contractCount')::NUMERIC BETWEEN 1 AND 200
      AND jsonb_typeof(s->'result'->'contractsSha256')='string' AND s->'result'->>'contractsSha256' ~ '^[a-f0-9]{64}$'
      AND public.omni_native_connector_settlement_valid_v2(s||jsonb_build_object('result',s->'result'||jsonb_build_object(
        'kind','mcp','operation','remove_credential','credentialVersion',2,'contractCount',0,
        'contractsSha256','4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945')),
        a||jsonb_build_object('kind','mcp','action','remove_credential')),FALSE)
    END
$function$;
ALTER TABLE public.omni_native_connector_actions
  DROP CONSTRAINT omni_native_connector_intent_v5,
  DROP CONSTRAINT omni_native_connector_settlement_v5,
  DROP CONSTRAINT omni_native_connector_actions_action_check,
  ADD CONSTRAINT omni_native_connector_actions_action_check CHECK(action IN ('review_contracts','enable','disable','remove_credential','trash','rotate_mcp','register_mcp','import_openapi')),
  ADD CONSTRAINT omni_native_connector_intent_v6 CHECK(public.omni_native_connector_intent_valid_v6(intent,acceptance)),
  ADD CONSTRAINT omni_native_connector_settlement_v6 CHECK(public.omni_native_connector_settlement_valid_v6(settlement,acceptance));

CREATE FUNCTION public.omni_native_openapi_import_declaration_valid_v1(d JSONB,resolved BOOLEAN)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT COALESCE(jsonb_typeof(d)='object' AND pg_column_size(d)<=10000
    AND d ?& ARRAY['name','endpoint','endpointRedacted','authType','authTokenEnv','authHeaderName','defaultRiskLevel','approvalRequired','specSource','specUrl','specUrlRedacted']
    AND d-ARRAY['name','endpoint','endpointRedacted','authType','authTokenEnv','authHeaderName','defaultRiskLevel','approvalRequired','specSource','specUrl','specUrlRedacted']='{}'::JSONB
    AND jsonb_typeof(d->'name')='string' AND length(d->>'name') BETWEEN 1 AND 120 AND d->>'name'=btrim(d->>'name')
    AND (NOT resolved AND d->'endpoint'='null'::JSONB OR jsonb_typeof(d->'endpoint')='string' AND length(d->>'endpoint') BETWEEN 1 AND 2048
      AND d->>'endpoint' ~ '^https?://[^/@?#[:space:]]+(/[^?#[:space:]]*)?$') AND d->'endpointRedacted'='false'::JSONB
    AND d->>'authType' IN ('none','bearer_env','api_key_header_env')
    AND (d->>'authType'='none' AND d->'authTokenEnv'='null'::JSONB OR d->>'authType'<>'none'
      AND jsonb_typeof(d->'authTokenEnv')='string' AND d->>'authTokenEnv' ~ '^[A-Z0-9_]{1,120}$')
    AND (d->>'authType'<>'api_key_header_env' AND d->'authHeaderName'='null'::JSONB OR d->>'authType'='api_key_header_env'
      AND jsonb_typeof(d->'authHeaderName')='string' AND d->>'authHeaderName' ~ '^[!#$%&''*+.^_`|~0-9A-Za-z-]{1,80}$'
      AND d->>'authHeaderName' !~* '^(authorization|cookie|host|connection|content-length|transfer-encoding|forwarded|proxy-|sec-|cf-connecting-ip|true-client-ip|x-(forwarded-|original-|rewrite-|http-method-override$|method-override$|real-ip$|client-ip$|vercel-))')
    AND d->'defaultRiskLevel' IN ('0'::JSONB,'1'::JSONB,'2'::JSONB,'3'::JSONB) AND jsonb_typeof(d->'approvalRequired')='boolean'
    AND jsonb_typeof(d->'specUrlRedacted')='boolean' AND (d->>'specSource'='text' AND d->'specUrl'='null'::JSONB AND d->'specUrlRedacted'='false'::JSONB
      OR d->>'specSource'='url' AND jsonb_typeof(d->'specUrl')='string' AND length(d->>'specUrl') BETWEEN 1 AND 2048
        AND d->>'specUrl' ~ '^https?://[^/@?#[:space:]]+(/[^?#[:space:]]*)?$'),FALSE)
$function$;
CREATE FUNCTION public.omni_native_openapi_import_preparation_intent_valid_v1(i JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT COALESCE(jsonb_typeof(i)='object' AND pg_column_size(i)<=16384
    AND i ?& ARRAY['contract','scope','keySha256','kind','nonce','operation','connectorId','review','declaration']
    AND i-ARRAY['contract','scope','keySha256','kind','nonce','operation','connectorId','review','declaration']='{}'::JSONB
    AND i->>'contract'='asael-openapi-import-preparation-intent:1' AND i->>'operation'='import_openapi' AND i->>'kind'='openapi'
    AND i->'review'='null'::JSONB AND i->>'connectorId' ~ '^native-openapi-[a-f0-9]{64}$'
    AND jsonb_typeof(i->'nonce')='string' AND (i->>'nonce' ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89aAbB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$'
      OR i->>'nonce' IN ('00000000-0000-0000-0000-000000000000','ffffffff-ffff-ffff-ffff-ffffffffffff'))
    AND public.omni_native_openapi_import_declaration_valid_v1(i->'declaration',FALSE)
    AND public.omni_native_connector_intent_valid_v1(
      jsonb_build_object('contract','asael-connector-action-intent:1','scope',i->'scope','keySha256',i->'keySha256',
        'request',jsonb_build_object('contract','asael-connector-action:1','kind','openapi','connectorId',i->'connectorId','action','review_contracts',
          'review',jsonb_build_object('kind','openapi','connectorId',i->'connectorId','connectorSha256',repeat('0',64),
            'contractsSha256',repeat('0',64),'configurationSha256',repeat('0',64),'reviewFingerprint',NULL,'credentialVersion',0,'reviewSha256',repeat('0',64)))),
      jsonb_build_object('contract','asael-connector-acceptance:1','id','connector-acceptance:'||repeat('0',64),'scope',i->'scope',
        'keySha256',i->'keySha256','requestSha256',repeat('0',64),'kind','openapi','connectorId',i->'connectorId','action','review_contracts',
        'reviewSha256',repeat('0',64),'acceptedAt','2026-10-05T00:00:00.000Z','acceptanceSha256',repeat('0',64))),FALSE)
$function$;
CREATE FUNCTION public.omni_native_openapi_import_attempt_valid_v1(a JSONB,i JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT COALESCE(jsonb_typeof(a)='object' AND pg_column_size(a)<=4096
    AND a ?& ARRAY['contract','id','scope','keySha256','intentSha256','startedAt','expiresAt','attemptSha256']
    AND a-ARRAY['contract','id','scope','keySha256','intentSha256','startedAt','expiresAt','attemptSha256']='{}'::JSONB
    AND a->>'contract'='asael-openapi-import-attempt:1' AND a->>'id' ~ '^connector-openapi-import-attempt:[a-f0-9]{64}$'
    AND a->'scope'=i->'scope' AND a->'keySha256'=i->'keySha256'
    AND jsonb_typeof(a->'startedAt')='string' AND jsonb_typeof(a->'expiresAt')='string'
    AND (a->>'expiresAt')::TIMESTAMPTZ-(a->>'startedAt')::TIMESTAMPTZ=INTERVAL '45 seconds'
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['intentSha256','attemptSha256']) f
      WHERE jsonb_typeof(a->f) IS DISTINCT FROM 'string' OR a->>f !~ '^[a-f0-9]{64}$'),FALSE)
$function$;
CREATE FUNCTION public.omni_native_openapi_import_preparation_proof_valid_v1(p JSONB,i JSONB,a JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT COALESCE(jsonb_typeof(p)='object' AND pg_column_size(p)<=24000
    AND p ?& ARRAY['contract','id','scope','keySha256','intentSha256','kind','nonce','operation','connectorId','review','declaration','resolvedDeclaration','attemptSha256','configurationSha256','snapshotSha256','summarySha256','reviewProjectionSha256','contractCount','preparedAt','expiresAt','preparationSha256']
    AND p-ARRAY['contract','id','scope','keySha256','intentSha256','kind','nonce','operation','connectorId','review','declaration','resolvedDeclaration','attemptSha256','configurationSha256','snapshotSha256','summarySha256','reviewProjectionSha256','contractCount','preparedAt','expiresAt','preparationSha256']='{}'::JSONB
    AND p->>'contract'='asael-openapi-import-preparation:1' AND p->>'id' ~ '^connector-preparation:[a-f0-9]{64}$'
    AND p-ARRAY['contract','id','intentSha256','resolvedDeclaration','attemptSha256','configurationSha256','snapshotSha256','summarySha256','reviewProjectionSha256','contractCount','preparedAt','expiresAt','preparationSha256']=i-'contract'
    AND public.omni_native_openapi_import_declaration_valid_v1(p->'resolvedDeclaration',TRUE)
    AND (p->'resolvedDeclaration')-'endpoint'=(i->'declaration')-'endpoint'
    AND (i->'declaration'->'endpoint'='null'::JSONB OR p->'resolvedDeclaration'->'endpoint'=i->'declaration'->'endpoint')
    AND p->'attemptSha256'=a->'attemptSha256' AND p->'intentSha256'=a->'intentSha256'
    AND jsonb_typeof(p->'preparedAt')='string' AND jsonb_typeof(p->'expiresAt')='string'
    AND (p->>'expiresAt')::TIMESTAMPTZ-(p->>'preparedAt')::TIMESTAMPTZ=INTERVAL '15 minutes'
    AND (p->>'preparedAt')::TIMESTAMPTZ>=(a->>'startedAt')::TIMESTAMPTZ AND (p->>'preparedAt')::TIMESTAMPTZ<(a->>'expiresAt')::TIMESTAMPTZ
    AND jsonb_typeof(p->'contractCount')='number' AND p->>'contractCount' ~ '^[1-9][0-9]{0,2}$' AND (p->>'contractCount')::NUMERIC BETWEEN 1 AND 200
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['intentSha256','attemptSha256','configurationSha256','snapshotSha256','summarySha256','reviewProjectionSha256','preparationSha256']) f
      WHERE jsonb_typeof(p->f) IS DISTINCT FROM 'string' OR p->>f !~ '^[a-f0-9]{64}$'),FALSE)
$function$;
CREATE FUNCTION public.omni_native_openapi_import_abandonment_valid_v1(a JSONB,i JSONB,t JSONB,p JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT COALESCE(jsonb_typeof(a)='object' AND pg_column_size(a)<=4096
    AND a ?& ARRAY['contract','id','scope','keySha256','intentSha256','attemptSha256','preparationSha256','abandonedAt','abandonmentSha256']
    AND a-ARRAY['contract','id','scope','keySha256','intentSha256','attemptSha256','preparationSha256','abandonedAt','abandonmentSha256']='{}'::JSONB
    AND a->>'contract'='asael-openapi-import-preparation-abandonment:1' AND a->>'id' ~ '^connector-preparation-abandonment:[a-f0-9]{64}$'
    AND a->'scope'=i->'scope' AND a->'keySha256'=i->'keySha256' AND jsonb_typeof(a->'abandonedAt')='string'
    AND (t IS NULL AND a->'attemptSha256'='null'::JSONB OR t IS NOT NULL AND a->'attemptSha256'=t->'attemptSha256'
      AND a->'intentSha256'=t->'intentSha256' AND (a->>'abandonedAt')::TIMESTAMPTZ>=(t->>'startedAt')::TIMESTAMPTZ)
    AND (p IS NULL AND a->'preparationSha256'='null'::JSONB OR p IS NOT NULL AND a->'preparationSha256'=p->'preparationSha256'
      AND (a->>'abandonedAt')::TIMESTAMPTZ>=(p->>'preparedAt')::TIMESTAMPTZ)
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['intentSha256','abandonmentSha256']) f
      WHERE jsonb_typeof(a->f) IS DISTINCT FROM 'string' OR a->>f !~ '^[a-f0-9]{64}$'),FALSE)
$function$;

-- New-target reservations are permanent and precede any connector row. Raw
-- source never enters this table; only one bounded encrypted normalized snapshot.
CREATE TABLE public.omni_native_openapi_import_preparations(
  id TEXT PRIMARY KEY CHECK(id ~ '^connector-preparation:[a-f0-9]{64}$'),
  tenant_id TEXT NOT NULL REFERENCES public.omni_auth_tenants(id),
  owner_actor_id TEXT NOT NULL CHECK(length(owner_actor_id) BETWEEN 1 AND 320 AND owner_actor_id=btrim(owner_actor_id)),
  canonical_actor_id TEXT NOT NULL CHECK(canonical_actor_id ~ '^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  idempotency_key_sha256 TEXT NOT NULL CHECK(idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  connector_id TEXT NOT NULL UNIQUE CHECK(connector_id ~ '^native-openapi-[a-f0-9]{64}$'),
  intent JSONB NOT NULL, attempt JSONB, attempt_expires_at TIMESTAMPTZ, input_commitment TEXT CHECK(input_commitment ~ '^[a-f0-9]{64}$'),
  preparation JSONB, expires_at TIMESTAMPTZ, sealed_snapshot JSONB,
  state TEXT NOT NULL CHECK(state IN ('preparing','ready','failed','expired','consumed','abandoned')), failure JSONB,
  consumed_by TEXT REFERENCES public.omni_native_connector_actions(id), consumed_key_sha256 TEXT CHECK(consumed_key_sha256 ~ '^[a-f0-9]{64}$'), abandonment JSONB,
  UNIQUE(tenant_id,owner_actor_id,idempotency_key_sha256),
  CHECK(public.omni_native_openapi_import_preparation_intent_valid_v1(intent)),
  CHECK(COALESCE(intent->'scope'=jsonb_build_object('tenantId',tenant_id,'ownerActorId',owner_actor_id,'canonicalActorId',canonical_actor_id)
    AND intent->>'keySha256'=idempotency_key_sha256 AND intent->>'connectorId'=connector_id,FALSE)),
  CHECK(attempt IS NULL AND state='abandoned' AND attempt_expires_at IS NULL AND input_commitment IS NULL AND preparation IS NULL AND failure IS NULL OR
    attempt IS NOT NULL AND attempt_expires_at IS NOT NULL AND input_commitment IS NOT NULL
      AND public.omni_native_openapi_import_attempt_valid_v1(attempt,intent) AND (attempt->>'expiresAt')::TIMESTAMPTZ=attempt_expires_at),
  CHECK(preparation IS NULL AND expires_at IS NULL AND state IN ('preparing','failed','abandoned') OR
    preparation IS NOT NULL AND expires_at IS NOT NULL AND state IN ('ready','expired','consumed','abandoned')
      AND public.omni_native_openapi_import_preparation_proof_valid_v1(preparation,intent,attempt)
      AND preparation->>'id'=id AND (preparation->>'expiresAt')::TIMESTAMPTZ=expires_at),
  CHECK((state='ready')=(sealed_snapshot IS NOT NULL)),
  CHECK(sealed_snapshot IS NULL OR COALESCE(jsonb_typeof(sealed_snapshot)='object' AND octet_length(sealed_snapshot::TEXT)<=5340000
    AND sealed_snapshot ?& ARRAY['version','algorithm','keyId','iv','ciphertext','tag']
    AND sealed_snapshot-ARRAY['version','algorithm','keyId','iv','ciphertext','tag']='{}'::JSONB
    AND sealed_snapshot->'version'='1'::JSONB AND sealed_snapshot->>'algorithm'='aes-256-gcm'
    AND sealed_snapshot->>'keyId' ~ '^[A-Za-z0-9_.:-]{1,80}$' AND sealed_snapshot->>'iv' ~ '^[A-Za-z0-9_-]{16}$'
    AND sealed_snapshot->>'tag' ~ '^[A-Za-z0-9_-]{22}$' AND length(sealed_snapshot->>'ciphertext') BETWEEN 1 AND 5333334
    AND sealed_snapshot->>'ciphertext' ~ '^[A-Za-z0-9_-]+$',FALSE)),
  CHECK((state='failed') IS NOT TRUE OR failure IS NOT NULL),
  CHECK(failure IS NULL OR COALESCE(state IN ('failed','abandoned') AND jsonb_typeof(failure)='object' AND failure ?& ARRAY['code','failedAt']
    AND failure-ARRAY['code','failedAt']='{}'::JSONB AND failure->>'code' IN ('source_unavailable','invalid_spec','unsupported_spec','scope_too_large','admission_failed')
    AND jsonb_typeof(failure->'failedAt')='string' AND (failure->>'failedAt')::TIMESTAMPTZ>=(attempt->>'startedAt')::TIMESTAMPTZ
    AND (failure->>'failedAt')::TIMESTAMPTZ<=attempt_expires_at,FALSE)),
  CHECK((state='consumed')=(consumed_by IS NOT NULL) AND (state='consumed')=(consumed_key_sha256 IS NOT NULL)),
  CHECK((state='abandoned')=(abandonment IS NOT NULL)),
  CHECK(abandonment IS NULL OR public.omni_native_openapi_import_abandonment_valid_v1(abandonment,intent,attempt,preparation))
);
CREATE INDEX omni_native_openapi_import_preparation_expiry ON public.omni_native_openapi_import_preparations(tenant_id,expires_at,id) WHERE sealed_snapshot IS NOT NULL;
CREATE FUNCTION public.omni_protect_native_openapi_import_preparation_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
DECLARE system_scope BOOLEAN := COALESCE(public.omni_system_scope_enabled(),FALSE); linked RECORD;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Import evidence and reservations are immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF system_scope OR NEW.state NOT IN ('preparing','abandoned') OR
      NOT public.omni_native_connector_actor_v1(NEW.tenant_id,NEW.owner_actor_id,NEW.canonical_actor_id,NEW.state='preparing')
    THEN RAISE EXCEPTION 'Exact original owner import authority is required' USING ERRCODE='42501'; END IF;
    IF NEW.state='abandoned' AND (NEW.attempt IS NOT NULL OR NEW.preparation IS NOT NULL) THEN
      RAISE EXCEPTION 'An absent key cannot invent an attempt or proof' USING ERRCODE='23514'; END IF;
    IF NEW.state='preparing' AND ((NEW.attempt->>'startedAt')::TIMESTAMPTZ>clock_timestamp() OR NEW.attempt_expires_at<=clock_timestamp()) THEN
      RAISE EXCEPTION 'Import must reserve a fresh attempt before fetching' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['state','preparation','expires_at','sealed_snapshot','failure','consumed_by','consumed_key_sha256','abandonment']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','preparation','expires_at','sealed_snapshot','failure','consumed_by','consumed_key_sha256','abandonment'])
    OR OLD.state IN ('consumed','abandoned') THEN RAISE EXCEPTION 'Import identity and terminal evidence are immutable' USING ERRCODE='55000'; END IF;
  IF NEW.state='ready' THEN
    IF system_scope OR OLD.state<>'preparing' OR OLD.attempt_expires_at<=clock_timestamp()
      OR (NEW.preparation->>'preparedAt')::TIMESTAMPTZ>clock_timestamp() OR NEW.expires_at<=clock_timestamp()
      OR NOT public.omni_native_connector_actor_v1(NEW.tenant_id,NEW.owner_actor_id,NEW.canonical_actor_id,TRUE)
    THEN RAISE EXCEPTION 'Only a current manager may finish the one live import attempt' USING ERRCODE='42501'; END IF;
  ELSE
    IF NEW.preparation IS DISTINCT FROM OLD.preparation OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.sealed_snapshot IS NOT NULL THEN
      RAISE EXCEPTION 'Issued import proof cannot change or be resealed' USING ERRCODE='55000'; END IF;
    IF NEW.state='failed' THEN
      IF system_scope OR OLD.state<>'preparing' OR OLD.attempt_expires_at<=clock_timestamp()
        OR (NEW.failure->>'failedAt')::TIMESTAMPTZ>clock_timestamp()
        OR NOT public.omni_native_connector_actor_v1(NEW.tenant_id,NEW.owner_actor_id,NEW.canonical_actor_id,TRUE)
      THEN RAISE EXCEPTION 'Only the live manager attempt may record a bounded failure' USING ERRCODE='42501'; END IF;
    ELSE
      IF NEW.failure IS DISTINCT FROM OLD.failure THEN RAISE EXCEPTION 'Import failure evidence is immutable' USING ERRCODE='55000'; END IF;
      IF NEW.state='expired' THEN
        IF NOT system_scope OR OLD.state<>'ready' OR OLD.sealed_snapshot IS NULL OR OLD.expires_at>clock_timestamp() THEN
          RAISE EXCEPTION 'Only bounded actual-role maintenance may scrub expired snapshots' USING ERRCODE='42501'; END IF;
      ELSIF NEW.state='abandoned' THEN
        IF system_scope OR OLD.state NOT IN ('preparing','ready','failed','expired')
          OR NOT public.omni_native_connector_actor_v1(NEW.tenant_id,NEW.owner_actor_id,NEW.canonical_actor_id,FALSE) THEN
          RAISE EXCEPTION 'Exact active original owner cleanup is required' USING ERRCODE='42501'; END IF;
      ELSIF NEW.state='consumed' THEN
        IF system_scope OR OLD.state<>'ready' OR OLD.expires_at<=clock_timestamp()
          OR NOT public.omni_native_connector_actor_v1(NEW.tenant_id,NEW.owner_actor_id,NEW.canonical_actor_id,TRUE) THEN
          RAISE EXCEPTION 'A current ready snapshot and manager are required' USING ERRCODE='42501'; END IF;
        SELECT * INTO linked FROM public.omni_native_connector_actions WHERE id=NEW.consumed_by AND tenant_id=NEW.tenant_id
          AND owner_actor_id=NEW.owner_actor_id AND canonical_actor_id=NEW.canonical_actor_id AND kind='openapi' AND action='import_openapi'
          AND connector_id=NEW.connector_id AND idempotency_key_sha256=NEW.consumed_key_sha256 AND state='accepted';
        IF NOT FOUND OR linked.intent->'request'->>'preparationId'<>NEW.id
          OR linked.acceptance->'reviewSha256' IS DISTINCT FROM NEW.preparation->'preparationSha256'
          OR linked.intent->'request'->'preparationSha256' IS DISTINCT FROM NEW.preparation->'preparationSha256'
          OR linked.accepted_at<(NEW.preparation->>'preparedAt')::TIMESTAMPTZ OR linked.accepted_at>=NEW.expires_at
        THEN RAISE EXCEPTION 'Consumption must bind its exact accepted import' USING ERRCODE='23514'; END IF;
      ELSE RAISE EXCEPTION 'An import attempt cannot be reopened' USING ERRCODE='55000'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER omni_native_openapi_import_preparation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.omni_native_openapi_import_preparations
FOR EACH ROW EXECUTE FUNCTION public.omni_protect_native_openapi_import_preparation_v1();
CREATE TRIGGER omni_native_openapi_import_preparation_no_truncate BEFORE TRUNCATE ON public.omni_native_openapi_import_preparations
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_native_openapi_import_preparation_v1();
ALTER TABLE public.omni_native_openapi_import_preparations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_native_openapi_import_preparations FORCE ROW LEVEL SECURITY;
CREATE POLICY omni_tenant_isolation ON public.omni_native_openapi_import_preparations AS PERMISSIVE FOR ALL
USING(public.omni_tenant_visible(tenant_id)) WITH CHECK(public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_native_openapi_import_preparation_actor ON public.omni_native_openapi_import_preparations AS RESTRICTIVE FOR ALL
USING((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id))
WITH CHECK((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()),tenant_id,owner_actor_id));
CREATE POLICY omni_native_openapi_import_preparation_owner ON public.omni_native_openapi_import_preparations AS RESTRICTIVE FOR ALL
USING((SELECT public.omni_system_scope_enabled()) OR public.omni_native_connector_actor_v1(tenant_id,owner_actor_id,canonical_actor_id,FALSE))
WITH CHECK((SELECT public.omni_system_scope_enabled()) OR public.omni_native_connector_actor_v1(tenant_id,owner_actor_id,canonical_actor_id,FALSE));
CREATE FUNCTION public.omni_protect_native_openapi_import_action_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
DECLARE original RECORD;
BEGIN
  IF NEW.action<>'import_openapi' THEN RETURN NEW; END IF;
  SELECT * INTO original FROM public.omni_native_openapi_import_preparations
    WHERE id=NEW.intent->'request'->>'preparationId' AND tenant_id=NEW.tenant_id AND owner_actor_id=NEW.owner_actor_id
      AND canonical_actor_id=NEW.canonical_actor_id AND connector_id=NEW.connector_id FOR UPDATE;
  IF NOT FOUND OR original.preparation IS NULL
    OR NEW.acceptance->'reviewSha256' IS DISTINCT FROM original.preparation->'preparationSha256'
    OR NEW.intent->'request'->'preparationSha256' IS DISTINCT FROM original.preparation->'preparationSha256'
    OR NEW.accepted_at<(original.preparation->>'preparedAt')::TIMESTAMPTZ OR NEW.accepted_at>=original.expires_at
  THEN RAISE EXCEPTION 'Import must retain its exact original snapshot proof' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF original.state<>'ready' OR original.expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'Import needs a fresh unconsumed snapshot' USING ERRCODE='23514'; END IF;
  ELSE
    IF original.state<>'consumed' OR original.consumed_by IS DISTINCT FROM NEW.id
      OR original.consumed_key_sha256 IS DISTINCT FROM NEW.idempotency_key_sha256
      OR NEW.settlement->'result'->'contractCount' IS DISTINCT FROM original.preparation->'contractCount'
      OR NEW.settlement->'result'->'configurationSha256' IS DISTINCT FROM original.preparation->'configurationSha256'
    THEN RAISE EXCEPTION 'Import settlement must bind its complete consumed snapshot' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER omni_native_openapi_import_action_guard BEFORE INSERT OR UPDATE ON public.omni_native_connector_actions
FOR EACH ROW EXECUTE FUNCTION public.omni_protect_native_openapi_import_action_v1();
REVOKE ALL ON public.omni_native_openapi_import_preparations FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_native_connector_intent_valid_v6(JSONB,JSONB),public.omni_native_connector_settlement_valid_v6(JSONB,JSONB),
  public.omni_native_openapi_import_declaration_valid_v1(JSONB,BOOLEAN),public.omni_native_openapi_import_preparation_intent_valid_v1(JSONB),
  public.omni_native_openapi_import_attempt_valid_v1(JSONB,JSONB),public.omni_native_openapi_import_preparation_proof_valid_v1(JSONB,JSONB,JSONB),
  public.omni_native_openapi_import_abandonment_valid_v1(JSONB,JSONB,JSONB,JSONB),public.omni_protect_native_openapi_import_preparation_v1(),
  public.omni_protect_native_openapi_import_action_v1() FROM PUBLIC;
DO $grants$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['omni_runtime','omni_maintenance'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('GRANT SELECT,INSERT ON public.omni_native_openapi_import_preparations TO %I',role_name);
      EXECUTE format('GRANT UPDATE(state,preparation,expires_at,sealed_snapshot,failure,consumed_by,consumed_key_sha256,abandonment) ON public.omni_native_openapi_import_preparations TO %I',role_name);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.omni_native_connector_intent_valid_v6(JSONB,JSONB),public.omni_native_connector_settlement_valid_v6(JSONB,JSONB),public.omni_native_openapi_import_declaration_valid_v1(JSONB,BOOLEAN),public.omni_native_openapi_import_preparation_intent_valid_v1(JSONB),public.omni_native_openapi_import_attempt_valid_v1(JSONB,JSONB),public.omni_native_openapi_import_preparation_proof_valid_v1(JSONB,JSONB,JSONB),public.omni_native_openapi_import_abandonment_valid_v1(JSONB,JSONB,JSONB,JSONB) TO %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_backup') THEN GRANT SELECT ON public.omni_native_openapi_import_preparations TO omni_backup; END IF;
END
$grants$;
-- Digest of this reviewed SQL migration file is recorded below.
INSERT INTO public.omni_schema_version (version,name,checksum,applied_at)
VALUES (
  242,
  'native_openapi_imports_v1',
  '69c0b615c0d7f966954c4c664d7dd1cd3110027ffd918381af6d11db9d92b495',
  clock_timestamp()
);
COMMIT;
