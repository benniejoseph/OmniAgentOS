BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope','true',true);
SELECT set_config('omni.system_reason','ordered schema migration',true);
SELECT set_config('search_path','public, pg_catalog',true);
DO $predecessor$
BEGIN
 IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 262 OR NOT EXISTS(SELECT 1 FROM public.omni_schema_version WHERE version=262 AND checksum='b8e1ee22c58a941ef450e5b1def4c8611e4c0fa3de096de3693a8a2c451be0a5') THEN
 RAISE EXCEPTION 'Studio project context snapshot predecessor is invalid' USING ERRCODE='55000'; END IF;
END
$predecessor$;
-- The stored graph keeps the previous application's strict graph contract.
-- Its server-owned brand snapshot is stored beside it in value.studioProjectContext.
-- Protect that snapshot from insertion, removal or change on every accepted run,
-- including pending work, while retaining all existing identity and input guards.
-- CREATE OR REPLACE preserves the existing trigger binding, ownership and ACL;
-- no table, grant, policy or historical row is changed by this migration.
CREATE OR REPLACE FUNCTION public.omni_protect_studio_record_v1() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.tenant_id,NEW.actor_id,NEW.kind,NEW.id,NEW.parent_id,NEW.created_at) IS DISTINCT FROM (OLD.tenant_id,OLD.actor_id,OLD.kind,OLD.id,OLD.parent_id,OLD.created_at) THEN RAISE EXCEPTION 'Studio record identity is immutable'; END IF;
  IF OLD.kind IN ('quote','request') AND NEW.body IS DISTINCT FROM OLD.body THEN RAISE EXCEPTION 'Studio admission records are immutable'; END IF;
  IF OLD.kind='run' AND (NEW.body#>'{value,graph}',NEW.body#>'{value,studioProjectContext}',NEW.body#>'{value,scope}',NEW.body#>'{value,flowRevision}',NEW.body#>'{value,requestedBy}',NEW.body->'assetPins',NEW.body->'dependencies',NEW.body->'executionScope',NEW.body->'requestHash',NEW.body->'routes',NEW.body->'capabilityPins',NEW.body->'reusable',NEW.body->'workspaceId',NEW.body->'projectId',NEW.body->'legacyActorId',NEW.body#>'{value,maxCostUsd}',NEW.body#>'{value,maxGenerations}',NEW.body#>'{value,estimate}') IS DISTINCT FROM (OLD.body#>'{value,graph}',OLD.body#>'{value,studioProjectContext}',OLD.body#>'{value,scope}',OLD.body#>'{value,flowRevision}',OLD.body#>'{value,requestedBy}',OLD.body->'assetPins',OLD.body->'dependencies',OLD.body->'executionScope',OLD.body->'requestHash',OLD.body->'routes',OLD.body->'capabilityPins',OLD.body->'reusable',OLD.body->'workspaceId',OLD.body->'projectId',OLD.body->'legacyActorId',OLD.body#>'{value,maxCostUsd}',OLD.body#>'{value,maxGenerations}',OLD.body#>'{value,estimate}') THEN RAISE EXCEPTION 'Studio run input snapshot is immutable'; END IF;
  IF OLD.kind='attempt' AND (NEW.body->'submissionKey',NEW.body->'runId',NEW.body->'nodeId',NEW.body->'providerPrompt') IS DISTINCT FROM (OLD.body->'submissionKey',OLD.body->'runId',OLD.body->'nodeId',OLD.body->'providerPrompt') THEN RAISE EXCEPTION 'Studio provider attempt identity is immutable'; END IF;
 END IF;
 RETURN NEW;
END
$fn$;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at) VALUES(263,'studio_project_context_snapshot_v1','e12731f398b50050a14e145054af59ee2804a2755fffdad62fefebd44f3be472',clock_timestamp());
COMMIT;
