BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout','600000',true);
SELECT set_config('omni.system_scope','true',true);
SELECT set_config('omni.system_reason','ordered schema migration',true);
SELECT set_config('search_path','public,pg_catalog',true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 238 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version=238 AND name='native_connector_credential_removals_v1'
      AND checksum='9b77ab90dd862d16a4cb1c670fa11f41436e58cfc8e7273c3e50e95725906ebe'
  )<>1 THEN RAISE EXCEPTION 'Native Trash predecessor is invalid' USING ERRCODE='55000'; END IF;
END
$migration$;

-- The two historical families continue through their unchanged validators.
CREATE FUNCTION public.omni_native_connector_intent_valid_v3(i JSONB,a JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT CASE WHEN i->'request'->>'action'<>'trash' THEN public.omni_native_connector_intent_valid_v2(i,a)
    ELSE COALESCE(
      i->'request'->>'contract'='asael-connector-lifecycle-action:1'
      AND i->'request'->>'kind'='mcp' AND a->>'kind'='mcp' AND a->>'action'='trash'
      AND public.omni_native_connector_intent_valid_v1(
        jsonb_set(jsonb_set(i #- '{request,preview}','{request,contract}','"asael-connector-action:1"'::JSONB),'{request,action}','"disable"'::JSONB),
        jsonb_set(a,'{action}','"disable"'::JSONB))
      AND jsonb_typeof(i->'request'->'preview')='object' AND pg_column_size(i->'request'->'preview')<=4096
      AND i->'request'->'preview' ?& ARRAY['version','action','trashId','resourceType','resourceId','lifecycleRevision','targetSha256','effectSummary','reversible','issuedAt','expiresAt','previewSha256']
      AND (i->'request'->'preview')-ARRAY['version','action','trashId','resourceType','resourceId','lifecycleRevision','targetSha256','effectSummary','reversible','issuedAt','expiresAt','previewSha256']='{}'::JSONB
      AND i->'request'->'preview'->>'version'='p9.3-trash-preview:1' AND i->'request'->'preview'->>'action'='trash'
      AND i->'request'->'preview'->'trashId'='null'::JSONB AND i->'request'->'preview'->>'resourceType'='mcp_connector'
      AND i->'request'->'preview'->'resourceId'=i->'request'->'connectorId'
      AND i->'request'->'preview'->'lifecycleRevision'='0'::JSONB AND i->'request'->'preview'->'reversible'='true'::JSONB
      AND jsonb_typeof(i->'request'->'preview'->'effectSummary')='string' AND char_length(i->'request'->'preview'->>'effectSummary') BETWEEN 1 AND 500
      AND jsonb_typeof(i->'request'->'preview'->'issuedAt')='string' AND jsonb_typeof(i->'request'->'preview'->'expiresAt')='string'
      AND (i->'request'->'preview'->>'expiresAt')::TIMESTAMPTZ-(i->'request'->'preview'->>'issuedAt')::TIMESTAMPTZ=INTERVAL '10 minutes'
      AND (a->>'acceptedAt')::TIMESTAMPTZ>=(i->'request'->'preview'->>'issuedAt')::TIMESTAMPTZ
      AND (a->>'acceptedAt')::TIMESTAMPTZ<(i->'request'->'preview'->>'expiresAt')::TIMESTAMPTZ
      AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['targetSha256','previewSha256']) field
        WHERE jsonb_typeof(i->'request'->'preview'->field) IS DISTINCT FROM 'string' OR (i->'request'->'preview'->>field) !~ '^[a-f0-9]{64}$'),FALSE)
    END
$function$;

CREATE FUNCTION public.omni_native_connector_settlement_valid_v3(s JSONB,a JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $function$
  SELECT CASE WHEN a->>'action'<>'trash' THEN public.omni_native_connector_settlement_valid_v2(s,a)
    ELSE s IS NULL OR COALESCE(
      jsonb_typeof(s)='object' AND pg_column_size(s)<=8192
      AND s ?& ARRAY['contract','acceptanceId','settledAt','result','settlementSha256']
      AND s-ARRAY['contract','acceptanceId','settledAt','result','settlementSha256']='{}'::JSONB
      AND s->>'contract'='asael-connector-settlement:2' AND s->'acceptanceId'=a->'id'
      AND jsonb_typeof(s->'settledAt')='string' AND (s->>'settledAt')::TIMESTAMPTZ>=(a->>'acceptedAt')::TIMESTAMPTZ
      AND jsonb_typeof(s->'settlementSha256')='string' AND s->>'settlementSha256' ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(s->'result')='object'
      AND s->'result' ?& ARRAY['kind','connectorId','operation','status','connectorStatus','contractCount','credentialVersion','connectorSha256','contractsSha256','configurationSha256','trash','failureCode']
      AND (s->'result')-ARRAY['kind','connectorId','operation','status','connectorStatus','contractCount','credentialVersion','connectorSha256','contractsSha256','configurationSha256','trash','failureCode']='{}'::JSONB
      AND s->'result'->>'kind'='mcp' AND s->'result'->'kind'=a->'kind' AND s->'result'->'connectorId'=a->'connectorId'
      AND s->'result'->>'operation'='trash' AND s->'result'->'operation'=a->'action' AND s->'result'->>'status'='complete'
      AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['connectorStatus','contractCount','credentialVersion','connectorSha256','contractsSha256','configurationSha256','failureCode']) field
        WHERE s->'result'->field IS DISTINCT FROM 'null'::JSONB)
      AND jsonb_typeof(s->'result'->'trash')='object'
      AND s->'result'->'trash' ?& ARRAY['trashId','proofSha256','restoreUntil','compensation','limitation']
      AND (s->'result'->'trash')-ARRAY['trashId','proofSha256','restoreUntil','compensation','limitation']='{}'::JSONB
      AND jsonb_typeof(s->'result'->'trash'->'trashId')='string' AND s->'result'->'trash'->>'trashId' ~ '^trash:[0-9a-f-]{36}$'
      AND jsonb_typeof(s->'result'->'trash'->'proofSha256')='string' AND s->'result'->'trash'->>'proofSha256' ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(s->'result'->'trash'->'restoreUntil')='string' AND (s->'result'->'trash'->>'restoreUntil')::TIMESTAMPTZ>(s->>'settledAt')::TIMESTAMPTZ
      AND (s->'result'->'trash'->>'compensation'='exact_restore' AND s->'result'->'trash'->'limitation'='null'::JSONB OR
        s->'result'->'trash'->>'compensation'='equivalent_action' AND s->'result'->'trash'->>'limitation'='Connector configuration and contracts can be restored, but its vault credential must be reconnected by a human.'),FALSE)
    END
$function$;

ALTER TABLE public.omni_native_connector_actions
  DROP CONSTRAINT omni_native_connector_intent_v2,
  DROP CONSTRAINT omni_native_connector_settlement_v2,
  DROP CONSTRAINT omni_native_connector_actions_action_check,
  ADD CONSTRAINT omni_native_connector_actions_action_check CHECK(action IN ('review_contracts','enable','disable','remove_credential','trash')),
  ADD CONSTRAINT omni_native_connector_intent_v3 CHECK(public.omni_native_connector_intent_valid_v3(intent,acceptance)),
  ADD CONSTRAINT omni_native_connector_settlement_v3 CHECK(public.omni_native_connector_settlement_valid_v3(settlement,acceptance));
REVOKE ALL ON FUNCTION public.omni_native_connector_intent_valid_v3(JSONB,JSONB),public.omni_native_connector_settlement_valid_v3(JSONB,JSONB) FROM PUBLIC;
DO $grants$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['omni_runtime','omni_maintenance'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.omni_native_connector_intent_valid_v3(JSONB,JSONB),public.omni_native_connector_settlement_valid_v3(JSONB,JSONB) TO %I',role_name);
    END IF;
  END LOOP;
END
$grants$;
-- Digest of this reviewed SQL migration file is recorded below.
INSERT INTO public.omni_schema_version (
  version,
  name,
  checksum,
  applied_at
) VALUES (
  239,
  'native_connector_trash_v1',
  '6af2db420131c4c68b3279b4030f161d72c85b2a740477fc6f77aa6b85482d83',
  clock_timestamp()
);
COMMIT;
