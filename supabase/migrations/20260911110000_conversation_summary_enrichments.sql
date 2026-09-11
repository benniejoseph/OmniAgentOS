BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
DECLARE
  latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version
  FROM public.omni_schema_version
  WHERE version IS NOT NULL;

  IF latest_version IS DISTINCT FROM 155 OR (
    SELECT count(*) FROM public.omni_schema_version
    WHERE version = 155
      AND name = 'knowledge_cognification_candidates_v1'
      AND checksum =
        'c14f3308088df1ce4eb94f7208580b91bc574efe7479bf2832d2f2ba853cac1e'
  ) <> 1 THEN
    RAISE EXCEPTION 'Conversation summary enrichment predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE TABLE public.omni_conversation_summary_enrichments (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'shadow',
  generation_id TEXT NOT NULL,
  episode_summary_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  project_id TEXT,
  bucket_index INTEGER NOT NULL,
  source_turn_ids TEXT[] NOT NULL,
  episode_source_sha256 TEXT NOT NULL,
  episode_summary_sha256 TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  enrichment_sha256 TEXT NOT NULL,
  input_character_count INTEGER NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  model_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_routing_source TEXT NOT NULL,
  model_assignment_id TEXT,
  model_assignment_revision BIGINT,
  model_configuration_sha256 TEXT,
  model_credential_source TEXT,
  model_usage_receipt_id TEXT NOT NULL,
  contract_sha256 TEXT NOT NULL,
  contract JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT omni_conversation_summary_enrichments_pkey
    PRIMARY KEY (tenant_id, id),
  CONSTRAINT omni_conversation_summary_enrichments_parent_fkey
    FOREIGN KEY (episode_summary_id)
    REFERENCES public.omni_conversation_summaries (id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT omni_conversation_summary_enrichments_generation_source_key
    UNIQUE (tenant_id, owner_actor_id, generation_id, source_sha256),
  CONSTRAINT omni_conversation_summary_enrichments_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^semantic_episode_enrichment_[0-9a-f]{48}$'
    AND generation_id ~ '^semantic_summary_generation_[0-9a-f]{48}$'
    AND btrim(tenant_id) <> ''
    AND btrim(owner_actor_id) <> ''
    AND btrim(episode_summary_id) <> ''
    AND btrim(thread_id) <> ''
    AND mode = 'shadow'
    AND bucket_index >= 0
    AND cardinality(source_turn_ids) = 12
    AND episode_source_sha256 ~ '^[0-9a-f]{64}$'
    AND episode_summary_sha256 ~ '^[0-9a-f]{64}$'
    AND source_sha256 ~ '^[0-9a-f]{64}$'
    AND enrichment_sha256 ~ '^[0-9a-f]{64}$'
    AND contract_sha256 ~ '^[0-9a-f]{64}$'
    AND input_character_count BETWEEN 1 AND 64000
    AND starts_at <= ends_at
    AND model_provider IN (
      'openai', 'google', 'anthropic', 'aws_bedrock', 'local'
    )
    AND btrim(model_id) <> ''
    AND model_routing_source IN (
      'tenant_assignment', 'deployment_environment'
    )
    AND (
      model_credential_source IS NULL
      OR model_credential_source IN (
        'tenant_vault', 'deployment_environment'
      )
    )
    AND btrim(model_usage_receipt_id) <> ''
    AND (
      (
        model_assignment_id IS NULL
        AND model_assignment_revision IS NULL
        AND model_configuration_sha256 IS NULL
      )
      OR (
        btrim(model_assignment_id) <> ''
        AND model_assignment_revision BETWEEN 1 AND 9007199254740991
        AND model_configuration_sha256 ~ '^[0-9a-f]{64}$'
      )
    )
    AND jsonb_typeof(contract) = 'object'
    AND octet_length(contract::TEXT) <= 1048576
    AND contract ->> 'schemaVersion' = '1'
    AND contract ->> 'contractKind' = 'semantic_episode_enrichment'
    AND contract ->> 'level' = 'episode'
    AND contract ->> 'shadowOnly' = 'true'
    AND contract ->> 'enrichmentId' = id
    AND contract ->> 'generationId' = generation_id
    AND contract ->> 'tenantId' = tenant_id
    AND contract ->> 'ownerActorId' = owner_actor_id
    AND contract ->> 'threadId' = thread_id
    AND (
      (project_id IS NULL AND contract -> 'projectId' = 'null'::JSONB)
      OR contract ->> 'projectId' = project_id
    )
    AND contract ->> 'episodeSummaryId' = episode_summary_id
    AND contract ->> 'episodeSourceSha256' = episode_source_sha256
    AND contract ->> 'deterministicSummarySha256' =
      episode_summary_sha256
    AND (contract ->> 'bucketIndex')::INTEGER = bucket_index
    AND contract -> 'sourceTurnIds' = to_jsonb(source_turn_ids)
    AND (contract ->> 'inputCharacterCount')::INTEGER =
      input_character_count
    AND contract ->> 'sourceSha256' = source_sha256
    AND contract ->> 'enrichmentSha256' = enrichment_sha256
    AND (contract ->> 'startsAt')::TIMESTAMPTZ = starts_at
    AND (contract ->> 'endsAt')::TIMESTAMPTZ = ends_at
    AND contract #>> '{modelAttribution,provider}' = model_provider
    AND contract #>> '{modelAttribution,model}' = model_id
    AND contract #>> '{modelAttribution,routingSource}' =
      model_routing_source
    AND contract #>> '{modelAttribution,assignmentScope}' = 'memory'
    AND contract #>> '{modelAttribution,usageReceiptRecorded}' = 'true'
    AND contract #>> '{modelAttribution,usageReceiptId}' =
      model_usage_receipt_id
    AND contract #>> '{modelAttribution,assignmentId}'
      IS NOT DISTINCT FROM model_assignment_id
    AND NULLIF(
      contract #>> '{modelAttribution,assignmentRevision}', ''
    )::BIGINT IS NOT DISTINCT FROM model_assignment_revision
    AND contract #>>
      '{modelAttribution,assignmentConfigurationSha256}'
      IS NOT DISTINCT FROM model_configuration_sha256
    AND contract #>> '{modelAttribution,credentialSource}'
      IS NOT DISTINCT FROM model_credential_source
    AND contract ->> 'contractSha256' = contract_sha256
  , FALSE))
);

CREATE INDEX omni_conversation_summary_enrichments_episode_idx
ON public.omni_conversation_summary_enrichments (
  tenant_id, owner_actor_id, episode_summary_id, created_at DESC, id
);

CREATE INDEX omni_conversation_summary_enrichments_generation_idx
ON public.omni_conversation_summary_enrichments (
  tenant_id, owner_actor_id, generation_id, created_at DESC, id
);

CREATE OR REPLACE FUNCTION
  public.omni_validate_conversation_summary_enrichment_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  parent_summary public.omni_conversation_summaries%ROWTYPE;
BEGIN
  IF TG_RELID IS DISTINCT FROM
      'public.omni_conversation_summary_enrichments'::regclass
    OR TG_WHEN IS DISTINCT FROM 'BEFORE'
    OR TG_LEVEL IS DISTINCT FROM 'ROW'
    OR TG_OP IS DISTINCT FROM 'INSERT'
  THEN
    RAISE EXCEPTION 'Conversation summary enrichment validator context is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF NULLIF(current_setting('omni.tenant_id', TRUE), '')
      IS DISTINCT FROM NEW.tenant_id
    OR NOT (
      public.omni_system_scope_enabled()
      OR public.omni_actor_scope_v1_allows(
        NEW.tenant_id, NEW.owner_actor_id
      )
      OR public.omni_actor_scope_v1_allows_canonical(
        NEW.tenant_id, NEW.owner_actor_id
      )
    )
  THEN
    RAISE EXCEPTION 'Conversation summary enrichment actor scope is invalid'
      USING ERRCODE = '42501';
  END IF;

  SELECT summary.* INTO parent_summary
  FROM public.omni_conversation_summaries summary
  WHERE summary.id = NEW.episode_summary_id
  FOR SHARE;

  IF NOT FOUND
    OR parent_summary.level IS DISTINCT FROM 'episode'
    OR parent_summary.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR parent_summary.owner_actor_id IS DISTINCT FROM NEW.owner_actor_id
    OR parent_summary.thread_id IS DISTINCT FROM NEW.thread_id
    OR parent_summary.project_id IS DISTINCT FROM NEW.project_id
    OR parent_summary.bucket_index IS DISTINCT FROM NEW.bucket_index
    OR parent_summary.source_turn_ids IS DISTINCT FROM NEW.source_turn_ids
    OR parent_summary.source_sha256 IS DISTINCT FROM
      NEW.episode_source_sha256
    OR parent_summary.summary_sha256 IS DISTINCT FROM
      NEW.episode_summary_sha256
    OR parent_summary.starts_at IS DISTINCT FROM NEW.starts_at
    OR parent_summary.ends_at IS DISTINCT FROM NEW.ends_at
    OR parent_summary.rebuildable IS DISTINCT FROM TRUE
  THEN
    RAISE EXCEPTION 'Conversation summary enrichment parent lineage is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF cardinality(NEW.source_turn_ids) <> (
    SELECT count(DISTINCT source_turn_id)
    FROM unnest(NEW.source_turn_ids) source_turn_id
  ) THEN
    RAISE EXCEPTION 'Conversation summary enrichment lineage contains duplicates'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.omni_ai_usage usage
    WHERE usage.id = NEW.model_usage_receipt_id
      AND usage.tenant_id = NEW.tenant_id
      AND usage.actor_id = NEW.owner_actor_id
      AND usage.operation = 'structured_generation'
      AND usage.purpose = 'conversation.summary.enrich.v1'
      AND usage.status = 'completed'
      AND usage.provider = NEW.model_provider
      AND usage.model = NEW.model_id
      AND usage.assignment_id IS NOT DISTINCT FROM NEW.model_assignment_id
      AND usage.assignment_revision::BIGINT
        IS NOT DISTINCT FROM NEW.model_assignment_revision
      AND usage.assignment_configuration_sha256
        IS NOT DISTINCT FROM NEW.model_configuration_sha256
      AND usage.credential_source
        IS NOT DISTINCT FROM NEW.model_credential_source
      AND (
        (
          NEW.model_routing_source = 'tenant_assignment'
          AND usage.assignment_scope = 'memory'
        )
        OR (
          NEW.model_routing_source = 'deployment_environment'
          AND usage.assignment_scope IS NULL
        )
      )
  ) THEN
    RAISE EXCEPTION 'Conversation summary enrichment usage receipt is invalid'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION
  public.omni_delete_stale_conversation_summary_enrichments_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_RELID IS DISTINCT FROM 'public.omni_conversation_summaries'::regclass
    OR TG_WHEN IS DISTINCT FROM 'BEFORE'
    OR TG_LEVEL IS DISTINCT FROM 'ROW'
    OR TG_OP IS DISTINCT FROM 'UPDATE'
  THEN
    RAISE EXCEPTION 'Conversation summary enrichment cleanup context is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF ROW(OLD.source_sha256, OLD.summary_sha256, OLD.source_turn_ids)
      IS DISTINCT FROM
    ROW(NEW.source_sha256, NEW.summary_sha256, NEW.source_turn_ids)
  THEN
    DELETE FROM public.omni_conversation_summary_enrichments enrichment
    WHERE enrichment.episode_summary_id = OLD.id;
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION
  public.omni_protect_conversation_summary_enrichment_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP NOT IN ('UPDATE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Conversation summary enrichment guard context is invalid'
      USING ERRCODE = '55000';
  END IF;
  RAISE EXCEPTION 'Conversation summary enrichment history is immutable'
    USING ERRCODE = '55000';
END
$function$;

CREATE TRIGGER omni_conversation_summary_enrichments_validate
BEFORE INSERT ON public.omni_conversation_summary_enrichments
FOR EACH ROW
EXECUTE FUNCTION public.omni_validate_conversation_summary_enrichment_v1();

CREATE TRIGGER omni_conversation_summary_enrichments_protect
BEFORE UPDATE ON public.omni_conversation_summary_enrichments
FOR EACH ROW
EXECUTE FUNCTION public.omni_protect_conversation_summary_enrichment_v1();

CREATE TRIGGER omni_conversation_summary_enrichments_no_truncate
BEFORE TRUNCATE ON public.omni_conversation_summary_enrichments
FOR EACH STATEMENT
EXECUTE FUNCTION public.omni_protect_conversation_summary_enrichment_v1();

CREATE TRIGGER omni_conversation_summary_enrichment_stale
BEFORE UPDATE OF source_sha256, summary_sha256, source_turn_ids
ON public.omni_conversation_summaries
FOR EACH ROW
EXECUTE FUNCTION
  public.omni_delete_stale_conversation_summary_enrichments_v1();

ALTER TABLE public.omni_conversation_summary_enrichments
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_conversation_summary_enrichments
  FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_tenant_isolation
ON public.omni_conversation_summary_enrichments
AS PERMISSIVE FOR ALL TO PUBLIC
USING (public.omni_tenant_visible(tenant_id))
WITH CHECK (public.omni_tenant_visible(tenant_id));

CREATE POLICY omni_conversation_summary_enrichments_actor_scope
ON public.omni_conversation_summary_enrichments
AS RESTRICTIVE FOR ALL TO PUBLIC
USING (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
  OR public.omni_actor_scope_v1_allows_canonical(
    tenant_id, owner_actor_id
  )
)
WITH CHECK (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
  OR public.omni_actor_scope_v1_allows_canonical(
    tenant_id, owner_actor_id
  )
);

DROP POLICY IF EXISTS omni_conversation_summary_events_actor_scope
  ON public.omni_events;
CREATE POLICY omni_conversation_summary_events_actor_scope
ON public.omni_events
AS RESTRICTIVE FOR ALL TO PUBLIC
USING (
  public.omni_system_scope_enabled()
  OR left(stream_id, 21) <> 'conversation-summary:'
  OR public.omni_actor_scope_v1_allows_validated(
    (SELECT public.omni_current_actor_scope_v1()),
    tenant_id,
    actor_id
  )
)
WITH CHECK (
  public.omni_system_scope_enabled()
  OR left(stream_id, 21) <> 'conversation-summary:'
  OR public.omni_actor_scope_v1_allows_validated(
    (SELECT public.omni_current_actor_scope_v1()),
    tenant_id,
    actor_id
  )
);

REVOKE ALL ON TABLE public.omni_conversation_summary_enrichments FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.omni_validate_conversation_summary_enrichment_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.omni_delete_stale_conversation_summary_enrichments_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.omni_protect_conversation_summary_enrichment_v1() FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    REVOKE ALL ON TABLE public.omni_conversation_summary_enrichments
      FROM omni_runtime;
    GRANT SELECT, INSERT ON public.omni_conversation_summary_enrichments
      TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    REVOKE ALL ON TABLE public.omni_conversation_summary_enrichments
      FROM omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    REVOKE ALL ON TABLE public.omni_conversation_summary_enrichments
      FROM omni_backup;
    GRANT SELECT ON public.omni_conversation_summary_enrichments
      TO omni_backup;
  END IF;
END
$grants$;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid =
      'public.omni_conversation_summary_enrichments'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid =
      'public.omni_conversation_summary_enrichments'::regclass
      AND polname = 'omni_conversation_summary_enrichments_actor_scope'
      AND NOT polpermissive
  ) <> 1 OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid = 'public.omni_events'::regclass
      AND polname = 'omni_conversation_summary_events_actor_scope'
      AND NOT polpermissive
  ) <> 1 OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid =
      'public.omni_conversation_summary_enrichments'::regclass
      AND tgname = 'omni_conversation_summary_enrichments_validate'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid =
      'public.omni_conversation_summary_enrichments'::regclass
      AND tgname = 'omni_conversation_summary_enrichments_protect'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid =
      'public.omni_conversation_summary_enrichments'::regclass
      AND tgname = 'omni_conversation_summary_enrichments_no_truncate'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.omni_conversation_summaries'::regclass
      AND tgname = 'omni_conversation_summary_enrichment_stale'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid =
      'public.omni_conversation_summary_enrichments'::regclass
      AND conname = 'omni_conversation_summary_enrichments_parent_fkey'
      AND confdeltype = 'c'
      AND confupdtype = 'r'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid =
      'public.omni_conversation_summary_enrichments'::regclass
      AND conname =
        'omni_conversation_summary_enrichments_generation_source_key'
      AND contype = 'u'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid =
      'public.omni_validate_conversation_summary_enrichment_v1()'::regprocedure
      AND prosecdef
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid =
      'public.omni_delete_stale_conversation_summary_enrichments_v1()'::regprocedure
      AND prosecdef
  ) OR EXISTS (
    SELECT 1 FROM information_schema.table_privileges
    WHERE table_schema = 'public'
      AND table_name = 'omni_conversation_summary_enrichments'
      AND grantee IN ('omni_runtime', 'omni_maintenance', 'omni_backup')
      AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
  ) THEN
    RAISE EXCEPTION 'Conversation summary enrichment boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  156,
  'conversation_summary_enrichments_v1',
  '83e7878f29b3ea25df0ecb40bd94521a3e84af93f5eae6a34ad03bd4b9071a37',
  clock_timestamp()
);

COMMIT;
